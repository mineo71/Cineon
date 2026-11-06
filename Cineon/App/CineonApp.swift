import SwiftUI

@main
struct CineonApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppModel()

    var body: some Scene {
        Window("Cineon", id: "main") {
            RootView()
                .environment(app)
                .onAppear { delegate.app = app }
                .onOpenURL { DeepLink.handle($0, app: app) }
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1360, height: 860)
        .commands { AppCommands(app: app) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var app: AppModel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        _ = Updater.shared
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        app?.prepareToQuit()
    }
}

struct AppCommands: Commands {
    let app: AppModel

    private var tab: BrowserTab? { app.route == .web ? app.browser.selected : nil }

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            CheckForUpdatesButton()
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { app.go(.settings) }.keyboardShortcut(",")
        }
        CommandGroup(replacing: .newItem) {
            Button("New Tab") { app.openCommandBar() }.keyboardShortcut("t")
            Button("Open Location…") { app.openCommandBar(seed: tab?.url?.absoluteString ?? "") }.keyboardShortcut("l")
            Button("Reopen Closed Tab") { app.browser.reopenClosed() }.keyboardShortcut("t", modifiers: [.command, .shift])
            Divider()
            Button("Import from Another Browser…") { app.sheet = .importBrowser }
        }
        CommandGroup(replacing: .saveItem) {
            Button("Close Tab") { if let tab { app.browser.close(tab) } }.keyboardShortcut("w")
        }
        CommandGroup(after: .textEditing) {
            Button("Find in Page") { app.isFindVisible = true }.keyboardShortcut("f")
        }
        CommandGroup(replacing: .toolbar) {
            Button("Hide Toolbars on Sites") { app.toggleSidebar() }.keyboardShortcut("s")
            Button("Cinema Mode") { app.toggleCinema() }.keyboardShortcut("c", modifiers: [.command, .shift])
            Divider()
            Button("Reload Page") { tab?.reload() }.keyboardShortcut("r")
            Button("Actual Size") { tab?.resetZoom() }.keyboardShortcut("0")
            Button("Zoom In") { tab?.zoom(by: 0.1) }.keyboardShortcut("=")
            Button("Zoom Out") { tab?.zoom(by: -0.1) }.keyboardShortcut("-")
            Divider()
            Button("Switch Theme") { app.toggleTheme() }.keyboardShortcut("d", modifiers: [.command, .shift])
        }
        CommandMenu("Watch") {
            Button("Home") { app.go(.home) }.keyboardShortcut("h", modifiers: [.command, .shift])
            Button("Library") { app.go(.library) }.keyboardShortcut("l", modifiers: [.command, .shift])
            Button("Timeline") { app.go(.timeline) }.keyboardShortcut("y")
            Button("Together") { app.go(.together) }
            Button("My Profile") { app.go(.profile) }
            Button("Rate My Films") { app.go(.rate) }.keyboardShortcut("r", modifiers: [.command, .shift])
            Divider()
            Button("Add to Backlog") { app.addCurrentPageToBacklog() }.keyboardShortcut("d")
            Button("Search All Sites") { app.openCommandBar() }.keyboardShortcut("f", modifiers: [.command, .shift])
            Divider()
            Button("Play or Pause") { app.togglePlayback() }.keyboardShortcut("p", modifiers: [.command, .shift])
            Button("Back 10 Seconds") { app.activePlayer?.skip(by: -10) }.keyboardShortcut(.leftArrow, modifiers: [.command, .shift])
            Button("Forward 10 Seconds") { app.activePlayer?.skip(by: 10) }.keyboardShortcut(.rightArrow, modifiers: [.command, .shift])
            Button("Next Episode") { app.playNextEpisode() }.keyboardShortcut("n", modifiers: [.command, .shift])
            Button("Picture in Picture") { app.browser.playingTab?.togglePictureInPicture() }.keyboardShortcut("i", modifiers: [.command, .shift])
            Menu("Sleep Timer") {
                ForEach(SleepTimerMode.choices, id: \.self) { mode in
                    Button(mode == .endOfItem ? "At the End of This" : mode.label) { app.startSleepTimer(mode) }
                }
                Divider()
                Button("Turn Off") { app.cancelSleepTimer() }.disabled(app.sleepTimer == nil)
            }
            Toggle("Voice Boost", isOn: Binding(get: { app.settings.voiceBoost }, set: { app.settings.voiceBoost = $0 }))
                .keyboardShortcut("b", modifiers: [.command, .shift])
            Divider()
            Button("Save This Moment") { app.saveMoment() }.keyboardShortcut("m", modifiers: [.command, .shift])
            Button("Download This Video") { app.downloadCurrentVideo() }.keyboardShortcut("s", modifiers: [.command, .shift])
            Button("Download the Rest of This Season") {
                if let tab = app.browser.selected { app.session.seasons.start(from: tab, fromCurrent: true) }
            }
            Button("Download the Whole Series…") {
                if let tab = app.browser.selected { app.session.seasons.startSeries(from: tab) }
            }
            Button("Downloads") { app.go(.downloads) }.keyboardShortcut("j", modifiers: [.command, .shift])
            Button("Find This on Another Site") { app.findElsewhere() }.keyboardShortcut("e", modifiers: [.command, .shift])
            Divider()
            Button("Who's Watching…") { app.isProfilePickerVisible = true }.keyboardShortcut("u", modifiers: [.command, .shift])
        }
        CommandMenu("Tabs") {
            Button("Back") { tab?.goBack() }.keyboardShortcut("[")
            Button("Forward") { tab?.goForward() }.keyboardShortcut("]")
            Divider()
            Button("Next Tab") { app.browser.selectAdjacent(1) }.keyboardShortcut(.tab, modifiers: .control)
            Button("Previous Tab") { app.browser.selectAdjacent(-1) }.keyboardShortcut(.tab, modifiers: [.control, .shift])
            Divider()
            ForEach(1...9, id: \.self) { number in
                Button("Tab \(number)") { app.browser.selectTab(atIndex: number - 1) }
                    .keyboardShortcut(KeyEquivalent(Character("\(number)")))
            }
        }
    }
}

private struct CheckForUpdatesButton: View {
    private let updater = Updater.shared

    var body: some View {
        Button("Check for Updates…") { updater.checkForUpdates() }
            .disabled(!updater.canCheck)
    }
}

enum DeepLink {
    static func handle(_ url: URL, app: AppModel) {
        guard url.scheme == "cineon" else { return }
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = Dictionary(
            (parts?.queryItems ?? []).map { ($0.name, $0.value ?? "") },
            uniquingKeysWith: { _, last in last }
        )
        switch url.host {
        case "open":
            if let target = query["url"].flatMap(URL.init(string:)) { app.browser.open(url: target) }
        case "search":
            if let q = query["q"] { app.browser.searchEverywhere(q) }
        #if DEBUG
        case "debug":
            // Test commands change and remove things. Only ever on throwaway test data.
            guard AppPaths.isScratch else { return }
            DebugCommands.run(path: url.path, query: query, app: app)
        #endif
        default:
            break
        }
    }
}
