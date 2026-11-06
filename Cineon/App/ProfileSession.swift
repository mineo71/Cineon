import Foundation
import Observation
import WebKit

/// Everything that belongs to the person currently watching.
@Observable
final class ProfileSession {
    let profile: Profile
    @ObservationIgnored let db: Database
    @ObservationIgnored let toasts: ToastCenter
    @ObservationIgnored weak var app: AppModel?
    @ObservationIgnored private let filters: FilterEngine

    let library: LibraryStore
    let shields: ShieldState

    var settings: AppSettings {
        didSet {
            guard settings != oldValue else { return }
            db.saveSettings(settings)
            if settings.overlaySweeper != oldValue.overlaySweeper {
                webKit.installScripts(overlaySweeper: settings.overlaySweeper)
            }
            if settings.networkBlocking != oldValue.networkBlocking || settings.enabledLists != oldValue.enabledLists {
                applyRules()
            }
            if settings.showDownloadButton != oldValue.showDownloadButton {
                downloads.refreshPills(force: true)
            }
            if settings.voiceBoost != oldValue.voiceBoost {
                for tab in browser.tabs { tab.applyVoiceBoost() }
            }
            if settings.sharePet != oldValue.sharePet { together.refreshIdentity() }
            if settings.cloudBackup != oldValue.cloudBackup, settings.cloudBackup { cloud.start() }
            if settings.captionStyle != oldValue.captionStyle {
                for tab in browser.tabs { tab.applyCaptions(force: true) }
                app?.localPlayback?.applyCaptionStyle(settings.captionStyle)
            }
        }
    }

    // Set right after init, because they hold a reference back to this object.
    @ObservationIgnored private(set) var webKit: WebKitEnvironment!
    @ObservationIgnored private(set) var router: ScriptRouter!
    @ObservationIgnored private(set) var tracker: WatchTracker!
    @ObservationIgnored private(set) var metadata: MetadataService!
    @ObservationIgnored private(set) var autopilot: EpisodeAutopilot!
    @ObservationIgnored private(set) var rescue: RescueEngine!
    @ObservationIgnored private(set) var frames: FrameCollector!
    private(set) var browser: BrowserModel!
    private(set) var downloads: DownloadCenter!
    private(set) var together: TogetherModel!
    private(set) var seasons: SeasonGrabber!
    private(set) var alerts: EpisodeAlerts!
    private(set) var cloud: CloudLibrary!

    init(profile: Profile, filters: FilterEngine, toasts: ToastCenter) throws {
        self.profile = profile
        self.filters = filters
        self.toasts = toasts
        let path = AppPaths.profile(profile.id).appendingPathComponent("cineon.sqlite").path
        let database = try Database(path: path)
        db = database
        settings = database.loadSettings()
        library = LibraryStore(db: database)
        shields = ShieldState(db: database)

        let router = ScriptRouter()
        self.router = router
        webKit = WebKitEnvironment(profileID: profile.id, router: router)
        webKit.installScripts(overlaySweeper: settings.overlaySweeper)
        tracker = WatchTracker(session: self)
        autopilot = EpisodeAutopilot(session: self)
        rescue = RescueEngine(session: self)
        frames = FrameCollector(session: self)
        metadata = MetadataService(library: library) { [weak self] in self?.settings.fetchMetadata ?? false }
        let browser = BrowserModel(session: self)
        self.browser = browser
        router.browser = browser
        downloads = DownloadCenter(session: self)
        together = TogetherModel(session: self)
        seasons = SeasonGrabber(session: self)
        alerts = EpisodeAlerts(session: self)
        cloud = CloudLibrary(session: self)

        library.seedDefaultSitesIfNeeded()
    }

    func start() {
        applyRules()
        browser.start()
        retryMissingMetadata()
        library.pruneFrames()
        together.start()
        alerts.start()
        cloud.start()
    }

    /// Applies the rule lists this person has switched on.
    func applyRules() {
        let lists = settings.networkBlocking
            ? FilterEngine.catalog.compactMap { settings.enabledLists.contains($0.id) ? filters.compiled[$0.id] : nil }
            : []
        webKit.applyRules(lists)
    }

    /// Titles added while offline get their posters on the next launch.
    private func retryMissingMetadata() {
        guard settings.fetchMetadata else { return }
        for title in library.titles.values where !title.metadataChecked && title.imdbID == nil {
            metadata.enrich(titleID: title.id, inBackground: true)
        }
    }

    func close() {
        // Kept, to carry on with next time.
        seasons.suspend()
        alerts.stop()
        cloud.stop()
        together.stop()
        downloads.suspendAll()
        shields.flush()
        browser.shutdown()
        webKit.teardown()
        db.sql.close()
    }

    // MARK: Profile

    @ObservationIgnored private var statsCache: (key: String, stats: ProfileStats)?

    /// The numbers on the profile page, worked out again when the library changes.
    var stats: ProfileStats {
        let ratingSum = library.titles.values.reduce(0) { $0 + ($1.ratingHalves ?? 0) + ($1.status == .watched ? 1000 : 0) }
        let key = "\(library.revision)|\(library.titles.count)|\(ratingSum)|\(downloads.items.count)"
        if let statsCache, statsCache.key == key { return statsCache.stats }
        let computed = ProfileStats.compute(
            titles: Array(library.titles.values),
            sessions: (try? db.sessions(limit: 100_000)) ?? library.sessions,
            progress: library.progress,
            moments: library.momentsByTitle.values.reduce(0) { $0 + $1.count },
            adsBlocked: (try? db.totalStats().ads) ?? 0,
            downloads: downloads.items.filter { $0.status == .done }.count
        )
        statsCache = (key, computed)
        return computed
    }

    /// This person's pixel pet, grown from what they watch.
    var pet: PixelPet { PixelPet.make(from: stats.petTraits(seed: profile.id.uuidString)) }

    // MARK: Actions

    /// The poster to show on this person's avatar.
    var latestPosterURL: URL? {
        library.continueWatching.first?.title.posterURL
            ?? library.watched.first?.posterURL
            ?? library.backlog.first?.posterURL
    }
}
