import Foundation
import Observation

/// In-memory view of one profile's library, kept in step with the database.
@Observable
final class LibraryStore {
    @ObservationIgnored let db: Database

    private(set) var titles: [Int64: Title] = [:]
    private(set) var progress: [WatchProgress] = []
    private(set) var sessions: [WatchSession] = []
    private(set) var events: [LibraryEvent] = []
    private(set) var sites: [Site] = []
    private(set) var framesBySession: [Int64: [FilmFrame]] = [:]
    private(set) var momentsByTitle: [Int64: [FilmFrame]] = [:]
    private(set) var bestFrameByTitle: [Int64: FilmFrame] = [:]
    /// Bumped on every timeline change, so views can refresh their derived data.
    private(set) var revision = 0
    @ObservationIgnored private var mergedInto: [Int64: Int64] = [:]
    /// Called when someone rates or files a title themselves, for the cloud backup.
    @ObservationIgnored var onPersonalChange: ((Title) -> Void)?

    init(db: Database) {
        self.db = db
        reload()
    }

    func reload() {
        titles = Dictionary(uniqueKeysWithValues: ((try? db.allTitles()) ?? []).map { ($0.id, $0) })
        progress = (try? db.allProgress()) ?? []
        sessions = (try? db.sessions(limit: 600)) ?? []
        events = (try? db.events(limit: 300)) ?? []
        sites = (try? db.allSites()) ?? []
        loadFrames()
        revision += 1
    }

    private func loadFrames() {
        framesBySession = [:]
        momentsByTitle = [:]
        bestFrameByTitle = [:]
        for frame in (try? db.allFrames()) ?? [] { index(frame) }
    }

    private func index(_ frame: FilmFrame) {
        if let session = frame.sessionID {
            framesBySession[session, default: []].append(frame)
            framesBySession[session]?.sort { $0.position < $1.position }
        }
        if frame.isMoment {
            momentsByTitle[frame.titleID, default: []].append(frame)
            momentsByTitle[frame.titleID]?.sort { $0.at > $1.at }
        }
        if (bestFrameByTitle[frame.titleID]?.interest ?? -1) < frame.interest {
            bestFrameByTitle[frame.titleID] = frame
        }
    }

    // MARK: Lists

    private func list(_ status: TitleStatus) -> [Title] {
        titles.values.filter { $0.status == status }
    }

    var backlog: [Title] { list(.backlog).sorted { $0.addedAt > $1.addedAt } }

    var watching: [Title] {
        list(.watching).sorted { ($0.lastWatchedAt ?? $0.updatedAt) > ($1.lastWatchedAt ?? $1.updatedAt) }
    }

    var watched: [Title] {
        list(.watched).sorted { ($0.finishedAt ?? $0.updatedAt) > ($1.finishedAt ?? $1.updatedAt) }
    }

    func count(_ status: TitleStatus) -> Int { titles.values.reduce(0) { $0 + ($1.status == status ? 1 : 0) } }

    /// Latest place you stopped, per title in progress.
    var continueWatching: [(title: Title, progress: WatchProgress)] {
        var seen = Set<Int64>()
        var out: [(Title, WatchProgress)] = []
        for p in progress where !seen.contains(p.titleID) {
            seen.insert(p.titleID)
            guard let title = titles[p.titleID], title.status == .watching else { continue }
            out.append((title, p))
        }
        return out
    }

    func latestProgress(titleID: Int64) -> WatchProgress? {
        progress.first { $0.titleID == titleID }
    }

    func progressList(titleID: Int64) -> [WatchProgress] {
        progress.filter { $0.titleID == titleID }
    }

    func sessions(titleID: Int64) -> [WatchSession] {
        (try? db.sessions(titleID: titleID)) ?? []
    }

    func search(_ query: String, limit: Int = 8) -> [Title] {
        let needle = TitleParser.normalize(query)
        guard !needle.isEmpty else { return [] }
        return titles.values
            .filter { $0.normName.contains(needle) }
            .sorted { lhs, rhs in
                let a = lhs.normName.hasPrefix(needle) ? 0 : 1
                let b = rhs.normName.hasPrefix(needle) ? 0 : 1
                if a != b { return a < b }
                return lhs.updatedAt > rhs.updatedAt
            }
            .prefix(limit)
            .map { $0 }
    }

    // MARK: Titles

    /// Finds a title already in the library that matches, by name and, when known, year.
    func find(name: String, altName: String? = nil, year: Int? = nil) -> Title? {
        let keys = [name, altName].compactMap { $0 }.map(TitleParser.normalize)
        let matches = titles.values.filter { keys.contains($0.normName) }
        if let year, let exact = matches.first(where: { $0.year == year }) { return exact }
        if let year { return matches.first { $0.year == nil || abs(($0.year ?? year) - year) <= 1 } }
        return matches.max { $0.updatedAt < $1.updatedAt }
    }

    @discardableResult
    func addTitle(
        name: String,
        year: Int? = nil,
        kind: TitleKind = .unknown,
        status: TitleStatus = .none,
        imdbID: String? = nil,
        posterURL: URL? = nil,
        backdropURL: URL? = nil,
        overview: String? = nil
    ) -> Title? {
        if let imdbID, let existing = titles.values.first(where: { $0.imdbID == imdbID }) {
            if status != .none, existing.status == .none { setStatus(existing.id, status) }
            return titles[existing.id]
        }
        var title = Title(
            id: 0, name: name, normName: TitleParser.normalize(name), year: year, kind: kind, status: status,
            imdbID: imdbID, posterURL: posterURL, backdropURL: backdropURL, overview: overview, genres: [],
            runtimeMinutes: nil, ratingHalves: nil, notes: nil, addedAt: .now, updatedAt: .now, finishedAt: nil,
            lastWatchedAt: nil, metadataChecked: false
        )
        guard let id = try? db.insertTitle(title) else { return nil }
        title.id = id
        titles[id] = title
        if status == .backlog {
            try? db.addEvent(.addedToBacklog, titleID: id)
            reloadEvents()
        }
        return title
    }

    func update(_ title: Title) {
        var copy = title
        copy.updatedAt = .now
        try? db.updateTitle(copy)
        titles[copy.id] = copy
    }

    func setStatus(_ id: Int64, _ status: TitleStatus) {
        guard var title = titles[id], title.status != status else { return }
        title.status = status
        title.updatedAt = .now
        title.statusAt = .now
        if status == .watched { title.finishedAt = .now }
        try? db.updateTitle(title)
        titles[id] = title
        onPersonalChange?(title)
        switch status {
        case .backlog: try? db.addEvent(.addedToBacklog, titleID: id)
        case .watched: try? db.addEvent(.markedWatched, titleID: id)
        case .watching: try? db.addEvent(.markedWatching, titleID: id)
        case .none: try? db.addEvent(.removed, titleID: id)
        }
        reloadEvents()
    }

    /// Out of ten in half steps (15 is 7.5), or nil to clear it.
    func setRating(_ id: Int64, halves: Int?) {
        guard var title = titles[id] else { return }
        let value = halves.map(Rating.clamp)
        guard title.ratingHalves != value else { return }
        title.ratingHalves = value
        title.ratedAt = .now
        title.updatedAt = .now
        try? db.updateTitle(title)
        titles[id] = title
        onPersonalChange?(title)
    }

    /// What the cloud backup remembers, applied without sending it straight back.
    func restore(_ id: Int64, halves: Int??, ratedAt: Date?, status: TitleStatus?, statusAt: Date?, finishedAt: Date?) {
        guard var title = titles[id] else { return }
        var changed = false
        if let halves, title.ratingHalves != halves {
            title.ratingHalves = halves.map(Rating.clamp)
            title.ratedAt = ratedAt
            changed = true
        }
        if let status, title.status != status {
            title.status = status
            title.statusAt = statusAt
            if status == .watched, title.finishedAt == nil { title.finishedAt = finishedAt ?? statusAt }
            changed = true
        }
        guard changed else { return }
        try? db.updateTitle(title)
        titles[id] = title
    }

    func delete(_ id: Int64) {
        // The folder has to go first: the database forgets which files were this title's.
        try? FileManager.default.removeItem(at: db.framesDirectory.appendingPathComponent("\(id)", isDirectory: true))
        try? db.deleteTitle(id)
        reload()
    }

    /// A recognised title can turn out to be a film already in the library, under another name.
    func merge(from source: Int64, into target: Int64) {
        guard source != target else { return }
        try? db.mergeTitle(from: source, into: target)
        mergedInto[source] = target
        reload()
    }

    /// Follows merges, so a session recording under an old ID keeps writing to the right title.
    func currentID(_ id: Int64) -> Int64? {
        var current = id
        while let next = mergedInto[current] { current = next }
        return titles[current] == nil ? nil : current
    }

    private func reloadEvents() {
        events = (try? db.events(limit: 300)) ?? []
        revision += 1
    }

    // MARK: Watching

    func recordWatchStart(titleID: Int64) {
        guard var title = titles[titleID] else { return }
        let previous = title.status
        title.lastWatchedAt = .now
        title.updatedAt = .now
        if previous != .watching { title.status = .watching }
        try? db.updateTitle(title)
        titles[titleID] = title
    }

    func saveProgress(_ p: WatchProgress) {
        try? db.upsertProgress(p)
        progress.removeAll { $0.titleID == p.titleID && $0.ref == p.ref }
        progress.insert(p, at: 0)
        if var title = titles[p.titleID] {
            title.lastWatchedAt = p.updatedAt
            titles[p.titleID] = title
            try? db.updateTitle(title)
        }
    }

    func clearProgress(titleID: Int64, ref: EpisodeRef) {
        try? db.clearProgress(titleID: titleID, ref: ref)
        progress = (try? db.allProgress()) ?? progress
    }

    func saveSession(_ s: WatchSession) -> WatchSession {
        var copy = s
        if s.id == 0 {
            copy.id = (try? db.insertSession(s)) ?? 0
        } else {
            try? db.updateSession(s)
        }
        if let index = sessions.firstIndex(where: { $0.id == copy.id }) {
            sessions[index] = copy
        } else {
            sessions.insert(copy, at: 0)
        }
        revision += 1
        return copy
    }

    func deleteSession(_ id: Int64) {
        // Frames go with their session. Moments someone chose to keep don't.
        for frame in framesBySession[id, default: []] where !frame.isMoment { removeFrameFile(frame) }
        try? db.deleteSession(id)
        sessions.removeAll { $0.id == id }
        loadFrames()
        revision += 1
    }

    // MARK: Frames

    func frames(sessionID: Int64) -> [FilmFrame] { framesBySession[sessionID, default: []] }
    func moments(titleID: Int64) -> [FilmFrame] { momentsByTitle[titleID, default: []] }
    func frameURL(_ frame: FilmFrame) -> URL { db.framesDirectory.appendingPathComponent(frame.file) }
    func bestFrameURL(titleID: Int64) -> URL? { bestFrameByTitle[titleID].map(frameURL) }

    func addFrame(_ frame: FilmFrame) {
        var copy = frame
        guard let id = try? db.insertFrame(frame) else { return }
        copy.id = id
        index(copy)
    }

    private func removeFrameFile(_ frame: FilmFrame) {
        try? FileManager.default.removeItem(at: frameURL(frame))
        try? db.deleteFrame(frame.id)
    }

    func deleteFrame(_ frame: FilmFrame) {
        removeFrameFile(frame)
        loadFrames()
    }

    func deleteAllFrames() {
        try? FileManager.default.removeItem(at: db.framesDirectory)
        try? db.deleteAllFrames()
        loadFrames()
    }

    /// Bytes on disk, worked out away from the main thread.
    func framesSize() async -> Int64 {
        let directory = db.framesDirectory
        return await Task.detached(priority: .utility) { Self.size(of: directory) }.value
    }

    nonisolated private static func size(of directory: URL) -> Int64 {
        guard let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in files {
            total += Int64((try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
        }
        return total
    }

    /// Keeps the folder from growing forever: past the limit, the oldest collected frames go.
    /// Moments are never removed by this.
    func pruneFrames(limit: Int64 = 800 * 1024 * 1024) {
        Task { [weak self] in
            guard let self, await self.framesSize() > limit else { return }
            let oldestFirst = ((try? self.db.allFrames()) ?? []).filter { !$0.isMoment }.sorted { $0.at < $1.at }
            let urls = oldestFirst.map(self.frameURL)
            let count = await Task.detached(priority: .utility) { () -> Int in
                let total = urls.reduce(Int64(0)) { sum, url in
                    sum + Int64((try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
                }
                var over = total - limit * 8 / 10
                var removed = 0
                for url in urls where over > 0 {
                    over -= Int64((try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
                    removed += 1
                }
                return removed
            }.value
            for frame in oldestFirst.prefix(count) { self.removeFrameFile(frame) }
            self.loadFrames()
        }
    }

    // MARK: Sites

    @discardableResult
    func addSite(url: URL, name: String? = nil) -> Site? {
        guard let host = url.host?.lowercased() else { return nil }
        let bare = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        if let existing = sites.first(where: { DomainName.isSameSite($0.host, bare) }) { return existing }
        // Most sites keep an icon here. Good enough until the first visit finds a sharper one.
        let icon = URL(string: "\(url.scheme ?? "https")://\(url.host ?? bare)/favicon.ico")
        var site = Site(
            id: 0, name: name ?? DomainName.displayName(bare), host: bare, homeURL: url, searchTemplate: nil, iconURL: icon,
            position: (sites.map(\.position).max() ?? -1) + 1, addedAt: .now, lastUsedAt: nil
        )
        guard let id = try? db.insertSite(site) else { return nil }
        site.id = id
        sites.append(site)
        return site
    }

    func updateSite(_ site: Site) {
        try? db.updateSite(site)
        if let index = sites.firstIndex(where: { $0.id == site.id }) { sites[index] = site }
    }

    func removeSite(_ id: Int64) {
        try? db.deleteSite(id)
        sites.removeAll { $0.id == id }
    }

    func moveSite(from source: IndexSet, to destination: Int) {
        sites.move(fromOffsets: source, toOffset: destination)
        for index in sites.indices {
            sites[index].position = index
            try? db.updateSite(sites[index])
        }
    }

    func site(forHost host: String?) -> Site? {
        guard let host else { return nil }
        return sites.first { DomainName.isSameSite($0.host, host) }
    }
}

// MARK: Sample data

extension LibraryStore {
    /// Seeds a useful first screen: free, legal sources that work with no account.
    func seedDefaultSitesIfNeeded() {
        guard sites.isEmpty else { return }
        let defaults: [(String, String, String?)] = [
            ("YouTube", "https://www.youtube.com", "https://www.youtube.com/results?search_query=%s"),
            ("Tubi", "https://tubitv.com", "https://tubitv.com/search/%s"),
            ("Internet Archive", "https://archive.org/details/movies", "https://archive.org/search?query=%s"),
            ("Pluto TV", "https://pluto.tv", "https://pluto.tv/search/details?query=%s"),
        ]
        for (name, urlString, template) in defaults {
            guard let url = URL(string: urlString), var site = addSite(url: url, name: name) else { continue }
            site.searchTemplate = template
            updateSite(site)
        }
    }
}
