using System.ComponentModel;
using System.Globalization;
using System.Text.Json;
using Cineon.Core.Data;

namespace Cineon.Core.Together;

// Port of Cineon/App/TogetherModel.swift. The Mac's @Observable on the main actor becomes properties,
// INotifyPropertyChanged and a coarse Changed event, all raised on the SynchronizationContext given at
// construction (the WinUI app passes its dispatcher context). Every public member switches to that
// context first, so work and state stay on one thread like the Mac's MainActor; read the properties
// from that thread too. Timers are PeriodicTimer and Task.Delay on a TimeProvider. What the Mac reaches
// through ProfileSession and the browser comes through ITogetherHost and IPartyPlayer.
//
// The Mac's fire-and-forget actions (enter, share, startParty, say, ...) return a Task here that ends
// when the work is done. It never faults: failures become toasts, as on the Mac. Ignore it, or await it.

/// <summary>How far someone has got with a challenge's title, from their own library.</summary>
public readonly record struct ChallengeProgress(double Fraction, int Watched, string Label, bool Finished);

/// <summary>
/// Watching with friends: share codes for lists, watch parties that follow the host, and races to the
/// end of a series. Nothing goes to the server until someone starts or joins something.
/// </summary>
public sealed class TogetherModel : INotifyPropertyChanged
{
    /// <summary>What <see cref="IPartyPlayer.EvaluateInPlayerAsync"/> is asked to run: the player's own clock.</summary>
    public const string PlayerStateScript = "window.__cineon ? __cineon.state() : null";

    /// <summary>WatchTracker.minimumDuration: shorter videos are ads and previews, not films.</summary>
    public const double MinimumDuration = 240;

    private readonly Data.Profile _profile;
    private readonly LibraryStore _library;
    private readonly ITogetherHost _host;
    private readonly IPartyPlayer _player;
    private readonly TogetherClient? _client;
    private TogetherIdentity _identity;

    private PartyState? _party;
    private bool _isHost;
    private IReadOnlyList<ChallengeSummary> _challenges = [];
    private readonly Dictionary<string, ChallengeState> _details = [];
    private readonly List<ShareInfo> _openedShares = [];
    private string? _lastShareCode;
    private bool _isWorking;
    private string? _personId;

    private CancellationTokenSource? _partyLoop;
    private CancellationTokenSource? _challengeLoop;
    private Guid? _partyTabId;
    private (double Position, bool Playing, double Rate, DateTimeOffset At)? _lastSent;
    private DateTimeOffset _lastCorrection = DateTimeOffset.MinValue;
    private DateTimeOffset _lastPoll = DateTimeOffset.MinValue;
    private DateTimeOffset _lastHeartbeat = DateTimeOffset.MinValue;
    private bool _isTicking;
    private readonly HashSet<string> _seenReactions = [];
    private readonly HashSet<string> _seenMessages = [];
    /// <summary>Milliseconds since 1970 when this person got into the party.</summary>
    private double _joinedAt;
    private readonly Dictionary<string, string> _reported = [];
    private readonly Dictionary<string, string?> _knownWinners = [];
    private DateTimeOffset _lastChallengeRefresh = DateTimeOffset.MinValue;
    private bool _askedToPressPlay;

    /// <param name="profile">Whose identity: <c>together.json</c> lives in this profile's folder.</param>
    /// <param name="library">The profile's library (backlog additions, challenge progress).</param>
    /// <param name="host">Toasts, clipboard, navigation, settings, the pet, metadata.</param>
    /// <param name="player">Tabs and their players, for watch parties.</param>
    /// <param name="client">The server, or null when this build has none (<see cref="IsAvailable"/> is false).</param>
    /// <param name="context">Where state changes and events happen. Defaults to the current context.</param>
    /// <param name="time">The clock and timers. Defaults to the system's.</param>
    public TogetherModel(Data.Profile profile, LibraryStore library, ITogetherHost host, IPartyPlayer player, TogetherClient? client,
        SynchronizationContext? context = null, TimeProvider? time = null)
    {
        _profile = profile;
        _library = library;
        _host = host;
        _player = player;
        _client = client;
        Context = context ?? SynchronizationContext.Current ?? new SynchronizationContext();
        Time = time ?? TimeProvider.System;
        _identity = TogetherIdentity.Load(profile);
        _personId = _identity.PersonId;
        // A party doesn't survive a restart: the film and everyone's place in it have moved on.
        if (_identity.PartyCode is not null)
        {
            _identity.PartyCode = null;
            Save();
        }
    }

    internal SynchronizationContext Context { get; }
    internal TimeProvider Time { get; }
    internal TogetherIdentity Identity => _identity;

    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>Raised once after anything here changed, on the model's context.</summary>
    public event EventHandler? Changed;

    /// <summary>The party this person is in, as last heard from the server.</summary>
    public PartyState? Party { get => _party; private set => Set(ref _party, value); }
    public bool IsHost { get => _isHost; private set => Set(ref _isHost, value); }
    /// <summary>The challenges this person is in, newest first.</summary>
    public IReadOnlyList<ChallengeSummary> Challenges { get => _challenges; private set => Set(ref _challenges, value); }
    /// <summary>Each challenge's members and winner, by code.</summary>
    public IReadOnlyDictionary<string, ChallengeState> Details => _details;
    /// <summary>Friends' lists opened here, most recent first.</summary>
    public IReadOnlyList<ShareInfo> OpenedShares => _openedShares;
    public string? LastShareCode { get => _lastShareCode; private set => Set(ref _lastShareCode, value); }
    /// <summary>Something started with a button is still going (opening a code, sharing, starting a party).</summary>
    public bool IsWorking { get => _isWorking; private set => Set(ref _isWorking, value); }
    /// <summary>This profile's id on the server, once registered.</summary>
    public string? PersonId { get => _personId; private set => Set(ref _personId, value); }

    public bool IsAvailable => _client is not null;
    public string MyName => _profile.Name;

    /// <summary>Lets this profile be found again from another one, or after starting over.</summary>
    public string RecoveryCode => _identity.Secret;

    private DateTimeOffset Now => Time.GetUtcNow();

    private ContextSwitch Switch() => new(Context);

    private void Save() => _identity.Save(_profile.Id);

    private void Set<T>(ref T field, T value, [System.Runtime.CompilerServices.CallerMemberName] string name = "")
    {
        // The Mac's @Observable reports every assignment; equal values change nothing on screen.
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        Notify(name);
    }

    private void Notify(string name)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
        Changed?.Invoke(this, EventArgs.Empty);
    }

    // MARK: Starting and stopping

    public void Start()
    {
        if (_client is null) return;
        _challengeLoop?.Cancel();
        _challengeLoop = Loop.Start(Context, Time, TimeSpan.FromSeconds(5), ChallengeTick);
        if (_identity.PersonId is null) return;
        _ = StartWork();
    }

    private async Task StartWork()
    {
        await Switch();
        await RefreshChallengesAsync();
        foreach (var code in _identity.OpenedShares.ToList()) await LoadShare(code, remember: false);
    }

    public void Stop()
    {
        _challengeLoop?.Cancel();
        _challengeLoop = null;
        if (Party is not null) _ = LeavePartyNow();
    }

    // MARK: Identity

    private async Task<TogetherClient> Register()
    {
        if (_client is null) throw new TogetherError("Together isn't set up in this build");
        string? pet = _host.Settings.SharePet ? _host.PetCode : null;
        if (_identity.PersonId is null || _identity.Name != MyName || _identity.Pet != pet)
        {
            var args = new Dictionary<string, object?>
            {
                ["deviceSecret"] = _identity.Secret,
                ["name"] = MyName,
                // An empty code takes the pet off, where leaving it out would keep the old one.
                ["pet"] = pet ?? "",
            };
            var reply = await _client.MutationAsync("people:register", args, Registered.FromJson);
            _identity.PersonId = reply.PersonId;
            _identity.Name = MyName;
            _identity.Pet = pet;
            PersonId = reply.PersonId;
            Save();
        }
        return _client;
    }

    /// <summary>The server and this profile's secret, registering first if needed. For the cloud backup.</summary>
    public async Task<(TogetherClient Client, string Secret)> AuthorizedAsync()
    {
        await Switch();
        var client = await Register();
        return (client, _identity.Secret);
    }

    /// <summary>Takes over the identity a recovery code belongs to: its ratings, lists and challenges.</summary>
    public async Task<bool> AdoptAsync(string recoveryCode)
    {
        await Switch();
        var code = SwiftText.Trim(recoveryCode);
        if (code.Length < 32 || code == _identity.Secret || !TogetherIdentity.IsStrictBase64(code)) return false;
        _identity.Secret = code;
        _identity.PersonId = null;
        _identity.Pet = null;
        Save();
        PersonId = null;
        try
        {
            await Register();
        }
        catch (Exception)
        {
            return false;
        }
        await RefreshChallengesAsync();
        return true;
    }

    /// <summary>Sends a changed pet or name to friends' screens.</summary>
    public async Task RefreshIdentity()
    {
        await Switch();
        if (_identity.PersonId is null) return;
        try
        {
            await Register();
        }
        catch (TogetherError)
        {
        }
    }

    private async Task Perform(string action, Func<Task> work)
    {
        await Switch();
        IsWorking = true;
        try
        {
            await work();
        }
        catch (Exception e)
        {
            _host.ShowToast($"Couldn't {action}: {e.Message}");
        }
        finally
        {
            IsWorking = false;
        }
    }

    private static Dictionary<string, object?> Args(params (string Key, object? Value)[] pairs)
    {
        var args = new Dictionary<string, object?>(pairs.Length);
        foreach (var (key, value) in pairs) args[key] = value;
        return args;
    }

    private static async Task Quietly(TogetherClient client, string path, Dictionary<string, object?> args)
    {
        try
        {
            await client.MutationAsync(path, args);
        }
        catch (TogetherError)
        {
        }
    }

    // MARK: Codes

    /// <summary>Opens whatever a friend's code points to: a list, a party or a challenge.</summary>
    public async Task Enter(string code)
    {
        await Switch();
        var clean = ShareCode.Normalize(code);
        if (clean.Length != 6)
        {
            _host.ShowToast("Codes have six letters and digits, like K7Q-2MX");
            return;
        }
        await Perform("open that code", async () =>
        {
            var client = await Register();
            var found = await client.QueryAsync("codes:resolve", Args(("code", clean)), CodeKind.FromJsonOrNull)
                ?? throw new TogetherError("No party, list or challenge has that code");
            switch (found.Kind)
            {
                case "share":
                    await LoadShare(clean, remember: true);
                    break;
                case "party":
                    await JoinParty(clean);
                    break;
                case "challenge":
                    await JoinChallenge(clean);
                    break;
                default:
                    throw new TogetherError("Cineon doesn't know that kind of code yet");
            }
        });
    }

    private void Copy(string code) => _host.CopyText(ShareCode.Display(code));

    // MARK: Sharing lists

    public async Task ShareWatched()
    {
        await Switch();
        var titles = _library.Watched.Take(500).Select(TitleCard.From).ToList();
        if (titles.Count == 0)
        {
            _host.ShowToast("Nothing in Watched to share yet");
            return;
        }
        await Share($"{MyName}'s watched films", titles);
    }

    public async Task Share(Title title)
    {
        await Switch();
        await Share(title.Name, [TitleCard.From(title)]);
    }

    private Task Share(string label, List<TitleCard> titles) => Perform("share", async () =>
    {
        var client = await Register();
        var reply = await client.MutationAsync("shares:create",
            Args(("deviceSecret", _identity.Secret), ("label", label), ("titles", titles.Select(t => t.ToJson()).ToList())),
            CodeReply.FromJson);
        LastShareCode = reply.Code;
        Copy(reply.Code);
        _host.ShowToast($"Code {ShareCode.Display(reply.Code)} copied. Send it to a friend.");
    });

    private async Task LoadShare(string code, bool remember)
    {
        if (_client is null) return;
        ShareInfo? share;
        try
        {
            share = await _client.QueryAsync("shares:get", Args(("code", code)), ShareInfo.FromJsonOrNull);
        }
        catch (TogetherError)
        {
            share = null;
        }
        if (share is null)
        {
            if (remember) _host.ShowToast("That list is gone");
            return;
        }
        _openedShares.RemoveAll(s => s.Code == share.Code);
        _openedShares.Insert(0, share);
        Notify(nameof(OpenedShares));
        if (remember)
        {
            _identity.OpenedShares.RemoveAll(c => c == share.Code);
            _identity.OpenedShares.Insert(0, share.Code);
            if (_identity.OpenedShares.Count > 20) _identity.OpenedShares.RemoveRange(20, _identity.OpenedShares.Count - 20);
            Save();
            _host.Go(TogetherRoute.Together);
        }
    }

    public void ForgetShare(string code)
    {
        _openedShares.RemoveAll(s => s.Code == code);
        _identity.OpenedShares.RemoveAll(c => c == code);
        Save();
        Notify(nameof(OpenedShares));
    }

    /// <summary>Adds a friend's film to the backlog, filling in its poster and details.</summary>
    public void AddToBacklog(TitleCard card)
    {
        var existing = (card.ImdbId is { } id ? _library.Titles.Values.FirstOrDefault(t => t.ImdbId == id) : null)
            ?? _library.Find(card.Name, year: card.Year);
        if (existing is not null)
        {
            if (existing.Status == TitleStatus.None) _library.SetStatus(existing.Id, TitleStatus.Backlog);
            var list = _library.Titles.TryGetValue(existing.Id, out var now) ? now.Status.Label.ToLowerInvariant() : "library";
            _host.ShowToast($"{existing.Name} is already in your {list}");
            return;
        }
        var added = _library.AddTitle(card.Name, card.Year, card.TitleKind, TitleStatus.Backlog, card.ImdbId, card.PosterUri);
        if (added is null) return;
        if (card.ImdbId is not null) _host.ApplyMetadata(added.Id, card);
        else _host.EnrichMetadata(added.Id);
        _host.ShowToast($"Added {card.Name} to backlog");
    }

    public bool HasInLibrary(TitleCard card)
    {
        if (card.ImdbId is { } id && _library.Titles.Values.Any(t => t.ImdbId == id && t.Status != TitleStatus.None)) return true;
        return _library.Find(card.Name, year: card.Year) is { } title && title.Status != TitleStatus.None;
    }

    // MARK: Watch party

    /// <summary>Starts a party from the film playing in the selected tab.</summary>
    public async Task StartParty()
    {
        await Switch();
        if (_player.SelectedTab is not { Url: { } url, Media: { } media } tab || media.Duration < MinimumDuration)
        {
            _host.ShowToast("Start the film first, then invite people to it");
            return;
        }
        var card = (tab.LinkedTitleId is long linked && _library.Titles.TryGetValue(linked, out var title) ? TitleCard.From(title) : null)
            ?? tab.Parsed;
        await Perform("start the party", async () =>
        {
            var client = await Register();
            var args = Args(("deviceSecret", _identity.Secret), ("pageUrl", Urls.Text(url)), ("position", media.Position),
                ("playing", media.IsPlaying), ("rate", media.Rate));
            if (card is not null) args["title"] = card.ToJson();
            var reply = await client.MutationAsync("parties:create", args, CodeReply.FromJson);
            _partyTabId = tab.Id;
            IsHost = true;
            _lastSent = (media.Position, media.IsPlaying, media.Rate, Now);
            _identity.PartyCode = reply.Code;
            Save();
            Party = await client.QueryAsync("parties:get", PartyQuery(reply.Code), PartyState.FromJsonOrNull);
            _joinedAt = Party?.Now ?? JsonArgs.Milliseconds(Now);
            Copy(reply.Code);
            _host.ShowToast($"Party {ShareCode.Display(reply.Code)} started. The code is copied.");
            StartPartyLoop();
        });
    }

    private async Task JoinParty(string code)
    {
        var client = await Register();
        if (Party is not null) _ = LeavePartyNow();
        var state = await client.MutationAsync("parties:join", Args(("deviceSecret", _identity.Secret), ("code", code)), PartyState.FromJson);
        Party = state;
        _joinedAt = state.Now;
        IsHost = state.HostId == _identity.PersonId;
        _identity.PartyCode = code;
        Save();
        _askedToPressPlay = false;
        if (Urls.Parse(state.PageUrl) is { } url)
        {
            _partyTabId = _player.OpenTab(url, select: true);
            _host.Go(TogetherRoute.Web);
        }
        _host.ShowToast($"Joined {state.HostName}'s party");
        StartPartyLoop();
    }

    /// <summary>Leaves the party; when the host leaves, it ends for everyone.</summary>
    public async Task LeaveParty()
    {
        await Switch();
        await LeavePartyNow();
    }

    /// <summary>Forgets the party straight away; the returned task is the server hearing about it.</summary>
    private Task LeavePartyNow()
    {
        if ((Party?.Code ?? _identity.PartyCode) is not { } code) return Task.CompletedTask;
        _partyLoop?.Cancel();
        _partyLoop = null;
        Party = null;
        IsHost = false;
        _partyTabId = null;
        _lastSent = null;
        _identity.PartyCode = null;
        Save();
        if (_client is null) return Task.CompletedTask;
        return Quietly(_client, "parties:leave", Args(("deviceSecret", _identity.Secret), ("code", code)));
    }

    /// <summary>A line of chat to everyone in the party.</summary>
    public async Task Say(string text)
    {
        await Switch();
        var clean = SwiftText.Trim(text);
        if (_client is not { } client || Party?.Code is not { } code || clean.Length == 0) return;
        try
        {
            await client.MutationAsync("parties:say",
                Args(("deviceSecret", _identity.Secret), ("code", code), ("text", SwiftText.Prefix(clean, 280))));
            _lastPoll = DateTimeOffset.MinValue;
        }
        catch (Exception e)
        {
            _host.ShowToast($"Couldn't send that: {e.Message}");
        }
    }

    public async Task React(string emoji)
    {
        await Switch();
        if (_client is not { } client || Party?.Code is not { } code) return;
        await Quietly(client, "parties:react", Args(("deviceSecret", _identity.Secret), ("code", code), ("emoji", emoji)));
    }

    public void CopyPartyCode()
    {
        if (Party?.Code is not { } code) return;
        Copy(code);
        _host.ShowToast($"Code {ShareCode.Display(code)} copied");
    }

    /// <summary>A fresh <c>t</c> each time, or the server answers from its cache with a stale clock.</summary>
    private Dictionary<string, object?> PartyQuery(string code) => Args(("code", code), ("t", JsonArgs.Milliseconds(Now)));

    private PartyTab? PartyTab => _partyTabId is Guid id ? _player.Tab(id) : null;

    private void StartPartyLoop()
    {
        _partyLoop?.Cancel();
        _partyLoop = Loop.Start(Context, Time, TimeSpan.FromSeconds(1), () => _ = PartyTick());
    }

    /// <summary>One second of a party: the host reports, members follow, everyone stays on the list.</summary>
    internal async Task PartyTick()
    {
        await Switch();
        if (_isTicking || _client is not { } client || Party?.Code is not { } code) return;
        _isTicking = true;
        try
        {
            if (IsHost) await SendHostState(client, code);
            // Members follow every second. The host only needs to see who's there and reactions.
            if (!IsHost || (Now - _lastPoll).TotalSeconds > 2.5)
            {
                _lastPoll = Now;
                // A dropped connection is just a missed second. Only the server saying so ends the party.
                PartyState? fetched;
                try
                {
                    fetched = await client.QueryAsync("parties:get", PartyQuery(code), PartyState.FromJsonOrNull);
                }
                catch (TogetherError)
                {
                    return;
                }
                if (fetched is not { Ended: false } state)
                {
                    if (!IsHost) _host.ShowToast("The party is over");
                    _ = LeavePartyNow();
                    return;
                }
                Party = state;
                ShowNewReactions(state);
                ShowNewMessages(state);
                if (!IsHost) await Follow(state);
            }
            // Members only ever read, so without this they'd drop off everyone's list after 30 s.
            if ((Now - _lastHeartbeat).TotalSeconds > 5)
            {
                _lastHeartbeat = Now;
                await Quietly(client, "parties:heartbeat", Args(("deviceSecret", _identity.Secret), ("code", code)));
            }
        }
        finally
        {
            _isTicking = false;
        }
    }

    /// <summary>The player's own clock, which is fresher than the reports it sends every few seconds.</summary>
    private async Task<(double Position, bool Playing, double Rate)?> PlayerState(Guid tab) =>
        ParsePlayerState(await _player.EvaluateInPlayerAsync(tab, PlayerStateScript));

    /// <summary>Reads media.js's <c>state()</c>: <c>t</c> (seconds), <c>paused</c>, <c>rate</c>.</summary>
    internal static (double Position, bool Playing, double Rate)? ParsePlayerState(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try
        {
            using var document = JsonDocument.Parse(json);
            var state = document.RootElement;
            if (state.ValueKind != JsonValueKind.Object) return null;
            if (!state.TryGetProperty("t", out var t) || t.ValueKind != JsonValueKind.Number) return null;
            var paused = !state.TryGetProperty("paused", out var p) || p.ValueKind switch
            {
                JsonValueKind.False => false,
                JsonValueKind.Number => p.GetDouble() != 0,
                _ => true,
            };
            var rate = state.TryGetProperty("rate", out var r) && r.ValueKind == JsonValueKind.Number ? r.GetDouble() : 1;
            return (t.GetDouble(), !paused, rate);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string Number(double value) => value.ToString("R", CultureInfo.InvariantCulture);

    private async Task SendHostState(TogetherClient client, string code)
    {
        if (_partyTabId is not Guid tabId || _player.Tab(tabId) is null) return;
        if (await PlayerState(tabId) is not { } now) return;
        var at = Now;
        var expected = _lastSent is { } last
            ? last.Playing ? last.Position + (at - last.At).TotalSeconds * last.Rate : last.Position
            : -100;
        var changed = _lastSent?.Playing != now.Playing || _lastSent?.Rate != now.Rate || Math.Abs(expected - now.Position) > 1.5;
        var due = (at - (_lastSent?.At ?? DateTimeOffset.MinValue)).TotalSeconds > 4;
        if (!changed && !due) return;
        _lastSent = (now.Position, now.Playing, now.Rate, at);
        var args = Args(("deviceSecret", _identity.Secret), ("code", code), ("position", now.Position), ("playing", now.Playing),
            ("rate", now.Rate));
        if (_player.Tab(tabId)?.Url is { } url && Urls.Text(url) != Party?.PageUrl) args["pageUrl"] = Urls.Text(url);
        await Quietly(client, "parties:update", args);
    }

    /// <summary>Keeps a member's player with the host's: same page, same second, playing or paused.</summary>
    private async Task Follow(PartyState state)
    {
        if (_partyTabId is not Guid tabId || _player.Tab(tabId) is not { } tab)
        {
            if (Urls.Parse(state.PageUrl) is { } url) _partyTabId = _player.OpenTab(url, select: false);
            return;
        }
        if (Urls.Parse(state.PageUrl) is { } target && tab.Url is { } current && UrlKey.Make(target) != UrlKey.Make(current))
        {
            _player.Load(tabId, target);
            return;
        }
        if (await PlayerState(tabId) is not { } mine) return;
        if (Math.Abs(mine.Rate - state.Rate) > 0.01) _player.PlayerCommand(tabId, $"rate({Number(state.Rate)})");
        if (state.Playing != mine.Playing)
        {
            if (state.Playing)
            {
                _player.PlayerCommand(tabId, "play()");
                // A page may only start sound after a click. Ask once.
                if (!_askedToPressPlay)
                {
                    _askedToPressPlay = true;
                    _ = AskToPressPlay(tabId, state.HostName);
                }
            }
            else
            {
                _player.PlayerCommand(tabId, "pause()");
            }
        }
        // Don't chase small drifts, and give a jump time to land before judging it.
        var position = state.ExpectedPosition;
        if (Math.Abs(mine.Position - position) > 2.5 && (Now - _lastCorrection).TotalSeconds > 3)
        {
            _lastCorrection = Now;
            _player.PlayerCommand(tabId, $"seek({Number(position)})");
        }
    }

    private async Task AskToPressPlay(Guid tabId, string hostName)
    {
        await Task.Delay(TimeSpan.FromSeconds(1.5), Time);
        await Switch();
        if (Party?.Playing != true || _player.Tab(tabId) is not { } tab || tab.Media?.IsPlaying == true) return;
        _player.ShowBanner(tabId, "party", $"{hostName} is playing. Press play to join in.", 6);
    }

    private void ShowNewMessages(PartyState state)
    {
        foreach (var message in state.Messages)
        {
            if (!_seenMessages.Add(message.Id)) continue;
            // Messages from before joining are history, not news.
            if (message.PersonId == PersonId || message.At < _joinedAt) continue;
            var text = $"{message.Name}: {message.Text}";
            if (PartyTab is { } tab && _host.Route == TogetherRoute.Web) _player.ShowBanner(tab.Id, "chat", text, 5);
            else if (_host.Route != TogetherRoute.Together) _host.ShowToast(text);
        }
    }

    private void ShowNewReactions(PartyState state)
    {
        foreach (var reaction in state.Reactions)
        {
            var key = $"{reaction.Name}|{reaction.Emoji}|{Number(reaction.At)}";
            if (!_seenReactions.Add(key) || reaction.Name == MyName) continue;
            var text = $"{reaction.Name} {reaction.Emoji}";
            if (PartyTab is { } tab && _host.Route == TogetherRoute.Web) _player.ShowBanner(tab.Id, "reaction", text, 3);
            else _host.ShowToast(text);
        }
    }

    // MARK: Challenges

    /// <summary>"First to finish": everyone who joins shows with how far they've got.</summary>
    public async Task CreateChallenge(Title title)
    {
        await Switch();
        await Perform("start the challenge", async () =>
        {
            var client = await Register();
            var total = 1;
            if (title.Kind is TitleKind.Series or TitleKind.Cartoon) total = Math.Max(1, await _host.EpisodeCountAsync(title));
            var reply = await client.MutationAsync("challenges:create",
                Args(("deviceSecret", _identity.Secret), ("title", TitleCard.From(title).ToJson()), ("totalEpisodes", total)),
                CodeReply.FromJson);
            Copy(reply.Code);
            _host.ShowToast($"Challenge {ShareCode.Display(reply.Code)} started. The code is copied.");
            _reported.Remove(reply.Code);
            await RefreshChallengesAsync();
            _host.Go(TogetherRoute.Together);
        });
    }

    private async Task JoinChallenge(string code)
    {
        var client = await Register();
        var state = await client.MutationAsync("challenges:join", Args(("deviceSecret", _identity.Secret), ("code", code)), ChallengeState.FromJson);
        _details[code] = state;
        Notify(nameof(Details));
        if (!HasInLibrary(state.Title)) AddToBacklog(state.Title);
        _host.ShowToast($"You're in: first to finish {state.Title.Name}");
        await RefreshChallengesAsync();
        _host.Go(TogetherRoute.Together);
    }

    public async Task LeaveChallenge(string code)
    {
        await Switch();
        await Perform("leave the challenge", async () =>
        {
            var client = await Register();
            await client.MutationAsync("challenges:leave", Args(("deviceSecret", _identity.Secret), ("code", code)));
            Challenges = [.. Challenges.Where(c => c.Code != code)];
            if (_details.Remove(code)) Notify(nameof(Details));
        });
    }

    public void CopyChallengeCode(string code)
    {
        Copy(code);
        _host.ShowToast($"Code {ShareCode.Display(code)} copied");
    }

    internal void ChallengeTick()
    {
        if (_identity.PersonId is null) return;
        // Every few seconds while you're looking, once a minute otherwise.
        var looking = _host.Route == TogetherRoute.Together;
        if (!looking && (Now - _lastChallengeRefresh).TotalSeconds <= 60) return;
        _ = RefreshChallengesAsync();
    }

    public async Task RefreshChallengesAsync()
    {
        await Switch();
        if (_client is not { } client || _identity.PersonId is null) return;
        _lastChallengeRefresh = Now;
        IReadOnlyList<ChallengeSummary> mine;
        try
        {
            mine = await client.QueryAsync("challenges:mine", Args(("deviceSecret", _identity.Secret)), ChallengeSummary.ListFromJson);
        }
        catch (TogetherError)
        {
            return;
        }
        Challenges = mine;
        foreach (var summary in mine)
        {
            await Report(summary, client);
            ChallengeState? state;
            try
            {
                state = await client.QueryAsync("challenges:get", Args(("code", summary.Code)), ChallengeState.FromJsonOrNull);
            }
            catch (TogetherError)
            {
                continue;
            }
            if (state is null) continue;
            _details[summary.Code] = state;
            Notify(nameof(Details));
            AnnounceWinner(state);
        }
    }

    private void AnnounceWinner(ChallengeState state)
    {
        var known = _knownWinners.TryGetValue(state.Code, out var previous);
        _knownWinners[state.Code] = state.WinnerName;
        // Only news counts: a winner already there when Cineon opened isn't announced again.
        if (!known || previous is not null || state.WinnerName is not { } winner) return;
        if (state.WinnerId == _identity.PersonId) _host.ShowToast($"You finished {state.Title.Name} first!");
        else _host.ShowToast($"{winner} finished {state.Title.Name} first");
    }

    private async Task Report(ChallengeSummary summary, TogetherClient client)
    {
        var progress = LocalProgress(summary.Title, (int)summary.TotalEpisodes);
        var signature = $"{(int)(progress.Fraction * 1000)}|{progress.Watched}|{progress.Finished}";
        if (_reported.TryGetValue(summary.Code, out var sent) && sent == signature) return;
        try
        {
            await client.MutationAsync("challenges:report", Args(("deviceSecret", _identity.Secret), ("code", summary.Code),
                ("fraction", progress.Fraction), ("watchedEpisodes", progress.Watched), ("label", progress.Label),
                ("finished", progress.Finished)));
            _reported[summary.Code] = signature;
        }
        catch (TogetherError)
        {
        }
    }

    /// <summary>How far this person has got with a title, from their own library.</summary>
    public ChallengeProgress LocalProgress(TitleCard card, int total)
    {
        var title = (card.ImdbId is { } id ? _library.Titles.Values.FirstOrDefault(t => t.ImdbId == id) : null)
            ?? _library.Find(card.Name, year: card.Year);
        if (title is null) return new(0, 0, "Not started", false);
        var threshold = _host.Settings.FinishThreshold;
        var rows = _library.ProgressList(title.Id);

        if (card.TitleKind is TitleKind.Series or TitleKind.Cartoon || rows.Any(r => r.Ref.IsEpisode))
        {
            var episodes = rows.Where(r => r.Ref.IsEpisode).ToList();
            bool Done(WatchProgress p) => p.Finished || p.Fraction >= threshold;
            var done = episodes.Count(Done);
            var count = Math.Max(1, total);
            var partial = episodes.Where(p => !Done(p)).MaxBy(p => p.UpdatedAt)?.Fraction ?? 0;
            var finished = (total > 0 && done >= total) || title.Status == TitleStatus.Watched;
            var fraction = finished ? 1 : Math.Min(0.999, (done + partial) / count);
            var latest = episodes.MaxBy(p => p.UpdatedAt)?.Ref;
            var label = $"{done} of {count} episodes";
            if (finished) label = "Finished";
            else if (latest is { } at) label += $" · on S{at.Season} E{at.Episode}";
            return new(fraction, done, label, finished);
        }

        var newest = rows.MaxBy(p => p.UpdatedAt);
        var isFinished = title.Status == TitleStatus.Watched || newest?.Finished == true || (newest?.Fraction ?? 0) >= threshold;
        var part = isFinished ? 1 : newest?.Fraction ?? 0;
        var text = isFinished ? "Finished" : part > 0 ? $"{(int)(part * 100)}% in" : "Not started";
        return new(part, isFinished ? 1 : 0, text, isFinished);
    }
}

/// <summary>The Mac's repeating Timers: a PeriodicTimer on the model's context, stopped by cancelling.</summary>
internal static class Loop
{
    public static CancellationTokenSource Start(SynchronizationContext context, TimeProvider time, TimeSpan period, Action tick)
    {
        var stop = new CancellationTokenSource();
        _ = Run(context, time, period, tick, stop.Token);
        return stop;
    }

    private static async Task Run(SynchronizationContext context, TimeProvider time, TimeSpan period, Action tick, CancellationToken token)
    {
        await new ContextSwitch(context);
        using var timer = new PeriodicTimer(period, time);
        try
        {
            while (await timer.WaitForNextTickAsync(token))
            {
                if (SynchronizationContext.Current != context) await new ContextSwitch(context);
                tick();
            }
        }
        catch (OperationCanceledException)
        {
        }
    }
}
