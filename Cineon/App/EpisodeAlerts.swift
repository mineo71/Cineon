import AppKit
import Foundation
import Observation
import UserNotifications

/// Notices when a series you're watching gets a new episode. The first check of a series only
/// remembers what's already out, so nobody gets a pile of notifications for old episodes.
@Observable
final class EpisodeAlerts {
    private(set) var alerts: [Int64: EpisodeAlert] = [:]
    private(set) var isChecking = false
    #if DEBUG
    @ObservationIgnored var lastNotificationForTests: String?
    #endif

    @ObservationIgnored private unowned let session: ProfileSession
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var firstCheck: Task<Void, Never>?
    @ObservationIgnored private var isStopped = false

    /// How often the episode lists are looked at again.
    static let interval: TimeInterval = 6 * 60 * 60

    init(session: ProfileSession) {
        self.session = session
        alerts = Dictionary(uniqueKeysWithValues: ((try? session.db.episodeAlerts()) ?? []).map { ($0.titleID, $0) })
    }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 30 * 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkIfDue() }
        }
        firstCheck = Task { [weak self] in
            try? await Task.sleep(for: .seconds(60))
            self?.checkIfDue()
        }
    }

    func stop() {
        isStopped = true
        timer?.invalidate()
        timer = nil
        firstCheck?.cancel()
    }

    /// The series to keep an eye on: the ones you're watching.
    var watchedSeries: [Title] {
        session.library.titles.values.filter { $0.status == .watching && ($0.kind == .series || $0.kind == .cartoon) }
    }

    /// Series with episodes that came out since you last watched them, newest first.
    var fresh: [(title: Title, alert: EpisodeAlert)] {
        alerts.values.compactMap { alert -> (Title, EpisodeAlert)? in
            guard let newAt = alert.newAt, alert.newCount > 0, Date.now.timeIntervalSince(newAt) < 21 * 86_400,
                  let title = session.library.titles[alert.titleID], title.status != .watched
            else { return nil }
            // Watching it since the news came in means you've seen it.
            if let watched = title.lastWatchedAt, watched > newAt { return nil }
            return (title, alert)
        }
        .sorted { ($0.1.newAt ?? .distantPast) > ($1.1.newAt ?? .distantPast) }
    }

    private func checkIfDue() {
        guard !isStopped, session.settings.newEpisodeAlerts, !isChecking else { return }
        let due = watchedSeries.contains { title in
            guard let alert = alerts[title.id] else { return true }
            return Date.now.timeIntervalSince(alert.checkedAt) > Self.interval
        }
        if due { Task { [weak self] in await self?.check(force: false) } }
    }

    /// Looks at every series you're watching. `force` checks even ones looked at recently.
    func check(force: Bool) async {
        guard !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        var news: [(Title, [EpisodeRef])] = []
        for title in watchedSeries {
            if isStopped { return }
            if !force, let alert = alerts[title.id], Date.now.timeIntervalSince(alert.checkedAt) < Self.interval { continue }
            let episodes = await session.metadata.episodes(for: title, fresh: true)
            let aired = episodes
                .filter { $0.season > 0 && $0.episode > 0 && ($0.released ?? .distantPast) <= .now }
                .map { EpisodeRef(season: $0.season, episode: $0.episode) }
            guard let latest = aired.max(by: { ($0.season, $0.episode) < ($1.season, $1.episode) }) else { continue }
            var alert = alerts[title.id] ?? EpisodeAlert(titleID: title.id, latest: latest, checkedAt: .now, newest: nil, newCount: 0, newAt: nil)
            let isFirstLook = alerts[title.id] == nil
            let added = aired.filter { ($0.season, $0.episode) > (alert.latest.season, alert.latest.episode) }
            alert.checkedAt = .now
            if !isFirstLook, !added.isEmpty {
                alert.latest = latest
                alert.newest = latest
                alert.newCount += added.count
                alert.newAt = .now
                news.append((title, added.sorted { ($0.season, $0.episode) < ($1.season, $1.episode) }))
            }
            guard !isStopped else { return }
            alerts[title.id] = alert
            try? session.db.saveEpisodeAlert(alert)
        }
        for (title, added) in news { await notify(title: title, added: added) }
    }

    /// Clears the news for a series, once you've seen it.
    func dismiss(_ titleID: Int64) {
        guard var alert = alerts[titleID] else { return }
        alert.newCount = 0
        alert.newAt = nil
        alerts[titleID] = alert
        try? session.db.saveEpisodeAlert(alert)
    }

    // MARK: Notifications

    private func notify(title: Title, added: [EpisodeRef]) async {
        let body: String
        if added.count == 1, let one = added.first {
            body = "\(one.longLabel) is out"
        } else {
            body = "\(added.count) new episodes, up to \(added.last?.longLabel ?? "")"
        }
        #if DEBUG
        lastNotificationForTests = "\(title.name)|\(body)"
        #endif
        session.toasts.show(
            "New on \(title.name): \(body.lowercased())",
            action: Toast.Action(title: "Open") { [weak self] in self?.session.app?.openTitle(title.id) }
        )
        // Test runs share the real app's name with macOS, and its permission with it.
        guard !AppPaths.isScratch else { return }
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        guard granted else { return }
        let content = UNMutableNotificationContent()
        content.title = "New episode of \(title.name)"
        content.body = body
        content.sound = .default
        content.userInfo = ["titleID": title.id, "profile": session.profile.id.uuidString]
        let request = UNNotificationRequest(identifier: "episode-\(title.id)-\(added.last?.shortLabel ?? "")", content: content, trigger: nil)
        try? await center.add(request)
    }
}

/// Opens the series when a new-episode notification is clicked.
final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationRouter()
    weak var app: AppModel?

    func install(app: AppModel) {
        self.app = app
        guard !AppPaths.isScratch else { return }
        UNUserNotificationCenter.current().delegate = self
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let id = (info["titleID"] as? NSNumber)?.int64Value else { return }
        await MainActor.run {
            NSApp.activate()
            app?.openTitle(id)
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
