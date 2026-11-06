import Foundation
import Observation

/// Keeps ratings and lists in the cloud, so they come back after a library is cleared, imported
/// again or opened on another Mac. Only the small things travel: a film's name, year and IMDb id,
/// its rating and its list. Watch history stays on this Mac.
@Observable
final class CloudLibrary {
    private(set) var lastSync: Date?
    private(set) var isSyncing = false
    private(set) var lastError: String?
    private(set) var cloudCount = 0

    @ObservationIgnored private unowned let session: ProfileSession
    @ObservationIgnored private var pending: Set<Int64> = []
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var lastPull = Date.distantPast
    @ObservationIgnored private var startTask: Task<Void, Never>?
    /// The profile closed. Nothing may touch it after this.
    @ObservationIgnored private var isStopped = false

    init(session: ProfileSession) {
        self.session = session
    }

    private var isOn: Bool { !isStopped && session.settings.cloudBackup && session.together.isAvailable }

    func start() {
        session.library.onPersonalChange = { [weak self] title in self?.noteChange(title) }
        guard isOn else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 10 * 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.syncNow() }
        }
        // A moment after launch, so starting up stays quick.
        startTask?.cancel()
        startTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    func stop() {
        isStopped = true
        timer?.invalidate()
        timer = nil
        flushTask?.cancel()
        startTask?.cancel()
    }

    func syncNow() {
        Task { [weak self] in await self?.sync() }
    }

    /// Something was rated or filed. Sent a couple of seconds later, together with anything else.
    func noteChange(_ title: Title) {
        guard isOn else { return }
        pending.insert(title.id)
        flushTask?.cancel()
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            await self?.flush()
        }
    }

    // MARK: Keys

    /// How a film is known in the cloud: its IMDb id when there is one, otherwise its name and year.
    nonisolated static func key(imdbID: String?, normName: String, year: Int?) -> String {
        if let imdbID, imdbID.hasPrefix("tt") { return imdbID }
        return "n:\(normName.prefix(140))|\(year.map(String.init) ?? "")"
    }

    nonisolated static func keys(for title: Title) -> [String] {
        var keys = [key(imdbID: nil, normName: title.normName, year: title.year)]
        if let imdb = title.imdbID, imdb.hasPrefix("tt") { keys.insert(imdb, at: 0) }
        return keys
    }

    private static func item(for title: Title) -> [String: Any] {
        var item: [String: Any] = [
            "key": key(imdbID: title.imdbID, normName: title.normName, year: title.year),
            "name": String(title.name.prefix(200)),
            "kind": title.kind.rawValue,
            "status": title.status.rawValue,
            "statusAt": ms(title.statusAt ?? title.updatedAt),
        ]
        if let year = title.year { item["year"] = year }
        if let finished = title.finishedAt { item["finishedAt"] = ms(finished) }
        if let rated = title.ratedAt {
            item["rating"] = title.ratingHalves.map { $0 as Any } ?? NSNull()
            item["ratedAt"] = ms(rated)
        }
        return item
    }

    private static func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }

    // MARK: Sending

    private func flush() async {
        guard !isStopped else { return }
        let ids = pending
        pending = []
        let titles = ids.compactMap { session.library.titles[$0] }
        guard !titles.isEmpty else { return }
        do {
            try await put(titles)
            lastSync = .now
            lastError = nil
        } catch {
            pending.formUnion(ids)
            lastError = error.localizedDescription
        }
    }

    private func put(_ titles: [Title]) async throws {
        let (client, secret) = try await session.together.authorized()
        for start in stride(from: 0, to: titles.count, by: 200) {
            let batch = titles[start..<min(titles.count, start + 200)].map(Self.item)
            let _: Saved = try await client.mutation("library:put", ["deviceSecret": secret, "items": batch])
        }
    }

    // MARK: Syncing

    /// Takes what the cloud knows that this Mac doesn't, and sends what only this Mac knows.
    func sync() async {
        guard isOn, !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            let (client, secret) = try await session.together.authorized()
            let remote: [CloudItem] = try await client.query(
                "library:all", ["deviceSecret": secret, "t": (Date.now.timeIntervalSince1970 * 1000).rounded()]
            )
            cloudCount = remote.count
            guard !isStopped else { return }
            let outgoing = merge(remote)
            if !outgoing.isEmpty { try await put(outgoing) }
            lastSync = .now
            lastPull = .now
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Applies newer cloud values here and returns the titles whose values here are newer.
    private func merge(_ remote: [CloudItem]) -> [Title] {
        var byKey: [String: CloudItem] = [:]
        for item in remote {
            if let known = byKey[item.key], known.newest >= item.newest { continue }
            byKey[item.key] = item
        }
        let library = session.library
        var outgoing: [Title] = []
        for title in library.titles.values {
            // An IMDb id found after the first backup leaves the old name-only entry behind. Both count.
            let matches = Self.keys(for: title).compactMap { byKey[$0] }
            let rated = matches.filter { $0.ratedAt != nil }.max { ($0.ratedAt ?? 0) < ($1.ratedAt ?? 0) }
            let filed = matches.filter { $0.statusAt != nil }.max { ($0.statusAt ?? 0) < ($1.statusAt ?? 0) }

            var halves: Int?? = nil
            var ratedAt: Date?
            let localRated = title.ratedAt.map { $0.timeIntervalSince1970 * 1000 } ?? 0
            if let rated, let at = rated.ratedAt, at > localRated + 500 {
                halves = .some(rated.rating.map { Int($0) })
                ratedAt = Date(timeIntervalSince1970: at / 1000)
            }

            var status: TitleStatus?
            var statusAt: Date?
            if let filed, let at = filed.statusAt, let remoteStatus = filed.status.flatMap(TitleStatus.init(rawValue:)),
               remoteStatus != title.status {
                // A title imported without a date only takes the cloud's list when it isn't in one here.
                let localAt = title.statusAt.map { $0.timeIntervalSince1970 * 1000 }
                if let localAt, at > localAt + 500 {
                    status = remoteStatus
                } else if localAt == nil, title.status == .none {
                    status = remoteStatus
                }
                statusAt = status != nil ? Date(timeIntervalSince1970: at / 1000) : nil
            }

            if halves != nil || status != nil {
                library.restore(
                    title.id, halves: halves, ratedAt: ratedAt, status: status, statusAt: statusAt,
                    finishedAt: filed?.finishedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
                )
            }

            let cloudRatedAt = rated?.ratedAt ?? 0
            let cloudStatusAt = filed?.statusAt ?? 0
            let localStatusAt = (title.statusAt ?? title.updatedAt).timeIntervalSince1970 * 1000
            let ratingIsNewer = title.ratedAt != nil && halves == nil && localRated > cloudRatedAt + 500
            let statusIsNewer = status == nil && title.status != .none && (filed == nil || (title.statusAt != nil && localStatusAt > cloudStatusAt + 500))
            if ratingIsNewer || statusIsNewer, let current = library.titles[title.id] { outgoing.append(current) }
        }
        return outgoing
    }
}

/// One title as the cloud keeps it.
nonisolated struct CloudItem: Decodable, Sendable {
    var key: String
    var name: String
    var rating: Double?
    var ratedAt: Double?
    var status: String?
    var statusAt: Double?
    var finishedAt: Double?

    var newest: Double { max(ratedAt ?? 0, statusAt ?? 0) }
}

private nonisolated struct Saved: Decodable, Sendable {
    var saved: Double?
}
