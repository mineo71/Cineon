using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using Cineon.Core.Data;

namespace Cineon.Core.Downloads;

// Port of Cineon/Downloads/SeasonGrabber.swift.

/// <summary>An episode as the catalogue lists it, for finding a season's episodes.</summary>
public sealed record PublishedEpisode(int Season, int Episode, DateTimeOffset? Released);

/// <summary>
/// What SeasonGrabber needs from the browser and the catalogue. The browser port implements it:
/// <list type="bullet">
/// <item><see cref="MakeHelperTab"/>: a hidden tab (the Mac's helper <c>BrowserTab</c> in an off-screen
/// window). Its WebView2 must keep playing while nobody sees it: host it in a window off screen and
/// keep <c>CoreWebView2Controller.IsVisible</c> true, so the player loads and asks for its file.</item>
/// <item><see cref="EpisodeUrl"/>: <c>Cineon.Core.Parsing.EpisodeLinks.Url(pageUrl, current, target)</c>.</item>
/// <item><see cref="IsAliveAsync"/>: <c>SiteProbe.check(url)</c> is <c>.alive</c>.</item>
/// <item><see cref="PublishedEpisodesAsync"/>: <c>MetadataService.EpisodesAsync(title)</c>, mapped.</item>
/// </list>
/// </summary>
public interface IEpisodeResolver
{
    IEpisodeHelperTab MakeHelperTab();

    /// <summary>The address of another episode of the series on the same site, or null when there's no way to tell.</summary>
    Uri? EpisodeUrl(Uri pageUrl, EpisodeRef current, EpisodeRef target);

    /// <summary>Whether the site answers this address with a page (not missing, not dead).</summary>
    Task<bool> IsAliveAsync(Uri url, CancellationToken ct);

    /// <summary>The series' episodes as the catalogue lists them, or none.</summary>
    Task<IReadOnlyList<PublishedEpisode>> PublishedEpisodesAsync(Title title, CancellationToken ct);
}

/// <summary>
/// A hidden tab that opens episodes and reports the files their players ask for. Disposing it tears
/// its WebView2 down (the Mac's <c>tearDownWebView</c>).
/// </summary>
public interface IEpisodeHelperTab : IDownloadTab, IDisposable
{
    /// <summary>The address the WebView2 is on now (<c>webView.url</c>).</summary>
    Uri? CurrentUrl { get; }
    void Load(Uri url);
    void Reload();
    void PausePlayback();
}

/// <summary>
/// Downloads a season, or every season of a series. A hidden tab opens each episode in turn, waits
/// for its player to ask for the file, and hands that to the download queue. Each link is fetched just
/// before its turn, because streaming sites' links expire while they wait. The job is saved as it
/// goes, so one that's still running when Cineon closes can carry on next time.
/// Like the Mac's main-actor class, call it on the UI thread; its own work comes back there.
/// </summary>
public sealed class SeasonGrabber
{
    public enum Scope { Season, Series }

    /// <summary>A season or series being fetched. Saved as <c>download-job.json</c>, in the Mac's shape.</summary>
    public sealed record Job
    {
        public Scope Scope { get; init; }
        public long? TitleId { get; init; }
        public string Name { get; init; } = "";
        public int Season { get; init; }
        public IReadOnlyList<EpisodeRef> Episodes { get; init => field = ValueList<EpisodeRef>.Of(value); } = ValueList<EpisodeRef>.Empty;
        public IReadOnlyList<EpisodeRef> Queued { get; init => field = ValueList<EpisodeRef>.Of(value); } = ValueList<EpisodeRef>.Empty;
        public IReadOnlyList<EpisodeRef> Missed { get; init => field = ValueList<EpisodeRef>.Of(value); } = ValueList<EpisodeRef>.Empty;
        public EpisodeRef? Current { get; init; }
        public required Uri PageUrl { get; init; }
        public EpisodeRef StartRef { get; init; }
        public Uri? PosterUrl { get; init; }
        public bool UsesPageList { get; init; }
        public bool IsFinished { get; init; }
        /// <summary>Stopped when Cineon closed, and waiting to carry on.</summary>
        public bool IsPaused { get; init; }

        public IReadOnlyList<int> Seasons => [.. Episodes.Select(e => e.Season).Distinct().Order()];

        public string Label
        {
            get
            {
                if (Scope == Scope.Season) return Season > 0 ? $"{Name}, season {Season}" : Name;
                var seasons = Seasons;
                return seasons.Count == 1 ? $"{Name}, season {seasons[0]}" : $"{Name}, all {seasons.Count} seasons";
            }
        }

        public int Handled => Queued.Count + Missed.Count;

        /// <summary>What's left to look for, in order.</summary>
        public IReadOnlyList<EpisodeRef> Remaining => [.. Episodes.Where(e => !Queued.Contains(e) && !Missed.Contains(e))];

        // MARK: JSON, as Swift's JSONEncoder writes the Codable struct

        public byte[] Encode()
        {
            using var stream = new MemoryStream();
            using (var w = new Utf8JsonWriter(stream, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
            {
                w.WriteStartObject();
                w.WriteString("scope", Scope == Scope.Season ? "season" : "series");
                if (TitleId is long titleId) w.WriteNumber("titleID", titleId);
                w.WriteString("name", Name);
                w.WriteNumber("season", Season);
                WriteRefs(w, "episodes", Episodes);
                WriteRefs(w, "queued", Queued);
                WriteRefs(w, "missed", Missed);
                if (Current is { } current)
                {
                    w.WritePropertyName("current");
                    WriteRef(w, current);
                }
                w.WriteString("pageURL", PageUrl.OriginalString);
                w.WritePropertyName("startRef");
                WriteRef(w, StartRef);
                if (PosterUrl is { } poster) w.WriteString("posterURL", poster.OriginalString);
                w.WriteBoolean("usesPageList", UsesPageList);
                w.WriteBoolean("isFinished", IsFinished);
                w.WriteBoolean("isPaused", IsPaused);
                w.WriteEndObject();
            }
            return stream.ToArray();
        }

        private static void WriteRefs(Utf8JsonWriter w, string name, IReadOnlyList<EpisodeRef> refs)
        {
            w.WriteStartArray(name);
            foreach (var episode in refs) WriteRef(w, episode);
            w.WriteEndArray();
        }

        private static void WriteRef(Utf8JsonWriter w, EpisodeRef episode)
        {
            w.WriteStartObject();
            w.WriteNumber("season", episode.Season);
            w.WriteNumber("episode", episode.Episode);
            w.WriteEndObject();
        }

        /// <summary>A job written by this app or by the Mac's, or null if it isn't one.</summary>
        public static Job? Decode(ReadOnlySpan<byte> json)
        {
            try
            {
                var reader = new Utf8JsonReader(json);
                using var doc = JsonDocument.ParseValue(ref reader);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return null;
                var scope = Text(root, "scope") switch
                {
                    "season" => Scope.Season,
                    "series" => Scope.Series,
                    _ => (Scope?)null,
                };
                if (scope is null || Text(root, "name") is not { } name || Int(root, "season") is not int season ||
                    Refs(root, "episodes") is not { } episodes || Urls.Parse(Text(root, "pageURL")) is not { } pageUrl ||
                    Ref(root, "startRef") is not { } startRef || Bool(root, "usesPageList") is not bool usesPageList)
                {
                    return null;
                }
                return new Job
                {
                    Scope = scope.Value,
                    TitleId = root.TryGetProperty("titleID", out var id) && id.ValueKind == JsonValueKind.Number && id.TryGetInt64(out var t) ? t : null,
                    Name = name,
                    Season = season,
                    Episodes = episodes,
                    Queued = Refs(root, "queued") ?? [],
                    Missed = Refs(root, "missed") ?? [],
                    Current = Ref(root, "current"),
                    PageUrl = pageUrl,
                    StartRef = startRef,
                    PosterUrl = Urls.Parse(Text(root, "posterURL")),
                    UsesPageList = usesPageList,
                    IsFinished = Bool(root, "isFinished") ?? false,
                    IsPaused = Bool(root, "isPaused") ?? false,
                };
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static string? Text(JsonElement o, string key) =>
            o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private static int? Int(JsonElement o, string key) =>
            o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

        private static bool? Bool(JsonElement o, string key) =>
            o.TryGetProperty(key, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

        private static EpisodeRef? Ref(JsonElement o, string key) =>
            o.TryGetProperty(key, out var v) ? ReadRef(v) : null;

        private static EpisodeRef? ReadRef(JsonElement v) =>
            v.ValueKind == JsonValueKind.Object && Int(v, "season") is int s && Int(v, "episode") is int e ? new EpisodeRef(s, e) : null;

        private static List<EpisodeRef>? Refs(JsonElement o, string key)
        {
            if (!o.TryGetProperty(key, out var v) || v.ValueKind != JsonValueKind.Array) return null;
            var refs = new List<EpisodeRef>();
            foreach (var item in v.EnumerateArray())
            {
                if (ReadRef(item) is not { } episode) return null;
                refs.Add(episode);
            }
            return refs;
        }
    }

    /// <summary>A whole series, found and waiting for a yes, because it can be very big.</summary>
    public sealed record Proposal
    {
        public required Job Job { get; init; }
        public long BytesPerEpisode { get; init; }
        /// <summary>From episodes downloaded before, rather than a round guess.</summary>
        public bool IsMeasured { get; init; }
        public long? FreeBytes { get; init; }

        public long TotalBytes => BytesPerEpisode * Job.Episodes.Count;
        public bool Fits => FreeBytes is not long free || TotalBytes < free;

        public IReadOnlyList<(int Season, int Count)> SeasonCounts =>
            [.. Job.Episodes.GroupBy(e => e.Season).Select(g => (g.Key, g.Count())).OrderBy(p => p.Key)];
    }

    /// <summary>How long one episode's player gets to ask for its file, in seconds.</summary>
    public const double EpisodeTimeout = 45;
    /// <summary>A guess for an episode's size when nothing has been downloaded yet to go by.</summary>
    public const long GuessedBytesPerEpisode = 1_000_000_000;

    public const string JobFileName = "download-job.json";

    private readonly DownloadCenter _downloads;
    private readonly IDownloadHost _host;
    private readonly IEpisodeResolver _resolver;
    private readonly string _jobFile;
    private IEpisodeHelperTab? _helper;
    private CancellationTokenSource? _runner;
    private HashSet<string> _used = [];

    /// <summary>The Mac's <c>job</c>: the season or series being fetched, or the last one, until dismissed.</summary>
    public Job? CurrentJob { get; private set; }
    /// <summary>The Mac's <c>proposal</c>.</summary>
    public Proposal? PendingProposal { get; private set; }
    /// <summary>Finding a whole series' seasons and episodes, before asking.</summary>
    public bool IsLooking { get; private set; }

    /// <summary>Raised after the job, the proposal or <see cref="IsLooking"/> changed.</summary>
    public event EventHandler? Changed;

    // Waits, shortened by tests.
    internal TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(0.5);
    internal TimeSpan SlotInterval { get; set; } = TimeSpan.FromSeconds(1.5);
    internal TimeSpan NudgeInterval { get; set; } = TimeSpan.FromSeconds(4);
    internal TimeSpan FirstLoadTimeout { get; set; } = TimeSpan.FromSeconds(20);
    internal TimeSpan EpisodeWait { get; set; } = TimeSpan.FromSeconds(EpisodeTimeout);
    private readonly List<Task> _work = [];

    /// <summary>Waits until nothing is looking for episodes or running a job. For tests and for closing.</summary>
    internal async Task IdleAsync()
    {
        while (true)
        {
            Task[] pending;
            lock (_work)
            {
                _work.RemoveAll(t => t.IsCompleted);
                pending = [.. _work];
            }
            if (pending.Length == 0) return;
            await Task.WhenAll(pending);
        }
    }

    /// <param name="profileDirectory">The profile's folder (<c>AppPaths.Profile(id)</c>), where the job is kept.</param>
    public SeasonGrabber(DownloadCenter downloads, IDownloadHost host, IEpisodeResolver resolver, string profileDirectory)
    {
        _downloads = downloads;
        _host = host;
        _resolver = resolver;
        _jobFile = Path.Combine(profileDirectory, JobFileName);
        Restore();
    }

    public bool IsRunning => CurrentJob is { IsFinished: false, IsPaused: false };
    public bool IsBusy => IsRunning || IsLooking;

    // MARK: Starting

    /// <summary>Starts from the series in this tab. <paramref name="fromCurrent"/> leaves out the episodes before the one on screen.</summary>
    public void Start(IDownloadTab tab, bool fromCurrent)
    {
        if (Prepare(tab) is not { } prepared) return;
        var (pageUrl, current, title, name) = prepared;
        var runner = NewRunner();
        Spawn(async () =>
        {
            var (episodes, onPage) = await EpisodeListAsync(current.Season, title, tab, pageUrl, current, runner.Token);
            if (runner.IsCancellationRequested) return;
            var list = fromCurrent ? episodes.Where(e => DownloadCenter.Compare(e, current) >= 0).ToList() : [.. episodes];
            // What's already on this PC, or on its way, isn't fetched twice.
            var have = Have(title?.Id, name);
            list.RemoveAll(have.Contains);
            if (episodes.Count == 0)
            {
                _host.ShowToast("Cineon couldn't find this season's episodes");
                return;
            }
            if (list.Count == 0)
            {
                _host.ShowToast("Every episode of this season is already on this PC");
                return;
            }
            Launch(new Job
            {
                Scope = Scope.Season, TitleId = title?.Id, Name = name, Season = current.Season, Episodes = list, PageUrl = pageUrl,
                StartRef = current, PosterUrl = title?.PosterUrl ?? tab.Parsed?.PosterUrl, UsesPageList = onPage,
            });
        });
    }

    /// <summary>Finds every season of the series in this tab and asks before getting them.</summary>
    public void StartSeries(IDownloadTab tab)
    {
        if (Prepare(tab) is not { } prepared) return;
        var (pageUrl, current, title, name) = prepared;
        IsLooking = true;
        RaiseChanged();
        _host.ShowToast($"Looking for every episode of {name}…");
        var runner = NewRunner();
        Spawn(async () =>
        {
            try
            {
                var seasons = await SeasonListAsync(title, tab, pageUrl, current, runner.Token);
                var episodes = new List<EpisodeRef>();
                var onPage = false;
                foreach (var season in seasons)
                {
                    if (runner.IsCancellationRequested) return;
                    var (list, fromPage) = await EpisodeListAsync(season, title, tab, pageUrl, current, runner.Token);
                    episodes.AddRange(list);
                    onPage = onPage || fromPage;
                }
                if (runner.IsCancellationRequested) return;
                var have = Have(title?.Id, name);
                var wanted = episodes.Where(e => !have.Contains(e)).ToList();
                if (episodes.Count == 0)
                {
                    _host.ShowToast($"Cineon couldn't find the episodes of {name}");
                    return;
                }
                if (wanted.Count == 0)
                {
                    _host.ShowToast($"Every episode of {name} is already on this PC");
                    return;
                }
                var job = new Job
                {
                    Scope = Scope.Series, TitleId = title?.Id, Name = name, Season = current.Season, Episodes = wanted, PageUrl = pageUrl,
                    StartRef = current, PosterUrl = title?.PosterUrl ?? tab.Parsed?.PosterUrl, UsesPageList = onPage,
                };
                var (perEpisode, measured) = BytesPerEpisode();
                PendingProposal = new Proposal
                {
                    Job = job, BytesPerEpisode = perEpisode, IsMeasured = measured, FreeBytes = FreeSpace(_downloads.Folder),
                };
            }
            finally
            {
                IsLooking = false;
                RaiseChanged();
            }
        });
    }

    /// <summary>Yes to the whole series.</summary>
    public void Confirm()
    {
        if (PendingProposal is not { } proposal) return;
        PendingProposal = null;
        Launch(proposal.Job);
    }

    public void Decline()
    {
        PendingProposal = null;
        RaiseChanged();
    }

    /// <summary>Carries on with a job that stopped when Cineon closed.</summary>
    public void Resume()
    {
        if (CurrentJob is not { IsPaused: true } paused || IsBusy) return;
        var have = Have(paused.TitleId, paused.Name);
        // Episodes queued last time whose download stopped with Cineon go round again, without
        // leaving their stopped copies behind in Downloads.
        foreach (var item in _downloads.Items.Where(i =>
                     i.Status == DownloadStatus.Failed && paused.Episodes.Contains(i.Ref) &&
                     (paused.TitleId is not null ? i.TitleId == paused.TitleId : i.Name == paused.Name)).ToList())
        {
            _downloads.Remove(item.Id);
        }
        paused = paused with { Queued = [.. paused.Queued.Where(have.Contains)], Missed = [], IsPaused = false };
        CurrentJob = paused;
        Persist();
        RaiseChanged();
        _host.ShowToast($"Carrying on with {paused.Label}: {paused.Remaining.Count} to go");
        var runner = NewRunner();
        Spawn(() => RunAsync(runner.Token));
    }

    public void Cancel()
    {
        PendingProposal = null;
        _runner?.Cancel();
        _runner = null;
        Finish(cancelled: true);
    }

    /// <summary>The profile is closing: stop now, and keep the job to carry on with next time.</summary>
    public void Suspend()
    {
        PendingProposal = null;
        _runner?.Cancel();
        _runner = null;
        TearDown();
        if (CurrentJob is not { IsFinished: false } current) return;
        CurrentJob = current with { IsPaused = true, Current = null };
        Persist();
        RaiseChanged();
    }

    public void Dismiss()
    {
        if (CurrentJob?.IsFinished != true) return;
        CurrentJob = null;
        Persist();
        RaiseChanged();
    }

    private (Uri PageUrl, EpisodeRef Current, Title? Title, string Name)? Prepare(IDownloadTab tab)
    {
        if (IsBusy)
        {
            _host.ShowToast(IsLooking ? "Still looking for the episodes" : $"Already getting {CurrentJob?.Label ?? "a season"}");
            return null;
        }
        if (tab.Url is not { } pageUrl || (tab.TrackRef ?? tab.Parsed?.Ref) is not { IsEpisode: true } current)
        {
            _host.ShowToast("Open an episode of the series first");
            return null;
        }
        var title = _downloads.LibraryTitle(tab);
        return (pageUrl, current, title, title?.Name ?? tab.Parsed?.Name ?? tab.DisplayTitle);
    }

    private void Launch(Job job)
    {
        CurrentJob = job;
        Persist();
        RaiseChanged();
        _host.ShowToast($"Getting {job.Episodes.Count} episode{(job.Episodes.Count == 1 ? "" : "s")} of {job.Label}");
        var runner = NewRunner();
        Spawn(() => RunAsync(runner.Token));
    }

    private CancellationTokenSource NewRunner()
    {
        _runner?.Cancel();
        _runner = new CancellationTokenSource();
        return _runner;
    }

    private void Spawn(Func<Task> body)
    {
        var task = Guard(body);
        lock (_work) _work.Add(task);
    }

    /// <summary>Runs a step of the job, treating cancellation as the end of it.</summary>
    private static async Task Guard(Func<Task> body)
    {
        try
        {
            await body();
        }
        catch (OperationCanceledException)
        {
        }
    }

    /// <summary>Episodes of this title already on this PC or on their way.</summary>
    private HashSet<EpisodeRef> Have(long? titleId, string name) =>
        [.. _downloads.Items
            .Where(i => i.Status != DownloadStatus.Failed && (titleId is not null ? i.TitleId == titleId : i.Name == name))
            .Select(i => i.Ref)];

    /// <summary>How big an episode is likely to be: the average of the episodes downloaded before, or a gigabyte.</summary>
    private (long Bytes, bool Measured) BytesPerEpisode()
    {
        var sizes = _downloads.Items
            .Where(i => i.Status == DownloadStatus.Done && i.Ref.IsEpisode && i.TotalBytes > 0)
            .Select(i => i.TotalBytes)
            .ToList();
        if (sizes.Count == 0) return (GuessedBytesPerEpisode, false);
        return (sizes.Sum() / sizes.Count, true);
    }

    /// <summary>Free space on the drive the folder is (or will be) on. Null when it can't be read.</summary>
    public static long? FreeSpace(string folder)
    {
        try
        {
            var path = Path.GetFullPath(folder);
            while (!Directory.Exists(path) && Path.GetDirectoryName(path) is { } parent && parent != path) path = parent;
            // The drive whose root is the longest match: on a Mac or Linux, volumes are mounted inside "/".
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            DriveInfo? best = null;
            foreach (var drive in DriveInfo.GetDrives())
            {
                string root;
                try
                {
                    if (!drive.IsReady) continue;
                    root = drive.RootDirectory.FullName;
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    continue;
                }
                var isInside = path.StartsWith(root, comparison) &&
                    (path.Length == root.Length || root.EndsWith(Path.DirectorySeparatorChar) || path[root.Length] == Path.DirectorySeparatorChar);
                if (isInside && (best is null || root.Length > best.RootDirectory.FullName.Length)) best = drive;
            }
            best ??= Path.GetPathRoot(path) is { Length: > 0 } pathRoot ? new DriveInfo(pathRoot) : null;
            return best?.AvailableFreeSpace;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    // MARK: Finding the episodes

    /// <summary>
    /// Every season of the series: from the page's own list, the published episode list, or by trying
    /// the first episode of each season's address.
    /// </summary>
    private async Task<List<int>> SeasonListAsync(Title? title, IDownloadTab tab, Uri pageUrl, EpisodeRef current, CancellationToken ct)
    {
        var seasons = new HashSet<int> { current.Season };
        if (Numbers(await tab.EvaluateInPageAsync("window.__cineon ? __cineon.seasonsOnPage() : []")) is { } numbers)
        {
            seasons.UnionWith(numbers.Where(n => n > 0));
        }
        if (seasons.Count == 1 && title is not null)
        {
            var now = DateTimeOffset.UtcNow;
            var aired = (await _resolver.PublishedEpisodesAsync(title, ct))
                .Where(e => e.Season > 0 && (e.Released ?? DateTimeOffset.MinValue) <= now);
            seasons.UnionWith(aired.Select(e => e.Season));
        }
        if (seasons.Count == 1)
        {
            for (var season = 1; season <= 30; season++)
            {
                if (season == current.Season) continue;
                if (ct.IsCancellationRequested) break;
                if (_resolver.EpisodeUrl(pageUrl, current, new EpisodeRef(season, 1)) is not { } url) break;
                if (await _resolver.IsAliveAsync(url, ct)) seasons.Add(season);
                else if (season > current.Season) break;
            }
        }
        return [.. seasons.Order()];
    }

    /// <summary>The season's episodes: from the page's own list, the published list, or by trying addresses.</summary>
    private async Task<(List<EpisodeRef> Episodes, bool OnPage)> EpisodeListAsync(
        int season, Title? title, IDownloadTab tab, Uri pageUrl, EpisodeRef current, CancellationToken ct)
    {
        var script = $"window.__cineon ? __cineon.episodesOnPage({season.ToString(CultureInfo.InvariantCulture)}) : []";
        if (Numbers(await tab.EvaluateInPageAsync(script)) is { Count: > 0 } numbers)
        {
            return ([.. numbers.Select(n => new EpisodeRef(season, n))], true);
        }
        if (title is not null)
        {
            var now = DateTimeOffset.UtcNow;
            var aired = (await _resolver.PublishedEpisodesAsync(title, ct))
                .Where(e => e.Season == season && e.Episode > 0 && (e.Released ?? DateTimeOffset.MinValue) <= now)
                .Select(e => new EpisodeRef(e.Season, e.Episode))
                .OrderBy(e => e.Episode)
                .ToList();
            if (aired.Count > 0 && _resolver.EpisodeUrl(pageUrl, current, aired[0]) is not null) return (aired, false);
        }
        // Nothing published: walk the addresses until one is missing. In the season on screen the
        // walk goes at least as far as the episode playing.
        var floor = season == current.Season ? current.Episode : 0;
        var found = new List<EpisodeRef>();
        for (var number = 1; number <= 60; number++)
        {
            if (ct.IsCancellationRequested) break;
            var episode = new EpisodeRef(season, number);
            if (episode == current)
            {
                found.Add(episode);
                continue;
            }
            if (_resolver.EpisodeUrl(pageUrl, current, episode) is not { } url) return ([], false);
            if (await _resolver.IsAliveAsync(url, ct)) found.Add(episode);
            else if (number > floor) break;
        }
        return (found, false);
    }

    /// <summary>A script's result as whole numbers, like Swift's <c>as? [NSNumber]</c>: null unless it's an array of numbers.</summary>
    internal static List<int>? Numbers(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
            var numbers = new List<int>();
            foreach (var item in doc.RootElement.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Number) return null;
                numbers.Add((int)Math.Truncate(item.GetDouble()));
            }
            return numbers;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // MARK: Running

    private async Task RunAsync(CancellationToken ct)
    {
        if (CurrentJob is not { } job) return;
        var tab = _resolver.MakeHelperTab();
        _helper = tab;
        _used = [];
        tab.Load(job.PageUrl);
        _ = await WaitForSourceAsync(tab, [], FirstLoadTimeout, ct);

        foreach (var episode in job.Remaining)
        {
            // Links expire, so each one is fetched only when there's room to start it.
            // Cancelled first, always: a closed profile mustn't be touched again.
            while (true)
            {
                if (ct.IsCancellationRequested) return;
                if (_downloads.HasFreeSlot) break;
                await Task.Delay(SlotInterval, ct);
            }
            if (CurrentJob is { } running)
            {
                CurrentJob = running with { Current = episode };
                Persist();
                RaiseChanged();
            }
            var found = await ResolveAsync(episode, tab, ct);
            if (ct.IsCancellationRequested) return;
            if (found is not null && CurrentJob is { } current)
            {
                _used.Add(found.Url.OriginalString);
                var subtitles = tab.Sources.Where(s => s.Kind == MediaSourceKind.Subtitle && s.IsCurrent).Take(6).Select(s => s.Url).ToList();
                _downloads.Enqueue(
                    found, current.TitleId, episode, current.Name,
                    _resolver.EpisodeUrl(current.PageUrl, current.StartRef, episode) ?? current.PageUrl,
                    tab.SourcesFrameUrl ?? current.PageUrl.OriginalString, tab.MediaDuration, current.PosterUrl, subtitles);
                CurrentJob = current with { Queued = [.. current.Queued, episode] };
            }
            else if (CurrentJob is { } missed)
            {
                CurrentJob = missed with { Missed = [.. missed.Missed, episode] };
            }
            Persist();
            RaiseChanged();
            tab.PausePlayback();
        }
        Finish(cancelled: false);
    }

    /// <summary>Opens one episode in the helper tab and waits for the file its player asks for.</summary>
    private async Task<MediaSource?> ResolveAsync(EpisodeRef episode, IEpisodeHelperTab tab, CancellationToken ct)
    {
        if (CurrentJob is not { } job) return null;
        // The page opened on this episode, so what it loaded is already it.
        if (episode == job.StartRef && tab.BestSource is { } best && best.Kind != MediaSourceKind.Subtitle &&
            !_used.Contains(best.Url.OriginalString))
        {
            return best;
        }
        var stale = tab.Sources.Select(s => s.Url.OriginalString).ToHashSet();
        stale.UnionWith(_used);
        if (job.UsesPageList)
        {
            var script = string.Create(CultureInfo.InvariantCulture, $"__cineon.openEpisode({episode.Season},{episode.Episode},false)");
            if (await tab.EvaluateInPageAsync(script) == "true")
            {
                if (await WaitForSourceAsync(tab, stale, EpisodeWait, ct) is { } found) return found;
                if (ct.IsCancellationRequested) return null;
                // The page's list didn't switch it, which can happen in another season: try its address.
            }
        }
        if (_resolver.EpisodeUrl(job.PageUrl, job.StartRef, episode) is not { } url) return null;
        var onlyFragment = tab.CurrentUrl is { } now && WithoutFragment(now) == WithoutFragment(url);
        tab.Load(url);
        if (onlyFragment) tab.Reload();
        return await WaitForSourceAsync(tab, [.. _used], EpisodeWait, ct);
    }

    private async Task<MediaSource?> WaitForSourceAsync(IEpisodeHelperTab tab, HashSet<string> stale, TimeSpan timeout, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        var nudged = DateTimeOffset.MinValue;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (ct.IsCancellationRequested) return null;
            if (tab.BestSource is { } best && best.Kind != MediaSourceKind.Subtitle && best.IsCurrent && !stale.Contains(best.Url.OriginalString))
            {
                return best;
            }
            // Many players only fetch their file once they play.
            if (DateTimeOffset.UtcNow - nudged > NudgeInterval)
            {
                nudged = DateTimeOffset.UtcNow;
                _ = await tab.EvaluateInPageAsync("window.__cineon ? __cineon.playQuietly() : false");
            }
            await Task.Delay(PollInterval, ct);
        }
        return null;
    }

    private void Finish(bool cancelled)
    {
        TearDown();
        if (CurrentJob is not { IsFinished: false } job) return;
        var done = job with { IsFinished = true, IsPaused = false, Current = null };
        CurrentJob = done;
        Persist();
        RaiseChanged();
        if (cancelled)
        {
            _host.ShowToast($"Stopped getting {done.Label}");
        }
        else if (done.Missed.Count == 0)
        {
            _host.ShowToast($"All {done.Queued.Count} episodes of {done.Label} are downloading");
        }
        else
        {
            var missed = string.Join(", ", done.Missed.Select(ShortLabel));
            _host.ShowToast($"Queued {done.Queued.Count} of {done.Episodes.Count}. Couldn't find the file for {missed}");
        }
    }

    /// <summary>"S1 E2", the Mac's <c>EpisodeRef.shortLabel</c>.</summary>
    public static string ShortLabel(EpisodeRef episode) => $"S{episode.Season} E{episode.Episode}";

    private void TearDown()
    {
        _helper?.Dispose();
        _helper = null;
    }

    // MARK: Keeping the job

    /// <summary>Written after every step, so a job is never lost to Cineon closing. A finished one is forgotten.</summary>
    private void Persist()
    {
        try
        {
            if (CurrentJob is not { IsFinished: false } job)
            {
                if (File.Exists(_jobFile)) File.Delete(_jobFile);
                return;
            }
            var temp = _jobFile + ".tmp";
            File.WriteAllBytes(temp, job.Encode());
            File.Move(temp, _jobFile, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private void Restore()
    {
        byte[] data;
        try
        {
            if (!File.Exists(_jobFile)) return;
            data = File.ReadAllBytes(_jobFile);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return;
        }
        if (Job.Decode(data) is not { IsFinished: false } saved) return;
        CurrentJob = saved with { IsPaused = true, Current = null };
        _host.ShowToast($"Getting {CurrentJob.Label} stopped when Cineon closed", "Carry on", Resume);
    }

    private static string WithoutFragment(Uri url)
    {
        var text = url.OriginalString;
        var hash = text.IndexOf('#');
        return hash < 0 ? text : text[..hash];
    }

    private void RaiseChanged() => Changed?.Invoke(this, EventArgs.Empty);
}
