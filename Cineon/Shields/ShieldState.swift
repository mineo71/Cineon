import Foundation
import Observation

/// One profile's shield preferences and running totals.
@Observable
final class ShieldState {
    @ObservationIgnored private let db: Database
    private(set) var prefsByHost: [String: SitePrefs]
    private(set) var total: ShieldStats
    @ObservationIgnored private var pending = ShieldStats()
    @ObservationIgnored private var flushTask: Task<Void, Never>?

    private static let dayFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    init(db: Database) {
        self.db = db
        prefsByHost = (try? db.sitePrefs()) ?? [:]
        total = (try? db.totalStats()) ?? ShieldStats()
    }

    private func key(_ host: String?) -> String {
        DomainName.registrable(host ?? "")
    }

    func prefs(for host: String?) -> SitePrefs {
        prefsByHost[key(host)] ?? SitePrefs(host: key(host))
    }

    func update(host: String?, _ change: (inout SitePrefs) -> Void) {
        guard host != nil else { return }
        var prefs = prefs(for: host)
        change(&prefs)
        prefsByHost[prefs.host] = prefs
        try? db.saveSitePrefs(prefs)
    }

    func record(_ delta: ShieldStats) {
        total.ads += delta.ads
        total.popups += delta.popups
        total.redirects += delta.redirects
        total.overlays += delta.overlays
        pending.ads += delta.ads
        pending.popups += delta.popups
        pending.redirects += delta.redirects
        pending.overlays += delta.overlays
        guard flushTask == nil else { return }
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            self?.flush()
        }
    }

    func flush() {
        flushTask = nil
        guard pending.total > 0 else { return }
        try? db.addStats(pending, day: Self.dayFormat.string(from: .now))
        pending = ShieldStats()
    }
}
