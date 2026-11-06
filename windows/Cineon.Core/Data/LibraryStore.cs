using System.ComponentModel;

namespace Cineon.Core.Data;

// Port of Cineon/Core/LibraryStore.swift. The Mac's @Observable becomes INotifyPropertyChanged plus a
// coarse Changed event. Like the Mac, it belongs to the UI thread and isn't safe to share across
// threads. Database errors are swallowed, as Swift's `try?` does.

/// <summary>In-memory view of one profile's library, kept in step with the database.</summary>
public sealed class LibraryStore : INotifyPropertyChanged
{
    public Database Db { get; }

    private readonly Dictionary<long, Title> _titles = [];
    private List<WatchProgress> _progress = [];
    private List<WatchSession> _sessions = [];
    private List<LibraryEvent> _events = [];
    private List<Site> _sites = [];
    private readonly Dictionary<long, IReadOnlyList<FilmFrame>> _framesBySession = [];
    private readonly Dictionary<long, IReadOnlyList<FilmFrame>> _momentsByTitle = [];
    private readonly Dictionary<long, FilmFrame> _bestFrameByTitle = [];
    private readonly Dictionary<long, long> _mergedInto = [];

    public IReadOnlyDictionary<long, Title> Titles => _titles;
    /// <summary>Latest first.</summary>
    public IReadOnlyList<WatchProgress> Progress => _progress;
    /// <summary>The latest 600, newest first.</summary>
    public IReadOnlyList<WatchSession> Sessions => _sessions;
    public IReadOnlyList<LibraryEvent> Events => _events;
    public IReadOnlyList<Site> Sites => _sites;
    public IReadOnlyDictionary<long, IReadOnlyList<FilmFrame>> FramesBySession => _framesBySession;
    public IReadOnlyDictionary<long, IReadOnlyList<FilmFrame>> MomentsByTitle => _momentsByTitle;
    public IReadOnlyDictionary<long, FilmFrame> BestFrameByTitle => _bestFrameByTitle;

    /// <summary>Bumped on every timeline change, so views can refresh their derived data.</summary>
    public int Revision { get; private set; }

    /// <summary>Called when someone rates or files a title themselves, for the cloud backup.</summary>
    public Action<Title>? OnPersonalChange { get; set; }

    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>Raised once after anything in the store changed.</summary>
    public event EventHandler? Changed;

    public LibraryStore(Database db)
    {
        Db = db;
        Reload();
    }

    private static DateTimeOffset Now => DateTimeOffset.UtcNow;

    private static T Try<T>(Func<T> body, T fallback)
    {
        try
        {
            return body();
        }
        catch (Exception e) when (e is SqlError or IOException or UnauthorizedAccessException)
        {
            return fallback;
        }
    }

    private static void Try(Action body)
    {
        try
        {
            body();
        }
        catch (Exception e) when (e is SqlError or IOException or UnauthorizedAccessException)
        {
        }
    }

    private void Notify(params string[] properties)
    {
        foreach (var property in properties) PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(property));
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void Reload()
    {
        _titles.Clear();
        foreach (var title in Try(Db.AllTitles, [])) _titles[title.Id] = title;
        _progress = Try(Db.AllProgress, []);
        _sessions = Try(() => Db.Sessions(limit: 600), []);
        _events = Try(() => Db.Events(limit: 300), []);
        _sites = Try(Db.AllSites, []);
        LoadFrames();
        Revision++;
        Notify(nameof(Titles), nameof(Progress), nameof(Sessions), nameof(Events), nameof(Sites),
            nameof(FramesBySession), nameof(MomentsByTitle), nameof(BestFrameByTitle), nameof(Revision));
    }

    private void LoadFrames()
    {
        _framesBySession.Clear();
        _momentsByTitle.Clear();
        _bestFrameByTitle.Clear();
        foreach (var frame in Try(Db.AllFrames, [])) Index(frame);
    }

    private void Index(FilmFrame frame)
    {
        if (frame.SessionId is long session)
        {
            var frames = _framesBySession.GetValueOrDefault(session) ?? [];
            _framesBySession[session] = [.. frames.Append(frame).OrderBy(f => f.Position)];
        }
        if (frame.IsMoment)
        {
            var moments = _momentsByTitle.GetValueOrDefault(frame.TitleId) ?? [];
            _momentsByTitle[frame.TitleId] = [.. moments.Append(frame).OrderByDescending(f => f.At)];
        }
        var best = _bestFrameByTitle.GetValueOrDefault(frame.TitleId);
        if ((best?.Interest ?? -1) < frame.Interest) _bestFrameByTitle[frame.TitleId] = frame;
    }

    // MARK: Lists

    private IEnumerable<Title> List(TitleStatus status) => _titles.Values.Where(t => t.Status == status);

    public IReadOnlyList<Title> Backlog => [.. List(TitleStatus.Backlog).OrderByDescending(t => t.AddedAt)];

    public IReadOnlyList<Title> Watching => [.. List(TitleStatus.Watching).OrderByDescending(t => t.LastWatchedAt ?? t.UpdatedAt)];

    public IReadOnlyList<Title> Watched => [.. List(TitleStatus.Watched).OrderByDescending(t => t.FinishedAt ?? t.UpdatedAt)];

    public int Count(TitleStatus status) => _titles.Values.Count(t => t.Status == status);

    /// <summary>Latest place you stopped, per title in progress.</summary>
    public IReadOnlyList<(Title Title, WatchProgress Progress)> ContinueWatching
    {
        get
        {
            var seen = new HashSet<long>();
            var result = new List<(Title, WatchProgress)>();
            foreach (var p in _progress)
            {
                if (!seen.Add(p.TitleId)) continue;
                if (!_titles.TryGetValue(p.TitleId, out var title) || title.Status != TitleStatus.Watching) continue;
                result.Add((title, p));
            }
            return result;
        }
    }

    public WatchProgress? LatestProgress(long titleId) => _progress.FirstOrDefault(p => p.TitleId == titleId);

    public IReadOnlyList<WatchProgress> ProgressList(long titleId) => [.. _progress.Where(p => p.TitleId == titleId)];

    /// <summary>Swift's <c>sessions(titleID:)</c>: all of one title's sessions, from the database.</summary>
    public IReadOnlyList<WatchSession> SessionsForTitle(long titleId) => Try(() => Db.SessionsForTitle(titleId), []);

    public IReadOnlyList<Title> Search(string query, int limit = 8)
    {
        var needle = LibraryText.Normalize(query);
        if (needle.Length == 0) return [];
        return [.. _titles.Values
            .Where(t => t.NormName.Contains(needle, StringComparison.Ordinal))
            .OrderBy(t => t.NormName.StartsWith(needle, StringComparison.Ordinal) ? 0 : 1)
            .ThenByDescending(t => t.UpdatedAt)
            .Take(limit)];
    }

    // MARK: Titles

    /// <summary>Finds a title already in the library that matches, by name and, when known, year.</summary>
    public Title? Find(string name, string? altName = null, int? year = null)
    {
        var keys = new[] { name, altName }.OfType<string>().Select(LibraryText.Normalize).ToList();
        var matches = _titles.Values.Where(t => keys.Contains(t.NormName)).ToList();
        if (year is int y)
        {
            if (matches.FirstOrDefault(t => t.Year == y) is { } exact) return exact;
            return matches.FirstOrDefault(t => t.Year is null || Math.Abs((t.Year ?? y) - y) <= 1);
        }
        return matches.MaxBy(t => t.UpdatedAt);
    }

    public Title? AddTitle(
        string name,
        int? year = null,
        TitleKind kind = TitleKind.Unknown,
        TitleStatus status = TitleStatus.None,
        string? imdbId = null,
        Uri? posterUrl = null,
        Uri? backdropUrl = null,
        string? overview = null)
    {
        if (imdbId is not null && _titles.Values.FirstOrDefault(t => t.ImdbId == imdbId) is { } existing)
        {
            if (status != TitleStatus.None && existing.Status == TitleStatus.None) SetStatus(existing.Id, status);
            return _titles.GetValueOrDefault(existing.Id);
        }
        var now = Now;
        var title = new Title
        {
            Id = 0, Name = name, NormName = LibraryText.Normalize(name), Year = year, Kind = kind, Status = status,
            ImdbId = imdbId, PosterUrl = posterUrl, BackdropUrl = backdropUrl, Overview = overview, Genres = [],
            RuntimeMinutes = null, RatingHalves = null, Notes = null, AddedAt = now, UpdatedAt = now, FinishedAt = null,
            LastWatchedAt = null, MetadataChecked = false,
        };
        long id;
        try
        {
            id = Db.InsertTitle(title);
        }
        catch (SqlError)
        {
            return null;
        }
        title = title with { Id = id };
        _titles[id] = title;
        if (status == TitleStatus.Backlog)
        {
            Try(() => Db.AddEvent(LibraryEventKind.AddedToBacklog, id));
            ReloadEvents();
        }
        Notify(nameof(Titles));
        return title;
    }

    public void Update(Title title)
    {
        var copy = title with { UpdatedAt = Now };
        Try(() => Db.UpdateTitle(copy));
        _titles[copy.Id] = copy;
        Notify(nameof(Titles));
    }

    public void SetStatus(long id, TitleStatus status)
    {
        if (!_titles.TryGetValue(id, out var title) || title.Status == status) return;
        var now = Now;
        title = title with { Status = status, UpdatedAt = now, StatusAt = now };
        if (status == TitleStatus.Watched) title = title with { FinishedAt = now };
        Try(() => Db.UpdateTitle(title));
        _titles[id] = title;
        OnPersonalChange?.Invoke(title);
        var kind = status switch
        {
            TitleStatus.Backlog => LibraryEventKind.AddedToBacklog,
            TitleStatus.Watched => LibraryEventKind.MarkedWatched,
            TitleStatus.Watching => LibraryEventKind.MarkedWatching,
            _ => LibraryEventKind.Removed,
        };
        Try(() => Db.AddEvent(kind, id));
        ReloadEvents();
        Notify(nameof(Titles));
    }

    /// <summary>Out of ten in half steps (15 is 7.5), or null to clear it.</summary>
    public void SetRating(long id, int? halves)
    {
        if (!_titles.TryGetValue(id, out var title)) return;
        int? value = halves is int h ? Data.Rating.Clamp(h) : null;
        if (title.RatingHalves == value) return;
        var now = Now;
        title = title with { RatingHalves = value, RatedAt = now, UpdatedAt = now };
        Try(() => Db.UpdateTitle(title));
        _titles[id] = title;
        OnPersonalChange?.Invoke(title);
        Notify(nameof(Titles));
    }

    /// <summary>
    /// What the cloud backup remembers, applied without sending it straight back. Swift's
    /// <c>halves: Int??</c> is <paramref name="restoreRating"/> (leave the rating alone when false)
    /// plus <paramref name="halves"/> (null clears it).
    /// </summary>
    public void Restore(long id, bool restoreRating, int? halves, DateTimeOffset? ratedAt, TitleStatus? status,
        DateTimeOffset? statusAt, DateTimeOffset? finishedAt)
    {
        if (!_titles.TryGetValue(id, out var title)) return;
        var changed = false;
        if (restoreRating && title.RatingHalves != halves)
        {
            title = title with { RatingHalves = halves is int h ? Data.Rating.Clamp(h) : null, RatedAt = ratedAt };
            changed = true;
        }
        if (status is TitleStatus newStatus && title.Status != newStatus)
        {
            title = title with { Status = newStatus, StatusAt = statusAt };
            if (newStatus == TitleStatus.Watched && title.FinishedAt is null) title = title with { FinishedAt = finishedAt ?? statusAt };
            changed = true;
        }
        if (!changed) return;
        Try(() => Db.UpdateTitle(title));
        _titles[id] = title;
        Notify(nameof(Titles));
    }

    public void Delete(long id)
    {
        // The folder has to go first: the database forgets which files were this title's.
        Try(() => Directory.Delete(Path.Combine(Db.FramesDirectory, id.ToString(System.Globalization.CultureInfo.InvariantCulture)), true));
        Try(() => Db.DeleteTitle(id));
        Reload();
    }

    /// <summary>A recognised title can turn out to be a film already in the library, under another name.</summary>
    public void Merge(long from, long into)
    {
        if (from == into) return;
        Try(() => Db.MergeTitle(from, into));
        _mergedInto[from] = into;
        Reload();
    }

    /// <summary>Follows merges, so a session recording under an old ID keeps writing to the right title.</summary>
    public long? CurrentId(long id)
    {
        var current = id;
        while (_mergedInto.TryGetValue(current, out var next)) current = next;
        return _titles.ContainsKey(current) ? current : null;
    }

    private void ReloadEvents()
    {
        _events = Try(() => Db.Events(limit: 300), []);
        Revision++;
        Notify(nameof(Events), nameof(Revision));
    }

    // MARK: Watching

    public void RecordWatchStart(long titleId)
    {
        if (!_titles.TryGetValue(titleId, out var title)) return;
        var now = Now;
        title = title with { LastWatchedAt = now, UpdatedAt = now };
        if (title.Status != TitleStatus.Watching) title = title with { Status = TitleStatus.Watching };
        Try(() => Db.UpdateTitle(title));
        _titles[titleId] = title;
        Notify(nameof(Titles));
    }

    public void SaveProgress(WatchProgress p)
    {
        Try(() => Db.UpsertProgress(p));
        _progress.RemoveAll(x => x.TitleId == p.TitleId && x.Ref == p.Ref);
        _progress.Insert(0, p);
        if (_titles.TryGetValue(p.TitleId, out var title))
        {
            title = title with { LastWatchedAt = p.UpdatedAt };
            _titles[p.TitleId] = title;
            Try(() => Db.UpdateTitle(title));
        }
        Notify(nameof(Progress), nameof(Titles));
    }

    public void ClearProgress(long titleId, EpisodeRef episode)
    {
        Try(() => Db.ClearProgress(titleId, episode));
        _progress = Try(Db.AllProgress, _progress);
        Notify(nameof(Progress));
    }

    /// <summary>Inserts a new session (ID 0) or updates one, and returns it with its ID.</summary>
    public WatchSession SaveSession(WatchSession s)
    {
        var copy = s;
        if (s.Id == 0) copy = s with { Id = Try(() => Db.InsertSession(s), 0L) };
        else Try(() => Db.UpdateSession(s));
        var index = _sessions.FindIndex(x => x.Id == copy.Id);
        if (index >= 0) _sessions[index] = copy;
        else _sessions.Insert(0, copy);
        Revision++;
        Notify(nameof(Sessions), nameof(Revision));
        return copy;
    }

    public void DeleteSession(long id)
    {
        // Frames go with their session. Moments someone chose to keep don't.
        foreach (var frame in Frames(id).Where(f => !f.IsMoment)) RemoveFrameFile(frame);
        Try(() => Db.DeleteSession(id));
        _sessions.RemoveAll(x => x.Id == id);
        LoadFrames();
        Revision++;
        Notify(nameof(Sessions), nameof(FramesBySession), nameof(MomentsByTitle), nameof(BestFrameByTitle), nameof(Revision));
    }

    // MARK: Frames

    public IReadOnlyList<FilmFrame> Frames(long sessionId) => _framesBySession.GetValueOrDefault(sessionId) ?? [];

    public IReadOnlyList<FilmFrame> Moments(long titleId) => _momentsByTitle.GetValueOrDefault(titleId) ?? [];

    /// <summary>Swift's <c>frameURL</c>: the image file's full path.</summary>
    public string FramePath(FilmFrame frame) => Path.Combine(Db.FramesDirectory, frame.File);

    /// <summary>Swift's <c>bestFrameURL(titleID:)</c>.</summary>
    public string? BestFramePath(long titleId) =>
        _bestFrameByTitle.TryGetValue(titleId, out var frame) ? FramePath(frame) : null;

    public void AddFrame(FilmFrame frame)
    {
        long id;
        try
        {
            id = Db.InsertFrame(frame);
        }
        catch (SqlError)
        {
            return;
        }
        Index(frame with { Id = id });
        Notify(nameof(FramesBySession), nameof(MomentsByTitle), nameof(BestFrameByTitle));
    }

    private void RemoveFrameFile(FilmFrame frame)
    {
        Try(() => File.Delete(FramePath(frame)));
        Try(() => Db.DeleteFrame(frame.Id));
    }

    public void DeleteFrame(FilmFrame frame)
    {
        RemoveFrameFile(frame);
        LoadFrames();
        Notify(nameof(FramesBySession), nameof(MomentsByTitle), nameof(BestFrameByTitle));
    }

    public void DeleteAllFrames()
    {
        Try(() =>
        {
            if (Directory.Exists(Db.FramesDirectory)) Directory.Delete(Db.FramesDirectory, true);
        });
        Try(Db.DeleteAllFrames);
        LoadFrames();
        Notify(nameof(FramesBySession), nameof(MomentsByTitle), nameof(BestFrameByTitle));
    }

    /// <summary>Bytes on disk, worked out away from the UI thread.</summary>
    public Task<long> FramesSizeAsync()
    {
        var directory = Db.FramesDirectory;
        return Task.Run(() => SizeOf(directory));
    }

    private static long SizeOf(string directory)
    {
        try
        {
            if (!Directory.Exists(directory)) return 0;
            return new DirectoryInfo(directory).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    private static long FileSize(string path)
    {
        try
        {
            var info = new FileInfo(path);
            return info.Exists ? info.Length : 0;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    /// <summary>
    /// Keeps the folder from growing forever: past the limit, the oldest collected frames go, down to
    /// 80% of it. Moments are never removed by this. Call it from the UI thread; the file sizes are
    /// worked out in the background and the store is changed back on the caller's context.
    /// </summary>
    public async Task PruneFramesAsync(long limit = 800L * 1024 * 1024)
    {
        if (await FramesSizeAsync() <= limit) return;
        var oldestFirst = Try(Db.AllFrames, []).Where(f => !f.IsMoment).OrderBy(f => f.At).ToList();
        var paths = oldestFirst.Select(FramePath).ToList();
        var count = await Task.Run(() =>
        {
            var total = paths.Sum(FileSize);
            var over = total - limit * 8 / 10;
            var removed = 0;
            foreach (var path in paths)
            {
                if (over <= 0) break;
                over -= FileSize(path);
                removed++;
            }
            return removed;
        });
        foreach (var frame in oldestFirst.Take(count)) RemoveFrameFile(frame);
        LoadFrames();
        Notify(nameof(FramesBySession), nameof(MomentsByTitle), nameof(BestFrameByTitle));
    }

    // MARK: Sites

    public Site? AddSite(Uri url, string? name = null)
    {
        var rawHost = url.IsAbsoluteUri ? url.Host : "";
        if (string.IsNullOrEmpty(rawHost)) return null;
        var host = rawHost.ToLowerInvariant();
        var bare = host.StartsWith("www.", StringComparison.Ordinal) ? host[4..] : host;
        if (_sites.FirstOrDefault(s => DomainName.IsSameSite(s.Host, bare)) is { } existing) return existing;
        // Most sites keep an icon here. Good enough until the first visit finds a sharper one.
        var icon = Urls.Parse($"{(url.IsAbsoluteUri ? url.Scheme : "https")}://{rawHost}/favicon.ico");
        var site = new Site
        {
            Id = 0, Name = name ?? DomainName.DisplayName(bare), Host = bare, HomeUrl = url, SearchTemplate = null, IconUrl = icon,
            Position = (_sites.Count == 0 ? -1 : _sites.Max(s => s.Position)) + 1, AddedAt = Now, LastUsedAt = null,
        };
        long id;
        try
        {
            id = Db.InsertSite(site);
        }
        catch (SqlError)
        {
            return null;
        }
        site = site with { Id = id };
        _sites.Add(site);
        Notify(nameof(Sites));
        return site;
    }

    public void UpdateSite(Site site)
    {
        Try(() => Db.UpdateSite(site));
        var index = _sites.FindIndex(s => s.Id == site.Id);
        if (index >= 0) _sites[index] = site;
        Notify(nameof(Sites));
    }

    public void RemoveSite(long id)
    {
        Try(() => Db.DeleteSite(id));
        _sites.RemoveAll(s => s.Id == id);
        Notify(nameof(Sites));
    }

    /// <summary>
    /// Swift's <c>moveSite(from:to:)</c> with SwiftUI's move semantics: the sites at
    /// <paramref name="source"/> offsets go before the site that was at <paramref name="destination"/>.
    /// </summary>
    public void MoveSite(IEnumerable<int> source, int destination)
    {
        var offsets = source.Where(i => i >= 0 && i < _sites.Count).Distinct().Order().ToList();
        if (offsets.Count > 0)
        {
            var moving = offsets.Select(i => _sites[i]).ToList();
            var insertAt = destination - offsets.Count(i => i < destination);
            foreach (var i in offsets.AsEnumerable().Reverse()) _sites.RemoveAt(i);
            _sites.InsertRange(Math.Clamp(insertAt, 0, _sites.Count), moving);
        }
        for (var index = 0; index < _sites.Count; index++)
        {
            _sites[index] = _sites[index] with { Position = index };
            var site = _sites[index];
            Try(() => Db.UpdateSite(site));
        }
        Notify(nameof(Sites));
    }

    /// <summary>Swift's <c>site(forHost:)</c>.</summary>
    public Site? SiteForHost(string? host) =>
        host is null ? null : _sites.FirstOrDefault(s => DomainName.IsSameSite(s.Host, host));

    // MARK: Sample data

    /// <summary>Seeds a useful first screen: free, legal sources that work with no account.</summary>
    public void SeedDefaultSitesIfNeeded()
    {
        if (_sites.Count > 0) return;
        (string Name, string Url, string? Template)[] defaults =
        [
            ("YouTube", "https://www.youtube.com", "https://www.youtube.com/results?search_query=%s"),
            ("Tubi", "https://tubitv.com", "https://tubitv.com/search/%s"),
            ("Internet Archive", "https://archive.org/details/movies", "https://archive.org/search?query=%s"),
            ("Pluto TV", "https://pluto.tv", "https://pluto.tv/search/details?query=%s"),
        ];
        foreach (var (name, urlString, template) in defaults)
        {
            if (Urls.Parse(urlString) is not { } url || AddSite(url, name) is not { } site) continue;
            UpdateSite(site with { SearchTemplate = template });
        }
    }
}
