using System.Text.Json;
using Cineon.Core.Data;
using Cineon.Core.Together;

namespace Cineon.Core.Tests.Together;

public sealed class CloudLibraryTests : IDisposable
{
    private readonly TogetherRig _rig = new();
    private readonly TestPerson _ann;
    private readonly CloudLibrary _cloud;
    private readonly DateTimeOffset _t0;

    public CloudLibraryTests()
    {
        _ann = _rig.Person("Ann");
        _cloud = new CloudLibrary(_ann.Library, _ann.Model, () => _ann.Host.Settings);
        _t0 = _rig.Clock.GetUtcNow().AddDays(-30);
    }

    public void Dispose()
    {
        _rig.Context.Run(_cloud.Stop).Wait(2000);
        _rig.Dispose();
    }

    private FakeConvex Server => _rig.Server;

    private static double Ms(DateTimeOffset date) => date.ToUnixTimeMilliseconds();

    /// <summary>A title stored with exactly these values, as if rated and filed at those times.</summary>
    private Title Stored(TestPerson person, string name, int? year = null, string? imdb = null, TitleStatus status = TitleStatus.None,
        DateTimeOffset? statusAt = null, int? halves = null, DateTimeOffset? ratedAt = null, DateTimeOffset? finishedAt = null,
        TitleKind kind = TitleKind.Film)
    {
        return person.Ui(() =>
        {
            var added = person.Library.AddTitle(name, year, kind, imdbId: imdb)!;
            var title = added with
            {
                Status = status, StatusAt = statusAt, RatingHalves = halves, RatedAt = ratedAt, FinishedAt = finishedAt,
                AddedAt = _t0, UpdatedAt = _t0,
            };
            person.Db.UpdateTitle(title);
            person.Library.Reload();
            return person.Library.Titles[title.Id];
        }).Result;
    }

    private async Task<string> Secret()
    {
        var (_, secret) = await _ann.Model.AuthorizedAsync();
        return secret;
    }

    private static List<JsonElement> PutItems(IEnumerable<FakeConvex.Call> calls) =>
        [.. calls.SelectMany(c => c.Args.GetProperty("items").EnumerateArray())];

    // MARK: Keys (ported from CineonTests/ProfileAndRatingTests.swift)

    [Fact]
    public void CloudKnowsFilmsByImdbOrByNameAndYear()
    {
        var film = new Title { Id = 1, Name = "Heat", NormName = "heat", Year = 1995 };
        Assert.Equal(["n:heat|1995"], CloudLibrary.Keys(film));
        Assert.Equal(["tt0113277", "n:heat|1995"], CloudLibrary.Keys(film with { ImdbId = "tt0113277" }));
        Assert.Equal("n:x|", CloudLibrary.Key(null, "x", null));
        // Only real IMDb ids count; long names are cut at 140 characters.
        Assert.Equal("n:x|2001", CloudLibrary.Key("nm0000001", "x", 2001));
        Assert.Equal("n:" + new string('a', 140) + "|", CloudLibrary.Key(null, new string('a', 300), null));
    }

    // MARK: Sending

    [Fact]
    public async Task TheFirstSyncSendsWhatOnlyThisPcKnows()
    {
        var rated = _t0.AddDays(1);
        var filed = _t0.AddDays(2);
        Stored(_ann, "Heat", 1995, "tt0113277", TitleStatus.Watched, filed, 17, rated, filed);
        Stored(_ann, "Arrival", 2016, status: TitleStatus.Backlog, statusAt: filed);
        Stored(_ann, "Imported", 2001, status: TitleStatus.Watching);
        Stored(_ann, "Unrated", 1999, halves: null, ratedAt: rated);
        Stored(_ann, "Nothing", 1980);

        await _cloud.SyncAsync();
        Assert.Null(_cloud.LastError);
        Assert.Equal(_rig.Clock.GetUtcNow(), _cloud.LastSync);
        Assert.Equal(0, _cloud.CloudCount);
        Assert.False(_cloud.IsSyncing);
        var all = Assert.Single(Server.CallsTo("library:all"));
        Assert.Equal(Ms(_rig.Clock.GetUtcNow()), all.Args.GetProperty("t").GetDouble());

        var items = PutItems(Server.CallsTo("library:put")).ToDictionary(i => i.GetProperty("name").GetString()!);
        Assert.Equal(["Arrival", "Heat", "Imported", "Unrated"], items.Keys.Order());
        Assert.Equal(
            $$"""{"key":"tt0113277","name":"Heat","kind":"film","status":"watched","statusAt":{{Ms(filed)}},"year":1995,"finishedAt":{{Ms(filed)}},"rating":17,"ratedAt":{{Ms(rated)}}}""",
            items["Heat"].GetRawText());
        Assert.Equal($$"""{"key":"n:arrival|2016","name":"Arrival","kind":"film","status":"backlog","statusAt":{{Ms(filed)}},"year":2016}""",
            items["Arrival"].GetRawText());
        // Imported without a date: its update time stands in.
        Assert.Equal(Ms(_t0), items["Imported"].GetProperty("statusAt").GetDouble());
        // A cleared rating travels as null with its time.
        Assert.Equal(JsonValueKind.Null, items["Unrated"].GetProperty("rating").ValueKind);
        Assert.Equal(Ms(rated), items["Unrated"].GetProperty("ratedAt").GetDouble());

        var cloud = Server.LibraryOf(await Secret());
        Assert.Equal(4, cloud.Count);
        Assert.Equal(17, cloud.Single(i => i.Key == "tt0113277").Rating);

        // Everything matches now: nothing more to send.
        await _cloud.SyncAsync();
        Assert.Single(Server.CallsTo("library:put"));
        Assert.Equal(4, _cloud.CloudCount);
    }

    [Fact]
    public async Task BigLibrariesGoInBatchesOf200()
    {
        await _ann.Ui(() =>
        {
            for (var i = 0; i < 450; i++) _ann.Library.AddTitle($"Film {i}", 1950 + i % 70, TitleKind.Film, TitleStatus.Backlog);
        });
        await _cloud.SyncAsync();
        Assert.Equal([200, 200, 50], Server.CallsTo("library:put").Select(c => c.Args.GetProperty("items").GetArrayLength()));
        Assert.Equal(450, Server.LibraryOf(await Secret()).Count);
    }

    [Fact]
    public async Task ChangesGoOutTogetherAMomentLater()
    {
        var heat = Stored(_ann, "Heat", 1995, "tt0113277");
        var dune = Stored(_ann, "Dune", 2021);
        await _ann.Ui(_cloud.Start);
        Assert.NotNull(_ann.Library.OnPersonalChange);

        await _ann.Ui(() => _ann.Library.SetRating(heat.Id, 16));
        await _rig.Advance(1);
        await _ann.Ui(() => _ann.Library.SetStatus(dune.Id, TitleStatus.Backlog));
        var lastChange = _rig.Clock.GetUtcNow();
        await _rig.Advance(1);
        Assert.Empty(Server.CallsTo("library:put"));
        await _rig.Advance(0.6);
        var put = Assert.Single(Server.CallsTo("library:put"));
        Assert.Equal(["Dune", "Heat"], PutItems([put]).Select(i => i.GetProperty("name").GetString()).Order());
        // Sent a second and a half after the last change.
        Assert.Equal(lastChange.AddSeconds(1.5), _cloud.LastSync);
        Assert.Empty(Server.CallsTo("library:all"));

        // Three seconds after starting, a full sync.
        await _rig.Advance(0.5);
        await _rig.WaitUntil(() => Server.CallsTo("library:all").Count == 1, "the sync after starting");
    }

    [Fact]
    public async Task FailedSendsWaitForTheNextOne()
    {
        var heat = Stored(_ann, "Heat", 1995, "tt0113277");
        var dune = Stored(_ann, "Dune", 2021);
        // What Start wires up, without its timers.
        await _ann.Ui(() => _ann.Library.OnPersonalChange = _cloud.NoteChange);
        _ann.Connection.Offline = true;
        await _ann.Ui(() => _ann.Library.SetRating(heat.Id, 16));
        await _rig.Advance(2);
        Assert.Equal("The network connection was lost.", _cloud.LastError);

        _ann.Connection.Offline = false;
        await _ann.Ui(() => _ann.Library.SetRating(dune.Id, 12));
        await _rig.Advance(2);
        Assert.Null(_cloud.LastError);
        Assert.Equal(["Dune", "Heat"], PutItems(Server.CallsTo("library:put")).Select(i => i.GetProperty("name").GetString()).Order());
    }

    [Fact]
    public async Task SyncingEveryTenMinutes()
    {
        await _ann.Ui(_cloud.Start);
        await _rig.Advance(3);
        await _rig.WaitUntil(() => Server.CallsTo("library:all").Count == 1, "the first sync");
        await _rig.Advance(596);
        Assert.Single(Server.CallsTo("library:all"));
        await _rig.Advance(1);
        await _rig.WaitUntil(() => Server.CallsTo("library:all").Count == 2, "the ten-minute sync");
    }

    [Fact]
    public async Task OffMeansOff()
    {
        var heat = Stored(_ann, "Heat", 1995, "tt0113277", TitleStatus.Watched, _t0);
        _ann.Host.Settings = new AppSettings { CloudBackup = false };
        await _ann.Ui(_cloud.Start);
        await _ann.Ui(() => _ann.Library.SetRating(heat.Id, 16));
        await _rig.Advance(700);
        await _cloud.SyncAsync();
        Assert.Empty(Server.Calls);

        // Stopped is stopped, whatever the settings say.
        _ann.Host.Settings = new AppSettings();
        await _ann.Ui(_cloud.Stop);
        await _cloud.SyncAsync();
        await _ann.Ui(() => _cloud.NoteChange(heat));
        await _rig.Advance(5);
        Assert.Empty(Server.Calls);
    }

    [Fact]
    public async Task WithoutAServerThereIsNoBackup()
    {
        var bob = _rig.Person("Bob", withServer: false);
        var cloud = new CloudLibrary(bob.Library, bob.Model, () => bob.Host.Settings);
        await cloud.SyncAsync();
        Assert.Null(cloud.LastSync);
        Assert.Null(cloud.LastError);
    }

    // MARK: Merging

    [Fact]
    public async Task NewerInTheCloudWinsHere()
    {
        var local = _t0.AddDays(1);
        var heat = Stored(_ann, "Heat", 1995, "tt0113277", TitleStatus.Backlog, local, 14, local);
        var later = local.AddSeconds(10);
        var finished = later.AddHours(-2);
        var secret = await Secret();
        Server.SeedLibrary(secret, new FakeConvex.LibraryFields
        {
            Key = "tt0113277", Name = "Heat", Year = 1995, Rating = 20, RatedAt = Ms(later), Status = "watched", StatusAt = Ms(later),
            FinishedAt = Ms(finished),
        });
        var personal = new List<Title>();
        await _ann.Ui(() => _ann.Library.OnPersonalChange = personal.Add);

        await _cloud.SyncAsync();
        var now = _ann.Library.Titles[heat.Id];
        Assert.Equal(20, now.RatingHalves);
        Assert.Equal(Ms(later), Ms(now.RatedAt!.Value));
        Assert.Equal(TitleStatus.Watched, now.Status);
        Assert.Equal(Ms(later), Ms(now.StatusAt!.Value));
        Assert.Equal(Ms(finished), Ms(now.FinishedAt!.Value));
        // Restored quietly: nothing echoed back.
        Assert.Empty(personal);
        Assert.Empty(Server.CallsTo("library:put"));
        Assert.Equal(1, _cloud.CloudCount);
    }

    [Fact]
    public async Task NewerHereIsSentAndKept()
    {
        var local = _t0.AddDays(1);
        var heat = Stored(_ann, "Heat", 1995, "tt0113277", TitleStatus.Watched, local, 18, local);
        var secret = await Secret();
        var earlier = local.AddSeconds(-10);
        Server.SeedLibrary(secret, new FakeConvex.LibraryFields
        {
            Key = "tt0113277", Name = "Heat", Rating = 6, RatedAt = Ms(earlier), Status = "backlog", StatusAt = Ms(earlier),
        });
        await _cloud.SyncAsync();
        Assert.Equal(18, _ann.Library.Titles[heat.Id].RatingHalves);
        Assert.Equal(TitleStatus.Watched, _ann.Library.Titles[heat.Id].Status);
        var stored = Server.LibraryOf(secret).Single();
        Assert.Equal((18.0, "watched"), (stored.Rating, stored.Status));
    }

    [Fact]
    public async Task HalfASecondEitherWayIsTheSameMoment()
    {
        var local = _t0.AddDays(1);
        var heat = Stored(_ann, "Heat", 1995, "tt0113277", TitleStatus.Backlog, local, 14, local);
        var secret = await Secret();
        Server.SeedLibrary(secret, new FakeConvex.LibraryFields
        {
            Key = "tt0113277", Name = "Heat", Rating = 20, RatedAt = Ms(local) + 400, Status = "watched", StatusAt = Ms(local) - 400,
        });
        await _cloud.SyncAsync();
        Assert.Equal(14, _ann.Library.Titles[heat.Id].RatingHalves);
        Assert.Equal(TitleStatus.Backlog, _ann.Library.Titles[heat.Id].Status);
        Assert.Empty(Server.CallsTo("library:put"));
    }

    [Fact]
    public async Task ARatingClearedElsewhereIsClearedHere()
    {
        var local = _t0.AddDays(1);
        var heat = Stored(_ann, "Heat", 1995, "tt0113277", TitleStatus.Watched, local, 14, local);
        var secret = await Secret();
        Server.SeedLibrary(secret, new FakeConvex.LibraryFields
        {
            Key = "tt0113277", Name = "Heat", Rating = null, RatedAt = Ms(local) + 60_000, Status = "watched", StatusAt = Ms(local),
        });
        await _cloud.SyncAsync();
        Assert.Null(_ann.Library.Titles[heat.Id].RatingHalves);
        Assert.Equal(Ms(local) + 60_000, Ms(_ann.Library.Titles[heat.Id].RatedAt!.Value));
    }

    [Fact]
    public async Task AnUndatedTitleOnlyTakesAListWhenItHasNone()
    {
        var loose = Stored(_ann, "Loose", 2001);
        var filed = Stored(_ann, "Filed", 2002, status: TitleStatus.Backlog);
        var secret = await Secret();
        var at = Ms(_t0.AddDays(3));
        Server.SeedLibrary(secret, new FakeConvex.LibraryFields { Key = "n:loose|2001", Name = "Loose", Status = "watching", StatusAt = at });
        Server.SeedLibrary(secret, new FakeConvex.LibraryFields { Key = "n:filed|2002", Name = "Filed", Status = "watched", StatusAt = at });
        await _cloud.SyncAsync();
        Assert.Equal(TitleStatus.Watching, _ann.Library.Titles[loose.Id].Status);
        Assert.Equal(at, Ms(_ann.Library.Titles[loose.Id].StatusAt!.Value));
        Assert.Equal(TitleStatus.Backlog, _ann.Library.Titles[filed.Id].Status);
        // And neither is sent: the cloud knows a list for both, and the undated one is no newer.
        Assert.Empty(Server.CallsTo("library:put"));
    }

    [Fact]
    public async Task ANameKeyFromBeforeTheImdbIdStillCounts()
    {
        var heat = Stored(_ann, "Heat", 1995, "tt0113277");
        var secret = await Secret();
        Server.SeedLibrary(secret, new FakeConvex.LibraryFields
        {
            Key = "n:heat|1995", Name = "Heat", Rating = 18, RatedAt = Ms(_t0.AddDays(1)),
        });
        await _cloud.SyncAsync();
        Assert.Equal(18, _ann.Library.Titles[heat.Id].RatingHalves);
    }

    [Fact]
    public async Task OfTwoCloudEntriesTheNewestCounts()
    {
        var heat = Stored(_ann, "Heat", 1995, "tt0113277");
        var older = new CloudItem("tt0113277", "Heat", Rating: 10, RatedAt: Ms(_t0.AddDays(1)));
        var newer = new CloudItem("tt0113277", "Heat", Rating: 16, RatedAt: Ms(_t0.AddDays(2)));
        await _ann.Ui(() => _cloud.Merge([older, newer]));
        Assert.Equal(16, _ann.Library.Titles[heat.Id].RatingHalves);
        await _ann.Ui(() => _ann.Library.Restore(heat.Id, true, null, null, null, null, null));
        await _ann.Ui(() => _cloud.Merge([newer, older]));
        Assert.Equal(16, _ann.Library.Titles[heat.Id].RatingHalves);

        // The id entry and the name entry: the newer rating of the two.
        var byName = new CloudItem("n:heat|1995", "Heat", Rating: 4, RatedAt: Ms(_t0.AddDays(3)));
        await _ann.Ui(() => _cloud.Merge([newer, byName]));
        Assert.Equal(4, _ann.Library.Titles[heat.Id].RatingHalves);
    }

    [Fact]
    public async Task ARecoveryCodeBringsTheLibraryBack()
    {
        Stored(_ann, "Heat", 1995, "tt0113277", TitleStatus.Watched, _t0.AddDays(1), 17, _t0.AddDays(1), _t0.AddDays(1));
        Stored(_ann, "Arrival", 2016, status: TitleStatus.Backlog, statusAt: _t0.AddDays(1));
        await _cloud.SyncAsync();

        // A fresh profile, its library imported again without ratings or lists.
        var bob = _rig.Person("Bob");
        var heat = Stored(bob, "Heat", 1995, "tt0113277");
        var arrival = Stored(bob, "Arrival", 2016);
        var cloud = new CloudLibrary(bob.Library, bob.Model, () => bob.Host.Settings);
        Assert.True(await bob.Model.AdoptAsync(_ann.Model.RecoveryCode));
        await cloud.SyncAsync();
        Assert.Null(cloud.LastError);
        Assert.Equal((17, TitleStatus.Watched), (bob.Library.Titles[heat.Id].RatingHalves, bob.Library.Titles[heat.Id].Status));
        Assert.Equal(TitleStatus.Backlog, bob.Library.Titles[arrival.Id].Status);
        Assert.Equal(2, cloud.CloudCount);
    }

    [Fact]
    public async Task ErrorsAreKeptForTheProfilePage()
    {
        _ann.Connection.Offline = true;
        await _cloud.SyncAsync();
        Assert.Equal("The network connection was lost.", _cloud.LastError);
        Assert.Null(_cloud.LastSync);
        _ann.Connection.Offline = false;
        await _cloud.SyncAsync();
        Assert.Null(_cloud.LastError);
        Assert.NotNull(_cloud.LastSync);
    }
}
