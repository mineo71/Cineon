namespace Cineon.Core.Data;

// Port of Cineon/Core/Database.swift. Same tables, columns, indexes, pragmas and migration steps, so
// a profile database moves between the Mac and Windows in either direction. Dates are REAL seconds
// since 1970, booleans INTEGER 0/1, addresses TEXT, genres joined with "|", subtitles with "\n".

/// <summary>One database per profile. Everything a person does in Cineon lives in this file.</summary>
public sealed class Database : IDisposable
{
    public SqliteDb Sql { get; }

    /// <summary>Where saved frames live, next to the database so they go when the profile goes.</summary>
    public string FramesDirectory { get; }

    public Database(string path)
    {
        Sql = new SqliteDb(path);
        FramesDirectory = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path))!, "Frames");
        try
        {
            Migrate();
        }
        catch
        {
            Sql.Close();
            throw;
        }
    }

    public void Dispose() => Sql.Close();

    private void Migrate()
    {
        if (Sql.UserVersion < 1)
        {
            Sql.Transaction(() =>
            {
                Sql.Exec(Script(SchemaV1));
                Sql.Exec("PRAGMA user_version=1");
            });
        }
        if (Sql.UserVersion < 2)
        {
            Sql.Transaction(() =>
            {
                Sql.Exec(Script(SchemaV2));
                Sql.Exec("PRAGMA user_version=2");
            });
        }
        if (Sql.UserVersion < 3)
        {
            Sql.Transaction(() =>
            {
                Sql.Exec(Script(SchemaV3));
                Sql.Exec("PRAGMA user_version=3");
            });
        }
        if (Sql.UserVersion < 4)
        {
            Sql.Transaction(() =>
            {
                Sql.Exec(Script(SchemaV4));
                Sql.Exec("PRAGMA user_version=4");
            });
        }
    }

    /// <summary>
    /// SQLite keeps each CREATE statement's text as written, so line endings are pinned to "\n" to
    /// match the Mac's schema even when this file is checked out with CRLF.
    /// </summary>
    private static string Script(string sql) => sql.ReplaceLineEndings("\n");

    // The scripts below are copied character for character from Database.swift.

    /// <summary>Ratings move from five stars to ten with halves, kept as half steps: 15 is 7.5.</summary>
    internal const string SchemaV4 = """
    ALTER TABLE titles ADD COLUMN rated_at REAL;
    ALTER TABLE titles ADD COLUMN status_at REAL;
    UPDATE titles SET rating = MIN(20, MAX(1, rating * 4)), rated_at = updated_at WHERE rating IS NOT NULL;
    CREATE TABLE episode_alerts(
        title_id INTEGER PRIMARY KEY REFERENCES titles(id) ON DELETE CASCADE,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        checked_at REAL NOT NULL,
        new_season INTEGER,
        new_episode INTEGER,
        new_count INTEGER NOT NULL DEFAULT 0,
        new_at REAL
    );
    """;

    internal const string SchemaV3 = """
    CREATE TABLE downloads(
        id INTEGER PRIMARY KEY,
        title_id INTEGER REFERENCES titles(id) ON DELETE SET NULL,
        season INTEGER NOT NULL DEFAULT 0,
        episode INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        source_url TEXT NOT NULL,
        page_url TEXT,
        referer TEXT,
        host TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'file',
        quality TEXT,
        file TEXT,
        subtitles TEXT NOT NULL DEFAULT '',
        bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        position REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        poster_url TEXT,
        created_at REAL NOT NULL,
        finished_at REAL,
        played_at REAL
    );
    CREATE INDEX downloads_time ON downloads(created_at DESC);
    """;

    internal const string SchemaV2 = """
    CREATE TABLE skip_rules(
        id INTEGER PRIMARY KEY,
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        site TEXT NOT NULL,
        kind TEXT NOT NULL,
        start REAL NOT NULL,
        end REAL NOT NULL DEFAULT 0,
        sightings INTEGER NOT NULL DEFAULT 1,
        misses INTEGER NOT NULL DEFAULT 0,
        updated_at REAL NOT NULL,
        UNIQUE(title_id, site, kind)
    );

    CREATE TABLE frames(
        id INTEGER PRIMARY KEY,
        session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        season INTEGER NOT NULL DEFAULT 0,
        episode INTEGER NOT NULL DEFAULT 0,
        position REAL NOT NULL,
        url TEXT,
        file TEXT NOT NULL,
        is_moment INTEGER NOT NULL DEFAULT 0,
        interest REAL NOT NULL DEFAULT 0,
        at REAL NOT NULL
    );
    CREATE INDEX frames_session ON frames(session_id, position);
    CREATE INDEX frames_title ON frames(title_id, at DESC);
    """;

    internal const string SchemaV1 = """
    CREATE TABLE titles(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        norm_name TEXT NOT NULL,
        year INTEGER,
        kind TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'none',
        imdb_id TEXT,
        poster_url TEXT,
        backdrop_url TEXT,
        overview TEXT,
        genres TEXT NOT NULL DEFAULT '',
        runtime_min INTEGER,
        rating INTEGER,
        notes TEXT,
        added_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        finished_at REAL,
        last_watched_at REAL,
        metadata_checked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX titles_norm ON titles(norm_name);
    CREATE UNIQUE INDEX titles_imdb ON titles(imdb_id) WHERE imdb_id IS NOT NULL;

    CREATE TABLE progress(
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        season INTEGER NOT NULL DEFAULT 0,
        episode INTEGER NOT NULL DEFAULT 0,
        url_key TEXT NOT NULL,
        url TEXT,
        host TEXT NOT NULL,
        position REAL NOT NULL,
        duration REAL NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0,
        updated_at REAL NOT NULL,
        PRIMARY KEY(title_id, season, episode)
    );
    CREATE INDEX progress_url ON progress(url_key);

    CREATE TABLE sessions(
        id INTEGER PRIMARY KEY,
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        season INTEGER NOT NULL DEFAULT 0,
        episode INTEGER NOT NULL DEFAULT 0,
        episode_name TEXT,
        url TEXT,
        host TEXT NOT NULL,
        started_at REAL NOT NULL,
        ended_at REAL NOT NULL,
        watched_seconds REAL NOT NULL DEFAULT 0,
        start_position REAL NOT NULL DEFAULT 0,
        end_position REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        finished INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX sessions_time ON sessions(started_at DESC);
    CREATE INDEX sessions_title ON sessions(title_id, started_at DESC);

    CREATE TABLE events(
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        at REAL NOT NULL
    );
    CREATE INDEX events_time ON events(at DESC);

    CREATE TABLE url_links(
        url_key TEXT PRIMARY KEY,
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        season INTEGER NOT NULL DEFAULT 0,
        episode INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE ignored(url_key TEXT PRIMARY KEY, at REAL NOT NULL);

    CREATE TABLE sites(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        home_url TEXT NOT NULL,
        search_template TEXT,
        icon_url TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        added_at REAL NOT NULL,
        last_used_at REAL
    );
    CREATE UNIQUE INDEX sites_host ON sites(host);

    CREATE TABLE history(
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL,
        host TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        visited_at REAL NOT NULL
    );
    CREATE INDEX history_time ON history(visited_at DESC);

    CREATE TABLE tabs(
        id TEXT PRIMARY KEY,
        url TEXT,
        title TEXT NOT NULL DEFAULT '',
        favicon_url TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 0,
        state BLOB
    );

    CREATE TABLE site_prefs(
        host TEXT PRIMARY KEY,
        shields_off INTEGER NOT NULL DEFAULT 0,
        allow_popups INTEGER NOT NULL DEFAULT 0,
        allow_redirects INTEGER NOT NULL DEFAULT 0,
        tracking_off INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE stats(
        day TEXT PRIMARY KEY,
        ads INTEGER NOT NULL DEFAULT 0,
        popups INTEGER NOT NULL DEFAULT 0,
        redirects INTEGER NOT NULL DEFAULT 0,
        overlays INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE settings(key TEXT PRIMARY KEY, value BLOB NOT NULL);
    """;

    private static DateTimeOffset Now => DateTimeOffset.UtcNow;

    // MARK: Episode alerts

    public List<EpisodeAlert> EpisodeAlerts() =>
        Sql.Query(
            "SELECT title_id,season,episode,checked_at,new_season,new_episode,new_count,new_at FROM episode_alerts",
            r => new EpisodeAlert
            {
                TitleId = r.Int(0),
                Latest = new EpisodeRef(r.IntValue(1), r.IntValue(2)),
                CheckedAt = r.Date(3),
                Newest = r.OptInt(4) is int season ? new EpisodeRef(season, r.IntValue(5)) : null,
                NewCount = r.IntValue(6),
                NewAt = r.OptDate(7),
            });

    public void SaveEpisodeAlert(EpisodeAlert a) =>
        Sql.Run(
            """
            INSERT OR REPLACE INTO episode_alerts(title_id,season,episode,checked_at,new_season,new_episode,new_count,new_at)
            VALUES(?,?,?,?,?,?,?,?)
            """,
            a.TitleId, a.Latest.Season, a.Latest.Episode, a.CheckedAt,
            a.Newest?.Season, a.Newest?.Episode, a.NewCount, a.NewAt);

    // MARK: Titles

    private const string TitleColumns =
        "id,name,norm_name,year,kind,status,imdb_id,poster_url,backdrop_url,overview,genres,runtime_min," +
        "rating,notes,added_at,updated_at,finished_at,last_watched_at,metadata_checked,rated_at,status_at";

    private static Title MapTitle(SqlRow r) => new()
    {
        Id = r.Int(0),
        Name = r.Text(1),
        NormName = r.Text(2),
        Year = r.OptInt(3),
        Kind = TitleKind.FromRaw(r.Text(4)) ?? TitleKind.Unknown,
        Status = TitleStatus.FromRaw(r.Text(5)) ?? TitleStatus.None,
        ImdbId = r.OptText(6),
        PosterUrl = r.OptUrl(7),
        BackdropUrl = r.OptUrl(8),
        Overview = r.OptText(9),
        Genres = r.Text(10).Split('|', StringSplitOptions.RemoveEmptyEntries),
        RuntimeMinutes = r.OptInt(11),
        RatingHalves = r.OptInt(12),
        Notes = r.OptText(13),
        AddedAt = r.Date(14),
        UpdatedAt = r.Date(15),
        FinishedAt = r.OptDate(16),
        LastWatchedAt = r.OptDate(17),
        MetadataChecked = r.Bool(18),
        RatedAt = r.OptDate(19),
        StatusAt = r.OptDate(20),
    };

    public List<Title> AllTitles() => Sql.Query($"SELECT {TitleColumns} FROM titles", MapTitle);

    public long InsertTitle(Title t) =>
        Sql.Run(
            """
            INSERT INTO titles(name,norm_name,year,kind,status,imdb_id,poster_url,backdrop_url,overview,genres,runtime_min,rating,notes,added_at,updated_at,finished_at,last_watched_at,metadata_checked,rated_at,status_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            TitleArgs(t));

    public void UpdateTitle(Title t) =>
        Sql.Run(
            """
            UPDATE titles SET name=?,norm_name=?,year=?,kind=?,status=?,imdb_id=?,poster_url=?,backdrop_url=?,overview=?,genres=?,runtime_min=?,rating=?,notes=?,added_at=?,updated_at=?,finished_at=?,last_watched_at=?,metadata_checked=?,rated_at=?,status_at=? WHERE id=?
            """,
            [.. TitleArgs(t), t.Id]);

    private static SqlValue[] TitleArgs(Title t) =>
    [
        t.Name, t.NormName, t.Year, t.Kind.ToRaw(), t.Status.ToRaw(),
        t.ImdbId, t.PosterUrl, t.BackdropUrl, t.Overview,
        string.Join('|', t.Genres), t.RuntimeMinutes, t.RatingHalves, t.Notes,
        t.AddedAt, t.UpdatedAt, t.FinishedAt, t.LastWatchedAt, t.MetadataChecked,
        t.RatedAt, t.StatusAt,
    ];

    public void DeleteTitle(long id) => Sql.Run("DELETE FROM titles WHERE id=?", id);

    /// <summary>
    /// Moves all watch records from one title to another, used when a recognised title turns out to
    /// be a duplicate of something already in the library.
    /// </summary>
    public void MergeTitle(long from, long into) =>
        Sql.Transaction(() =>
        {
            Sql.Run("UPDATE sessions SET title_id=? WHERE title_id=?", into, from);
            Sql.Run("UPDATE events SET title_id=? WHERE title_id=?", into, from);
            Sql.Run("UPDATE OR REPLACE url_links SET title_id=? WHERE title_id=?", into, from);
            Sql.Run("UPDATE OR IGNORE progress SET title_id=? WHERE title_id=?", into, from);
            Sql.Run("UPDATE OR IGNORE skip_rules SET title_id=? WHERE title_id=?", into, from);
            Sql.Run("UPDATE frames SET title_id=? WHERE title_id=?", into, from);
            Sql.Run("UPDATE downloads SET title_id=? WHERE title_id=?", into, from);
            Sql.Run("DELETE FROM titles WHERE id=?", from);
        });

    // MARK: Progress

    private const string ProgressColumns = "title_id,season,episode,url_key,url,host,position,duration,finished,updated_at";

    private static WatchProgress MapProgress(SqlRow r) => new()
    {
        TitleId = r.Int(0),
        Ref = new EpisodeRef(r.IntValue(1), r.IntValue(2)),
        UrlKey = r.Text(3),
        Url = r.OptUrl(4),
        Host = r.Text(5),
        Position = r.Real(6),
        Duration = r.Real(7),
        Finished = r.Bool(8),
        UpdatedAt = r.Date(9),
    };

    public List<WatchProgress> AllProgress() =>
        Sql.Query($"SELECT {ProgressColumns} FROM progress ORDER BY updated_at DESC", MapProgress);

    public WatchProgress? Progress(string urlKey) =>
        Sql.Query(
            $"SELECT {ProgressColumns} FROM progress WHERE url_key=? ORDER BY updated_at DESC LIMIT 1",
            [urlKey], MapProgress).FirstOrDefault();

    public WatchProgress? Progress(long titleId, EpisodeRef episode) =>
        Sql.Query(
            $"SELECT {ProgressColumns} FROM progress WHERE title_id=? AND season=? AND episode=?",
            [titleId, episode.Season, episode.Episode], MapProgress).FirstOrDefault();

    public void UpsertProgress(WatchProgress p) =>
        Sql.Run(
            """
            INSERT INTO progress(title_id,season,episode,url_key,url,host,position,duration,finished,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(title_id,season,episode) DO UPDATE SET
              url_key=excluded.url_key,url=excluded.url,host=excluded.host,position=excluded.position,
              duration=excluded.duration,finished=MAX(progress.finished,excluded.finished),updated_at=excluded.updated_at
            """,
            p.TitleId, p.Ref.Season, p.Ref.Episode, p.UrlKey, p.Url,
            p.Host, p.Position, p.Duration, p.Finished, p.UpdatedAt);

    public void ClearProgress(long titleId, EpisodeRef episode) =>
        Sql.Run(
            "UPDATE progress SET position=0, finished=0 WHERE title_id=? AND season=? AND episode=?",
            titleId, episode.Season, episode.Episode);

    // MARK: Sessions

    private const string SessionColumns =
        "id,title_id,season,episode,episode_name,url,host,started_at,ended_at,watched_seconds,start_position," +
        "end_position,duration,finished";

    private static WatchSession MapSession(SqlRow r) => new()
    {
        Id = r.Int(0),
        TitleId = r.Int(1),
        Ref = new EpisodeRef(r.IntValue(2), r.IntValue(3)),
        EpisodeName = r.OptText(4),
        Url = r.OptUrl(5),
        Host = r.Text(6),
        StartedAt = r.Date(7),
        EndedAt = r.Date(8),
        WatchedSeconds = r.Real(9),
        StartPosition = r.Real(10),
        EndPosition = r.Real(11),
        Duration = r.Real(12),
        Finished = r.Bool(13),
    };

    /// <summary>Latest first, started before <paramref name="before"/> (any time when null).</summary>
    public List<WatchSession> Sessions(int limit = 300, DateTimeOffset? before = null) =>
        Sql.Query(
            $"SELECT {SessionColumns} FROM sessions WHERE started_at < ? ORDER BY started_at DESC LIMIT ?",
            [before.HasValue ? StoredDate.ToUnix(before.Value) : StoredDate.DistantFutureUnixSeconds, limit], MapSession);

    /// <summary>Swift's <c>sessions(titleID:)</c>: one title's sessions, latest first.</summary>
    public List<WatchSession> SessionsForTitle(long titleId) =>
        Sql.Query(
            $"SELECT {SessionColumns} FROM sessions WHERE title_id=? ORDER BY started_at DESC",
            [titleId], MapSession);

    public WatchSession? LatestSession(long titleId, EpisodeRef episode, DateTimeOffset after) =>
        Sql.Query(
            $"""
            SELECT {SessionColumns} FROM sessions
            WHERE title_id=? AND season=? AND episode=? AND ended_at>=?
            ORDER BY ended_at DESC LIMIT 1
            """,
            [titleId, episode.Season, episode.Episode, after], MapSession).FirstOrDefault();

    /// <summary>The last time this exact page was watched, for addresses older than the saved progress.</summary>
    public WatchSession? LatestSession(Uri url) =>
        Sql.Query(
            $"SELECT {SessionColumns} FROM sessions WHERE url=? ORDER BY ended_at DESC LIMIT 1",
            [url], MapSession).FirstOrDefault();

    public long InsertSession(WatchSession s) =>
        Sql.Run(
            """
            INSERT INTO sessions(title_id,season,episode,episode_name,url,host,started_at,ended_at,watched_seconds,
            start_position,end_position,duration,finished) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            s.TitleId, s.Ref.Season, s.Ref.Episode, s.EpisodeName, s.Url,
            s.Host, s.StartedAt, s.EndedAt, s.WatchedSeconds, s.StartPosition,
            s.EndPosition, s.Duration, s.Finished);

    public void UpdateSession(WatchSession s) =>
        Sql.Run(
            "UPDATE sessions SET ended_at=?,watched_seconds=?,end_position=?,duration=?,finished=?,url=?,host=? WHERE id=?",
            s.EndedAt, s.WatchedSeconds, s.EndPosition, s.Duration, s.Finished, s.Url, s.Host, s.Id);

    public void DeleteSession(long id) => Sql.Run("DELETE FROM sessions WHERE id=?", id);

    /// <summary>Seconds watched per day (UTC days, as on the Mac), for the calendar on the timeline.</summary>
    public List<(DateTimeOffset Day, double Seconds)> SecondsPerDay(DateTimeOffset since) =>
        Sql.Query(
            """
            SELECT CAST(started_at/86400 AS INTEGER) AS d, SUM(watched_seconds) FROM sessions
            WHERE started_at>=? GROUP BY d ORDER BY d
            """,
            [since], r => (StoredDate.FromUnix(r.Int(0) * 86400.0), r.Real(1)));

    public double TotalSeconds(DateTimeOffset since) =>
        Sql.Query(
            "SELECT COALESCE(SUM(watched_seconds),0) FROM sessions WHERE started_at>=?",
            [since], r => r.Real(0)).FirstOrDefault();

    // MARK: Skip rules

    private const string SkipColumns = "id,title_id,site,kind,start,end,sightings,misses,updated_at";

    private static SkipRule? MapSkipRule(SqlRow r)
    {
        if (SkipRuleKind.FromRaw(r.Text(3)) is not { } kind) return null;
        return new SkipRule
        {
            Id = r.Int(0), TitleId = r.Int(1), Site = r.Text(2), Kind = kind, Start = r.Real(4), End = r.Real(5),
            Sightings = r.IntValue(6), Misses = r.IntValue(7), UpdatedAt = r.Date(8),
        };
    }

    public List<SkipRule> SkipRules(long titleId) =>
        [.. Sql.Query($"SELECT {SkipColumns} FROM skip_rules WHERE title_id=? ORDER BY site,kind", [titleId], MapSkipRule).OfType<SkipRule>()];

    public List<SkipRule> SkipRules(long titleId, string site) =>
        [.. Sql.Query($"SELECT {SkipColumns} FROM skip_rules WHERE title_id=? AND site=?", [titleId, site], MapSkipRule).OfType<SkipRule>()];

    public void SaveSkipRule(SkipRule rule) =>
        Sql.Run(
            """
            INSERT INTO skip_rules(title_id,site,kind,start,end,sightings,misses,updated_at) VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(title_id,site,kind) DO UPDATE SET start=excluded.start,end=excluded.end,
              sightings=excluded.sightings,misses=excluded.misses,updated_at=excluded.updated_at
            """,
            rule.TitleId, rule.Site, rule.Kind.ToRaw(), rule.Start, rule.End,
            rule.Sightings, rule.Misses, rule.UpdatedAt);

    public void DeleteSkipRule(long id) => Sql.Run("DELETE FROM skip_rules WHERE id=?", id);

    // MARK: Frames

    private const string FrameColumns = "id,session_id,title_id,season,episode,position,url,file,is_moment,interest,at";

    private static FilmFrame MapFrame(SqlRow r) => new()
    {
        Id = r.Int(0),
        SessionId = r.IsNull(1) ? null : r.Int(1),
        TitleId = r.Int(2),
        Ref = new EpisodeRef(r.IntValue(3), r.IntValue(4)),
        Position = r.Real(5),
        Url = r.OptUrl(6),
        File = r.Text(7),
        IsMoment = r.Bool(8),
        Interest = r.Real(9),
        At = r.Date(10),
    };

    public List<FilmFrame> AllFrames() => Sql.Query($"SELECT {FrameColumns} FROM frames ORDER BY position", MapFrame);

    public long InsertFrame(FilmFrame f) =>
        Sql.Run(
            "INSERT INTO frames(session_id,title_id,season,episode,position,url,file,is_moment,interest,at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            f.SessionId, f.TitleId, f.Ref.Season, f.Ref.Episode,
            f.Position, f.Url, f.File, f.IsMoment, f.Interest, f.At);

    public void DeleteFrame(long id) => Sql.Run("DELETE FROM frames WHERE id=?", id);

    public void DeleteAllFrames() => Sql.Run("DELETE FROM frames");

    /// <summary>Every host this person has been to, latest first, for spotting another address of a site.</summary>
    public List<string> KnownHosts() =>
        Sql.Query(
            """
            SELECT host, MAX(at) AS last FROM (
              SELECT host, visited_at AS at FROM history
              UNION ALL SELECT host, ended_at FROM sessions
              UNION ALL SELECT host, updated_at FROM progress
            ) WHERE host <> '' GROUP BY host ORDER BY last DESC LIMIT 500
            """,
            r => r.Text(0));

    // MARK: Downloads

    private const string DownloadColumns =
        "id,title_id,season,episode,name,source_url,page_url,referer,host,kind,quality,file,subtitles,bytes," +
        "total_bytes,status,error,position,duration,poster_url,created_at,finished_at,played_at";

    private static DownloadItem? MapDownload(SqlRow r)
    {
        if (r.OptUrl(5) is not { } source) return null;
        return new DownloadItem
        {
            Id = r.Int(0),
            TitleId = r.IsNull(1) ? null : r.Int(1),
            Ref = new EpisodeRef(r.IntValue(2), r.IntValue(3)),
            Name = r.Text(4),
            SourceUrl = source,
            PageUrl = r.OptUrl(6),
            Referer = r.OptText(7),
            Host = r.Text(8),
            Kind = MediaSourceKind.FromRaw(r.Text(9)) ?? MediaSourceKind.File,
            Quality = r.OptText(10),
            File = r.OptText(11),
            Subtitles = r.Text(12).Split('\n', StringSplitOptions.RemoveEmptyEntries),
            Bytes = r.Int(13),
            TotalBytes = r.Int(14),
            Status = DownloadStatus.FromRaw(r.Text(15)) ?? DownloadStatus.Failed,
            Error = r.OptText(16),
            Position = r.Real(17),
            Duration = r.Real(18),
            PosterUrl = r.OptUrl(19),
            CreatedAt = r.Date(20),
            FinishedAt = r.OptDate(21),
            PlayedAt = r.OptDate(22),
        };
    }

    public List<DownloadItem> AllDownloads() =>
        [.. Sql.Query($"SELECT {DownloadColumns} FROM downloads ORDER BY created_at DESC", MapDownload).OfType<DownloadItem>()];

    private static SqlValue[] DownloadArgs(DownloadItem d) =>
    [
        d.TitleId, d.Ref.Season, d.Ref.Episode, d.Name, d.SourceUrl.OriginalString,
        d.PageUrl, d.Referer, d.Host, d.Kind.ToRaw(), d.Quality, d.File,
        string.Join('\n', d.Subtitles), d.Bytes, d.TotalBytes, d.Status.ToRaw(), d.Error,
        d.Position, d.Duration, d.PosterUrl, d.CreatedAt, d.FinishedAt, d.PlayedAt,
    ];

    public long InsertDownload(DownloadItem d) =>
        Sql.Run(
            """
            INSERT INTO downloads(title_id,season,episode,name,source_url,page_url,referer,host,kind,quality,file,subtitles,bytes,
            total_bytes,status,error,position,duration,poster_url,created_at,finished_at,played_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            DownloadArgs(d));

    public void UpdateDownload(DownloadItem d) =>
        Sql.Run(
            """
            UPDATE downloads SET title_id=?,season=?,episode=?,name=?,source_url=?,page_url=?,referer=?,host=?,kind=?,quality=?,
            file=?,subtitles=?,bytes=?,total_bytes=?,status=?,error=?,position=?,duration=?,poster_url=?,created_at=?,
            finished_at=?,played_at=? WHERE id=?
            """,
            [.. DownloadArgs(d), d.Id]);

    public void DeleteDownload(long id) => Sql.Run("DELETE FROM downloads WHERE id=?", id);

    // MARK: Events

    public void AddEvent(LibraryEventKind kind, long titleId, DateTimeOffset? at = null) =>
        Sql.Run("INSERT INTO events(kind,title_id,at) VALUES(?,?,?)", kind.ToRaw(), titleId, at ?? Now);

    public List<LibraryEvent> Events(int limit = 300) =>
        Sql.Query("SELECT id,kind,title_id,at FROM events ORDER BY at DESC LIMIT ?", [limit], r => new LibraryEvent
        {
            Id = r.Int(0),
            Kind = LibraryEventKind.FromRaw(r.Text(1)) ?? LibraryEventKind.Removed,
            TitleId = r.Int(2),
            At = r.Date(3),
        });

    // MARK: Links and ignores

    public (long TitleId, EpisodeRef Ref)? Link(string urlKey) =>
        Sql.Query("SELECT title_id,season,episode FROM url_links WHERE url_key=?", [urlKey],
                r => ((long TitleId, EpisodeRef Ref)?)(r.Int(0), new EpisodeRef(r.IntValue(1), r.IntValue(2))))
            .FirstOrDefault();

    public void SetLink(string urlKey, long titleId, EpisodeRef episode) =>
        Sql.Run(
            "INSERT OR REPLACE INTO url_links(url_key,title_id,season,episode) VALUES(?,?,?,?)",
            urlKey, titleId, episode.Season, episode.Episode);

    public bool IsIgnored(string urlKey) =>
        Sql.Query("SELECT 1 FROM ignored WHERE url_key=?", [urlKey], _ => true).Count > 0;

    public void Ignore(string urlKey) =>
        Sql.Run("INSERT OR REPLACE INTO ignored(url_key,at) VALUES(?,?)", urlKey, Now);

    // MARK: Sites

    private static Site? MapSite(SqlRow r)
    {
        if (r.OptUrl(3) is not { } home) return null;
        return new Site
        {
            Id = r.Int(0), Name = r.Text(1), Host = r.Text(2), HomeUrl = home, SearchTemplate = r.OptText(4),
            IconUrl = r.OptUrl(5), Position = r.IntValue(6), AddedAt = r.Date(7), LastUsedAt = r.OptDate(8),
        };
    }

    public List<Site> AllSites() =>
        [.. Sql.Query(
            "SELECT id,name,host,home_url,search_template,icon_url,position,added_at,last_used_at FROM sites ORDER BY position,id",
            MapSite).OfType<Site>()];

    public long InsertSite(Site s) =>
        Sql.Run(
            "INSERT INTO sites(name,host,home_url,search_template,icon_url,position,added_at,last_used_at) VALUES(?,?,?,?,?,?,?,?)",
            s.Name, s.Host, s.HomeUrl.OriginalString, s.SearchTemplate, s.IconUrl,
            s.Position, s.AddedAt, s.LastUsedAt);

    public void UpdateSite(Site s) =>
        Sql.Run(
            "UPDATE sites SET name=?,host=?,home_url=?,search_template=?,icon_url=?,position=?,last_used_at=? WHERE id=?",
            s.Name, s.Host, s.HomeUrl.OriginalString, s.SearchTemplate, s.IconUrl,
            s.Position, s.LastUsedAt, s.Id);

    public void DeleteSite(long id) => Sql.Run("DELETE FROM sites WHERE id=?", id);

    // MARK: History

    public void AddHistory(Uri url, string host, string title)
    {
        // Collapse reloads and quick returns to the same page into one row.
        var recent = Now.AddSeconds(-1800);
        var existing = Sql.Query(
            "SELECT id FROM history WHERE url=? AND visited_at>=? ORDER BY visited_at DESC LIMIT 1",
            [url, recent], r => (long?)r.Int(0)).FirstOrDefault();
        if (existing is long id)
        {
            Sql.Run("UPDATE history SET title=?,visited_at=? WHERE id=?", title, Now, id);
        }
        else
        {
            Sql.Run("INSERT INTO history(url,host,title,visited_at) VALUES(?,?,?,?)", url, host, title, Now);
        }
    }

    public void UpdateHistoryTitle(Uri url, string title) =>
        Sql.Run(
            """
            UPDATE history SET title=? WHERE id=(SELECT id FROM history WHERE url=? ORDER BY visited_at DESC LIMIT 1)
            """,
            title, url);

    private static HistoryEntry? MapHistory(SqlRow r)
    {
        if (r.OptUrl(1) is not { } url) return null;
        return new HistoryEntry { Id = r.Int(0), Url = url, Host = r.Text(2), Title = r.Text(3), VisitedAt = r.Date(4) };
    }

    public List<HistoryEntry> SearchHistory(string query, int limit = 8)
    {
        var like = "%" + query.Replace("%", "") + "%";
        return [.. Sql.Query(
            """
            SELECT id,url,host,title,MAX(visited_at) FROM history
            WHERE title LIKE ? OR url LIKE ? GROUP BY url ORDER BY MAX(visited_at) DESC LIMIT ?
            """,
            [like, like, limit], MapHistory).OfType<HistoryEntry>()];
    }

    public List<HistoryEntry> RecentHistory(int limit = 300) =>
        [.. Sql.Query(
            "SELECT id,url,host,title,visited_at FROM history ORDER BY visited_at DESC LIMIT ?",
            [limit], MapHistory).OfType<HistoryEntry>()];

    public void ClearHistory() => Sql.Run("DELETE FROM history");

    // MARK: Tabs

    public List<PersistedTab> LoadTabs() =>
        Sql.Query("SELECT id,url,title,favicon_url,position,active,state FROM tabs ORDER BY position", r => new PersistedTab
        {
            Id = Guid.TryParseExact(r.Text(0), "D", out var id) ? id : Guid.NewGuid(),
            Url = r.OptUrl(1),
            Title = r.Text(2),
            FaviconUrl = r.OptUrl(3),
            Position = r.IntValue(4),
            IsActive = r.Bool(5),
            State = r.OptBlob(6),
            IsPinnedToSearch = false,
        });

    public void SaveTabs(IEnumerable<PersistedTab> tabs) =>
        Sql.Transaction(() =>
        {
            Sql.Run("DELETE FROM tabs");
            foreach (var t in tabs)
            {
                Sql.Run(
                    "INSERT INTO tabs(id,url,title,favicon_url,position,active,state) VALUES(?,?,?,?,?,?,?)",
                    UuidString(t.Id), t.Url, t.Title, t.FaviconUrl,
                    t.Position, t.IsActive, t.State);
            }
        });

    /// <summary>A UUID as Swift's <c>uuidString</c> writes it: upper-case, with hyphens.</summary>
    public static string UuidString(Guid id) => id.ToString("D").ToUpperInvariant();

    // MARK: Site preferences

    public Dictionary<string, SitePrefs> SitePrefs()
    {
        var rows = Sql.Query("SELECT host,shields_off,allow_popups,allow_redirects,tracking_off FROM site_prefs", r =>
            new SitePrefs(r.Text(0))
            {
                ShieldsOff = r.Bool(1), AllowPopups = r.Bool(2), AllowRedirects = r.Bool(3), TrackingOff = r.Bool(4),
            });
        return rows.ToDictionary(p => p.Host);
    }

    public void SaveSitePrefs(SitePrefs p) =>
        Sql.Run(
            "INSERT OR REPLACE INTO site_prefs(host,shields_off,allow_popups,allow_redirects,tracking_off) VALUES(?,?,?,?,?)",
            p.Host, p.ShieldsOff, p.AllowPopups, p.AllowRedirects, p.TrackingOff);

    // MARK: Shield statistics

    /// <summary>Adds to one day's counts. <paramref name="day"/> is the Mac's "yyyy-MM-dd" text.</summary>
    public void AddStats(ShieldStats delta, string day) =>
        Sql.Run(
            """
            INSERT INTO stats(day,ads,popups,redirects,overlays) VALUES(?,?,?,?,?)
            ON CONFLICT(day) DO UPDATE SET ads=ads+excluded.ads,popups=popups+excluded.popups,
              redirects=redirects+excluded.redirects,overlays=overlays+excluded.overlays
            """,
            day, delta.Ads, delta.Popups, delta.Redirects, delta.Overlays);

    public ShieldStats TotalStats() =>
        Sql.Query(
            "SELECT COALESCE(SUM(ads),0),COALESCE(SUM(popups),0),COALESCE(SUM(redirects),0),COALESCE(SUM(overlays),0) FROM stats",
            r => new ShieldStats { Ads = r.IntValue(0), Popups = r.IntValue(1), Redirects = r.IntValue(2), Overlays = r.IntValue(3) })
            .FirstOrDefault();

    // MARK: Settings

    public AppSettings LoadSettings()
    {
        byte[]? data;
        try
        {
            data = Sql.Query("SELECT value FROM settings WHERE key='app'", r => r.OptBlob(0)).FirstOrDefault();
        }
        catch (SqlError)
        {
            data = null;
        }
        return data is null ? new AppSettings() : AppSettings.Decode(data) ?? new AppSettings();
    }

    public void SaveSettings(AppSettings settings)
    {
        byte[] data;
        try
        {
            data = settings.Encode();
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            return;
        }
        try
        {
            Sql.Run("INSERT OR REPLACE INTO settings(key,value) VALUES('app',?)", data);
        }
        catch (SqlError)
        {
        }
    }
}
