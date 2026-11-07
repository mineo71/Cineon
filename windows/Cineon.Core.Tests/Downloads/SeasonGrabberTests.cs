using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Cineon.Core.Data;
using Cineon.Core.Downloads;

namespace Cineon.Core.Tests.Downloads;

/// <summary>A streaming site as SeasonGrabber sees it through the browser: episode pages and their files.</summary>
internal sealed partial class FakeSite : IEpisodeResolver
{
    public const string Page = "https://site.test/series/severance";
    public Dictionary<EpisodeRef, Uri> Files { get; } = [];
    public HashSet<EpisodeRef> Alive { get; } = [];
    public List<PublishedEpisode> Published { get; } = [];
    public bool PageList { get; set; } = true;
    public List<FakeHelperTab> Tabs { get; } = [];

    public void Episodes(int season, params int[] numbers)
    {
        foreach (var number in numbers)
        {
            var episode = new EpisodeRef(season, number);
            Files[episode] = new Uri($"https://cdn.test/media/s{season}e{number}.mp4");
            Alive.Add(episode);
        }
    }

    public static Uri UrlOf(EpisodeRef episode) => new($"{Page}/s{episode.Season}e{episode.Episode}");

    public static EpisodeRef? EpisodeOf(Uri url) =>
        EpisodePath().Match(url.OriginalString) is { Success: true } m
            ? new EpisodeRef(int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture))
            : null;

    [GeneratedRegex(@"/s(\d+)e(\d+)$")]
    private static partial Regex EpisodePath();

    public IEpisodeHelperTab MakeHelperTab()
    {
        var tab = new FakeHelperTab(this);
        lock (Tabs) Tabs.Add(tab);
        return tab;
    }

    public Uri? EpisodeUrl(Uri pageUrl, EpisodeRef current, EpisodeRef target) => UrlOf(target);

    public Task<bool> IsAliveAsync(Uri url, CancellationToken ct) => Task.FromResult(EpisodeOf(url) is { } e && Alive.Contains(e));

    public Task<IReadOnlyList<PublishedEpisode>> PublishedEpisodesAsync(Title title, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<PublishedEpisode>>(Published);
}

/// <summary>The hidden tab: opening an episode makes its player ask for its file.</summary>
internal sealed class FakeHelperTab(FakeSite site) : IEpisodeHelperTab
{
    private readonly Lock _gate = new();
    private readonly List<MediaSource> _sources = [];
    private double _clock;

    public Uri? CurrentUrl { get; private set; }
    public Uri? Url => CurrentUrl;
    public string DisplayTitle => "Severance";
    public long? LinkedTitleId => null;
    public EpisodeRef? TrackRef => null;
    public PageTitle? Parsed => null;
    public string? SourcesFrameUrl => "https://player.test/embed";
    public double MediaDuration => 3000;
    public bool Disposed { get; private set; }
    public int Paused { get; private set; }

    public IReadOnlyList<MediaSource> Sources
    {
        get
        {
            lock (_gate) return [.. _sources];
        }
    }

    public MediaSource? BestSource => MediaSource.Best(Sources, null);

    private void Show(EpisodeRef? episode)
    {
        lock (_gate)
        {
            for (var i = 0; i < _sources.Count; i++) _sources[i] = _sources[i] with { IsCurrent = false };
            if (episode is { } e && site.Files.TryGetValue(e, out var file))
            {
                _sources.Add(new MediaSource { Url = file, Kind = MediaSourceKind.File, FoundAt = ++_clock, IsCurrent = true });
            }
        }
    }

    public void Load(Uri url)
    {
        CurrentUrl = url;
        Show(FakeSite.EpisodeOf(url));
    }

    public void Reload() => Load(CurrentUrl!);

    public void PausePlayback() => Paused++;

    public Task<string?> EvaluateInPageAsync(string script)
    {
        var open = Regex.Match(script, @"__cineon\.openEpisode\((\d+),(\d+),false\)");
        if (open.Success)
        {
            if (!site.PageList) return Task.FromResult<string?>("false");
            Show(new EpisodeRef(int.Parse(open.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(open.Groups[2].Value, CultureInfo.InvariantCulture)));
            return Task.FromResult<string?>("true");
        }
        return Task.FromResult<string?>("true");
    }

    public void Dispose() => Disposed = true;
}

public sealed class SeasonGrabberTests : IDisposable
{
    private readonly DownloadRig _rig = new();
    private readonly FakeSite _site = new();
    private readonly string _profile;

    public SeasonGrabberTests()
    {
        _profile = _rig.Folder.File("Profile");
        Directory.CreateDirectory(_profile);
    }

    public void Dispose() => _rig.Dispose();

    private string JobFile => Path.Combine(_profile, SeasonGrabber.JobFileName);

    private SeasonGrabber Make()
    {
        foreach (var file in _site.Files.Values) _rig.Server.Bytes(file.AbsolutePath, Encoding.UTF8.GetBytes(file.AbsolutePath));
        return new SeasonGrabber(_rig.Center, _rig.Host, _site, _profile)
        {
            PollInterval = TimeSpan.FromMilliseconds(5),
            SlotInterval = TimeSpan.FromMilliseconds(5),
            NudgeInterval = TimeSpan.FromMilliseconds(50),
            // Generous: the whole suite runs in parallel, and CI machines are slower.
            FirstLoadTimeout = TimeSpan.FromMilliseconds(1500),
            EpisodeWait = TimeSpan.FromMilliseconds(1500),
        };
    }

    /// <summary>The tab on screen, on season 1 episode 2, with the page's own episode list.</summary>
    private static FakeTab ScreenTab(string? seasons = null, Func<int, string?>? episodes = null) => new()
    {
        Url = FakeSite.UrlOf(new EpisodeRef(1, 2)),
        TrackRef = new EpisodeRef(1, 2),
        Parsed = new PageTitle { Name = "Severance", Ref = new EpisodeRef(1, 2), KindHint = TitleKind.Series },
        Script = script =>
        {
            if (script.Contains("seasonsOnPage", StringComparison.Ordinal)) return seasons;
            var m = Regex.Match(script, @"episodesOnPage\((\d+)\)");
            return m.Success ? episodes?.Invoke(int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture)) : null;
        },
    };

    /// The grabber and the download center hand work to each other, so one wait on each isn't
    /// enough under load: wait until a whole pass finds nothing new.
    private async Task Settle(SeasonGrabber grabber)
    {
        string? last = null;
        for (var pass = 0; pass < 200; pass++)
        {
            await grabber.IdleAsync();
            await _rig.Center.IdleAsync();
            await Task.Delay(15, TestContext.Current.CancellationToken);
            var job = grabber.CurrentJob;
            var now = string.Join(",", _rig.Center.Items.Select(i => $"{i.Ref.Season}x{i.Ref.Episode}:{i.Status}"))
                + $"|{job?.Handled}|{job?.IsFinished}|{job?.IsPaused}|{grabber.IsBusy}|{_rig.Center.ActiveCount}";
            // Walking addresses pauses between probes, so a quiet moment isn't enough while it's busy.
            if (now == last && (!grabber.IsBusy || pass > 150)) return;
            last = now;
        }
    }

    private IEnumerable<EpisodeRef> Downloaded() =>
        _rig.Center.Items.Where(i => i.Status == DownloadStatus.Done).Select(i => i.Ref).OrderBy(r => r.Season).ThenBy(r => r.Episode);

    [Fact]
    public async Task ASeasonFromThePagesOwnListIsQueuedOneByOne()
    {
        _site.Episodes(1, 1, 2, 3);
        var grabber = Make();
        grabber.Start(ScreenTab(episodes: s => s == 1 ? "[1,2,3]" : "[]"), fromCurrent: false);
        await Settle(grabber);

        Assert.Equal([new EpisodeRef(1, 1), new EpisodeRef(1, 2), new EpisodeRef(1, 3)], Downloaded());
        var job = grabber.CurrentJob!;
        Assert.True(job.IsFinished);
        Assert.True(job.UsesPageList);
        Assert.Equal(3, job.Queued.Count);
        Assert.False(File.Exists(JobFile), "A finished job is forgotten");
        Assert.Contains("Getting 3 episodes of Severance, season 1", _rig.Host.Toasts);
        Assert.Contains("All 3 episodes of Severance, season 1 are downloading", _rig.Host.Toasts);
        Assert.True(_site.Tabs.Single().Disposed);

        var item = _rig.Center.Items.Single(i => i.Ref == new EpisodeRef(1, 3));
        Assert.Equal("Severance S01E03.mp4", Path.GetFileName(item.File));
        Assert.Equal(FakeSite.UrlOf(new EpisodeRef(1, 3)), item.PageUrl);
        Assert.Equal("https://player.test/embed", item.Referer);
        Assert.Equal(_rig.Library.Titles.Values.Single().Id, item.TitleId);

        grabber.Dismiss();
        Assert.Null(grabber.CurrentJob);
    }

    [Fact]
    public async Task FromTheCurrentEpisodeLeavesOutTheOnesBefore()
    {
        _site.Episodes(1, 1, 2, 3);
        var grabber = Make();
        grabber.Start(ScreenTab(episodes: _ => "[1,2,3]"), fromCurrent: true);
        await Settle(grabber);
        Assert.Equal([new EpisodeRef(1, 2), new EpisodeRef(1, 3)], Downloaded());
    }

    [Fact]
    public async Task WithoutAListTheAddressesAreWalked()
    {
        _site.Episodes(1, 1, 2, 3, 4);
        _site.PageList = false;
        var grabber = Make();
        grabber.Start(ScreenTab(), fromCurrent: false);
        await Settle(grabber);
        Assert.Equal(4, Downloaded().Count());
        Assert.False(grabber.CurrentJob!.UsesPageList);
    }

    [Fact]
    public async Task MissedEpisodesAreReported()
    {
        _site.Episodes(1, 1, 2);
        // Episode 3 has a page but its player never asks for a file.
        _site.Alive.Add(new EpisodeRef(1, 3));
        var grabber = Make();
        grabber.Start(ScreenTab(episodes: _ => "[1,2,3]"), fromCurrent: false);
        await Settle(grabber);
        Assert.Equal([new EpisodeRef(1, 3)], grabber.CurrentJob!.Missed);
        Assert.Contains("Queued 2 of 3. Couldn't find the file for S1 E3", _rig.Host.Toasts);
    }

    [Fact]
    public async Task EpisodesAlreadyHereAreNotFetchedTwice()
    {
        _site.Episodes(1, 1, 2);
        var grabber = Make();
        grabber.Start(ScreenTab(episodes: _ => "[1,2]"), fromCurrent: false);
        await Settle(grabber);
        grabber.Dismiss();
        grabber.Start(ScreenTab(episodes: _ => "[1,2]"), fromCurrent: false);
        await Settle(grabber);
        Assert.Contains("Every episode of this season is already on this PC", _rig.Host.Toasts);
        Assert.Equal(2, _rig.Center.Items.Count);
    }

    [Fact]
    public async Task AWholeSeriesWaitsForAYes()
    {
        _site.Episodes(1, 1, 2);
        _site.Episodes(2, 1);
        var grabber = Make();
        var looked = false;
        grabber.Changed += (_, _) => looked |= grabber.IsLooking;
        grabber.StartSeries(ScreenTab(seasons: "[1,2]", episodes: s => s == 1 ? "[1,2]" : "[1]"));
        await Settle(grabber);
        Assert.True(looked);
        Assert.False(grabber.IsLooking);
        Assert.Contains("Looking for every episode of Severance…", _rig.Host.Toasts);

        var proposal = grabber.PendingProposal!;
        Assert.Equal(3, proposal.Job.Episodes.Count);
        Assert.Equal(SeasonGrabber.Scope.Series, proposal.Job.Scope);
        Assert.Equal(SeasonGrabber.GuessedBytesPerEpisode, proposal.BytesPerEpisode);
        Assert.False(proposal.IsMeasured);
        Assert.NotNull(proposal.FreeBytes);
        Assert.Empty(_rig.Center.Items);

        grabber.Confirm();
        await Settle(grabber);
        Assert.Equal(3, Downloaded().Count());
        Assert.Contains("All 3 episodes of Severance, all 2 seasons are downloading", _rig.Host.Toasts);
    }

    [Fact]
    public async Task SeasonsComeFromTheCatalogueWhenThePageHasNoList()
    {
        _site.Episodes(1, 1, 2);
        _site.Episodes(2, 1, 2);
        var released = DateTimeOffset.UtcNow.AddDays(-30);
        _site.Published.AddRange([
            new PublishedEpisode(1, 1, released), new PublishedEpisode(1, 2, released),
            new PublishedEpisode(2, 1, released), new PublishedEpisode(2, 2, released),
            new PublishedEpisode(2, 3, DateTimeOffset.UtcNow.AddDays(30)),
        ]);
        var grabber = Make();
        grabber.StartSeries(ScreenTab());
        await Settle(grabber);
        Assert.Equal(
            [new EpisodeRef(1, 1), new EpisodeRef(1, 2), new EpisodeRef(2, 1), new EpisodeRef(2, 2)],
            grabber.PendingProposal!.Job.Episodes);
        grabber.Decline();
        Assert.Null(grabber.PendingProposal);
    }

    [Fact]
    public void OnlyOneJobAtATimeAndOnlyFromAnEpisode()
    {
        var grabber = Make();
        grabber.Start(new FakeTab { Url = new Uri("https://site.test/film"), Parsed = new PageTitle { Name = "Dune" } }, fromCurrent: false);
        Assert.Contains("Open an episode of the series first", _rig.Host.Toasts);
    }

    [Fact]
    public async Task AJobLeftByAClosedCineonCarriesOn()
    {
        _site.Episodes(1, 1, 2, 3);
        // Episode 1 was queued and stopped with Cineon; episode 2 finished.
        var stopped = new DownloadItem
        {
            Name = "Severance", Ref = new EpisodeRef(1, 1), SourceUrl = _site.Files[new EpisodeRef(1, 1)],
            Status = DownloadStatus.Downloading, CreatedAt = DateTimeOffset.UtcNow,
        };
        _rig.Db.InsertDownload(stopped);
        _rig.Db.InsertDownload(stopped with { Ref = new EpisodeRef(1, 2), Status = DownloadStatus.Done, SourceUrl = _site.Files[new EpisodeRef(1, 2)] });
        // As the Mac writes it, mid-run.
        File.WriteAllText(JobFile, $$"""
            {"scope":"season","name":"Severance","season":1,"episodes":[{"season":1,"episode":1},{"season":1,"episode":2},{"season":1,"episode":3}],"queued":[{"season":1,"episode":1},{"season":1,"episode":2}],"missed":[],"current":{"season":1,"episode":3},"pageURL":"{{FakeSite.UrlOf(new EpisodeRef(1, 2)).OriginalString.Replace("/", "\\/")}}","startRef":{"season":1,"episode":2},"usesPageList":true,"isFinished":false,"isPaused":false}
            """);

        var grabber = Make();
        var job = grabber.CurrentJob!;
        Assert.True(job.IsPaused);
        Assert.Null(job.Current);
        Assert.False(grabber.IsRunning);
        var (message, title, action) = _rig.Host.Actions.Single(a => a.Message.Contains("stopped when Cineon closed", StringComparison.Ordinal));
        Assert.Equal("Getting Severance, season 1 stopped when Cineon closed", message);
        Assert.Equal("Carry on", title);

        action!();
        Assert.Contains("Carrying on with Severance, season 1: 2 to go", _rig.Host.Toasts);
        await Settle(grabber);
        Assert.Equal([new EpisodeRef(1, 1), new EpisodeRef(1, 2), new EpisodeRef(1, 3)], Downloaded());
        // The stopped copy went, rather than staying beside the new one.
        Assert.DoesNotContain(_rig.Center.Items, i => i.Status == DownloadStatus.Failed);
        Assert.True(grabber.CurrentJob!.IsFinished);
    }

    [Fact]
    public async Task SuspendingKeepsTheJobForNextTime()
    {
        _site.Episodes(1, 1, 2, 3);
        // Nothing can start, so the job waits for a free slot.
        var gate = new TaskCompletionSource();
        _rig.Server.Route("/busy.mp4", async request =>
        {
            await gate.Task;
            return FakeServer.Serve(request, [1]);
        });
        _rig.Enqueue("https://cdn.test/busy.mp4", name: "A");
        _rig.Enqueue("https://cdn.test/busy.mp4", name: "B");
        var grabber = Make();
        grabber.Start(ScreenTab(episodes: _ => "[1,2,3]"), fromCurrent: false);
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!File.Exists(JobFile) && DateTime.UtcNow < deadline) await Task.Delay(5, TestContext.Current.CancellationToken);
        Assert.True(grabber.IsRunning);
        Assert.True(grabber.IsBusy);

        grabber.Start(ScreenTab(episodes: _ => "[1,2,3]"), fromCurrent: false);
        Assert.Contains("Already getting Severance, season 1", _rig.Host.Toasts);

        grabber.Suspend();
        Assert.True(grabber.CurrentJob!.IsPaused);
        var saved = SeasonGrabber.Job.Decode(File.ReadAllBytes(JobFile))!;
        Assert.True(saved.IsPaused);
        Assert.Equal(3, saved.Remaining.Count);
        gate.SetResult();
        await Settle(grabber);
        Assert.DoesNotContain(_rig.Center.Items, i => i.Name == "Severance");

        // Cancelling instead finishes it and says so.
        grabber.Cancel();
        Assert.Contains("Stopped getting Severance, season 1", _rig.Host.Toasts);
        Assert.False(File.Exists(JobFile));
    }
}
