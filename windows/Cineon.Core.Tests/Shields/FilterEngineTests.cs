using System.Net;
using System.Text.Json;
using Cineon.Core.Shields;

namespace Cineon.Core.Tests.Shields;

public sealed class FilterEngineTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "CineonShields-" + Guid.NewGuid().ToString("N"));
    private readonly string _bundled;
    private readonly string _data;

    public FilterEngineTests()
    {
        _bundled = Path.Combine(_root, "Bundled");
        _data = Path.Combine(_root, "Data", "Filters");
        Directory.CreateDirectory(_bundled);
        foreach (var info in FilterEngine.Catalog)
        {
            File.WriteAllText(Path.Combine(_bundled, $"{info.Id}.txt"), $"! {info.Name}\n||{info.Id}-ads.com^\n##.{info.Id}-banner\n");
        }
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private FilterEngine Make(HttpMessageHandler? handler = null, Func<DateTimeOffset>? now = null) =>
        new(_data, _bundled, handler is null ? null : new HttpClient(handler), now);

    [Fact]
    public void TheCatalogMatchesTheMac()
    {
        Assert.Equal(["easylist", "easyprivacy", "ublock", "peterlowe", "cineon-streaming"], FilterEngine.Catalog.Select(i => i.Id));
        Assert.Null(FilterEngine.Catalog[^1].UpdateUrl);
        Assert.Equal("Peter Lowe's list", FilterEngine.Catalog[3].Name);
    }

    [Fact]
    public async Task PrepareParsesEveryListAndRemembersCounts()
    {
        var engine = Make();
        int changes = 0;
        engine.Changed += () => changes++;
        Assert.False(engine.IsReady);

        await engine.PrepareAsync();

        Assert.True(engine.IsReady);
        Assert.Equal(FilterStatus.Idle, engine.Status);
        Assert.Equal(5, engine.Compiled.Count);
        Assert.All(engine.RuleCounts.Values, count => Assert.Equal(2, count));
        Assert.Equal(10, engine.TotalRules);
        Assert.Equal("5/10", engine.RulesSummary);
        Assert.Equal(5, changes);
        Assert.Equal(engine.Generation, changes);
        Assert.Equal(Decision.Block, engine.Rules.Match("https://ublock-ads.com/x.js", null, ResourceType.Script));

        // Counts are kept for next launch, and lists known by then are parsed in one go.
        var again = Make();
        Assert.Equal(10, again.TotalRules);
        int againChanges = 0;
        again.Changed += () => againChanges++;
        await again.PrepareAsync();
        Assert.Equal(1, againChanges);
        Assert.Equal(5, again.Compiled.Count);
    }

    [Fact]
    public async Task ADownloadedCopyWinsOverTheBundledOne()
    {
        Directory.CreateDirectory(_data);
        File.WriteAllText(Path.Combine(_data, "peterlowe.txt"), "||fresh-one.com^\n||fresh-two.com^\n||fresh-three.com^\n");
        var engine = Make();
        await engine.PrepareAsync();
        Assert.Equal(3, engine.RuleCounts["peterlowe"]);
        Assert.Equal(Decision.Block, engine.Rules.Match("https://fresh-two.com/", null, ResourceType.Image));
    }

    [Fact]
    public async Task RulesForFollowsTheProfileSettings()
    {
        var engine = Make();
        await engine.PrepareAsync();
        Assert.True(engine.RulesFor(networkBlocking: false, ["easylist"]).IsEmpty);
        var some = engine.RulesFor(networkBlocking: true, ["cineon-streaming", "easylist", "unknown"]);
        Assert.Equal(["easylist", "cineon-streaming"], some.ActiveLists);
        Assert.Equal(Decision.Allow, some.Match("https://peterlowe-ads.com/", null, ResourceType.Script));
        Assert.Equal(Decision.Block, some.Match("https://easylist-ads.com/", null, ResourceType.Script));
        Assert.Contains(".cineon-streaming-banner", some.CssFor("example.com"));
        Assert.DoesNotContain(".ublock-banner", some.CssFor("example.com"));
    }

    [Fact]
    public async Task UpdateDownloadsListsWithAnAddress()
    {
        var list = "! Fresh\n" + string.Join('\n', Enumerable.Range(0, 100).Select(i => $"||fresh{i}.example^"));
        var handler = new FakeHandler(request => request.RequestUri!.Host == "easylist.to" && request.RequestUri.AbsolutePath.EndsWith("easylist.txt")
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(list) }
            : new HttpResponseMessage(HttpStatusCode.NotFound));
        var now = new DateTimeOffset(2026, 11, 6, 12, 0, 0, TimeSpan.Zero);
        var engine = Make(handler, () => now);
        await engine.PrepareAsync();
        Assert.Null(engine.LastUpdated);

        Assert.True(await engine.UpdateAsync(TestContext.Current.CancellationToken));

        Assert.Equal(4, handler.Requests.Count);
        Assert.Equal(FilterStatus.Idle, engine.Status);
        Assert.Equal(now, engine.LastUpdated);
        Assert.Equal(100, engine.RuleCounts["easylist"]);
        Assert.True(File.Exists(Path.Combine(_data, "easylist.txt")));
        Assert.Equal(Decision.Block, engine.Rules.Match("https://fresh42.example/", null, ResourceType.Script));
        Assert.Equal(Decision.Allow, engine.Rules.Match("https://easylist-ads.com/", null, ResourceType.Script));
        Assert.Equal(now, Make(handler, () => now).LastUpdated);
    }

    [Fact]
    public async Task ShortOrFailedDownloadsChangeNothing()
    {
        var handler = new FakeHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("||tiny.com^") });
        var engine = Make(handler);
        await engine.PrepareAsync();
        Assert.False(await engine.UpdateAsync(TestContext.Current.CancellationToken));
        Assert.Null(engine.LastUpdated);
        Assert.Equal(2, engine.RuleCounts["easylist"]);

        var offline = Make(new FakeHandler(_ => throw new HttpRequestException("offline")));
        Assert.False(await offline.UpdateAsync(TestContext.Current.CancellationToken));
        Assert.Equal(FilterStatus.Idle, offline.Status);
    }

    [Fact]
    public async Task UpdatesAreDueWeekly()
    {
        var handler = new FakeHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound));
        var now = new DateTimeOffset(2026, 11, 6, 12, 0, 0, TimeSpan.Zero);
        var engine = Make(handler, () => now);
        await engine.UpdateIfDueAsync();
        Assert.Empty(handler.Requests);

        now = now.AddDays(6);
        await Make(handler, () => now).UpdateIfDueAsync();
        Assert.Empty(handler.Requests);

        now = now.AddDays(2);
        await Make(handler, () => now).UpdateIfDueAsync();
        Assert.Equal(4, handler.Requests.Count);
    }

    [Fact]
    public async Task StateIsSavedAsJson()
    {
        var engine = Make();
        await engine.PrepareAsync();
        using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(_data, "filters.json")));
        Assert.Equal(2, json.RootElement.GetProperty("ruleCounts").GetProperty("easylist").GetInt32());
        Assert.Equal(JsonValueKind.String, json.RootElement.GetProperty("firstSeen").ValueKind);
    }

    [Fact]
    public void StatusPrintsLikeSwift()
    {
        Assert.Equal("idle", FilterStatus.Idle.ToString());
        Assert.Equal("preparing(\"Preparing ad blocker, 1 of 5\")", FilterStatus.Preparing("Preparing ad blocker, 1 of 5").ToString());
        Assert.Equal("failed(\"easylist: bad\")", FilterStatus.Failed("easylist: bad").ToString());
    }

    private sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public List<Uri> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            lock (Requests) Requests.Add(request.RequestUri!);
            return Task.FromResult(respond(request));
        }
    }
}
