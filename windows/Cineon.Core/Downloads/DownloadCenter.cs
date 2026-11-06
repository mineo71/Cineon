using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Cineon.Core.Data;
using Cineon.Core.Import;

namespace Cineon.Core.Downloads;

// Port of Cineon/Downloads/DownloadCenter.swift.
//
// Saves films and episodes to this PC, from the files their players stream. What people do by
// digging the link out of the Network tab, done with one click.
//
// Whole files go through HttpClient with the page's own cookies, address and browser name, so a site
// sees the same visitor it served the player to. A stopped or failed file carries on from where it
// was with an HTTP Range request. Sites that only stream playlists go through HlsDownloader, which
// writes one .ts file (the Mac saves a .movpkg through AVFoundation).
//
// Threading: like the Mac's main-actor class, the center belongs to the thread that made it (the UI
// thread in the app). Transfers run on the thread pool; their progress, the Changed event, the host's
// calls and the request context's calls all come back through the SynchronizationContext captured
// when the center was made. Reading state from any thread is safe.

/// <summary>The download queue: two at a time, oldest first, with progress, stop, retry and the Bin.</summary>
public sealed class DownloadCenter
{
    /// <summary>
    /// Downloads at the same time. More only splits the same connection and makes links expire
    /// before their turn.
    /// </summary>
    public const int MaxRunning = 2;

    /// <summary>Where unfinished downloads wait to be carried on, inside the downloads folder.</summary>
    public const string PartialFolderName = ".cineon-partial";

    private readonly Database _db;
    private readonly LibraryStore _library;
    private readonly Func<AppSettings> _settings;
    private readonly IRequestContext _requestContext;
    private readonly IDownloadHost _host;
    private readonly DownloadHttp _http;
    private readonly HlsDownloader _hls;
    private readonly SynchronizationContext? _context;
    private readonly string _partialKey;

    private readonly Lock _gate = new();
    private readonly List<DownloadItem> _items;
    private readonly Dictionary<long, double> _progress = [];
    private readonly Dictionary<long, CancellationTokenSource> _tasks = [];
    private readonly Dictionary<long, DateTimeOffset> _lastWrite = [];
    private readonly Dictionary<long, IReadOnlyList<Uri>> _pending = [];
    private readonly HashSet<long> _starting = [];
    private readonly HashSet<Task> _running = [];
    private DateTimeOffset _lastPillRefresh = DateTimeOffset.MinValue;
    private string? _userAgent;
    private bool _suspended;

    /// <summary>Raised after the list or any progress changed, on the center's thread.</summary>
    public event EventHandler? Changed;

    public DownloadCenter(
        Database db,
        LibraryStore library,
        Func<AppSettings> settings,
        IRequestContext requestContext,
        IDownloadHost host,
        HttpMessageHandler? handler = null)
    {
        _db = db;
        _library = library;
        _settings = settings;
        _requestContext = requestContext;
        _host = host;
        _context = SynchronizationContext.Current;
        _http = new DownloadHttp(DownloadHttp.MakeClient(handler));
        _hls = new HlsDownloader(_http);
        _partialKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(db.Sql.Path)))[..8].ToLowerInvariant();
        try
        {
            _items = db.AllDownloads();
        }
        catch (SqlError)
        {
            _items = [];
        }
        // Whatever was running when Cineon last closed stopped with it.
        foreach (var item in _items.ToList().Where(i => i.Status.IsActive))
        {
            Save(item with { Status = DownloadStatus.Failed, Error = "Stopped when Cineon closed" });
        }
    }

    // MARK: Tuning, for tests

    internal HlsDownloader Hls => _hls;
    internal DownloadHttp Http => _http;
    /// <summary>How long a progress report waits after the last, so the list isn't flooded.</summary>
    internal TimeSpan ProgressInterval { get; set; } = TimeSpan.FromMilliseconds(200);

    /// <summary>Waits until nothing is starting or running. For tests and for closing.</summary>
    internal async Task IdleAsync()
    {
        while (true)
        {
            Task[] running;
            lock (_gate) running = [.. _running.Where(t => !t.IsCompleted)];
            if (running.Length == 0) return;
            try
            {
                await Task.WhenAll(running).ConfigureAwait(false);
            }
            catch
            {
                // Each task reports its own failure.
            }
        }
    }

    // MARK: Reading

    /// <summary>Newest first.</summary>
    public IReadOnlyList<DownloadItem> Items
    {
        get
        {
            lock (_gate) return [.. _items];
        }
    }

    /// <summary>Live progress, 0 to 1, for downloads whose size isn't known in bytes.</summary>
    public IReadOnlyDictionary<long, double> Progress
    {
        get
        {
            lock (_gate) return new Dictionary<long, double>(_progress);
        }
    }

    public int ActiveCount
    {
        get
        {
            lock (_gate) return _items.Count(i => i.Status.IsActive);
        }
    }

    public int RunningCount
    {
        get
        {
            lock (_gate) return _items.Count(i => i.Status == DownloadStatus.Downloading) + _starting.Count;
        }
    }

    public bool HasFreeSlot => RunningCount < MaxRunning;

    public DownloadItem? Item(long id)
    {
        lock (_gate) return _items.FirstOrDefault(i => i.Id == id);
    }

    public double Fraction(DownloadItem item)
    {
        if (item.Status == DownloadStatus.Done) return 1;
        lock (_gate) return _progress.TryGetValue(item.Id, out var fraction) ? fraction : item.Fraction;
    }

    /// <summary>The download that already holds what this tab is showing, if there is one.</summary>
    public DownloadItem? Existing(IDownloadTab tab)
    {
        var best = tab.BestSource;
        lock (_gate)
        {
            if (best is not null)
            {
                var wanted = MediaUrls.Progressive(best.Url.OriginalString);
                if (_items.FirstOrDefault(i => i.SourceUrl.OriginalString == wanted && i.Status != DownloadStatus.Failed) is { } match)
                {
                    return match;
                }
            }
            if (tab.LinkedTitleId is not long titleId) return null;
            var episode = tab.TrackRef ?? tab.Parsed?.Ref ?? EpisodeRef.None;
            return _items.FirstOrDefault(i => i.TitleId == titleId && i.Ref == episode && i.Status != DownloadStatus.Failed);
        }
    }

    /// <summary>The download for a file someone stopped watching on this PC.</summary>
    public DownloadItem? ItemForFile(string path)
    {
        lock (_gate) return _items.FirstOrDefault(i => i.File == path);
    }

    /// <summary>The chosen folder, or Videos\Cineon (the Mac's <c>DownloadCenter.folder(settings:)</c>).</summary>
    public static string FolderFor(AppSettings settings) => AppPaths.DownloadsFolder(settings);

    public string Folder => FolderFor(_settings());

    // MARK: Starting

    /// <summary>Downloads what the tab is playing. Returns false when there's nothing to download.</summary>
    public bool Download(IDownloadTab tab)
    {
        if (Existing(tab) is { } existing)
        {
            if (existing.Status == DownloadStatus.Done)
            {
                OnUi(() => _host.PlayDownload(existing));
            }
            else
            {
                Toast($"{existing.Name} is already downloading");
            }
            return true;
        }
        if (tab.BestSource is not { } source)
        {
            Toast("Play the video for a moment first, so Cineon can see its file");
            return false;
        }
        var title = LibraryTitle(tab);
        var episode = tab.TrackRef ?? tab.Parsed?.Ref ?? EpisodeRef.None;
        var name = title?.Name ?? tab.Parsed?.Name ?? tab.DisplayTitle;
        var subtitles = tab.Sources.Where(s => s.Kind == MediaSourceKind.Subtitle && s.IsCurrent).Take(6).Select(s => s.Url).ToList();
        if (Enqueue(
                source, title?.Id, episode, name, tab.Url, tab.SourcesFrameUrl ?? tab.Url?.OriginalString, tab.MediaDuration,
                title?.PosterUrl ?? tab.Parsed?.PosterUrl, subtitles) is not { } item)
        {
            return false;
        }
        bool isWaiting;
        lock (_gate) isWaiting = Item(item.Id)?.Status == DownloadStatus.Queued && !_starting.Contains(item.Id);
        Toast(isWaiting ? $"Queued {item.FileBaseName}, after the ones running now" : $"Downloading {item.FileBaseName}");
        return true;
    }

    /// <summary>Adds a download to the queue. It starts as soon as fewer than two are running.</summary>
    public DownloadItem? Enqueue(
        MediaSource source, long? titleId, EpisodeRef episode, string name, Uri? pageUrl, string? referer,
        double duration, Uri? posterUrl, IReadOnlyList<Uri> subtitles)
    {
        var sourceUrl = MediaUrls.Progressive(source.Url);
        var item = new DownloadItem
        {
            Id = 0, TitleId = titleId, Ref = episode, Name = name, SourceUrl = sourceUrl, PageUrl = pageUrl,
            Referer = referer, Host = (pageUrl is null ? null : SwiftUrl.Host(pageUrl)) ?? SwiftUrl.Host(sourceUrl) ?? "",
            Kind = source.Kind == MediaSourceKind.Hls ? MediaSourceKind.Hls : MediaSourceKind.File,
            Quality = MediaSource.QualityIn(sourceUrl.OriginalString), File = null, Subtitles = [], Bytes = 0,
            TotalBytes = 0, Status = DownloadStatus.Queued, Error = null, Position = 0, Duration = duration,
            PosterUrl = posterUrl, CreatedAt = DateTimeOffset.UtcNow, FinishedAt = null, PlayedAt = null,
        };
        try
        {
            item = item with { Id = _db.InsertDownload(item) };
        }
        catch (SqlError)
        {
            return null;
        }
        lock (_gate)
        {
            _items.Insert(0, item);
            _pending[item.Id] = subtitles;
        }
        Pump();
        RefreshPills(force: true);
        RaiseChanged();
        return item;
    }

    /// <summary>Starts queued downloads, oldest first, while there's room.</summary>
    private void Pump()
    {
        var starts = new List<(long Id, IReadOnlyList<Uri> Subtitles)>();
        lock (_gate)
        {
            if (_suspended) return;
            for (var index = _items.Count - 1; index >= 0; index--)
            {
                var item = _items[index];
                if (item.Status != DownloadStatus.Queued || _tasks.ContainsKey(item.Id) || _starting.Contains(item.Id)) continue;
                if (_items.Count(i => i.Status == DownloadStatus.Downloading) + _starting.Count >= MaxRunning) break;
                _starting.Add(item.Id);
                starts.Add((item.Id, _pending.Remove(item.Id, out var subtitles) ? subtitles : []));
            }
        }
        foreach (var (id, subtitles) in starts)
        {
            Track(Task.Run(async () =>
            {
                try
                {
                    await BeginAsync(id, subtitles).ConfigureAwait(false);
                }
                finally
                {
                    lock (_gate) _starting.Remove(id);
                    // One that didn't start after all leaves its slot to the next.
                    Pump();
                }
            }));
        }
    }

    private void Track(Task task)
    {
        lock (_gate) _running.Add(task);
        task.ContinueWith(t =>
        {
            lock (_gate) _running.Remove(t);
        }, TaskScheduler.Default);
    }

    /// <summary>Downloads any file the way the page's player would, with its cookies and address.</summary>
    public async Task<byte[]?> FetchAsync(Uri url, string? referer)
    {
        var probe = new DownloadItem
        {
            Id = 0, SourceUrl = url, Referer = referer, Host = SwiftUrl.Host(url) ?? "", Kind = MediaSourceKind.Subtitle,
            Status = DownloadStatus.Queued, CreatedAt = DateTimeOffset.UtcNow,
        };
        var headers = await RequestHeadersAsync(probe).ConfigureAwait(false);
        try
        {
            var data = await _http.GetBytesAsync(url, headers, null, CancellationToken.None).ConfigureAwait(false);
            return data.Length == 0 ? null : data;
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            return null;
        }
    }

    /// <summary>Adds a subtitle file someone picked to a download, copied next to it.</summary>
    public string? AddSubtitles(string file, long id)
    {
        if (Item(id) is not { } item) return null;
        byte[] data;
        try
        {
            data = File.ReadAllBytes(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        var folder = item.File is { } existing ? Path.GetDirectoryName(existing) ?? Folder : Folder;
        var ext = Path.GetExtension(file).Equals(".srt", StringComparison.OrdinalIgnoreCase) ? "srt" : "vtt";
        var stem = Path.GetFileNameWithoutExtension(file);
        var label = SubtitleTrack.LabelForFile(file, item.Subtitles.Count);
        var name = label.Length == 0 || label.StartsWith("Track", StringComparison.Ordinal) ? stem : label.ToLowerInvariant();
        var target = Unique(Path.Combine(folder, $"{item.FileBaseName}.{name}.{ext}"));
        try
        {
            File.WriteAllBytes(target, data);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        lock (_gate)
        {
            if (Item(id) is not { } current) return null;
            Save(current with { Subtitles = [.. current.Subtitles, target] });
        }
        RaiseChanged();
        return target;
    }

    /// <summary>The downloaded episode after this one, if it's on this PC.</summary>
    public DownloadItem? NextEpisode(DownloadItem item)
    {
        if (item.TitleId is not long titleId || !item.Ref.IsEpisode) return null;
        lock (_gate)
        {
            return _items
                .Where(i => i.TitleId == titleId && i.Status == DownloadStatus.Done && i.Ref.IsEpisode && i.File is not null)
                .Where(i => Compare(i.Ref, item.Ref) > 0)
                .OrderBy(i => i.Ref.Season).ThenBy(i => i.Ref.Episode)
                .FirstOrDefault();
        }
    }

    internal static int Compare(EpisodeRef a, EpisodeRef b) =>
        a.Season != b.Season ? a.Season.CompareTo(b.Season) : a.Episode.CompareTo(b.Episode);

    /// <summary>A watched episode goes to the Recycle Bin, where it can still be put back from.</summary>
    public void BinWatched(long id)
    {
        if (Item(id) is not { } item || !item.Ref.IsEpisode || item.Status != DownloadStatus.Done) return;
        Remove(id);
        Toast($"Moved {item.FileBaseName} to the Recycle Bin, since you've watched it");
    }

    /// <summary>
    /// The library's entry for what the tab shows, added if it isn't there yet, so the copy on this PC
    /// has a poster, and watching it lands on the timeline. Call on the library's (UI) thread.
    /// </summary>
    public Title? LibraryTitle(IDownloadTab tab)
    {
        if (tab.LinkedTitleId is long id && _library.Titles.TryGetValue(id, out var linked)) return linked;
        if (tab.Parsed is not { } parsed) return null;
        if (_library.Find(parsed.Name, parsed.AltName, parsed.Year) is { } found) return found;
        if (_library.AddTitle(parsed.Name, parsed.Year, parsed.KindHint, TitleStatus.None, posterUrl: parsed.PosterUrl, overview: parsed.Overview)
            is not { } added)
        {
            return null;
        }
        OnUi(() => _host.EnrichTitle(added.Id, parsed.AltName));
        return added;
    }

    /// <summary>Puts a stopped or failed download back in the queue. A file carries on from where it stopped.</summary>
    public void Retry(long id)
    {
        lock (_gate)
        {
            if (Item(id) is not { } item || item.Status.IsActive) return;
            Save(item with { Status = DownloadStatus.Queued, Error = null });
        }
        Pump();
        RaiseChanged();
    }

    /// <summary>Stops a download. What it saved so far is kept, so <see cref="Retry"/> carries on from there.</summary>
    public void Cancel(long id)
    {
        CancellationTokenSource? task;
        var changed = false;
        lock (_gate)
        {
            if (!_tasks.TryGetValue(id, out task))
            {
                // Still waiting for its turn.
                if (Item(id) is { Status: DownloadStatus.Queued } item)
                {
                    _pending.Remove(id);
                    Save(item with { Status = DownloadStatus.Failed, Error = "Stopped" });
                    changed = true;
                }
            }
        }
        if (task is not null)
        {
            task.Cancel();
            return;
        }
        if (changed)
        {
            RefreshPills(force: true);
            RaiseChanged();
        }
    }

    /// <summary>Moves the file to the Recycle Bin, where it can still be recovered, and forgets the download.</summary>
    public void Remove(long id)
    {
        Cancel(id);
        if (Item(id) is not { } item) return;
        var files = new[] { item.File }.Concat(item.Subtitles).OfType<string>().Where(File.Exists).ToList();
        if (files.Count > 0) OnUi(() => _host.MoveToRecycleBin(files));
        lock (_gate)
        {
            try
            {
                _db.DeleteDownload(id);
            }
            catch (SqlError)
            {
            }
            _items.RemoveAll(i => i.Id == id);
            _progress.Remove(id);
            // Without a running transfer, nothing else will clear its partial file.
            if (!_tasks.ContainsKey(id)) DeletePartials(item);
        }
        RefreshPills(force: true);
        RaiseChanged();
    }

    public void ShowInFileExplorer(DownloadItem item)
    {
        if (item.File is { } file && (File.Exists(file) || Directory.Exists(file)))
        {
            OnUi(() => _host.ShowInFileExplorer(file, true));
            return;
        }
        var folder = Folder;
        try
        {
            Directory.CreateDirectory(folder);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
        OnUi(() => _host.ShowInFileExplorer(folder, false));
    }

    /// <summary>Remembers where playback stopped, and for how long the file runs.</summary>
    public void NotePlayback(long id, double position, double duration)
    {
        lock (_gate)
        {
            if (Item(id) is not { } item) return;
            Save(item with { Position = position, Duration = duration > 0 ? duration : item.Duration, PlayedAt = DateTimeOffset.UtcNow });
        }
        RaiseChanged();
    }

    /// <summary>Stops everything when the profile closes. Nothing starts again on this center.</summary>
    public void SuspendAll()
    {
        List<CancellationTokenSource> tasks;
        lock (_gate)
        {
            _suspended = true;
            tasks = [.. _tasks.Values];
        }
        foreach (var task in tasks) task.Cancel();
    }

    // MARK: Running

    private async Task BeginAsync(long id, IReadOnlyList<Uri> subtitles)
    {
        if (Item(id) is not { } first) return;
        var headers = await RequestHeadersAsync(first).ConfigureAwait(false);
        DownloadItem item;
        var cancel = new CancellationTokenSource();
        lock (_gate)
        {
            if (_suspended || Item(id) is not { Status: DownloadStatus.Queued } current)
            {
                cancel.Dispose();
                return;
            }
            item = current with { Status = DownloadStatus.Downloading };
            Save(item);
            _tasks[id] = cancel;
            // Counted as running from now on. The Mac counts it twice until its subtitles are
            // saved, which can hold the next download back until this one ends.
            _starting.Remove(id);
        }
        RaiseChanged();

        Track(Task.Run(() => item.Kind == MediaSourceKind.Hls
            ? RunPlaylistAsync(item, headers, cancel.Token)
            : RunFileAsync(item, headers, cancel.Token)));
        if (subtitles.Count > 0) await SaveSubtitlesAsync(subtitles, id, headers).ConfigureAwait(false);
    }

    private async Task RunFileAsync(DownloadItem item, RequestHeaders headers, CancellationToken ct)
    {
        var part = PartialFile(item);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(part)!);
            MarkHidden(Path.GetDirectoryName(part)!);
            var lastReport = DateTimeOffset.MinValue;
            var suggested = await TransferFileAsync(item.SourceUrl, headers, part, (bytes, total, final) =>
            {
                var now = DateTimeOffset.UtcNow;
                if (!final && now - lastReport < ProgressInterval) return;
                lastReport = now;
                Wrote(item.Id, bytes, total);
            }, ct).ConfigureAwait(false);
            Finished(item.Id, part, Extension(suggested, item.SourceUrl), duration: 0);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            Fail(item, "Stopped");
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            Fail(item, DownloadErrors.Describe(e));
        }
    }

    private async Task RunPlaylistAsync(DownloadItem item, RequestHeaders headers, CancellationToken ct)
    {
        var staging = PartialPlaylist(item);
        try
        {
            Directory.CreateDirectory(staging);
            MarkHidden(Path.GetDirectoryName(staging)!);
            var lastReport = DateTimeOffset.MinValue;
            var outcome = await _hls.DownloadAsync(item.SourceUrl, headers, staging, fraction =>
            {
                var now = DateTimeOffset.UtcNow;
                if (fraction < 1 && now - lastReport < ProgressInterval) return;
                lastReport = now;
                Loaded(item.Id, fraction);
            }, ct).ConfigureAwait(false);
            Finished(item.Id, outcome.File, outcome.Extension, outcome.Duration);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            Fail(item, "Stopped");
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            Fail(item, DownloadErrors.Describe(e));
        }
    }

    /// <summary>
    /// Fetches a whole file into <paramref name="part"/>, carrying on from what's there with a Range
    /// request when the site allows it. Returns the name the site suggests for the file, if any.
    /// </summary>
    private async Task<string?> TransferFileAsync(Uri url, RequestHeaders headers, string part, Action<long, long, bool> wrote, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            var have = File.Exists(part) ? new FileInfo(part).Length : 0;
            using var response = await _http.SendAsync(url, headers, null, have, ct).ConfigureAwait(false);
            var status = (int)response.StatusCode;
            if (status == 416 && have > 0)
            {
                // Nothing left to send: the part may already be the whole file.
                if (response.Content.Headers.ContentRange?.Length == have) return SuggestedName(response);
                TryDelete(part);
                if (attempt == 0) continue;
            }
            if (status >= 400) throw new DownloadHttpException(status);

            var range = response.Content.Headers.ContentRange;
            var append = have > 0 && status == 206 && range?.From == have;
            var fresh = status != 206 || (range?.From ?? 0) == 0;
            if (!append && !fresh)
            {
                // A piece from somewhere else in the file: start again from its beginning.
                TryDelete(part);
                if (attempt == 0) continue;
                throw new DownloadFailedException(DownloadErrors.Explain(status));
            }
            var start = append ? have : 0;
            var total = append
                ? range?.Length ?? (response.Content.Headers.ContentLength is long rest ? have + rest : 0)
                : response.Content.Headers.ContentLength ?? 0;
            await using (var file = new FileStream(part, append ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16, useAsync: true))
            await using (var body = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
            {
                wrote(start, total, false);
                await _http.CopyAsync(body, file, written => wrote(start + written, total, false), ct).ConfigureAwait(false);
            }
            wrote(new FileInfo(part).Length, total, true);
            return SuggestedName(response);
        }
    }

    /// <summary>The name a response suggests, like <c>URLResponse.suggestedFilename</c>.</summary>
    private static string? SuggestedName(HttpResponseMessage response)
    {
        var disposition = response.Content.Headers.ContentDisposition;
        var named = disposition?.FileNameStar ?? disposition?.FileName;
        if (!string.IsNullOrWhiteSpace(named)) return named.Trim('"');
        if (response.RequestMessage?.RequestUri is { } final && SwiftUrl.Extension(SwiftUrl.LastPathComponent(final)).Length > 0)
        {
            return SwiftUrl.LastPathComponent(final);
        }
        return response.Content.Headers.ContentType?.MediaType switch
        {
            "video/mp4" => "video.mp4",
            "video/x-m4v" => "video.m4v",
            "video/quicktime" => "video.mov",
            "video/webm" => "video.webm",
            "video/x-matroska" => "video.mkv",
            _ => null,
        };
    }

    private async Task<RequestHeaders> RequestHeadersAsync(DownloadItem item)
    {
        if (_userAgent is null)
        {
            try
            {
                _userAgent = await OnUiAsync(_requestContext.UserAgentAsync).ConfigureAwait(false);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
            }
        }
        var headers = new Dictionary<string, string> { ["Accept"] = "*/*" };
        if (_userAgent is { } agent) headers["User-Agent"] = agent;
        if (item.Referer is { Length: > 0 } referer)
        {
            headers["Referer"] = referer;
            if (Urls.Parse(referer) is { } refererUrl && refererUrl.Scheme.Length > 0 && SwiftUrl.Host(refererUrl) is { } host &&
                !DomainName.IsSameSite(host, SwiftUrl.Host(item.SourceUrl)))
            {
                headers["Origin"] = $"{refererUrl.Scheme}://{host}" +
                    (SwiftUrl.Port(refererUrl) is int port ? ":" + port.ToString(CultureInfo.InvariantCulture) : "");
            }
        }
        // A stream asks the same few hosts for many segments, so each host's cookies are looked up once.
        var cookies = new ConcurrentDictionary<string, Task<string?>>();
        return new RequestHeaders(headers, url => cookies.GetOrAdd(
            $"{url.Scheme}://{SwiftUrl.Host(url)}{SwiftUrl.Path(url)}",
            _ => CookieHeaderAsync(url)));
    }

    /// <summary>The profile's cookies that this address would be sent, logins included.</summary>
    private async Task<string?> CookieHeaderAsync(Uri url)
    {
        try
        {
            var all = await OnUiAsync(() => _requestContext.CookiesAsync(url)).ConfigureAwait(false);
            return DownloadHttp.CookieHeader(DownloadHttp.CookiesFor(url, all));
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            return null;
        }
    }

    private async Task SaveSubtitlesAsync(IReadOnlyList<Uri> urls, long id, RequestHeaders headers)
    {
        var saved = new List<string>();
        var folder = Folder;
        try
        {
            Directory.CreateDirectory(folder);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
        for (var index = 0; index < urls.Count; index++)
        {
            var url = urls[index];
            byte[] data;
            try
            {
                data = await _http.GetBytesAsync(url, headers, null, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                continue;
            }
            if (data.Length == 0 || Item(id) is not { } item) continue;
            var ext = SwiftUrl.PathExtension(url).Equals("srt", StringComparison.OrdinalIgnoreCase) ? "srt" : "vtt";
            var label = SubtitleTrack.LabelFor(url, index);
            var target = Unique(Path.Combine(folder, $"{item.FileBaseName}.{label}.{ext}"));
            try
            {
                await File.WriteAllBytesAsync(target, data).ConfigureAwait(false);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            saved.Add(target);
        }
        if (saved.Count == 0) return;
        lock (_gate)
        {
            if (Item(id) is not { } item) return;
            Save(item with { Subtitles = [.. item.Subtitles, .. saved] });
        }
        RaiseChanged();
    }

    // MARK: Transfer events

    private void Wrote(long id, long bytes, long total)
    {
        lock (_gate)
        {
            if (Item(id) is not { } item) return;
            item = item with { Bytes = bytes, TotalBytes = total > 0 ? total : item.TotalBytes };
            if (item.TotalBytes > 0) _progress[id] = (double)bytes / item.TotalBytes;
            // Keep the row current without writing the database many times a second.
            var now = DateTimeOffset.UtcNow;
            if (now - _lastWrite.GetValueOrDefault(id, DateTimeOffset.MinValue) > TimeSpan.FromSeconds(3))
            {
                _lastWrite[id] = now;
                Save(item);
            }
            else
            {
                Replace(item);
            }
        }
        RefreshPills();
        RaiseChanged();
    }

    private void Loaded(long id, double fraction)
    {
        lock (_gate)
        {
            if (Item(id) is null) return;
            _progress[id] = fraction;
        }
        RefreshPills();
        RaiseChanged();
    }

    private void Finished(long id, string staged, string extension, double duration)
    {
        DownloadItem item;
        string? failure = null;
        lock (_gate)
        {
            if (Item(id) is not { } current)
            {
                TryDelete(staged);
                return;
            }
            item = current;
            var folder = Folder;
            var target = "";
            try
            {
                Directory.CreateDirectory(folder);
                target = Unique(Path.Combine(folder, $"{item.FileBaseName}.{extension}"));
                File.Move(staged, target);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                var name = Path.GetFileName(folder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
                failure = $"Couldn't save into {name}: {e.Message}";
            }
            if (failure is null)
            {
                var size = SizeOf(target);
                item = item with
                {
                    File = target, Status = DownloadStatus.Done, Error = null, FinishedAt = DateTimeOffset.UtcNow,
                    Bytes = size > 0 ? size : item.Bytes, TotalBytes = size > 0 ? size : item.TotalBytes,
                    Duration = duration > 0 ? duration : item.Duration,
                };
                _tasks.Remove(id);
                _progress.Remove(id);
                Save(item);
                DeletePartials(item);
            }
        }
        if (failure is not null)
        {
            Fail(item, failure);
            return;
        }
        RefreshPills(force: true);
        Pump();
        RaiseChanged();
        Toast($"Saved {item.FileBaseName}", "Play", () =>
        {
            if (Item(id) is { } saved) _host.PlayDownload(saved);
        });
        Track(ReadDurationAsync(id));
    }

    private void Fail(DownloadItem stopped, string message)
    {
        var id = stopped.Id;
        lock (_gate)
        {
            _tasks.Remove(id);
            _progress.Remove(id);
            if (Item(id) is not { } item)
            {
                // Removed while it ran: nothing will carry on from its partial file.
                DeletePartials(stopped);
                return;
            }
            Save(item with { Status = DownloadStatus.Failed, Error = message });
        }
        RefreshPills(force: true);
        Pump();
        RaiseChanged();
    }

    private async Task ReadDurationAsync(long id)
    {
        if (Item(id)?.File is not { } file) return;
        double? duration;
        try
        {
            duration = await OnUiAsync(() => _host.MediaDurationAsync(file)).ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            return;
        }
        if (duration is not double seconds || !double.IsFinite(seconds) || seconds <= 0) return;
        lock (_gate)
        {
            if (Item(id) is not { } item) return;
            Save(item with { Duration = seconds });
        }
        RaiseChanged();
    }

    // MARK: Partial files

    private string PartialDirectory(DownloadItem item) =>
        Path.Combine(Folder, PartialFolderName);

    /// <summary>Where a file download's bytes collect until it's finished.</summary>
    internal string PartialFile(DownloadItem item) =>
        Path.Combine(PartialDirectory(item), $"{_partialKey}-{item.Id.ToString(CultureInfo.InvariantCulture)}.part");

    /// <summary>Where a stream's segments collect until it's finished.</summary>
    internal string PartialPlaylist(DownloadItem item) =>
        Path.Combine(PartialDirectory(item), $"{_partialKey}-{item.Id.ToString(CultureInfo.InvariantCulture)}.hls");

    private void DeletePartials(DownloadItem item)
    {
        TryDelete(PartialFile(item));
        try
        {
            var staging = PartialPlaylist(item);
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
            var folder = PartialDirectory(item);
            if (Directory.Exists(folder) && !Directory.EnumerateFileSystemEntries(folder).Any()) Directory.Delete(folder);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static void MarkHidden(string folder)
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            var info = new DirectoryInfo(folder);
            if (!info.Attributes.HasFlag(FileAttributes.Hidden)) info.Attributes |= FileAttributes.Hidden;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static void TryDelete(string file)
    {
        try
        {
            if (File.Exists(file)) File.Delete(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    // MARK: Helpers

    private void Save(DownloadItem item)
    {
        try
        {
            _db.UpdateDownload(item);
        }
        catch (SqlError)
        {
        }
        lock (_gate) Replace(item);
    }

    private void Replace(DownloadItem item)
    {
        var index = _items.FindIndex(i => i.Id == item.Id);
        if (index >= 0) _items[index] = item;
    }

    /// <summary>
    /// Updates the download button on every page that shows one. At most once a second while a
    /// download runs, so it doesn't flood the page.
    /// </summary>
    public void RefreshPills(bool force = false)
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            if (!force && now - _lastPillRefresh <= TimeSpan.FromSeconds(1)) return;
            _lastPillRefresh = now;
        }
        OnUi(_host.RefreshDownloadPills);
    }

    private void Toast(string message, string? actionTitle = null, Action? action = null) =>
        OnUi(() => _host.ShowToast(message, actionTitle, action));

    private void RaiseChanged() => OnUi(() => Changed?.Invoke(this, EventArgs.Empty));

    private void OnUi(Action body)
    {
        if (_context is null || SynchronizationContext.Current == _context) body();
        else _context.Post(_ => body(), null);
    }

    private Task<T> OnUiAsync<T>(Func<Task<T>> body)
    {
        if (_context is null || SynchronizationContext.Current == _context) return body();
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _context.Post(async _ =>
        {
            try
            {
                done.SetResult(await body());
            }
            catch (Exception e)
            {
                done.SetException(e);
            }
        }, null);
        return done.Task;
    }

    /// <summary>The same name with " 2", " 3"… added until nothing is there. "Name.en.vtt" keeps both extensions.</summary>
    public static string Unique(string path)
    {
        var target = path;
        var counter = 2;
        var folder = Path.GetDirectoryName(path) ?? "";
        var ext = Path.GetExtension(path);
        var stem = Path.GetFileNameWithoutExtension(path);
        while (File.Exists(target) || Directory.Exists(target))
        {
            target = Path.Combine(folder, $"{stem} {counter.ToString(CultureInfo.InvariantCulture)}{ext}");
            counter++;
        }
        return target;
    }

    private static readonly HashSet<string> KnownExtensions = ["mp4", "m4v", "mov", "webm", "mkv"];

    /// <summary>The site's name for the file, then the address, then mp4.</summary>
    internal static string Extension(string? suggested, Uri source)
    {
        foreach (var candidate in new[] { suggested is null ? null : SwiftUrl.Extension(suggested), SwiftUrl.PathExtension(source) })
        {
            if (candidate?.ToLowerInvariant() is { } ext && KnownExtensions.Contains(ext)) return ext;
        }
        return "mp4";
    }

    /// <summary>A file's size, or a folder's total.</summary>
    public static long SizeOf(string path)
    {
        try
        {
            if (File.Exists(path)) return new FileInfo(path).Length;
            if (!Directory.Exists(path)) return 0;
            return new DirectoryInfo(path).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }
}
