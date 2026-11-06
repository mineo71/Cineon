import SwiftUI

/// Floats over a page that's still there but whose video stopped, or where someone asked.
struct RescuePanel: View {
    let rescue: RescueSession
    let tab: BrowserTab
    @Environment(\.palette) private var palette

    private var headline: String {
        switch rescue.reason {
        case .videoFailed: "The video on \(rescue.host) stopped"
        case .videoStalled: "The video on \(rescue.host) is stuck"
        case .pageMissing: "\(rescue.name) is gone from \(rescue.host)"
        case .pageFailed: "\(rescue.host) didn't load"
        case .manual: "Find \(rescue.name) elsewhere"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(headline)
                .font(Typeface.title(17))
                .foregroundStyle(palette.ink)
                .lineLimit(2)
            RescueSearchBody(rescue: rescue, tab: tab)
        }
        .padding(16)
        .frame(width: 380, alignment: .leading)
        .glassPanel(cornerRadius: 16)
    }
}

/// What's being tried, what turned up, and the choice between them.
struct RescueSearchBody: View {
    let rescue: RescueSession
    let tab: BrowserTab
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var engine: RescueEngine { app.session.rescue }

    private var status: String {
        if let countdown = rescue.countdown, let first = rescue.options.first {
            return "Opening on \(first.siteName) in \(countdown)."
        }
        return switch rescue.stage {
        case .mirrors:
            rescue.mirrorsTotal > 0 ? "Trying \(rescue.mirrorsTotal) other addresses for \(rescue.host)." : "Looking for \(rescue.name)."
        case .searching:
            "Searching your sites for \(rescue.name), \(rescue.sitesDone) of \(rescue.sitesTotal)."
        case .finished:
            if !rescue.options.isEmpty {
                rescue.options.count == 1 ? "Found it on one of your sites." : "Found it on \(rescue.options.count) of your sites."
            } else if rescue.sitesTotal == 0 {
                "You have no other sites to look on."
            } else {
                "\(rescue.name) isn't on your other sites."
            }
        }
    }

    private var carryOn: String {
        if rescue.ref.isEpisode { return "Open" }
        return rescue.resumePoint.map { "Carry on at \(Timecode.string($0))" } ?? "Open"
    }

    private var isWorking: Bool { rescue.stage != .finished }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if isWorking {
                    ProgressView().controlSize(.small)
                }
                Text(status)
                    .font(Typeface.ui(13))
                    .foregroundStyle(palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !rescue.options.isEmpty {
                VStack(spacing: 2) {
                    ForEach(rescue.options.prefix(5)) { option in
                        optionRow(option)
                    }
                }
            }

            if rescue.ref.isEpisode, !rescue.options.isEmpty {
                Text("These open the series' page. Choose \(rescue.ref.longLabel.lowercased()) there\(rescue.resumePoint.map { " and Cineon jumps to \(Timecode.string($0))" } ?? "").")
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                if rescue.stage == .finished, rescue.options.isEmpty {
                    Button("Search the web") {
                        let query = "\(rescue.name) \(rescue.year.map(String.init) ?? "") watch online"
                        if let url = app.settings.searchEngine.url(for: query) {
                            engine.stop(tab: tab)
                            tab.load(url)
                        }
                    }
                    .buttonStyle(SilverButtonStyle())
                }
                if tab.failure != nil {
                    Button("Try again") {
                        engine.stop(tab: tab)
                        tab.reload()
                    }
                    .buttonStyle(OutlineButtonStyle())
                }
                Button(rescue.countdown != nil ? "Stay here" : "Close") {
                    if rescue.countdown != nil {
                        engine.stopCountdown(tab: tab)
                    } else {
                        engine.dismiss(tab: tab)
                    }
                }
                .buttonStyle(OutlineButtonStyle())
            }
        }
        .animation(Motion.quick, value: rescue.options)
    }

    private func optionRow(_ option: RescueSession.Option) -> some View {
        HStack(spacing: 10) {
            SiteIcon(name: option.siteName, url: option.siteIcon, size: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(option.siteName)
                    .font(Typeface.ui(13, .medium))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                Text(option.label)
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink3)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button {
                engine.take(option, tab: tab)
            } label: {
                Text(carryOn)
            }
            .buttonStyle(SilverButtonStyle())
            .help(option.isStrong ? "Looks like the same film" : "Might be the same film. Check once it opens.")
        }
        .padding(.vertical, 5)
    }
}
