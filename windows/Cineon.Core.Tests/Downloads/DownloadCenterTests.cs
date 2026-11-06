using System.Net;
using System.Text;
using Cineon.Core.Data;
using Cineon.Core.Downloads;

namespace Cineon.Core.Tests.Downloads;

/// <summary>The queue, whole-file downloads and their records, against an in-process server.</summary>
public sealed class DownloadCenterTests : IDisposable
{
    private readonly DownloadRig _rig = new();

    public void Dispose() => _rig.Dispose();

    private DownloadCenter Center => _rig.Center;
    private FakeServer Server => _rig.Server;

    private static async Task Until(Func<bool> condition, int seconds = 10)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("Condition never held");
            await Task.Delay(10, TestContext.Current.CancellationToken);
        }
    }

    [Fact]
    public async Task SavesAFileWithThePagesHeadersAndRecordsIt()
    {
        var film = FakeServer.Random(300_000, 1);
        Server.Bytes("/a/1080.mp4", film, "video/mp4");
        _rig.Context.Cookies.Add(new BrowserCookie("session", "abc", ".cdn.test", "/", IsSecure: true));
        _rig.Context.Cookies.Add(new BrowserCookie("other", "x", "elsewhere.test", "/", IsSecure: false));
        _rig.Context.Cookies.Add(new BrowserCookie("deep", "y", "cdn.test", "/private", IsSecure: false));

        var item = _rig.Enqueue("https://media.cdn.test/a/1080.mp4", name: "Severance", episode: new EpisodeRef(1, 2));
        await Center.IdleAsync();

        var saved = Center.Item(item.Id)!;
        Assert.Equal(DownloadStatus.Done, saved.Status);
        Assert.Equal(Path.Combine(_rig.Downloads, "Severance S01E02 [1080p].mp4"), saved.File);
        Assert.Equal(film, File.ReadAllBytes(saved.File!));
        Assert.Equal(film.Length, saved.TotalBytes);
        Assert.Equal(1, Center.Fraction(saved));
        var stored = Assert.Single(_rig.Db.AllDownloads());
        Assert.Equal((DownloadStatus.Done, saved.File, (long)film.Length, "1080p"), (stored.Status, stored.File, stored.TotalBytes, stored.Quality));

        var request = Server.Last("/a/1080.mp4");
        Assert.Equal("https://site.test/film/arrival", request.Headers.Referrer?.OriginalString);
        Assert.Equal("https://site.test", request.Headers.GetValues("Origin").Single());
        Assert.Contains("Cineon-Test", request.Headers.UserAgent.ToString());
        Assert.Equal("session=abc", request.Headers.GetValues("Cookie").Single());
        Assert.Contains("Saved Severance S01E02 [1080p]", _rig.Host.Toasts);
        // Nothing is left half-done in the folder.
        Assert.False(Directory.Exists(Path.Combine(_rig.Downloads, DownloadCenter.PartialFolderName)));
    }

    [Fact]
    public async Task NoOriginForTheSameSiteAndPlayActionPlaysIt()
    {
        Server.Bytes("/f.mp4", [1, 2, 3]);
        var item = _rig.Enqueue("https://cdn.site.test/f.mp4");
        await Center.IdleAsync();
        Assert.False(Server.Last("/f.mp4").Headers.Contains("Origin"));
        var (_, title, action) = _rig.Host.Actions.Single(a => a.Message.StartsWith("Saved", StringComparison.Ordinal));
        Assert.Equal("Play", title);
        action!();
        Assert.Equal(item.Id, Assert.Single(_rig.Host.Played).Id);
    }

    [Fact]
    public async Task TwoRunAtATimeAndTheRestWaitTheirTurn()
    {
        var gates = new Dictionary<string, TaskCompletionSource>
        {
            ["/1.mp4"] = new(), ["/2.mp4"] = new(), ["/3.mp4"] = new(),
        };
        foreach (var (path, gate) in gates)
        {
            Server.Route(path, async request =>
            {
                await gate.Task;
                return FakeServer.Serve(request, [1, 2, 3]);
            });
        }
        var first = _rig.Enqueue("https://cdn.test/1.mp4", name: "One");
        var second = _rig.Enqueue("https://cdn.test/2.mp4", name: "Two");
        var third = _rig.Enqueue("https://cdn.test/3.mp4", name: "Three");

        await Until(() => Server.Count("/1.mp4") == 1 && Server.Count("/2.mp4") == 1);
        Assert.Equal(2, Center.RunningCount);
        Assert.False(Center.HasFreeSlot);
        Assert.Equal(3, Center.ActiveCount);
        Assert.Equal(DownloadStatus.Queued, Center.Item(third.Id)!.Status);
        Assert.Equal(0, Server.Count("/3.mp4"));

        gates["/1.mp4"].SetResult();
        await Until(() => Server.Count("/3.mp4") == 1);
        gates["/2.mp4"].SetResult();
        gates["/3.mp4"].SetResult();
        await Center.IdleAsync();
        Assert.All(new[] { first, second, third }, i => Assert.Equal(DownloadStatus.Done, Center.Item(i.Id)!.Status));
        // Newest first, like the Mac's list.
        Assert.Equal([third.Id, second.Id, first.Id], Center.Items.Select(i => i.Id));
    }

    [Fact]
    public async Task AStoppedFileCarriesOnWithARangeRequest()
    {
        var film = FakeServer.Random(500_000, 2);
        var broken = true;
        Server.Route("/film.mp4", request =>
        {
            if (broken && request.Headers.Range is null)
            {
                return FakeServer.Serve(request, film, "video/mp4", new BrokenStream(film, 200_000));
            }
            return FakeServer.Serve(request, film, "video/mp4");
        });
        var item = _rig.Enqueue("https://cdn.test/film.mp4");
        await Center.IdleAsync();

        var failed = Center.Item(item.Id)!;
        Assert.Equal(DownloadStatus.Failed, failed.Status);
        Assert.Equal("The network connection was lost.", failed.Error);
        Assert.Equal(200_000, new FileInfo(Center.PartialFile(failed)).Length);

        broken = false;
        Center.Retry(item.Id);
        await Center.IdleAsync();

        var done = Center.Item(item.Id)!;
        Assert.Equal(DownloadStatus.Done, done.Status);
        Assert.Equal(film, File.ReadAllBytes(done.File!));
        Assert.Equal(200_000, Server.Last("/film.mp4").Headers.Range!.Ranges.Single().From);
    }

    [Fact]
    public async Task ASiteThatIgnoresRangeStartsAgainFromTheTop()
    {
        var film = FakeServer.Random(50_000, 3);
        // Half a file from before, where the first download of this profile will collect.
        var part = Center.PartialFile(new DownloadItem { Id = 1, SourceUrl = new Uri("https://cdn.test/plain.mp4") });
        Directory.CreateDirectory(Path.GetDirectoryName(part)!);
        File.WriteAllBytes(part, FakeServer.Random(20_000, 9));
        // The server ignores Range and sends everything.
        Server.Route("/plain.mp4", _ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(film) });
        var item = _rig.Enqueue("https://cdn.test/plain.mp4");
        Assert.Equal(1, item.Id);
        await Center.IdleAsync();
        Assert.Equal(20_000, Server.Last("/plain.mp4").Headers.Range!.Ranges.Single().From);
        Assert.Equal(film, File.ReadAllBytes(Center.Item(item.Id)!.File!));
    }

    [Fact]
    public async Task StoppingKeepsWhatWasSavedForLater()
    {
        var release = new TaskCompletionSource();
        Server.Route("/slow.mp4", async request =>
        {
            await release.Task;
            return FakeServer.Serve(request, [1, 2, 3]);
        });
        var item = _rig.Enqueue("https://cdn.test/slow.mp4");
        await Until(() => Server.Count("/slow.mp4") == 1);
        Center.Cancel(item.Id);
        await Center.IdleAsync();
        var stopped = Center.Item(item.Id)!;
        Assert.Equal(DownloadStatus.Failed, stopped.Status);
        Assert.Equal("Stopped", stopped.Error);
        release.SetResult();
    }

    [Fact]
    public async Task StoppingAQueuedDownloadNeedsNoNetwork()
    {
        var gate = new TaskCompletionSource();
        Server.Route("/busy.mp4", async request =>
        {
            await gate.Task;
            return FakeServer.Serve(request, [1]);
        });
        _rig.Enqueue("https://cdn.test/busy.mp4", name: "A");
        _rig.Enqueue("https://cdn.test/busy.mp4", name: "B");
        var waiting = _rig.Enqueue("https://cdn.test/never.mp4", name: "C");
        Center.Cancel(waiting.Id);
        Assert.Equal(DownloadStatus.Failed, Center.Item(waiting.Id)!.Status);
        Assert.Equal("Stopped", Center.Item(waiting.Id)!.Error);
        gate.SetResult();
        await Center.IdleAsync();
        Assert.Equal(0, Server.Count("/never.mp4"));
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden, "The site refused. The link may have expired: open the page and download again.")]
    [InlineData(HttpStatusCode.Unauthorized, "The site refused. The link may have expired: open the page and download again.")]
    [InlineData(HttpStatusCode.NotFound, "The file is gone from the site.")]
    [InlineData(HttpStatusCode.Gone, "The file is gone from the site.")]
    [InlineData(HttpStatusCode.ServiceUnavailable, "The site answered with an error (503).")]
    public async Task RefusalsSayWhatHappened(HttpStatusCode status, string message)
    {
        Server.Status("/x.mp4", status);
        var item = _rig.Enqueue("https://cdn.test/x.mp4");
        await Center.IdleAsync();
        Assert.Equal(DownloadStatus.Failed, Center.Item(item.Id)!.Status);
        Assert.Equal(message, Center.Item(item.Id)!.Error);
        Assert.Equal(message, _rig.Db.AllDownloads().Single().Error);
    }

    [Fact]
    public async Task HdrezkaSegmentsAreTracedBackToTheWholeFile()
    {
        Server.Bytes("/cdn/stream/1080.mp4", [9, 9, 9]);
        Assert.Equal("https://x.test/cdn/stream/1080.mp4?t=1", MediaUrls.Progressive("https://x.test/cdn/stream/1080.mp4:hls:seg-1-v1-a1.ts?t=1"));
        Assert.Equal(MediaSourceKind.File, MediaUrls.KindOf(MediaUrls.Progressive("https://x.test/cdn/stream/1080.mp4:hls:seg-1-v1-a1.ts")));
        Assert.Null(MediaUrls.KindOf("https://x.test/v/seg-12.m4s"));
        Assert.Equal(MediaSourceKind.Hls, MediaUrls.KindOf("https://x.test/master.m3u8?x=1"));

        var item = _rig.Enqueue("https://x.test/cdn/stream/1080.mp4:hls:seg-1-v1-a1.ts", name: "Mayday");
        Assert.Equal("https://x.test/cdn/stream/1080.mp4", item.SourceUrl.OriginalString);
        await Center.IdleAsync();
        Assert.Equal(Path.Combine(_rig.Downloads, "Mayday [1080p].mp4"), Center.Item(item.Id)!.File);
    }

    [Fact]
    public async Task SubtitlesAreSavedBesideTheFilm()
    {
        Server.Bytes("/f.mp4", [1, 2]);
        Server.Text("/subs/film_eng.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n", "text/vtt");
        Server.Text("/s/1234.srt", "1\n00:00:01,000 --> 00:00:02,000\nHi\n", "text/plain");
        Server.Status("/s/missing.vtt", HttpStatusCode.NotFound);
        var item = _rig.Enqueue("https://cdn.test/f.mp4", subtitles:
        [
            new Uri("https://cdn.test/subs/film_eng.vtt"), new Uri("https://cdn.test/s/1234.srt"), new Uri("https://cdn.test/s/missing.vtt"),
        ]);
        await Center.IdleAsync();
        var saved = Center.Item(item.Id)!;
        Assert.Equal(
            [Path.Combine(_rig.Downloads, "Arrival.en.vtt"), Path.Combine(_rig.Downloads, "Arrival.sub2.srt")],
            saved.Subtitles);
        Assert.All(saved.Subtitles, path => Assert.True(File.Exists(path)));
        Assert.Equal(saved.Subtitles, _rig.Db.AllDownloads().Single().Subtitles);
    }

    [Fact]
    public async Task SameNameGetsANumberAndExtensionsComeFromTheSite()
    {
        Server.Route("/a", request =>
        {
            var response = FakeServer.Serve(request, [1]);
            response.Content.Headers.ContentDisposition = new System.Net.Http.Headers.ContentDispositionHeaderValue("attachment") { FileName = "film.webm" };
            return response;
        });
        Server.Bytes("/b.mkv", [2]);
        var first = _rig.Enqueue("https://cdn.test/a");
        await Center.IdleAsync();
        var second = _rig.Enqueue("https://cdn.test/b.mkv");
        var third = _rig.Enqueue("https://cdn.test/b.mkv");
        await Center.IdleAsync();
        Assert.Equal(Path.Combine(_rig.Downloads, "Arrival.webm"), Center.Item(first.Id)!.File);
        Assert.Equal(
            new[] { Path.Combine(_rig.Downloads, "Arrival.mkv"), Path.Combine(_rig.Downloads, "Arrival 2.mkv") }.Order(),
            new[] { Center.Item(second.Id)!.File!, Center.Item(third.Id)!.File! }.Order());
        Assert.Equal("Name.en 2.vtt", Path.GetFileName(UniqueWith("Name.en.vtt")));
    }

    private string UniqueWith(string name)
    {
        Directory.CreateDirectory(_rig.Downloads);
        var path = Path.Combine(_rig.Downloads, name);
        File.WriteAllText(path, "x");
        return DownloadCenter.Unique(path);
    }

    [Fact]
    public void WhatWasRunningWhenCineonClosedIsMarkedStopped()
    {
        var item = new DownloadItem
        {
            SourceUrl = new Uri("https://cdn.test/a.mp4"), Name = "Arrival", Status = DownloadStatus.Downloading, CreatedAt = DateTimeOffset.UtcNow,
        };
        var id = _rig.Db.InsertDownload(item);
        _rig.Db.InsertDownload(item with { Status = DownloadStatus.Done });
        var center = _rig.Make();
        Assert.Equal("Stopped when Cineon closed", center.Item(id)!.Error);
        Assert.Equal(DownloadStatus.Failed, _rig.Db.AllDownloads().Single(d => d.Id == id).Status);
        Assert.Equal(0, center.ActiveCount);
    }

    [Fact]
    public async Task RemovingSendsTheFilesToTheBinAndForgetsIt()
    {
        Server.Bytes("/f.mp4", [1, 2]);
        Server.Text("/en.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n");
        var item = _rig.Enqueue("https://cdn.test/f.mp4", subtitles: [new Uri("https://cdn.test/en.vtt")]);
        await Center.IdleAsync();
        var saved = Center.Item(item.Id)!;
        Center.Remove(item.Id);
        Assert.Equal([saved.File!, .. saved.Subtitles], _rig.Host.Recycled);
        Assert.Null(Center.Item(item.Id));
        Assert.Empty(_rig.Db.AllDownloads());
    }

    [Fact]
    public async Task RemovingAFailedDownloadClearsItsPartialFile()
    {
        var film = FakeServer.Random(10_000, 4);
        Server.Route("/f.mp4", request => FakeServer.Serve(request, film, body: new BrokenStream(film, 4_000)));
        var item = _rig.Enqueue("https://cdn.test/f.mp4");
        await Center.IdleAsync();
        var part = Center.PartialFile(Center.Item(item.Id)!);
        Assert.True(File.Exists(part));
        Center.Remove(item.Id);
        Assert.False(File.Exists(part));
    }

    [Fact]
    public async Task EpisodesFollowOnAndWatchedOnesGoToTheBin()
    {
        Server.Bytes("/e.mp4", [1]);
        var title = _rig.Library.AddTitle("Severance", kind: TitleKind.Series)!;
        var e2 = _rig.Enqueue("https://cdn.test/e.mp4", name: "Severance", episode: new EpisodeRef(1, 2), titleId: title.Id);
        var e1 = _rig.Enqueue("https://cdn.test/e.mp4", name: "Severance", episode: new EpisodeRef(1, 1), titleId: title.Id);
        var e5 = _rig.Enqueue("https://cdn.test/e.mp4", name: "Severance", episode: new EpisodeRef(2, 1), titleId: title.Id);
        await Center.IdleAsync();

        Assert.Equal(e2.Id, Center.NextEpisode(Center.Item(e1.Id)!)?.Id);
        Assert.Equal(e5.Id, Center.NextEpisode(Center.Item(e2.Id)!)?.Id);
        Assert.Null(Center.NextEpisode(Center.Item(e5.Id)!));
        var file = Center.Item(e1.Id)!.File!;
        Assert.Equal(e1.Id, Center.ItemForFile(file)?.Id);

        Center.NotePlayback(e1.Id, 42, 3000);
        Assert.Equal(42, _rig.Db.AllDownloads().Single(d => d.Id == e1.Id).Position);
        Center.BinWatched(e1.Id);
        Assert.Null(Center.Item(e1.Id));
        Assert.Contains("Moved Severance S01E01 to the Recycle Bin, since you've watched it", _rig.Host.Toasts);
    }

    [Fact]
    public async Task DownloadingFromATabAddsTheTitleAndKnowsWhatItHas()
    {
        Server.Bytes("/v/720.mp4", [5, 5]);
        var tab = new FakeTab
        {
            Url = new Uri("https://site.test/film/dune"), DisplayTitle = "Dune",
            Parsed = new PageTitle { Name = "Dune", AltName = "Дюна", Year = 2021, KindHint = TitleKind.Film },
            SourcesFrameUrl = "https://player.test/embed/1",
        };
        Assert.False(Center.Download(tab));
        Assert.Contains("Play the video for a moment first, so Cineon can see its file", _rig.Host.Toasts);

        tab.SourceList.Add(DownloadRig.Source("https://cdn.test/v/720.mp4"));
        tab.SourceList.Add(DownloadRig.Source("https://cdn.test/v/en.vtt", MediaSourceKind.Subtitle));
        Assert.True(Center.Download(tab));
        var title = _rig.Library.Titles.Values.Single();
        Assert.Equal("Dune", title.Name);
        Assert.Equal((title.Id, "Дюна"), Assert.Single(_rig.Host.Enriched));
        Assert.Contains("Downloading Dune [720p]", _rig.Host.Toasts);
        await Center.IdleAsync();

        var item = Center.Items.Single();
        Assert.Equal(title.Id, item.TitleId);
        Assert.Equal("https://player.test/embed/1", item.Referer);
        Assert.Equal("site.test", item.Host);
        Assert.Equal(item.Id, Center.Existing(tab)?.Id);

        // Asking again plays what's already here.
        Assert.True(Center.Download(tab));
        Assert.Equal(item.Id, Assert.Single(_rig.Host.Played).Id);
    }

    [Fact]
    public async Task AnyFileCanBeFetchedAsThePageWould()
    {
        Server.Text("/s.vtt", "WEBVTT");
        _rig.Context.Cookies.Add(new BrowserCookie("a", "1", "cdn.test", "/", false));
        var data = await Center.FetchAsync(new Uri("https://cdn.test/s.vtt"), "https://site.test/p");
        Assert.Equal("WEBVTT", Encoding.UTF8.GetString(data!));
        Assert.Equal("a=1", Server.Last("/s.vtt").Headers.GetValues("Cookie").Single());
        Assert.Null(await Center.FetchAsync(new Uri("https://cdn.test/none.vtt"), null));
    }

    [Fact]
    public async Task APickedSubtitleFileIsCopiedNextToTheFilm()
    {
        Server.Bytes("/f.mp4", [1]);
        var item = _rig.Enqueue("https://cdn.test/f.mp4");
        await Center.IdleAsync();
        var picked = _rig.Folder.File("Arrival.ukr.srt");
        File.WriteAllText(picked, "1\n00:00:01,000 --> 00:00:02,000\nПривіт\n");
        var path = Center.AddSubtitles(picked, item.Id);
        Assert.Equal(Path.Combine(_rig.Downloads, "Arrival.uk.srt"), path);
        Assert.Equal([path!], Center.Item(item.Id)!.Subtitles);
    }

    [Fact]
    public async Task TheDurationIsReadOnceTheFileIsSaved()
    {
        _rig.Host.Duration = 5400;
        Server.Bytes("/f.mp4", [1]);
        var item = _rig.Enqueue("https://cdn.test/f.mp4");
        await Center.IdleAsync();
        Assert.Equal(5400, Center.Item(item.Id)!.Duration);
    }

    [Fact]
    public void CookiesFollowTheMacsRule()
    {
        BrowserCookie[] all =
        [
            new("a", "1", ".example.test", "/", false),
            new("b", "2", "example.test", "/", false),
            new("c", "3", "other.test", "/", false),
            new("d", "4", "cdn.example.test", "/video", false),
            new("e", "5", "cdn.example.test", "/", true),
        ];
        Assert.Equal("a=1; b=2; d=4", DownloadHttp.CookieHeader(DownloadHttp.CookiesFor(new Uri("http://cdn.example.test/video/1.mp4"), all)));
        Assert.Equal("a=1; b=2; e=5", DownloadHttp.CookieHeader(DownloadHttp.CookiesFor(new Uri("https://cdn.example.test/x"), all)));
        Assert.Null(DownloadHttp.CookieHeader([]));
    }
}
