import AppKit
import SwiftUI
import WebKit

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 38) {
                Text("Settings")
                    .font(Typeface.title(30))
                    .foregroundStyle(palette.ink)
                AppearanceSection()
                CloudSection()
                ShieldsSection()
                PlaybackSection()
                DownloadsSection()
                SitesSection()
                ProfilesSection()
                PrivacySection()
                UpdatesSection()
                ShortcutsSection()
            }
            .frame(maxWidth: 660, alignment: .leading)
            .padding(.horizontal, 32)
            .padding(.top, 34)
            .padding(.bottom, 60)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.never)
        .background(palette.cardFill)
    }
}

private struct Section<Content: View>: View {
    let name: String
    @ViewBuilder let content: () -> Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(name)
                .font(Typeface.title(20))
                .foregroundStyle(palette.ink)
            VStack(alignment: .leading, spacing: 12) {
                content()
            }
        }
    }
}

private struct SettingToggle: View {
    let label: String
    var detail: String?
    @Binding var isOn: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(Typeface.ui(13))
                    .foregroundStyle(palette.ink)
                if let detail {
                    Text(detail)
                        .font(Typeface.ui(12))
                        .foregroundStyle(palette.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
        .tint(palette.isDark ? Color(white: 0.78) : .black)
    }
}

private struct SettingSlider: View {
    let label: String
    let valueText: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    var step: Double?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            Text(label)
                .font(Typeface.ui(13))
                .foregroundStyle(palette.ink)
            Spacer()
            Group {
                if let step {
                    Slider(value: $value, in: range, step: step)
                } else {
                    Slider(value: $value, in: range)
                }
            }
            .controlSize(.small)
            .tint(palette.isDark ? Color(white: 0.78) : .black)
            .frame(width: 180)
            Text(valueText)
                .font(Typeface.time(12))
                .foregroundStyle(palette.ink2)
                .frame(width: 58, alignment: .trailing)
        }
    }
}

// MARK: Appearance

private struct AppearanceSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var session = app.session
        Section(name: "Appearance") {
            HStack(spacing: 14) {
                ThemeCard(theme: .dark)
                ThemeCard(theme: .white)
            }
            SettingToggle(
                label: "Ambient light",
                detail: "The film's colours spill onto the window around it while it plays.",
                isOn: $session.settings.ambientLight
            )
            if session.settings.ambientLight {
                SettingSlider(
                    label: "Strength",
                    valueText: "\(Int(session.settings.ambientStrength * 100))%",
                    value: $session.settings.ambientStrength,
                    range: 0.15...1
                )
            }
            SettingToggle(label: "Logo animation on launch", isOn: $session.settings.launchAnimation)
        }
    }
}

private struct ThemeCard: View {
    let theme: AppTheme
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var isSelected: Bool { app.settings.theme == theme }
    private var sample: Palette { theme == .dark ? .dark : .white }

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.35)) { app.settings.theme = theme }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                ZStack {
                    sample.canvas
                    LogoMark(size: 52, color: sample.ink)
                }
                .frame(width: 180, height: 104)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(isSelected ? palette.ink : palette.line, lineWidth: isSelected ? 2 : 1)
                )
                Text(theme.label)
                    .font(Typeface.ui(13, isSelected ? .medium : .regular))
                    .foregroundStyle(isSelected ? palette.ink : palette.ink2)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: Shields

private struct ShieldsSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isUpdating = false

    private func listBinding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { app.settings.enabledLists.contains(id) },
            set: { on in
                if on { app.settings.enabledLists.insert(id) } else { app.settings.enabledLists.remove(id) }
            }
        )
    }

    private var updatedText: String {
        guard let date = app.filters.lastUpdated else { return "Using the lists built into the app" }
        return "Updated \(DateText.relative(date))"
    }

    private var statusText: String? {
        if case .preparing(let text) = app.filters.status { return text }
        if case .failed(let text) = app.filters.status { return "Couldn't compile \(text)" }
        return nil
    }

    var body: some View {
        @Bindable var session = app.session
        let total = session.shields.total
        Section(name: "Shields") {
            Text("Blocked so far: \(total.ads) ads and trackers, \(total.popups) pop-ups, \(total.redirects) redirects, \(total.overlays) click traps.")
                .font(Typeface.ui(13))
                .foregroundStyle(palette.ink2)

            SettingToggle(label: "Block ads and trackers", detail: "Compiled into the page engine, so it adds almost nothing to load time.", isOn: $session.settings.networkBlocking)
            SettingToggle(label: "Block pop-ups", detail: "Stops windows that open to other sites when you click.", isOn: $session.settings.popupShield)
            SettingToggle(label: "Block redirects", detail: "Stops scripts sending the whole page to another site.", isOn: $session.settings.redirectShield)
            SettingToggle(label: "Remove click traps", detail: "Clears invisible layers placed over the player to steal your first click.", isOn: $session.settings.overlaySweeper)
            SettingToggle(label: "Block downloads", detail: "Stops the fake player and codec downloads streaming sites push.", isOn: $session.settings.downloadShield)

            if session.settings.networkBlocking {
                Rectangle().fill(palette.line).frame(height: 0.5)
                ForEach(FilterEngine.catalog) { info in
                    SettingToggle(
                        label: info.name,
                        detail: detail(for: info),
                        isOn: listBinding(info.id)
                    )
                }
                HStack(spacing: 12) {
                    Button(isUpdating ? "Updating…" : "Update lists now") { update() }
                        .buttonStyle(OutlineButtonStyle())
                        .disabled(isUpdating)
                    Text(statusText ?? updatedText)
                        .font(Typeface.ui(12))
                        .foregroundStyle(palette.ink3)
                }
            }
        }
    }

    private func detail(for info: FilterListInfo) -> String {
        guard let count = app.filters.ruleCounts[info.id] else { return info.summary }
        return "\(info.summary). \(count.formatted()) rules."
    }

    private func update() {
        isUpdating = true
        Task {
            let changed = await app.filters.update()
            isUpdating = false
            if changed {
                app.toasts.show("Filter lists updated")
            } else {
                app.toasts.show("Couldn't update the lists. Check your connection.")
            }
        }
    }
}

// MARK: Playback

private struct PlaybackSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var session = app.session
        Section(name: "Watching") {
            SettingToggle(label: "Resume where I stopped", detail: "Jumps to your place as soon as the video loads, with a way to start over.", isOn: $session.settings.autoResume)
            SettingToggle(label: "Only one film at a time", detail: "Starting a video pauses any other tab that's playing.", isOn: $session.settings.pauseOtherTabs)
            SettingToggle(label: "Rescue films from dead sites", detail: "When a site or video stops working, looks at the site's other addresses and then your other sites, and carries on from the same second.", isOn: $session.settings.autoRescue)
            SettingToggle(label: "Learn what I skip", detail: "Skip an intro once, and Cineon offers to skip it in every episode of that series. Each skip can be undone.", isOn: $session.settings.learnSkips)
            SettingToggle(label: "Play the next episode", detail: "Offers it when the credits start, and plays it when the episode ends.", isOn: $session.settings.autoNextEpisode)
            SettingToggle(label: "Keep frames from what I watch", detail: "Saves a few small images from each session for your timeline. They stay on this Mac.", isOn: $session.settings.keepFrames)
            SettingToggle(label: "Voice boost", detail: "Dialogue louder, rumble and explosions softer. Works in players that let Cineon change their sound; others are left as they are.", isOn: $session.settings.voiceBoost)
            SettingToggle(label: "Tell me about new episodes", detail: "Checks the series you're watching every few hours and sends a notification when a new episode is out.", isOn: $session.settings.newEpisodeAlerts)
            SettingSlider(
                label: "Count as finished at",
                valueText: "\(Int(session.settings.finishThreshold * 100))%",
                value: $session.settings.finishThreshold,
                range: 0.7...1,
                step: 0.01
            )
            SettingSlider(
                label: "Start tracking after",
                valueText: "\(Int(session.settings.minimumSecondsToTrack)) s",
                value: $session.settings.minimumSecondsToTrack,
                range: 5...120,
                step: 5
            )
            SettingSlider(
                label: "Free memory of idle tabs after",
                valueText: session.settings.hibernateMinutes == 0 ? "Never" : "\(Int(session.settings.hibernateMinutes)) min",
                value: $session.settings.hibernateMinutes,
                range: 0...120,
                step: 5
            )
        }
    }
}

// MARK: Downloads and captions

private struct DownloadsSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        @Bindable var session = app.session
        let folder = session.downloads.folder
        Section(name: "Downloads and captions") {
            SettingToggle(
                label: "Show a download button on players",
                detail: "Appears in the player's corner when you move the mouse. ⇧⌘S works either way.",
                isOn: $session.settings.showDownloadButton
            )
            SettingToggle(
                label: "Play the next downloaded episode",
                detail: "When an episode ends in the player on this Mac, the next one on this Mac starts after a short countdown.",
                isOn: $session.settings.playNextDownload
            )
            SettingToggle(
                label: "Bin episodes once watched",
                detail: "A downloaded episode you watched to the end goes to the Bin when you move on, to save space. You can put it back from there.",
                isOn: $session.settings.binWatchedDownloads
            )
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Save downloads to")
                        .font(Typeface.ui(13))
                        .foregroundStyle(palette.ink)
                    Text(folder.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(Typeface.ui(11.5))
                        .foregroundStyle(palette.ink3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                Button("Change…", action: chooseFolder)
                    .buttonStyle(OutlineButtonStyle())
                if !session.settings.downloadsFolder.isEmpty {
                    Button("Use Movies") { session.settings.downloadsFolder = "" }
                        .buttonStyle(OutlineButtonStyle())
                }
            }
            Picker("Captions", selection: $session.settings.captionStyle) {
                ForEach(CaptionStyle.allCases, id: \.self) { style in
                    Text(style.label).tag(style)
                }
            }
            .font(Typeface.ui(13))
            .foregroundStyle(palette.ink)
            .frame(maxWidth: 360)
            Text("Larger captions apply to players that use the browser's own subtitles, and to downloads.")
                .font(Typeface.ui(11.5))
                .foregroundStyle(palette.ink3)
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Use This Folder"
        panel.directoryURL = app.session.downloads.folder
        guard panel.runModal() == .OK, let url = panel.url else { return }
        app.settings.downloadsFolder = url.path
    }
}

// MARK: Sites

private struct SitesSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        Section(name: "Sites") {
            ForEach(app.library.sites) { site in
                HStack(spacing: 10) {
                    SiteIcon(name: site.name, url: site.iconURL, size: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(site.name)
                            .font(Typeface.ui(13))
                            .foregroundStyle(palette.ink)
                        Text(site.searchTemplate == nil ? "\(site.host). Search not learned yet." : site.host)
                            .font(Typeface.ui(12))
                            .foregroundStyle(palette.ink3)
                    }
                    Spacer()
                    Button("Edit") { app.sheet = .editSite(site.id) }
                        .buttonStyle(OutlineButtonStyle())
                }
            }
            HStack(spacing: 10) {
                Button("Add a site") { app.sheet = .addSite(prefill: nil) }
                    .buttonStyle(OutlineButtonStyle())
                Button("Import from another browser") { app.sheet = .importBrowser }
                    .buttonStyle(OutlineButtonStyle())
            }
        }
    }
}

// MARK: Profiles

private struct ProfilesSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var name = ""

    var body: some View {
        @Bindable var profiles = app.profiles
        Section(name: "Profiles") {
            Text("Each profile has its own library, timeline, settings and site logins.")
                .font(Typeface.ui(12.5))
                .foregroundStyle(palette.ink2)
            HStack(spacing: 10) {
                TextField("Name", text: $name)
                    .textFieldStyle(.plain)
                    .font(Typeface.ui(13))
                    .foregroundStyle(palette.ink)
                    .padding(.horizontal, 10)
                    .frame(width: 180, height: 30)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .onSubmit(rename)
                    .onAppear { name = app.session.profile.name }
                Button("Rename", action: rename)
                    .buttonStyle(OutlineButtonStyle())
                Button("Who's watching…") { app.isProfilePickerVisible = true }
                    .buttonStyle(OutlineButtonStyle())
            }
            SettingToggle(label: "Ask who's watching on launch", isOn: $profiles.askOnLaunch)
        }
    }

    private func rename() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        app.profiles.rename(app.session.profile.id, to: trimmed)
        app.toasts.show("Renamed to \(trimmed). The sidebar updates next launch.")
    }
}

// MARK: Privacy

private struct PrivacySection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var confirmingCookies = false
    @State private var confirmingHistory = false
    @State private var confirmingFrames = false
    @State private var framesSize: Int64 = 0

    var body: some View {
        @Bindable var session = app.session
        Section(name: "Privacy and data") {
            SettingToggle(
                label: "Fetch posters and details",
                detail: "Sends film names to IMDb and Cinemeta. Without it, Cineon uses each page's own image and title.",
                isOn: $session.settings.fetchMetadata
            )
            SettingToggle(label: "Save browsing history", detail: "Pages for the command bar. Your film timeline is saved either way.", isOn: $session.settings.saveBrowsingHistory)
            Picker("Web search", selection: $session.settings.searchEngine) {
                ForEach(SearchEngine.allCases, id: \.self) { engine in
                    Text(engine.label).tag(engine)
                }
            }
            .font(Typeface.ui(13))
            .foregroundStyle(palette.ink)
            .frame(maxWidth: 300)

            HStack(spacing: 10) {
                Button("Export library") { export() }
                    .buttonStyle(OutlineButtonStyle())
                Button(framesSize > 0 ? "Delete frames (\(ByteCountFormatter.string(fromByteCount: framesSize, countStyle: .file)))" : "Delete frames") {
                    confirmingFrames = true
                }
                .buttonStyle(OutlineButtonStyle())
                .task { framesSize = await app.library.framesSize() }
                .confirmationDialog("Delete all saved frames?", isPresented: $confirmingFrames) {
                    Button("Delete frames and moments", role: .destructive) {
                        app.library.deleteAllFrames()
                        framesSize = 0
                        app.toasts.show("Frames deleted")
                    }
                } message: {
                    Text("This includes moments you saved. Your library and timeline stay.")
                }
                Button("Clear browsing history") { confirmingHistory = true }
                    .buttonStyle(OutlineButtonStyle())
                    .confirmationDialog("Clear browsing history?", isPresented: $confirmingHistory) {
                        Button("Clear history", role: .destructive) {
                            try? app.session.db.clearHistory()
                            app.toasts.show("Browsing history cleared")
                        }
                    } message: {
                        Text("Your library and film timeline stay.")
                    }
                Button("Clear cookies and logins") { confirmingCookies = true }
                    .buttonStyle(OutlineButtonStyle())
                    .confirmationDialog("Clear cookies and logins?", isPresented: $confirmingCookies) {
                        Button("Clear cookies and logins", role: .destructive) { clearCookies() }
                    } message: {
                        Text("You'll be signed out of every site in this profile.")
                    }
            }
        }
    }

    private func clearCookies() {
        let store = app.session.webKit.dataStore
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
            app.toasts.show("Cookies and logins cleared")
        }
    }

    private func export() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Cineon library.json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try LibraryExport.make(from: app.library)
            try data.write(to: url, options: .atomic)
            app.toasts.show("Library exported")
        } catch {
            app.toasts.show("Couldn't export: \(error.localizedDescription)")
        }
    }
}

enum LibraryExport {
    struct Payload: Codable {
        struct Item: Codable {
            var name: String
            var year: Int?
            var kind: String
            var status: String
            var imdbID: String?
            var rating: Double?
            var finishedAt: Date?
        }

        struct Session: Codable {
            var title: String
            var season: Int
            var episode: Int
            var site: String
            var url: String?
            var startedAt: Date
            var endedAt: Date
            var watchedSeconds: Double
            var stoppedAt: Double
            var duration: Double
            var finished: Bool
        }

        var exportedAt: Date
        var titles: [Item]
        var timeline: [Session]
    }

    static func make(from library: LibraryStore) throws -> Data {
        let payload = Payload(
            exportedAt: .now,
            titles: library.titles.values.sorted { $0.name < $1.name }.map {
                Payload.Item(
                    name: $0.name, year: $0.year, kind: $0.kind.rawValue, status: $0.status.rawValue,
                    imdbID: $0.imdbID, rating: $0.rating, finishedAt: $0.finishedAt
                )
            },
            timeline: library.sessions.map {
                Payload.Session(
                    title: library.titles[$0.titleID]?.name ?? "", season: $0.ref.season, episode: $0.ref.episode,
                    site: $0.host, url: $0.url?.absoluteString, startedAt: $0.startedAt, endedAt: $0.endedAt,
                    watchedSeconds: $0.watchedSeconds, stoppedAt: $0.endPosition, duration: $0.duration, finished: $0.finished
                )
            }
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(payload)
    }
}

// MARK: Updates

private struct UpdatesSection: View {
    @Environment(\.palette) private var palette
    @Bindable private var updater = Updater.shared

    var body: some View {
        Section(name: "Updates") {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Cineon \(updater.version)")
                        .font(Typeface.ui(13))
                        .foregroundStyle(palette.ink)
                    Text(updater.isRunning ? "New versions come from Cineon's page on GitHub." : "This build doesn't update itself.")
                        .font(Typeface.ui(12))
                        .foregroundStyle(palette.ink3)
                }
                Spacer()
                Button("Check Now") { updater.checkForUpdates() }
                    .buttonStyle(OutlineButtonStyle())
                    .disabled(!updater.canCheck)
            }
            if updater.isRunning {
                SettingToggle(label: "Check for updates every day", isOn: $updater.checksAutomatically)
                SettingToggle(
                    label: "Install updates automatically",
                    detail: "Downloads new versions quietly and puts them in place the next time you quit Cineon.",
                    isOn: $updater.installsAutomatically
                )
            }
        }
    }
}

// MARK: Shortcuts

private struct ShortcutsSection: View {
    @Environment(\.palette) private var palette

    private let shortcuts: [(String, String)] = [
        ("New tab or search", "⌘T"),
        ("Edit the address", "⌘L"),
        ("Close tab", "⌘W"),
        ("Reopen closed tab", "⇧⌘T"),
        ("Jump to tab 1 to 9", "⌘1 to ⌘9"),
        ("Hide or show sidebar", "⌘S"),
        ("Add to backlog", "⌘D"),
        ("Cinema mode", "⇧⌘C"),
        ("Play or pause", "⇧⌘P"),
        ("Back or forward 10 seconds", "⇧⌘← ⇧⌘→"),
        ("Picture in picture", "⇧⌘I"),
        ("Save this moment", "⇧⌘M"),
        ("Find this on another site", "⇧⌘E"),
        ("Home", "⇧⌘H"),
        ("Library", "⇧⌘L"),
        ("Timeline", "⌘Y"),
        ("Who's watching", "⇧⌘U"),
        ("Switch theme", "⇧⌘D"),
    ]

    var body: some View {
        Section(name: "Keyboard shortcuts") {
            Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 6) {
                ForEach(shortcuts, id: \.0) { shortcut in
                    GridRow {
                        Text(shortcut.0)
                            .font(Typeface.ui(13))
                            .foregroundStyle(palette.ink2)
                        Text(shortcut.1)
                            .font(Typeface.ui(13))
                            .foregroundStyle(palette.ink)
                    }
                }
            }
        }
    }
}

// MARK: Cloud

private struct CloudSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var showsCode = false
    @State private var entered = ""
    @State private var isRestoring = false

    var body: some View {
        @Bindable var session = app.session
        Section(name: "Ratings in the cloud") {
            SettingToggle(
                label: "Back up ratings and lists",
                detail: "Your stars and which list each film is in are kept on Cineon's server, so they come back after you clear the library, import again or use another Mac. Watch history stays here.",
                isOn: $session.settings.cloudBackup
            )
            SettingToggle(label: "Show my pet to friends", detail: "Your pixel pet is your picture in parties and challenges.", isOn: $session.settings.sharePet)
            CloudStatus()
            VStack(alignment: .leading, spacing: 8) {
                Text("Recovery code")
                    .font(Typeface.ui(13))
                    .foregroundStyle(palette.ink)
                Text("Enter it on another Mac or a new profile to bring back your ratings, lists and challenges. Keep it to yourself: anyone with it can change them.")
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Text(showsCode ? app.session.together.recoveryCode : String(repeating: "•", count: 24))
                        .font(Typeface.time(12))
                        .foregroundStyle(palette.ink2)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                    Spacer()
                    Button(showsCode ? "Hide" : "Show") { showsCode.toggle() }
                        .buttonStyle(OutlineButtonStyle())
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(app.session.together.recoveryCode, forType: .string)
                        app.toasts.show("Recovery code copied")
                    }
                    .buttonStyle(OutlineButtonStyle())
                }
                HStack(spacing: 8) {
                    TextField("Paste a recovery code", text: $entered)
                        .textFieldStyle(.plain)
                        .font(Typeface.time(12))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(palette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    Button(isRestoring ? "Restoring…" : "Restore") {
                        isRestoring = true
                        Task {
                            let ok = await app.session.together.adopt(recoveryCode: entered)
                            if ok { await app.session.cloud.sync() }
                            isRestoring = false
                            entered = ""
                            app.toasts.show(ok ? "Restored. Ratings and lists from that code are back" : "That code didn't work")
                        }
                    }
                    .buttonStyle(SilverButtonStyle())
                    .disabled(entered.count < 32 || isRestoring)
                }
            }
        }
    }
}
