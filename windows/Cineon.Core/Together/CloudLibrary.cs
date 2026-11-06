using System.ComponentModel;
using System.Text.Json;
using Cineon.Core.Data;

namespace Cineon.Core.Together;

// Port of Cineon/App/CloudLibrary.swift. Same keys, same payload for library:put, same merge rules
// (last write wins, with half a second of slack) and batches of 200. State changes and events happen on
// the SynchronizationContext given at construction (the TogetherModel's by default), like the Mac's
// main actor.

/// <summary>
/// Keeps ratings and lists in the cloud, so they come back after a library is cleared, imported again
/// or opened on another PC. Only the small things travel: a film's name, year and IMDb id, its rating
/// and its list. Watch history stays on this PC.
/// </summary>
public sealed class CloudLibrary : INotifyPropertyChanged
{
    /// <summary>The most items <c>library:put</c> takes in one call.</summary>
    public const int BatchSize = 200;

    private readonly LibraryStore _library;
    private readonly TogetherModel _together;
    private readonly Func<AppSettings> _settings;
    private readonly SynchronizationContext _context;
    private readonly TimeProvider _time;

    private DateTimeOffset? _lastSync;
    private bool _isSyncing;
    private string? _lastError;
    private int _cloudCount;

    private readonly HashSet<long> _pending = [];
    private CancellationTokenSource? _flush;
    private CancellationTokenSource? _timer;
    private CancellationTokenSource? _start;
    /// <summary>The profile closed. Nothing may touch it after this.</summary>
    private bool _isStopped;

    /// <param name="library">The profile's library. <see cref="Start"/> takes its <c>OnPersonalChange</c>.</param>
    /// <param name="together">For the server and this profile's secret.</param>
    /// <param name="settings">The profile's current settings (<c>CloudBackup</c> switches all of this).</param>
    public CloudLibrary(LibraryStore library, TogetherModel together, Func<AppSettings> settings,
        SynchronizationContext? context = null, TimeProvider? time = null)
    {
        _library = library;
        _together = together;
        _settings = settings;
        _context = context ?? together.Context;
        _time = time ?? together.Time;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>Raised once after anything here changed, on the context.</summary>
    public event EventHandler? Changed;

    public DateTimeOffset? LastSync { get => _lastSync; private set => Set(ref _lastSync, value); }
    public bool IsSyncing { get => _isSyncing; private set => Set(ref _isSyncing, value); }
    public string? LastError { get => _lastError; private set => Set(ref _lastError, value); }
    /// <summary>How many titles the cloud held at the last sync.</summary>
    public int CloudCount { get => _cloudCount; private set => Set(ref _cloudCount, value); }

    private bool IsOn => !_isStopped && _settings().CloudBackup && _together.IsAvailable;

    private DateTimeOffset Now => _time.GetUtcNow();

    private ContextSwitch Switch() => new(_context);

    private void Set<T>(ref T field, T value, [System.Runtime.CompilerServices.CallerMemberName] string name = "")
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void Start()
    {
        _library.OnPersonalChange = NoteChange;
        if (!IsOn) return;
        _timer?.Cancel();
        _timer = Loop.Start(_context, _time, TimeSpan.FromMinutes(10), SyncNow);
        // A moment after launch, so starting up stays quick.
        _start?.Cancel();
        _start = new CancellationTokenSource();
        _ = SyncSoon(_start.Token);
    }

    private async Task SyncSoon(CancellationToken token)
    {
        await Switch();
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(3), _time, token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        await SyncAsync();
    }

    public void Stop()
    {
        _isStopped = true;
        _timer?.Cancel();
        _timer = null;
        _flush?.Cancel();
        _start?.Cancel();
    }

    public void SyncNow() => _ = SyncAsync();

    /// <summary>Something was rated or filed. Sent a couple of seconds later, together with anything else.</summary>
    public void NoteChange(Title title)
    {
        if (!IsOn) return;
        _pending.Add(title.Id);
        _flush?.Cancel();
        _flush = new CancellationTokenSource();
        _ = FlushSoon(_flush.Token);
    }

    private async Task FlushSoon(CancellationToken token)
    {
        await Switch();
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(1.5), _time, token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        await FlushAsync();
    }

    // MARK: Keys

    /// <summary>How a film is known in the cloud: its IMDb id when there is one, otherwise its name and year.</summary>
    public static string Key(string? imdbId, string normName, int? year)
    {
        if (imdbId is not null && imdbId.StartsWith("tt", StringComparison.Ordinal)) return imdbId;
        return "n:" + SwiftText.Prefix(normName, 140) + "|" + (year is int y ? y.ToString(System.Globalization.CultureInfo.InvariantCulture) : "");
    }

    public static IReadOnlyList<string> Keys(Title title)
    {
        var keys = new List<string> { Key(null, title.NormName, title.Year) };
        if (title.ImdbId is { } imdb && imdb.StartsWith("tt", StringComparison.Ordinal)) keys.Insert(0, imdb);
        return keys;
    }

    /// <summary>One title as <c>library:put</c> takes it.</summary>
    internal static Dictionary<string, object?> Item(Title title)
    {
        var item = new Dictionary<string, object?>
        {
            ["key"] = Key(title.ImdbId, title.NormName, title.Year),
            ["name"] = SwiftText.Prefix(title.Name, 200),
            ["kind"] = title.Kind.ToRaw(),
            ["status"] = title.Status.ToRaw(),
            ["statusAt"] = Ms(title.StatusAt ?? title.UpdatedAt),
        };
        if (title.Year is int year) item["year"] = year;
        if (title.FinishedAt is { } finished) item["finishedAt"] = Ms(finished);
        if (title.RatedAt is { } rated)
        {
            // A cleared rating goes as null with its time, so other devices clear it too.
            item["rating"] = title.RatingHalves;
            item["ratedAt"] = Ms(rated);
        }
        return item;
    }

    /// <summary>Milliseconds since 1970, rounded half away from zero like Swift's <c>rounded()</c>.</summary>
    internal static double Ms(DateTimeOffset date) => Math.Round(StoredDate.ToUnix(date) * 1000, MidpointRounding.AwayFromZero);

    private static DateTimeOffset FromMs(double ms) => StoredDate.FromUnix(ms / 1000);

    // MARK: Sending

    internal async Task FlushAsync()
    {
        await Switch();
        if (_isStopped) return;
        var ids = _pending.ToList();
        _pending.Clear();
        var titles = ids.Select(id => _library.Titles.GetValueOrDefault(id)).OfType<Title>().ToList();
        if (titles.Count == 0) return;
        try
        {
            await Put(titles);
            LastSync = Now;
            LastError = null;
        }
        catch (Exception e)
        {
            _pending.UnionWith(ids);
            LastError = e.Message;
        }
    }

    private async Task Put(List<Title> titles)
    {
        var (client, secret) = await _together.AuthorizedAsync();
        for (var start = 0; start < titles.Count; start += BatchSize)
        {
            var batch = titles.Skip(start).Take(BatchSize).Select(Item).ToList();
            await client.MutationAsync("library:put", new Dictionary<string, object?> { ["deviceSecret"] = secret, ["items"] = batch },
                SavedFromJson);
        }
    }

    private static double? SavedFromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return JsonRead.OptionalNumber(e, "saved");
    }

    // MARK: Syncing

    /// <summary>Takes what the cloud knows that this PC doesn't, and sends what only this PC knows.</summary>
    public async Task SyncAsync()
    {
        await Switch();
        if (!IsOn || IsSyncing) return;
        IsSyncing = true;
        try
        {
            var (client, secret) = await _together.AuthorizedAsync();
            var remote = await client.QueryAsync("library:all",
                new Dictionary<string, object?> { ["deviceSecret"] = secret, ["t"] = Ms(Now) },
                e => JsonRead.ArrayOf(e, CloudItem.FromJson));
            CloudCount = remote.Count;
            if (_isStopped) return;
            var outgoing = Merge(remote);
            if (outgoing.Count > 0) await Put(outgoing);
            LastSync = Now;
            LastError = null;
        }
        catch (Exception e)
        {
            LastError = e.Message;
        }
        finally
        {
            IsSyncing = false;
        }
    }

    /// <summary>Applies newer cloud values here and returns the titles whose values here are newer.</summary>
    internal List<Title> Merge(IReadOnlyList<CloudItem> remote)
    {
        var byKey = new Dictionary<string, CloudItem>();
        foreach (var item in remote)
        {
            if (byKey.TryGetValue(item.Key, out var known) && known.Newest >= item.Newest) continue;
            byKey[item.Key] = item;
        }
        var outgoing = new List<Title>();
        foreach (var title in _library.Titles.Values.ToList())
        {
            // An IMDb id found after the first backup leaves the old name-only entry behind. Both count.
            var matches = Keys(title).Select(k => byKey.GetValueOrDefault(k)).OfType<CloudItem>().ToList();
            var rated = matches.Where(m => m.RatedAt is not null).MaxBy(m => m.RatedAt ?? 0);
            var filed = matches.Where(m => m.StatusAt is not null).MaxBy(m => m.StatusAt ?? 0);

            // Swift's `halves: Int??`: whether to touch the rating, and what to set it to.
            var restoreRating = false;
            int? halves = null;
            DateTimeOffset? ratedAt = null;
            var localRated = title.RatedAt is { } r ? JsonArgs.Milliseconds(r) : 0;
            if (rated is { RatedAt: double remoteRated } && remoteRated > localRated + 500)
            {
                restoreRating = true;
                halves = rated.Rating is double rating ? (int)rating : null;
                ratedAt = FromMs(remoteRated);
            }

            TitleStatus? status = null;
            DateTimeOffset? statusAt = null;
            if (filed is { StatusAt: double at } && TitleStatus.FromRaw(filed.Status) is { } remoteStatus && remoteStatus != title.Status)
            {
                // A title imported without a date only takes the cloud's list when it isn't in one here.
                double? localAt = title.StatusAt is { } s ? JsonArgs.Milliseconds(s) : null;
                if (localAt is double local && at > local + 500) status = remoteStatus;
                else if (localAt is null && title.Status == TitleStatus.None) status = remoteStatus;
                statusAt = status is not null ? FromMs(at) : null;
            }

            if (restoreRating || status is not null)
            {
                _library.Restore(title.Id, restoreRating, halves, ratedAt, status, statusAt,
                    filed?.FinishedAt is double finished ? FromMs(finished) : null);
            }

            var cloudRatedAt = rated?.RatedAt ?? 0;
            var cloudStatusAt = filed?.StatusAt ?? 0;
            var localStatusAt = JsonArgs.Milliseconds(title.StatusAt ?? title.UpdatedAt);
            var ratingIsNewer = title.RatedAt is not null && !restoreRating && localRated > cloudRatedAt + 500;
            var statusIsNewer = status is null && title.Status != TitleStatus.None &&
                (filed is null || (title.StatusAt is not null && localStatusAt > cloudStatusAt + 500));
            if ((ratingIsNewer || statusIsNewer) && _library.Titles.TryGetValue(title.Id, out var current)) outgoing.Add(current);
        }
        return outgoing;
    }
}

/// <summary>One title as the cloud keeps it (times in milliseconds since 1970).</summary>
public sealed record CloudItem(
    string Key, string Name, double? Rating = null, double? RatedAt = null, string? Status = null, double? StatusAt = null, double? FinishedAt = null)
{
    public double Newest => Math.Max(RatedAt ?? 0, StatusAt ?? 0);

    public static CloudItem FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new CloudItem(JsonRead.String(e, "key"), JsonRead.String(e, "name"), JsonRead.OptionalNumber(e, "rating"),
            JsonRead.OptionalNumber(e, "ratedAt"), JsonRead.OptionalString(e, "status"), JsonRead.OptionalNumber(e, "statusAt"),
            JsonRead.OptionalNumber(e, "finishedAt"));
    }
}
