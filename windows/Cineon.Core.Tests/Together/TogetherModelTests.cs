using System.Text.Json;
using Cineon.Core.Data;
using Cineon.Core.Together;

namespace Cineon.Core.Tests.Together;

public sealed class TogetherModelTests : IDisposable
{
    private readonly TogetherRig _rig = new();

    public void Dispose() => _rig.Dispose();

    private FakeConvex Server => _rig.Server;

    private static string Arg(FakeConvex.Call call, string name) => call.Args.GetProperty(name).ToString();

    private static Title AddTitle(TestPerson person, string name, int? year, TitleKind kind, TitleStatus status, string? imdb = null) =>
        person.Ui(() => person.Library.AddTitle(name, year, kind, status, imdb)!).Result;

    // MARK: Registration

    [Fact]
    public async Task RegistersOnceWithTheProfileNameAndPet()
    {
        var ann = _rig.Person("Ann");
        Assert.True(ann.Model.IsAvailable);
        Assert.Null(ann.Model.PersonId);

        await ann.Model.Enter("ABC-DEF");
        var register = Assert.Single(Server.CallsTo("people:register"));
        Assert.Equal(ann.Model.RecoveryCode, Arg(register, "deviceSecret"));
        Assert.Equal("Ann", Arg(register, "name"));
        Assert.Equal("p1-Ab3_x9", Arg(register, "pet"));
        Assert.Equal(["Couldn't open that code: No party, list or challenge has that code"], ann.Host.Toasts);
        Assert.False(ann.Model.IsWorking);

        var personId = ann.Model.PersonId;
        Assert.NotNull(personId);
        Assert.Equal(Server.People.Single().Id, personId);
        using (var file = JsonDocument.Parse(File.ReadAllText(ann.IdentityFile)))
        {
            Assert.Equal(personId, file.RootElement.GetProperty("personId").GetString());
            Assert.Equal("p1-Ab3_x9", file.RootElement.GetProperty("pet").GetString());
        }

        // Known already: no second registration.
        await ann.Model.Enter("ABC-DEF");
        Assert.Single(Server.CallsTo("people:register"));

        // A new pet goes to friends' screens.
        ann.Host.PetCode = "p2-Zz";
        await ann.Model.RefreshIdentity();
        Assert.Equal("p2-Zz", Arg(Server.CallsTo("people:register")[^1], "pet"));
        Assert.Equal("p2-Zz", Server.People.Single().Pet);

        // Not sharing the pet sends an empty code, which takes it off.
        ann.Host.Settings = new AppSettings { SharePet = false };
        await ann.Model.RefreshIdentity();
        Assert.Equal("", Arg(Server.CallsTo("people:register")[^1], "pet"));
        Assert.Null(Server.People.Single().Pet);
        Assert.Equal(personId, ann.Model.PersonId);
        Assert.Equal(3, Server.CallsTo("people:register").Count);
    }

    [Fact]
    public async Task RefreshingAnIdentityNobodyHasSeenSendsNothing()
    {
        var ann = _rig.Person("Ann");
        await ann.Model.RefreshIdentity();
        Assert.Empty(Server.Calls);
    }

    [Fact]
    public async Task CodesThatAreNotSixCharactersNeverReachTheServer()
    {
        var ann = _rig.Person("Ann");
        await ann.Model.Enter("K7Q-2M");
        await ann.Model.Enter("");
        Assert.Equal(["Codes have six letters and digits, like K7Q-2MX", "Codes have six letters and digits, like K7Q-2MX"], ann.Host.Toasts);
        Assert.Empty(Server.Calls);
    }

    [Fact]
    public async Task WithoutAServerTogetherSaysSo()
    {
        var ann = _rig.Person("Ann", withServer: false);
        Assert.False(ann.Model.IsAvailable);
        await ann.Ui(ann.Model.Start);
        await ann.Model.Enter("K7Q2MX");
        Assert.Equal(["Couldn't open that code: Together isn't set up in this build"], ann.Host.Toasts);
        await Assert.ThrowsAsync<TogetherError>(() => ann.Model.AuthorizedAsync());
    }

    [Fact]
    public async Task ServerErrorsBecomeToasts()
    {
        var ann = _rig.Person("Ann");
        ann.Connection.Offline = true;
        await ann.Model.Enter("K7Q2MX");
        Assert.Equal(["Couldn't open that code: The network connection was lost."], ann.Host.Toasts);
        Assert.False(ann.Model.IsWorking);
    }

    [Fact]
    public async Task StartingOverWithAPartyCodeForgetsTheParty()
    {
        var ann = _rig.Person("Ann");
        var identity = TogetherIdentity.Load(ann.IdentityFile, "Ann");
        identity.PartyCode = "PARTY2";
        identity.Save(ann.IdentityFile);
        ann.Restart();
        Assert.Null(TogetherIdentity.Load(ann.IdentityFile, "Ann").PartyCode);
        Assert.Null(ann.Model.Party);
    }

    // MARK: Shared lists

    [Fact]
    public async Task AListSharedByOneOpensForAnother()
    {
        var ann = _rig.Person("Ann");
        var bob = _rig.Person("Bob");

        await ann.Model.ShareWatched();
        Assert.Equal(["Nothing in Watched to share yet"], ann.Host.Toasts);
        Assert.Empty(Server.Calls);

        var heat = AddTitle(ann, "Heat", 1995, TitleKind.Film, TitleStatus.Watched, "tt0113277");
        await ann.Ui(() => ann.Library.SetRating(heat.Id, 17));
        AddTitle(ann, "Arrival", 2016, TitleKind.Film, TitleStatus.Watched);
        AddTitle(ann, "Dune", 2021, TitleKind.Film, TitleStatus.Backlog);

        Server.NextCodes.Enqueue("K7QM2X");
        await ann.Model.ShareWatched();
        Assert.Equal("K7QM2X", ann.Model.LastShareCode);
        Assert.Equal("K7Q-M2X", ann.Host.Clipboard);
        Assert.Equal("Code K7Q-M2X copied. Send it to a friend.", ann.Host.Toasts[^1]);
        var create = Assert.Single(Server.CallsTo("shares:create"));
        Assert.Equal("Ann's watched films", Arg(create, "label"));
        Assert.Equal(2, create.Args.GetProperty("titles").GetArrayLength());

        await bob.Model.Enter("k7q m2x");
        Assert.Empty(bob.Host.Toasts);
        var share = Assert.Single(bob.Model.OpenedShares);
        Assert.Equal("K7QM2X", share.Code);
        Assert.Equal("Ann", share.OwnerName);
        Assert.Equal("Ann's watched films", share.Label);
        Assert.Equal(["Arrival", "Heat"], share.Titles.Select(t => t.Name).Order());
        var heatCard = share.Titles.Single(t => t.Name == "Heat");
        Assert.Equal(17, heatCard.Rating);
        Assert.Equal("watched", heatCard.Status);
        Assert.Equal([TogetherRoute.Together], bob.Host.Went);
        Assert.Equal(["K7QM2X"], TogetherIdentity.Load(bob.IdentityFile, "Bob").OpenedShares);

        // One title on its own.
        Server.NextCodes.Enqueue("NEW456");
        await ann.Model.Share(heat);
        Assert.Equal("Heat", Arg(Server.CallsTo("shares:create")[^1], "label"));
        await bob.Model.Enter("NEW-456");
        Assert.Equal(["NEW456", "K7QM2X"], bob.Model.OpenedShares.Select(s => s.Code));
        Assert.Equal(["NEW456", "K7QM2X"], TogetherIdentity.Load(bob.IdentityFile, "Bob").OpenedShares);

        // Opened again after a restart, without going to the Together page.
        bob.Host.Went.Clear();
        bob.Restart();
        await bob.Ui(bob.Model.Start);
        await _rig.WaitUntil(() => bob.Model.OpenedShares.Count == 2, "shares to load again");
        Assert.Empty(bob.Host.Went);

        await bob.Ui(() => bob.Model.ForgetShare("NEW456"));
        Assert.Equal(["K7QM2X"], bob.Model.OpenedShares.Select(s => s.Code));
        Assert.Equal(["K7QM2X"], TogetherIdentity.Load(bob.IdentityFile, "Bob").OpenedShares);
    }

    [Fact]
    public async Task AFriendsFilmGoesIntoTheBacklogOnce()
    {
        var bob = _rig.Person("Bob");
        var heat = new TitleCard("Heat", 1995, "film", "tt0113277", "https://img.example/heat.jpg");
        Assert.False(await bob.Ui(() => bob.Model.HasInLibrary(heat)));

        await bob.Ui(() => bob.Model.AddToBacklog(heat));
        var added = bob.Library.Titles.Values.Single();
        Assert.Equal(("Heat", (int?)1995, TitleKind.Film, TitleStatus.Backlog, "tt0113277"), (added.Name, added.Year, added.Kind, added.Status, added.ImdbId));
        Assert.Equal("https://img.example/heat.jpg", added.PosterUrl?.OriginalString);
        Assert.Equal((added.Id, heat), Assert.Single(bob.Host.Applied));
        Assert.Equal("Added Heat to backlog", bob.Host.Toasts[^1]);
        Assert.True(await bob.Ui(() => bob.Model.HasInLibrary(heat)));

        await bob.Ui(() => bob.Model.AddToBacklog(heat with { ImdbId = null }));
        Assert.Equal("Heat is already in your backlog", bob.Host.Toasts[^1]);
        Assert.Single(bob.Library.Titles);

        // Without an IMDb id it's looked up instead.
        await bob.Ui(() => bob.Model.AddToBacklog(new TitleCard("Arrival", 2016, "film")));
        Assert.Equal(bob.Library.Titles.Values.Single(t => t.Name == "Arrival").Id, Assert.Single(bob.Host.Enriched));

        // A title known but in no list is filed into the backlog.
        var dune = AddTitle(bob, "Dune", 2021, TitleKind.Film, TitleStatus.None);
        Assert.False(await bob.Ui(() => bob.Model.HasInLibrary(new TitleCard("Dune", 2021, "film"))));
        await bob.Ui(() => bob.Model.AddToBacklog(new TitleCard("Dune", 2021, "film")));
        Assert.Equal(TitleStatus.Backlog, bob.Library.Titles[dune.Id].Status);
        Assert.Equal("Dune is already in your backlog", bob.Host.Toasts[^1]);
    }

    // MARK: Watch party

    private async Task<(TestPerson Host, TestPerson Guest, FakePlayer.FakeTab Film)> StartedParty(string code = "PARTY2")
    {
        var ann = _rig.Person("Ann");
        var bob = _rig.Person("Bob");
        var film = ann.Player.Add("https://films.example/watch/heat?utm_source=feed");
        film.Parsed = new TitleCard("Heat", 1995, "film");
        film.Position = 600;
        film.Playing = true;
        Server.NextCodes.Enqueue(code);
        await ann.Model.StartParty();
        Assert.Equal(code, ann.Model.Party?.Code);
        await bob.Model.Enter(code);
        Assert.NotNull(bob.Model.Party);
        return (ann, bob, film);
    }

    [Fact]
    public async Task APartyNeedsAFilmPlaying()
    {
        var ann = _rig.Person("Ann");
        await ann.Model.StartParty();
        var trailer = ann.Player.Add("https://films.example/trailer");
        trailer.Duration = 120;
        await ann.Model.StartParty();
        trailer.HasVideo = false;
        await ann.Model.StartParty();
        Assert.Equal(Enumerable.Repeat("Start the film first, then invite people to it", 3), ann.Host.Toasts);
        Assert.Empty(Server.Calls);
    }

    [Fact]
    public async Task GuestsFollowTheHost()
    {
        var (ann, bob, film) = await StartedParty();

        // The host's side.
        Assert.True(ann.Model.IsHost);
        Assert.Equal("PAR-TY2", ann.Host.Clipboard);
        Assert.Equal("Party PAR-TY2 started. The code is copied.", ann.Host.Toasts[^1]);
        var create = Assert.Single(Server.CallsTo("parties:create"));
        Assert.Equal("https://films.example/watch/heat?utm_source=feed", Arg(create, "pageUrl"));
        Assert.Equal(600, create.Args.GetProperty("position").GetDouble());
        Assert.True(create.Args.GetProperty("playing").GetBoolean());
        Assert.Equal("""{"name":"Heat","kind":"film","year":1995}""", create.Args.GetProperty("title").GetRawText());
        Assert.Equal("PARTY2", TogetherIdentity.Load(ann.IdentityFile, "Ann").PartyCode);
        // parties:get carries a fresh `t` so the server doesn't answer from its cache.
        Assert.True(Server.CallsTo("parties:get")[^1].Args.TryGetProperty("t", out _));

        // The guest's side: a tab on the host's page, and the web page shown.
        Assert.False(bob.Model.IsHost);
        Assert.Equal("Joined Ann's party", bob.Host.Toasts[^1]);
        Assert.Equal((new Uri("https://films.example/watch/heat?utm_source=feed"), true), Assert.Single(bob.Player.Opened));
        Assert.Equal([TogetherRoute.Web], bob.Host.Went);
        Assert.Equal(["Ann", "Bob"], bob.Model.Party!.Members.Select(m => m.Name));
        Assert.Equal("p1-Ab3_x9", bob.Model.Party.HostPet);
        Assert.Equal("PARTY2", TogetherIdentity.Load(bob.IdentityFile, "Bob").PartyCode);
        var guestTab = bob.Player.SelectedFake!;
        guestTab.BlocksAutoplay = true;

        // A second on: the guest jumps to the host's place and is asked to press play, once.
        await _rig.Advance(1);
        Assert.Contains(bob.Player.Commands, c => c.Command == "play()");
        Assert.Contains(bob.Player.Commands, c => c.Command == "seek(601)");
        Assert.Equal(601, guestTab.Position, 3);
        Assert.Empty(bob.Player.Banners);
        await _rig.Advance(1);
        await _rig.Advance(1);
        var banner = Assert.Single(bob.Player.Banners);
        Assert.Equal((guestTab.Id, "party", "Ann is playing. Press play to join in.", 6.0), banner);

        // They press play; from then on small drifts are left alone.
        guestTab.BlocksAutoplay = false;
        guestTab.Playing = true;
        var commands = bob.Player.Commands.Count;
        await _rig.Advance(1);
        Assert.Equal(commands, bob.Player.Commands.Count);

        // The host pauses: the update goes out straight away and the guest pauses too.
        film.Playing = false;
        await _rig.AdvanceUntil(() => !guestTab.Playing, "the guest to pause");
        var update = Server.CallsTo("parties:update")[^1];
        Assert.False(update.Args.GetProperty("playing").GetBoolean());
        Assert.False(update.Args.TryGetProperty("pageUrl", out _));

        // The host jumps ahead: the guest lands there too (within a correction's grace period).
        film.Position = 1200;
        await _rig.AdvanceUntil(() => Math.Abs(guestTab.Position - 1200) < 0.01, "the guest to jump");
        Assert.Contains(bob.Player.Commands, c => c.Command == "seek(1200)");

        // The host speeds up.
        film.Rate = 1.5;
        await _rig.AdvanceUntil(() => guestTab.Rate == 1.5, "the guest's speed");
        Assert.Contains(bob.Player.Commands, c => c.Command == "rate(1.5)");

        // A tracking parameter isn't a new page; a new episode is.
        film.Url = new Uri("https://films.example/watch/heat?utm_source=other");
        await _rig.Advance(5);
        Assert.Empty(bob.Player.Loads);
        film.Url = new Uri("https://films.example/watch/heat-2");
        await _rig.AdvanceUntil(() => bob.Player.Loads.Count == 1, "the guest to load the new page");
        Assert.Equal(new Uri("https://films.example/watch/heat-2"), bob.Player.Loads[0].Url);
        Assert.Equal("https://films.example/watch/heat-2", Arg(Server.CallsTo("parties:update")[^1], "pageUrl"));

        Assert.DoesNotContain(ann.Host.Toasts, t => t.StartsWith("Couldn't", StringComparison.Ordinal));
        Assert.DoesNotContain(bob.Host.Toasts, t => t.StartsWith("Couldn't", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AGuestWhoClosedThePartyTabGetsANewOne()
    {
        var (_, bob, _) = await StartedParty();
        bob.Player.Tabs.Clear();
        await _rig.Advance(1);
        var reopened = bob.Player.Opened[^1];
        Assert.Equal((new Uri("https://films.example/watch/heat?utm_source=feed"), false), reopened);
    }

    [Fact]
    public async Task HeartbeatsKeepGuestsOnTheList()
    {
        var (ann, bob, _) = await StartedParty();
        var bobId = bob.Model.PersonId;
        await _rig.Advance(1);
        Assert.Single(Server.CallsTo("parties:heartbeat"), c => Arg(c, "deviceSecret") == bob.Model.RecoveryCode);

        // Not every second: once more than five have gone by.
        for (var i = 0; i < 5; i++) await _rig.Advance(1);
        Assert.Single(Server.CallsTo("parties:heartbeat"), c => Arg(c, "deviceSecret") == bob.Model.RecoveryCode);
        await _rig.Advance(1);
        Assert.Equal(2, Server.CallsTo("parties:heartbeat").Count(c => Arg(c, "deviceSecret") == bob.Model.RecoveryCode));

        // A dropped connection is a missed second, not the end of the party; after 30 s the host
        // stops seeing the guest.
        bob.Connection.Offline = true;
        await _rig.AdvanceUntil(() => ann.Model.Party!.Members.All(m => m.PersonId != bobId), "the guest to drop off", steps: 40);
        Assert.NotNull(bob.Model.Party);
        Assert.Equal(["Joined Ann's party"], bob.Host.Toasts);

        // Back online: a heartbeat later they're there again.
        bob.Connection.Offline = false;
        await _rig.AdvanceUntil(() => ann.Model.Party!.Members.Any(m => m.PersonId == bobId), "the guest to come back", steps: 10);
    }

    [Fact]
    public async Task HeartbeatErrorsAreQuiet()
    {
        var (_, bob, _) = await StartedParty();
        // Left from somewhere else: the server answers NOT_MEMBER to the next heartbeat.
        await bob.Client!.MutationAsync("parties:leave",
            new Dictionary<string, object?> { ["deviceSecret"] = bob.Model.RecoveryCode, ["code"] = "PARTY2" }, TestContext.Current.CancellationToken);
        await _rig.Advance(1);
        await _rig.Advance(6);
        Assert.NotNull(bob.Model.Party);
        Assert.Equal(["Joined Ann's party"], bob.Host.Toasts);
    }

    [Fact]
    public async Task ChatAndReactionsShowOnceAndNeverYourOwn()
    {
        var ann = _rig.Person("Ann");
        var bob = _rig.Person("Bob");
        var film = ann.Player.Add("https://films.example/watch/heat");
        film.Position = 10;
        film.Playing = true;
        Server.NextCodes.Enqueue("PARTY2");
        await ann.Model.StartParty();
        await ann.Model.Say("Before you came");
        await _rig.Advance(1);
        await bob.Model.Enter("PARTY2");
        var guestTab = bob.Player.SelectedFake!;

        await ann.Model.Say("  hi there  ");
        Assert.Equal("hi there", Server.CallsTo("parties:say")[^1].Args.GetProperty("text").GetString());
        await _rig.AdvanceUntil(() => bob.Player.Banners.Any(b => b.Id == "chat"), "the chat banner");
        Assert.Equal((guestTab.Id, "chat", "Ann: hi there", 5.0), bob.Player.Banners.Single(b => b.Id == "chat"));
        Assert.Equal("Before you came", bob.Model.Party!.Messages[0].Text);

        // On the Together page chat shows there, not as a toast.
        bob.Host.Route = TogetherRoute.Together;
        await ann.Model.Say("second");
        await _rig.AdvanceUntil(() => bob.Model.Party!.Messages.Count == 3, "the second message");
        Assert.Single(bob.Player.Banners, b => b.Id == "chat");
        Assert.DoesNotContain(bob.Host.Toasts, t => t.Contains("second", StringComparison.Ordinal));

        // The host is elsewhere: a toast.
        await bob.Model.Say("hey");
        await bob.Model.React("🎉");
        await _rig.AdvanceUntil(() => ann.Host.Toasts.Contains("Bob 🎉"), "the reaction toast", steps: 5);
        Assert.Contains("Bob: hey", ann.Host.Toasts);
        // Never your own.
        Assert.DoesNotContain(ann.Host.Toasts, t => t.StartsWith("Ann", StringComparison.Ordinal));
        await _rig.Advance(3);
        Assert.DoesNotContain(bob.Host.Toasts, t => t.StartsWith("Bob", StringComparison.Ordinal));
        Assert.DoesNotContain(bob.Player.Banners, b => b.Text.StartsWith("Bob", StringComparison.Ordinal));
        // And each once.
        await _rig.Advance(5);
        Assert.Single(ann.Host.Toasts, t => t == "Bob 🎉");
        Assert.Single(ann.Host.Toasts, t => t == "Bob: hey");
    }

    [Fact]
    public async Task ChatIsRateLimitedAsTheServerSays()
    {
        var (ann, _, _) = await StartedParty();
        for (var i = 1; i <= 5; i++) await ann.Model.Say($"line {i}");
        await ann.Model.Say("one too many");
        Assert.Equal("Couldn't send that: Slow down. At most 5 messages every 5 seconds.", ann.Host.Toasts[^1]);
        Assert.Equal(6, Server.CallsTo("parties:say").Count);

        // Blank lines are never sent; long ones are cut at 280 characters.
        await ann.Model.Say("   \n ");
        Assert.Equal(6, Server.CallsTo("parties:say").Count);

        await _rig.Advance(5.1);
        await ann.Model.Say(new string('x', 300));
        Assert.Equal(280, Server.CallsTo("parties:say")[^1].Args.GetProperty("text").GetString()!.Length);
        Assert.Equal("Couldn't send that: Slow down. At most 5 messages every 5 seconds.", ann.Host.Toasts[^1]);
        await _rig.AdvanceUntil(() => ann.Model.Party!.Messages.Count == 6, "the host to see six messages", steps: 5);
    }

    [Fact]
    public async Task WhenTheHostLeavesThePartyIsOver()
    {
        var (ann, bob, _) = await StartedParty();
        await _rig.Advance(1);

        await ann.Model.LeaveParty();
        Assert.Null(ann.Model.Party);
        Assert.False(ann.Model.IsHost);
        Assert.Null(TogetherIdentity.Load(ann.IdentityFile, "Ann").PartyCode);
        Assert.True(Server.Parties.Single().Ended);

        await _rig.AdvanceUntil(() => bob.Model.Party is null, "the guest to hear");
        Assert.Equal("The party is over", bob.Host.Toasts[^1]);
        Assert.Null(TogetherIdentity.Load(bob.IdentityFile, "Bob").PartyCode);
        Assert.Equal(2, Server.CallsTo("parties:leave").Count);

        // No more polling once it's over.
        var polls = Server.CallsTo("parties:get").Count;
        await _rig.Advance(5);
        Assert.Equal(polls, Server.CallsTo("parties:get").Count);
    }

    [Fact]
    public async Task AGuestLeavingKeepsThePartyGoing()
    {
        var (ann, bob, _) = await StartedParty();
        await bob.Model.LeaveParty();
        Assert.Null(bob.Model.Party);
        Assert.False(Server.Parties.Single().Ended);
        await _rig.AdvanceUntil(() => ann.Model.Party!.Members.Count == 1, "the host to see one member");
        Assert.NotNull(ann.Model.Party);
    }

    [Fact]
    public async Task StoppingTheModelLeavesTheParty()
    {
        var (ann, _, _) = await StartedParty();
        await ann.Ui(ann.Model.Stop);
        await _rig.WaitUntil(() => Server.Parties.Single().Ended, "the party to end");
        Assert.Null(ann.Model.Party);
    }

    [Fact]
    public async Task JoiningAnEndedPartySaysSo()
    {
        var (ann, _, _) = await StartedParty();
        await ann.Model.LeaveParty();
        var carol = _rig.Person("Carol");
        await carol.Model.Enter("PARTY2");
        Assert.Equal(["Couldn't open that code: This watch party has ended."], carol.Host.Toasts);
        Assert.Null(carol.Model.Party);
    }

    [Fact]
    public void PlayerStateIsReadFromMediaJs()
    {
        Assert.Equal((12.5, true, 1.25), TogetherModel.ParsePlayerState("""{"type":"tick","t":12.5,"paused":false,"rate":1.25}"""));
        Assert.Equal((3.0, false, 1.0), TogetherModel.ParsePlayerState("""{"t":3}"""));
        Assert.Null(TogetherModel.ParsePlayerState("null"));
        Assert.Null(TogetherModel.ParsePlayerState(null));
        Assert.Null(TogetherModel.ParsePlayerState("""{"paused":true}"""));
        Assert.Null(TogetherModel.ParsePlayerState("garbage"));
    }

    // MARK: Challenges

    [Fact]
    public async Task FirstToFinish()
    {
        var ann = _rig.Person("Ann");
        var bob = _rig.Person("Bob");
        var severance = AddTitle(ann, "Severance", 2022, TitleKind.Series, TitleStatus.Watching, "tt11280740");
        ann.Host.EpisodeCount = 3;
        ann.Host.Route = TogetherRoute.Together;

        Server.NextCodes.Enqueue("RACE22");
        await ann.Model.CreateChallenge(severance);
        Assert.Equal("RAC-E22", ann.Host.Clipboard);
        Assert.Equal("Challenge RAC-E22 started. The code is copied.", ann.Host.Toasts[^1]);
        Assert.Equal(3, Server.CallsTo("challenges:create")[0].Args.GetProperty("totalEpisodes").GetDouble());
        Assert.Equal("RACE22", Assert.Single(ann.Model.Challenges).Code);
        Assert.True(ann.Model.Details.ContainsKey("RACE22"));
        var annReport = Assert.Single(Server.CallsTo("challenges:report"));
        Assert.Equal("0 of 3 episodes", Arg(annReport, "label"));

        // Bob joins: the series lands in his backlog.
        await bob.Model.Enter("race-22");
        Assert.Equal("You're in: first to finish Severance", bob.Host.Toasts[^1]);
        Assert.Contains("Added Severance to backlog", bob.Host.Toasts);
        var bobSeverance = bob.Library.Titles.Values.Single();
        Assert.Equal((TitleStatus.Backlog, "tt11280740", TitleKind.Series), (bobSeverance.Status, bobSeverance.ImdbId, bobSeverance.Kind));
        Assert.Equal([TogetherRoute.Together], bob.Host.Went);
        Assert.Equal(["Ann", "Bob"], bob.Model.Details["RACE22"].Members.Select(m => m.Name).Order());

        // One episode done and half of the next.
        await bob.Ui(() =>
        {
            var now = _rig.Clock.GetUtcNow();
            bob.Library.SaveProgress(Progress(bobSeverance.Id, new EpisodeRef(1, 1), 3000, 3000, true, now.AddMinutes(-60)));
            bob.Library.SaveProgress(Progress(bobSeverance.Id, new EpisodeRef(1, 2), 1500, 3000, false, now));
        });
        var progress = await bob.Ui(() => bob.Model.LocalProgress(new TitleCard("Severance", 2022, "series", "tt11280740"), 3));
        Assert.Equal(new ChallengeProgress(0.5, 1, "1 of 3 episodes · on S1 E2", false), progress);
        await bob.Model.RefreshChallengesAsync();
        var bobReport = Server.CallsTo("challenges:report").Last(c => Arg(c, "deviceSecret") == bob.Model.RecoveryCode);
        Assert.Equal(0.5, bobReport.Args.GetProperty("fraction").GetDouble());
        Assert.Equal(1, bobReport.Args.GetProperty("watchedEpisodes").GetDouble());
        Assert.Equal("1 of 3 episodes · on S1 E2", Arg(bobReport, "label"));
        Assert.False(bobReport.Args.GetProperty("finished").GetBoolean());

        // Nothing new, nothing sent.
        var reports = Server.CallsTo("challenges:report").Count;
        await bob.Model.RefreshChallengesAsync();
        Assert.Equal(reports, Server.CallsTo("challenges:report").Count);

        await ann.Model.RefreshChallengesAsync();
        Assert.Equal("Bob", ann.Model.Challenges.Single().LeaderName);
        Assert.Equal(["Bob", "Ann"], ann.Model.Details["RACE22"].Members.Select(m => m.Name));
        Assert.Null(ann.Model.Details["RACE22"].WinnerName);

        // Bob marks it watched: he wins, and both hear about it once.
        await bob.Ui(() => bob.Library.SetStatus(bobSeverance.Id, TitleStatus.Watched));
        await bob.Model.RefreshChallengesAsync();
        Assert.Equal("You finished Severance first!", bob.Host.Toasts[^1]);
        await ann.Model.RefreshChallengesAsync();
        Assert.Equal("Bob finished Severance first", ann.Host.Toasts[^1]);
        Assert.Equal("Bob", ann.Model.Details["RACE22"].WinnerName);
        Assert.Equal(1, ann.Model.Details["RACE22"].Members[0].Fraction);
        var toasts = ann.Host.Toasts.Count;
        await ann.Model.RefreshChallengesAsync();
        Assert.Equal(toasts, ann.Host.Toasts.Count);

        // A winner already there when Cineon opens isn't news.
        ann.Restart();
        await ann.Model.RefreshChallengesAsync();
        Assert.Equal(toasts, ann.Host.Toasts.Count);

        await ann.Model.LeaveChallenge("RACE22");
        Assert.Empty(ann.Model.Challenges);
        Assert.False(ann.Model.Details.ContainsKey("RACE22"));
        await bob.Model.RefreshChallengesAsync();
        Assert.Equal(1, bob.Model.Challenges.Single().MemberCount);
    }

    [Fact]
    public async Task ChallengesRefreshOftenOnlyWhileLookedAt()
    {
        var ann = _rig.Person("Ann");
        var film = AddTitle(ann, "Heat", 1995, TitleKind.Film, TitleStatus.Backlog);
        await ann.Model.CreateChallenge(film);
        Assert.Equal(1, Server.CallsTo("challenges:create")[0].Args.GetProperty("totalEpisodes").GetDouble());

        ann.Restart();
        await ann.Ui(ann.Model.Start);
        await _rig.WaitUntil(() => ann.Model.Challenges.Count == 1, "challenges at start");
        int Mine() => Server.CallsTo("challenges:mine").Count;
        var before = Mine();

        ann.Host.Route = TogetherRoute.Other;
        await _rig.Advance(5);
        Assert.Equal(before, Mine());

        ann.Host.Route = TogetherRoute.Together;
        await _rig.Advance(5);
        await _rig.WaitUntil(() => Mine() == before + 1, "a refresh while looking");

        // Elsewhere, once a minute.
        ann.Host.Route = TogetherRoute.Other;
        await _rig.Advance(60);
        Assert.Equal(before + 1, Mine());
        await _rig.Advance(5);
        await _rig.WaitUntil(() => Mine() == before + 2, "the minutely refresh");
    }

    [Fact]
    public async Task ProgressOnAFilm()
    {
        var ann = _rig.Person("Ann");
        var card = new TitleCard("Heat", 1995, "film", "tt0113277");
        Assert.Equal(new ChallengeProgress(0, 0, "Not started", false), await ann.Ui(() => ann.Model.LocalProgress(card, 1)));

        var heat = AddTitle(ann, "Heat", 1995, TitleKind.Film, TitleStatus.Watching, "tt0113277");
        Assert.Equal(new ChallengeProgress(0, 0, "Not started", false), await ann.Ui(() => ann.Model.LocalProgress(card, 1)));

        await ann.Ui(() => ann.Library.SaveProgress(Progress(heat.Id, EpisodeRef.None, 2400, 6000, false, _rig.Clock.GetUtcNow())));
        Assert.Equal(new ChallengeProgress(0.4, 0, "40% in", false), await ann.Ui(() => ann.Model.LocalProgress(card, 1)));

        // Past the finish threshold (92% by default) counts as finished.
        await ann.Ui(() => ann.Library.SaveProgress(Progress(heat.Id, EpisodeRef.None, 5600, 6000, false, _rig.Clock.GetUtcNow())));
        Assert.Equal(new ChallengeProgress(1, 1, "Finished", true), await ann.Ui(() => ann.Model.LocalProgress(card, 1)));

        ann.Host.Settings = new AppSettings { FinishThreshold = 0.99 };
        var lower = await ann.Ui(() => ann.Model.LocalProgress(card, 1));
        Assert.Equal("93% in", lower.Label);

        // Found by name and year when the card has no IMDb id.
        await ann.Ui(() => ann.Library.SetStatus(heat.Id, TitleStatus.Watched));
        Assert.Equal(new ChallengeProgress(1, 1, "Finished", true), await ann.Ui(() => ann.Model.LocalProgress(new TitleCard("heat", 1995), 1)));
    }

    [Fact]
    public async Task ProgressOnASeriesWithoutAKnownEpisodeCount()
    {
        var ann = _rig.Person("Ann");
        var show = AddTitle(ann, "Dark", 2017, TitleKind.Series, TitleStatus.Watching);
        var card = TitleCard.From(show);
        Assert.Equal(new ChallengeProgress(0, 0, "0 of 1 episodes", false), await ann.Ui(() => ann.Model.LocalProgress(card, 0)));
        await ann.Ui(() => ann.Library.SaveProgress(Progress(show.Id, new EpisodeRef(2, 5), 3000, 3000, true, _rig.Clock.GetUtcNow())));
        // A total of 0 never counts as finished by episodes; 1 done of "1" caps at 99.9%.
        Assert.Equal(new ChallengeProgress(0.999, 1, "1 of 1 episodes · on S2 E5", false), await ann.Ui(() => ann.Model.LocalProgress(card, 0)));
        Assert.Equal(new ChallengeProgress(1, 1, "Finished", true), await ann.Ui(() => ann.Model.LocalProgress(card, 1)));
    }

    private static WatchProgress Progress(long titleId, EpisodeRef episode, double position, double duration, bool finished, DateTimeOffset at) => new()
    {
        TitleId = titleId, Ref = episode, UrlKey = $"films.example/{titleId}/{episode.Season}/{episode.Episode}",
        Url = new Uri($"https://films.example/{titleId}/{episode.Season}/{episode.Episode}"), Host = "films.example",
        Position = position, Duration = duration, Finished = finished, UpdatedAt = at,
    };

    // MARK: Recovery code

    [Fact]
    public async Task ARecoveryCodeTakesOverAnIdentity()
    {
        var ann = _rig.Person("Ann");
        var film = AddTitle(ann, "Heat", 1995, TitleKind.Film, TitleStatus.Backlog);
        await ann.Model.CreateChallenge(film);
        var annId = ann.Model.PersonId;
        var code = ann.Model.RecoveryCode;

        var bob = _rig.Person("Bob");
        await bob.Model.AuthorizedAsync();
        var bobSecret = bob.Model.RecoveryCode;

        Assert.False(await bob.Model.AdoptAsync("too-short"));
        Assert.False(await bob.Model.AdoptAsync(bobSecret));
        Assert.False(await bob.Model.AdoptAsync("q8Hk2v_9-Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu="));
        Assert.Equal(bobSecret, bob.Model.RecoveryCode);

        Assert.True(await bob.Model.AdoptAsync($"  {code}\n"));
        Assert.Equal(code, bob.Model.RecoveryCode);
        Assert.Equal(annId, bob.Model.PersonId);
        Assert.Single(bob.Model.Challenges);
        var stored = TogetherIdentity.Load(bob.IdentityFile, "x");
        Assert.Equal((code, annId), (stored.Secret, stored.PersonId));
        // It registers under this profile's name.
        Assert.Equal("Bob", Arg(Server.CallsTo("people:register")[^1], "name"));
    }

    [Fact]
    public async Task AdoptingWhileOfflineFails()
    {
        var bob = _rig.Person("Bob");
        bob.Connection.Offline = true;
        Assert.False(await bob.Model.AdoptAsync("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu="));
        Assert.Null(bob.Model.PersonId);
    }

    [Fact]
    public async Task ChangesAreRaisedOnTheModelsContext()
    {
        var ann = _rig.Person("Ann");
        var threads = new List<bool>();
        var names = new List<string?>();
        ann.Model.PropertyChanged += (_, e) =>
        {
            threads.Add(SynchronizationContext.Current == _rig.Context);
            names.Add(e.PropertyName);
        };
        var changed = 0;
        ann.Model.Changed += (_, _) => changed++;
        await ann.Model.Enter("K7QM2X");
        Assert.All(threads, Assert.True);
        Assert.Contains("IsWorking", names);
        Assert.Contains("PersonId", names);
        Assert.Equal(names.Count, changed);
    }
}
