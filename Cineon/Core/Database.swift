import Foundation

/// One database per profile. Everything a person does in Cineon lives in this file.
final class Database {
    let sql: SQLiteDB
    /// Where saved frames live, next to the database so they go when the profile goes.
    let framesDirectory: URL

    init(path: String) throws {
        sql = try SQLiteDB(path: path)
        framesDirectory = URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("Frames", isDirectory: true)
        try migrate()
    }

    private func migrate() throws {
        if sql.userVersion < 1 {
            try sql.transaction {
                try sql.exec(Self.schemaV1)
                try sql.exec("PRAGMA user_version=1")
            }
        }
        if sql.userVersion < 2 {
            try sql.transaction {
                try sql.exec(Self.schemaV2)
                try sql.exec("PRAGMA user_version=2")
            }
        }
        if sql.userVersion < 3 {
            try sql.transaction {
                try sql.exec(Self.schemaV3)
                try sql.exec("PRAGMA user_version=3")
            }
        }
        if sql.userVersion < 4 {
            try sql.transaction {
                try sql.exec(Self.schemaV4)
                try sql.exec("PRAGMA user_version=4")
            }
        }
    }

    /// Ratings move from five stars to ten with halves, kept as half steps: 15 is 7.5.
    private static let schemaV4 = """
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
    """

    private static let schemaV3 = """
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
    """

    private static let schemaV2 = """
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
    """

    private static let schemaV1 = """
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
    """

    // MARK: Episode alerts

    func episodeAlerts() throws -> [EpisodeAlert] {
        try sql.query(
            "SELECT title_id,season,episode,checked_at,new_season,new_episode,new_count,new_at FROM episode_alerts", []
        ) { r in
            EpisodeAlert(
                titleID: r.int(0), latest: EpisodeRef(season: r.intValue(1), episode: r.intValue(2)), checkedAt: r.date(3),
                newest: r.optInt(4).map { EpisodeRef(season: $0, episode: r.intValue(5)) }, newCount: r.intValue(6), newAt: r.optDate(7)
            )
        }
    }

    func saveEpisodeAlert(_ a: EpisodeAlert) throws {
        try sql.run(
            """
            INSERT OR REPLACE INTO episode_alerts(title_id,season,episode,checked_at,new_season,new_episode,new_count,new_at)
            VALUES(?,?,?,?,?,?,?,?)
            """,
            [.int(a.titleID), .opt(a.latest.season), .opt(a.latest.episode), .date(a.checkedAt),
             .opt(a.newest?.season), .opt(a.newest?.episode), .opt(a.newCount), .opt(a.newAt)]
        )
    }

    // MARK: Titles

    private static let titleColumns = """
    id,name,norm_name,year,kind,status,imdb_id,poster_url,backdrop_url,overview,genres,runtime_min,\
    rating,notes,added_at,updated_at,finished_at,last_watched_at,metadata_checked,rated_at,status_at
    """

    private func mapTitle(_ r: SQLRow) -> Title {
        Title(
            id: r.int(0),
            name: r.text(1),
            normName: r.text(2),
            year: r.optInt(3),
            kind: TitleKind(rawValue: r.text(4)) ?? .unknown,
            status: TitleStatus(rawValue: r.text(5)) ?? .none,
            imdbID: r.optText(6),
            posterURL: r.optURL(7),
            backdropURL: r.optURL(8),
            overview: r.optText(9),
            genres: r.text(10).split(separator: "|").map(String.init),
            runtimeMinutes: r.optInt(11),
            ratingHalves: r.optInt(12),
            notes: r.optText(13),
            addedAt: r.date(14),
            updatedAt: r.date(15),
            finishedAt: r.optDate(16),
            lastWatchedAt: r.optDate(17),
            metadataChecked: r.bool(18),
            ratedAt: r.optDate(19),
            statusAt: r.optDate(20)
        )
    }

    func allTitles() throws -> [Title] {
        try sql.query("SELECT \(Self.titleColumns) FROM titles", [], mapTitle)
    }

    func insertTitle(_ t: Title) throws -> Int64 {
        try sql.run(
            """
            INSERT INTO titles(name,norm_name,year,kind,status,imdb_id,poster_url,backdrop_url,overview,genres,\
            runtime_min,rating,notes,added_at,updated_at,finished_at,last_watched_at,metadata_checked,rated_at,status_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            titleArgs(t)
        )
    }

    func updateTitle(_ t: Title) throws {
        try sql.run(
            """
            UPDATE titles SET name=?,norm_name=?,year=?,kind=?,status=?,imdb_id=?,poster_url=?,backdrop_url=?,\
            overview=?,genres=?,runtime_min=?,rating=?,notes=?,added_at=?,updated_at=?,finished_at=?,\
            last_watched_at=?,metadata_checked=?,rated_at=?,status_at=? WHERE id=?
            """,
            titleArgs(t) + [.int(t.id)]
        )
    }

    private func titleArgs(_ t: Title) -> [SQLValue] {
        [
            .text(t.name), .text(t.normName), .opt(t.year), .text(t.kind.rawValue), .text(t.status.rawValue),
            .opt(t.imdbID), .opt(t.posterURL), .opt(t.backdropURL), .opt(t.overview),
            .text(t.genres.joined(separator: "|")), .opt(t.runtimeMinutes), .opt(t.ratingHalves), .opt(t.notes),
            .date(t.addedAt), .date(t.updatedAt), .opt(t.finishedAt), .opt(t.lastWatchedAt), .bool(t.metadataChecked),
            .opt(t.ratedAt), .opt(t.statusAt),
        ]
    }

    func deleteTitle(_ id: Int64) throws {
        try sql.run("DELETE FROM titles WHERE id=?", [.int(id)])
    }

    /// Moves all watch records from one title to another, used when a recognised title
    /// turns out to be a duplicate of something already in the library.
    func mergeTitle(from source: Int64, into target: Int64) throws {
        try sql.transaction {
            try sql.run("UPDATE sessions SET title_id=? WHERE title_id=?", [.int(target), .int(source)])
            try sql.run("UPDATE events SET title_id=? WHERE title_id=?", [.int(target), .int(source)])
            try sql.run("UPDATE OR REPLACE url_links SET title_id=? WHERE title_id=?", [.int(target), .int(source)])
            try sql.run("UPDATE OR IGNORE progress SET title_id=? WHERE title_id=?", [.int(target), .int(source)])
            try sql.run("UPDATE OR IGNORE skip_rules SET title_id=? WHERE title_id=?", [.int(target), .int(source)])
            try sql.run("UPDATE frames SET title_id=? WHERE title_id=?", [.int(target), .int(source)])
            try sql.run("UPDATE downloads SET title_id=? WHERE title_id=?", [.int(target), .int(source)])
            try sql.run("DELETE FROM titles WHERE id=?", [.int(source)])
        }
    }

    // MARK: Progress

    private static let progressColumns = "title_id,season,episode,url_key,url,host,position,duration,finished,updated_at"

    private func mapProgress(_ r: SQLRow) -> WatchProgress {
        WatchProgress(
            titleID: r.int(0),
            ref: EpisodeRef(season: r.intValue(1), episode: r.intValue(2)),
            urlKey: r.text(3),
            url: r.optURL(4),
            host: r.text(5),
            position: r.real(6),
            duration: r.real(7),
            finished: r.bool(8),
            updatedAt: r.date(9)
        )
    }

    func allProgress() throws -> [WatchProgress] {
        try sql.query("SELECT \(Self.progressColumns) FROM progress ORDER BY updated_at DESC", [], mapProgress)
    }

    func progress(urlKey: String) throws -> WatchProgress? {
        try sql.query(
            "SELECT \(Self.progressColumns) FROM progress WHERE url_key=? ORDER BY updated_at DESC LIMIT 1",
            [.text(urlKey)], mapProgress
        ).first
    }

    func progress(titleID: Int64, ref: EpisodeRef) throws -> WatchProgress? {
        try sql.query(
            "SELECT \(Self.progressColumns) FROM progress WHERE title_id=? AND season=? AND episode=?",
            [.int(titleID), .int(Int64(ref.season)), .int(Int64(ref.episode))], mapProgress
        ).first
    }

    func upsertProgress(_ p: WatchProgress) throws {
        try sql.run(
            """
            INSERT INTO progress(title_id,season,episode,url_key,url,host,position,duration,finished,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(title_id,season,episode) DO UPDATE SET
              url_key=excluded.url_key,url=excluded.url,host=excluded.host,position=excluded.position,
              duration=excluded.duration,finished=MAX(progress.finished,excluded.finished),updated_at=excluded.updated_at
            """,
            [
                .int(p.titleID), .int(Int64(p.ref.season)), .int(Int64(p.ref.episode)), .text(p.urlKey), .opt(p.url),
                .text(p.host), .real(p.position), .real(p.duration), .bool(p.finished), .date(p.updatedAt),
            ]
        )
    }

    func clearProgress(titleID: Int64, ref: EpisodeRef) throws {
        try sql.run(
            "UPDATE progress SET position=0, finished=0 WHERE title_id=? AND season=? AND episode=?",
            [.int(titleID), .int(Int64(ref.season)), .int(Int64(ref.episode))]
        )
    }

    // MARK: Sessions

    private static let sessionColumns = """
    id,title_id,season,episode,episode_name,url,host,started_at,ended_at,watched_seconds,start_position,\
    end_position,duration,finished
    """

    private func mapSession(_ r: SQLRow) -> WatchSession {
        WatchSession(
            id: r.int(0),
            titleID: r.int(1),
            ref: EpisodeRef(season: r.intValue(2), episode: r.intValue(3)),
            episodeName: r.optText(4),
            url: r.optURL(5),
            host: r.text(6),
            startedAt: r.date(7),
            endedAt: r.date(8),
            watchedSeconds: r.real(9),
            startPosition: r.real(10),
            endPosition: r.real(11),
            duration: r.real(12),
            finished: r.bool(13)
        )
    }

    func sessions(limit: Int = 300, before: Date? = nil) throws -> [WatchSession] {
        try sql.query(
            "SELECT \(Self.sessionColumns) FROM sessions WHERE started_at < ? ORDER BY started_at DESC LIMIT ?",
            [.date(before ?? .distantFuture), .int(Int64(limit))], mapSession
        )
    }

    func sessions(titleID: Int64) throws -> [WatchSession] {
        try sql.query(
            "SELECT \(Self.sessionColumns) FROM sessions WHERE title_id=? ORDER BY started_at DESC",
            [.int(titleID)], mapSession
        )
    }

    func latestSession(titleID: Int64, ref: EpisodeRef, after: Date) throws -> WatchSession? {
        try sql.query(
            """
            SELECT \(Self.sessionColumns) FROM sessions
            WHERE title_id=? AND season=? AND episode=? AND ended_at>=?
            ORDER BY ended_at DESC LIMIT 1
            """,
            [.int(titleID), .int(Int64(ref.season)), .int(Int64(ref.episode)), .date(after)], mapSession
        ).first
    }

    /// The last time this exact page was watched, for addresses older than the saved progress.
    func latestSession(url: URL) throws -> WatchSession? {
        try sql.query(
            "SELECT \(Self.sessionColumns) FROM sessions WHERE url=? ORDER BY ended_at DESC LIMIT 1",
            [.text(url.absoluteString)], mapSession
        ).first
    }

    func insertSession(_ s: WatchSession) throws -> Int64 {
        try sql.run(
            """
            INSERT INTO sessions(title_id,season,episode,episode_name,url,host,started_at,ended_at,watched_seconds,
            start_position,end_position,duration,finished) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            [
                .int(s.titleID), .int(Int64(s.ref.season)), .int(Int64(s.ref.episode)), .opt(s.episodeName), .opt(s.url),
                .text(s.host), .date(s.startedAt), .date(s.endedAt), .real(s.watchedSeconds), .real(s.startPosition),
                .real(s.endPosition), .real(s.duration), .bool(s.finished),
            ]
        )
    }

    func updateSession(_ s: WatchSession) throws {
        try sql.run(
            "UPDATE sessions SET ended_at=?,watched_seconds=?,end_position=?,duration=?,finished=?,url=?,host=? WHERE id=?",
            [
                .date(s.endedAt), .real(s.watchedSeconds), .real(s.endPosition), .real(s.duration), .bool(s.finished),
                .opt(s.url), .text(s.host), .int(s.id),
            ]
        )
    }

    func deleteSession(_ id: Int64) throws {
        try sql.run("DELETE FROM sessions WHERE id=?", [.int(id)])
    }

    /// Seconds watched per day, for the calendar on the timeline.
    func secondsPerDay(since: Date) throws -> [(day: Date, seconds: Double)] {
        try sql.query(
            """
            SELECT CAST(started_at/86400 AS INTEGER) AS d, SUM(watched_seconds) FROM sessions
            WHERE started_at>=? GROUP BY d ORDER BY d
            """,
            [.date(since)]
        ) { (Date(timeIntervalSince1970: r_day($0)), $0.real(1)) }
    }

    func totalSeconds(since: Date) throws -> Double {
        try sql.query(
            "SELECT COALESCE(SUM(watched_seconds),0) FROM sessions WHERE started_at>=?", [.date(since)]
        ) { $0.real(0) }.first ?? 0
    }

    // MARK: Skip rules

    private static let skipColumns = "id,title_id,site,kind,start,end,sightings,misses,updated_at"

    private func mapSkipRule(_ r: SQLRow) -> SkipRule? {
        guard let kind = SkipRule.Kind(rawValue: r.text(3)) else { return nil }
        return SkipRule(
            id: r.int(0), titleID: r.int(1), site: r.text(2), kind: kind, start: r.real(4), end: r.real(5),
            sightings: r.intValue(6), misses: r.intValue(7), updatedAt: r.date(8)
        )
    }

    func skipRules(titleID: Int64) throws -> [SkipRule] {
        try sql.query(
            "SELECT \(Self.skipColumns) FROM skip_rules WHERE title_id=? ORDER BY site,kind", [.int(titleID)], mapSkipRule
        ).compactMap { $0 }
    }

    func skipRules(titleID: Int64, site: String) throws -> [SkipRule] {
        try sql.query(
            "SELECT \(Self.skipColumns) FROM skip_rules WHERE title_id=? AND site=?", [.int(titleID), .text(site)], mapSkipRule
        ).compactMap { $0 }
    }

    func saveSkipRule(_ rule: SkipRule) throws {
        try sql.run(
            """
            INSERT INTO skip_rules(title_id,site,kind,start,end,sightings,misses,updated_at) VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(title_id,site,kind) DO UPDATE SET start=excluded.start,end=excluded.end,
              sightings=excluded.sightings,misses=excluded.misses,updated_at=excluded.updated_at
            """,
            [
                .int(rule.titleID), .text(rule.site), .text(rule.kind.rawValue), .real(rule.start), .real(rule.end),
                .int(Int64(rule.sightings)), .int(Int64(rule.misses)), .date(rule.updatedAt),
            ]
        )
    }

    func deleteSkipRule(_ id: Int64) throws {
        try sql.run("DELETE FROM skip_rules WHERE id=?", [.int(id)])
    }

    // MARK: Frames

    private static let frameColumns = "id,session_id,title_id,season,episode,position,url,file,is_moment,interest,at"

    private func mapFrame(_ r: SQLRow) -> FilmFrame {
        FilmFrame(
            id: r.int(0), sessionID: r.optInt(1).map(Int64.init), titleID: r.int(2),
            ref: EpisodeRef(season: r.intValue(3), episode: r.intValue(4)), position: r.real(5), url: r.optURL(6),
            file: r.text(7), isMoment: r.bool(8), interest: r.real(9), at: r.date(10)
        )
    }

    func allFrames() throws -> [FilmFrame] {
        try sql.query("SELECT \(Self.frameColumns) FROM frames ORDER BY position", [], mapFrame)
    }

    func insertFrame(_ f: FilmFrame) throws -> Int64 {
        try sql.run(
            "INSERT INTO frames(session_id,title_id,season,episode,position,url,file,is_moment,interest,at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [
                .opt(f.sessionID), .int(f.titleID), .int(Int64(f.ref.season)), .int(Int64(f.ref.episode)),
                .real(f.position), .opt(f.url), .text(f.file), .bool(f.isMoment), .real(f.interest), .date(f.at),
            ]
        )
    }

    func deleteFrame(_ id: Int64) throws {
        try sql.run("DELETE FROM frames WHERE id=?", [.int(id)])
    }

    func deleteAllFrames() throws {
        try sql.run("DELETE FROM frames")
    }

    /// Every host this person has been to, latest first, for spotting another address of a site.
    func knownHosts() throws -> [String] {
        try sql.query(
            """
            SELECT host, MAX(at) AS last FROM (
              SELECT host, visited_at AS at FROM history
              UNION ALL SELECT host, ended_at FROM sessions
              UNION ALL SELECT host, updated_at FROM progress
            ) WHERE host <> '' GROUP BY host ORDER BY last DESC LIMIT 500
            """
        ) { $0.text(0) }
    }

    // MARK: Downloads

    private static let downloadColumns = """
    id,title_id,season,episode,name,source_url,page_url,referer,host,kind,quality,file,subtitles,bytes,\
    total_bytes,status,error,position,duration,poster_url,created_at,finished_at,played_at
    """

    private func mapDownload(_ r: SQLRow) -> DownloadItem? {
        guard let source = r.optURL(5) else { return nil }
        return DownloadItem(
            id: r.int(0), titleID: r.optInt(1).map(Int64.init), ref: EpisodeRef(season: r.intValue(2), episode: r.intValue(3)),
            name: r.text(4), sourceURL: source, pageURL: r.optURL(6), referer: r.optText(7), host: r.text(8),
            kind: MediaSource.Kind(rawValue: r.text(9)) ?? .file, quality: r.optText(10), file: r.optText(11),
            subtitles: r.text(12).split(separator: "\n").map(String.init), bytes: r.int(13), totalBytes: r.int(14),
            status: DownloadStatus(rawValue: r.text(15)) ?? .failed, error: r.optText(16), position: r.real(17),
            duration: r.real(18), posterURL: r.optURL(19), createdAt: r.date(20), finishedAt: r.optDate(21),
            playedAt: r.optDate(22)
        )
    }

    func allDownloads() throws -> [DownloadItem] {
        try sql.query("SELECT \(Self.downloadColumns) FROM downloads ORDER BY created_at DESC", [], mapDownload).compactMap { $0 }
    }

    private func downloadArgs(_ d: DownloadItem) -> [SQLValue] {
        [
            .opt(d.titleID), .int(Int64(d.ref.season)), .int(Int64(d.ref.episode)), .text(d.name), .text(d.sourceURL.absoluteString),
            .opt(d.pageURL), .opt(d.referer), .text(d.host), .text(d.kind.rawValue), .opt(d.quality), .opt(d.file),
            .text(d.subtitles.joined(separator: "\n")), .int(d.bytes), .int(d.totalBytes), .text(d.status.rawValue), .opt(d.error),
            .real(d.position), .real(d.duration), .opt(d.posterURL), .date(d.createdAt), .opt(d.finishedAt), .opt(d.playedAt),
        ]
    }

    func insertDownload(_ d: DownloadItem) throws -> Int64 {
        try sql.run(
            """
            INSERT INTO downloads(title_id,season,episode,name,source_url,page_url,referer,host,kind,quality,file,subtitles,bytes,
            total_bytes,status,error,position,duration,poster_url,created_at,finished_at,played_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            downloadArgs(d)
        )
    }

    func updateDownload(_ d: DownloadItem) throws {
        try sql.run(
            """
            UPDATE downloads SET title_id=?,season=?,episode=?,name=?,source_url=?,page_url=?,referer=?,host=?,kind=?,quality=?,
            file=?,subtitles=?,bytes=?,total_bytes=?,status=?,error=?,position=?,duration=?,poster_url=?,created_at=?,
            finished_at=?,played_at=? WHERE id=?
            """,
            downloadArgs(d) + [.int(d.id)]
        )
    }

    func deleteDownload(_ id: Int64) throws {
        try sql.run("DELETE FROM downloads WHERE id=?", [.int(id)])
    }

    // MARK: Events

    func addEvent(_ kind: LibraryEventKind, titleID: Int64, at: Date = .now) throws {
        try sql.run("INSERT INTO events(kind,title_id,at) VALUES(?,?,?)", [.text(kind.rawValue), .int(titleID), .date(at)])
    }

    func events(limit: Int = 300) throws -> [LibraryEvent] {
        try sql.query("SELECT id,kind,title_id,at FROM events ORDER BY at DESC LIMIT ?", [.int(Int64(limit))]) { r in
            LibraryEvent(id: r.int(0), kind: LibraryEventKind(rawValue: r.text(1)) ?? .removed, titleID: r.int(2), at: r.date(3))
        }
    }

    // MARK: Links and ignores

    func link(urlKey: String) throws -> (titleID: Int64, ref: EpisodeRef)? {
        try sql.query("SELECT title_id,season,episode FROM url_links WHERE url_key=?", [.text(urlKey)]) { r in
            (r.int(0), EpisodeRef(season: r.intValue(1), episode: r.intValue(2)))
        }.first
    }

    func setLink(urlKey: String, titleID: Int64, ref: EpisodeRef) throws {
        try sql.run(
            "INSERT OR REPLACE INTO url_links(url_key,title_id,season,episode) VALUES(?,?,?,?)",
            [.text(urlKey), .int(titleID), .int(Int64(ref.season)), .int(Int64(ref.episode))]
        )
    }

    func isIgnored(urlKey: String) throws -> Bool {
        try !sql.query("SELECT 1 FROM ignored WHERE url_key=?", [.text(urlKey)]) { _ in true }.isEmpty
    }

    func ignore(urlKey: String) throws {
        try sql.run("INSERT OR REPLACE INTO ignored(url_key,at) VALUES(?,?)", [.text(urlKey), .date(.now)])
    }

    // MARK: Sites

    private func mapSite(_ r: SQLRow) -> Site? {
        guard let home = r.optURL(3) else { return nil }
        return Site(
            id: r.int(0), name: r.text(1), host: r.text(2), homeURL: home, searchTemplate: r.optText(4),
            iconURL: r.optURL(5), position: r.intValue(6), addedAt: r.date(7), lastUsedAt: r.optDate(8)
        )
    }

    func allSites() throws -> [Site] {
        try sql.query(
            "SELECT id,name,host,home_url,search_template,icon_url,position,added_at,last_used_at FROM sites ORDER BY position,id",
            [], mapSite
        ).compactMap { $0 }
    }

    func insertSite(_ s: Site) throws -> Int64 {
        try sql.run(
            "INSERT INTO sites(name,host,home_url,search_template,icon_url,position,added_at,last_used_at) VALUES(?,?,?,?,?,?,?,?)",
            [
                .text(s.name), .text(s.host), .text(s.homeURL.absoluteString), .opt(s.searchTemplate), .opt(s.iconURL),
                .int(Int64(s.position)), .date(s.addedAt), .opt(s.lastUsedAt),
            ]
        )
    }

    func updateSite(_ s: Site) throws {
        try sql.run(
            "UPDATE sites SET name=?,host=?,home_url=?,search_template=?,icon_url=?,position=?,last_used_at=? WHERE id=?",
            [
                .text(s.name), .text(s.host), .text(s.homeURL.absoluteString), .opt(s.searchTemplate), .opt(s.iconURL),
                .int(Int64(s.position)), .opt(s.lastUsedAt), .int(s.id),
            ]
        )
    }

    func deleteSite(_ id: Int64) throws {
        try sql.run("DELETE FROM sites WHERE id=?", [.int(id)])
    }

    // MARK: History

    func addHistory(url: URL, host: String, title: String) throws {
        // Collapse reloads and quick returns to the same page into one row.
        let recent = Date.now.addingTimeInterval(-1800)
        let existing = try sql.query(
            "SELECT id FROM history WHERE url=? AND visited_at>=? ORDER BY visited_at DESC LIMIT 1",
            [.text(url.absoluteString), .date(recent)]
        ) { $0.int(0) }.first
        if let existing {
            try sql.run("UPDATE history SET title=?,visited_at=? WHERE id=?", [.text(title), .date(.now), .int(existing)])
        } else {
            try sql.run(
                "INSERT INTO history(url,host,title,visited_at) VALUES(?,?,?,?)",
                [.text(url.absoluteString), .text(host), .text(title), .date(.now)]
            )
        }
    }

    func updateHistoryTitle(url: URL, title: String) throws {
        try sql.run(
            """
            UPDATE history SET title=? WHERE id=(SELECT id FROM history WHERE url=? ORDER BY visited_at DESC LIMIT 1)
            """,
            [.text(title), .text(url.absoluteString)]
        )
    }

    private func mapHistory(_ r: SQLRow) -> HistoryEntry? {
        guard let url = r.optURL(1) else { return nil }
        return HistoryEntry(id: r.int(0), url: url, host: r.text(2), title: r.text(3), visitedAt: r.date(4))
    }

    func searchHistory(_ query: String, limit: Int = 8) throws -> [HistoryEntry] {
        let like = "%" + query.replacingOccurrences(of: "%", with: "") + "%"
        return try sql.query(
            """
            SELECT id,url,host,title,MAX(visited_at) FROM history
            WHERE title LIKE ? OR url LIKE ? GROUP BY url ORDER BY MAX(visited_at) DESC LIMIT ?
            """,
            [.text(like), .text(like), .int(Int64(limit))], mapHistory
        ).compactMap { $0 }
    }

    func recentHistory(limit: Int = 300) throws -> [HistoryEntry] {
        try sql.query(
            "SELECT id,url,host,title,visited_at FROM history ORDER BY visited_at DESC LIMIT ?",
            [.int(Int64(limit))], mapHistory
        ).compactMap { $0 }
    }

    func clearHistory() throws {
        try sql.run("DELETE FROM history")
    }

    // MARK: Tabs

    func loadTabs() throws -> [PersistedTab] {
        try sql.query("SELECT id,url,title,favicon_url,position,active,state FROM tabs ORDER BY position") { r in
            PersistedTab(
                id: UUID(uuidString: r.text(0)) ?? UUID(),
                url: r.optURL(1),
                title: r.text(2),
                faviconURL: r.optURL(3),
                position: r.intValue(4),
                isActive: r.bool(5),
                state: r.optBlob(6),
                isPinnedToSearch: false
            )
        }
    }

    func saveTabs(_ tabs: [PersistedTab]) throws {
        try sql.transaction {
            try sql.run("DELETE FROM tabs")
            for t in tabs {
                try sql.run(
                    "INSERT INTO tabs(id,url,title,favicon_url,position,active,state) VALUES(?,?,?,?,?,?,?)",
                    [
                        .text(t.id.uuidString), .opt(t.url), .text(t.title), .opt(t.faviconURL),
                        .int(Int64(t.position)), .bool(t.isActive), .opt(t.state),
                    ]
                )
            }
        }
    }

    // MARK: Site preferences

    func sitePrefs() throws -> [String: SitePrefs] {
        let rows = try sql.query("SELECT host,shields_off,allow_popups,allow_redirects,tracking_off FROM site_prefs") { r in
            SitePrefs(host: r.text(0), shieldsOff: r.bool(1), allowPopups: r.bool(2), allowRedirects: r.bool(3), trackingOff: r.bool(4))
        }
        return Dictionary(uniqueKeysWithValues: rows.map { ($0.host, $0) })
    }

    func saveSitePrefs(_ p: SitePrefs) throws {
        try sql.run(
            "INSERT OR REPLACE INTO site_prefs(host,shields_off,allow_popups,allow_redirects,tracking_off) VALUES(?,?,?,?,?)",
            [.text(p.host), .bool(p.shieldsOff), .bool(p.allowPopups), .bool(p.allowRedirects), .bool(p.trackingOff)]
        )
    }

    // MARK: Shield statistics

    func addStats(_ delta: ShieldStats, day: String) throws {
        try sql.run(
            """
            INSERT INTO stats(day,ads,popups,redirects,overlays) VALUES(?,?,?,?,?)
            ON CONFLICT(day) DO UPDATE SET ads=ads+excluded.ads,popups=popups+excluded.popups,
              redirects=redirects+excluded.redirects,overlays=overlays+excluded.overlays
            """,
            [.text(day), .int(Int64(delta.ads)), .int(Int64(delta.popups)), .int(Int64(delta.redirects)), .int(Int64(delta.overlays))]
        )
    }

    func totalStats() throws -> ShieldStats {
        try sql.query(
            "SELECT COALESCE(SUM(ads),0),COALESCE(SUM(popups),0),COALESCE(SUM(redirects),0),COALESCE(SUM(overlays),0) FROM stats"
        ) { r in
            ShieldStats(ads: r.intValue(0), popups: r.intValue(1), redirects: r.intValue(2), overlays: r.intValue(3))
        }.first ?? ShieldStats()
    }

    // MARK: Settings

    func loadSettings() -> AppSettings {
        let data = (try? sql.query("SELECT value FROM settings WHERE key='app'") { $0.optBlob(0) })?.first ?? nil
        guard let data, let decoded = try? JSONDecoder().decode(AppSettings.self, from: data) else {
            return AppSettings()
        }
        return decoded
    }

    func saveSettings(_ settings: AppSettings) {
        guard let data = try? JSONEncoder().encode(settings) else { return }
        _ = try? sql.run("INSERT OR REPLACE INTO settings(key,value) VALUES('app',?)", [.blob(data)])
    }
}

private nonisolated func r_day(_ r: SQLRow) -> TimeInterval { TimeInterval(r.int(0)) * 86400 }
