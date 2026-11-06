import Foundation
import Observation
import Sparkle

/// In-app updates through Sparkle. Releases live on GitHub; the feed is the `appcast.xml`
/// attached to the latest release (see `scripts/release.sh`).
///
/// The updater only runs in a real install. Debug builds and test runs on scratch data
/// leave it off, unless `CINEON_UPDATE_FEED` points them at a test feed.
@Observable
final class Updater {
    static let shared = Updater()

    /// A feed for trying an update locally, instead of the one in Info.plist.
    nonisolated static let testFeed = ProcessInfo.processInfo.environment["CINEON_UPDATE_FEED"]

    private(set) var canCheck = false
    /// What the last check did, for tests: "found 1.0.1", "none", "downloaded", or an error.
    var lastEvent = "-"
    @ObservationIgnored private let controller: SPUStandardUpdaterController
    @ObservationIgnored private let delegate = UpdaterDelegate()
    @ObservationIgnored private var observation: NSKeyValueObservation?

    var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }

    var isRunning: Bool { Self.shouldStart }

    var checksAutomatically: Bool {
        get { access(keyPath: \.checksAutomatically); return controller.updater.automaticallyChecksForUpdates }
        set { withMutation(keyPath: \.checksAutomatically) { controller.updater.automaticallyChecksForUpdates = newValue } }
    }

    var installsAutomatically: Bool {
        get { access(keyPath: \.installsAutomatically); return controller.updater.automaticallyDownloadsUpdates }
        set { withMutation(keyPath: \.installsAutomatically) { controller.updater.automaticallyDownloadsUpdates = newValue } }
    }

    private static var shouldStart: Bool {
        if testFeed != nil { return true }
        #if DEBUG
        return false
        #else
        return !AppPaths.isScratch
        #endif
    }

    private init() {
        controller = SPUStandardUpdaterController(
            startingUpdater: Self.shouldStart, updaterDelegate: delegate, userDriverDelegate: delegate
        )
        canCheck = controller.updater.canCheckForUpdates
        observation = controller.updater.observe(\.canCheckForUpdates, options: [.new]) { [weak self] _, change in
            guard let value = change.newValue else { return }
            Task { @MainActor in self?.canCheck = value }
        }
    }

    /// Checks now and shows the result, including "you're up to date".
    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }

    /// Checks quietly, the way the daily check does. Used by tests.
    func checkInBackground() {
        controller.updater.checkForUpdatesInBackground()
    }
}

private final class UpdaterDelegate: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
    nonisolated private func note(_ event: String) {
        Task { @MainActor in Updater.shared.lastEvent = event }
    }

    nonisolated func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        note("found \(item.displayVersionString)")
    }

    nonisolated func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: any Error) {
        note("none: \((error as NSError).localizedDescription)")
    }

    nonisolated func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        note("alert \(update.displayVersionString) stage \(state.stage.rawValue)")
    }

    nonisolated func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
        note("downloading \(item.displayVersionString)")
    }

    nonisolated func updater(_ updater: SPUUpdater, failedToDownloadUpdate item: SUAppcastItem, error: any Error) {
        note("error: download \((error as NSError).localizedDescription)")
    }

    nonisolated func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
        note("downloaded \(item.displayVersionString)")
    }

    nonisolated func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        note("ready \(item.displayVersionString)")
        return false
    }

    nonisolated func updater(_ updater: SPUUpdater, didAbortWithError error: any Error) {
        note("error: \((error as NSError).localizedDescription)")
    }

    nonisolated func feedURLString(for updater: SPUUpdater) -> String? {
        Updater.testFeed
    }

    /// A test copy installs its update on quit and stays closed: relaunching would drop
    /// `CINEON_DATA_DIR` and open the real library.
    nonisolated func updaterShouldRelaunchApplication(_ updater: SPUUpdater) -> Bool {
        !AppPaths.isScratch
    }
}
