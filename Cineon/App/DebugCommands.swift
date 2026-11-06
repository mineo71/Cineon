#if DEBUG
import AppKit
import WebKit

/// Lets end-to-end tests drive a Debug build from the shell, through `cineon://debug/...` links.
/// Compiled out of Release builds entirely.
enum DebugCommands {
    private static var outputURL: URL {
        AppPaths.root.appendingPathComponent("debug-output.txt")
    }

    private static func write(_ text: String) {
        try? text.write(to: outputURL, atomically: true, encoding: .utf8)
    }

    static func run(path: String, query: [String: String], app: AppModel) {
        switch path {
        case "/updatecheck":
            Updater.shared.checkInBackground()
            write("ok")
        case "/route":
            switch query["to"] {
            case "home": app.go(.home)
            case "library": app.go(.library)
            case "timeline": app.go(.timeline)
            case "settings": app.go(.settings)
            case "web": app.go(.web)
            case "downloads": app.go(.downloads)
            case "together": app.go(.together)
            case "profile": app.go(.profile)
            case "rate": app.go(.rate)
            default: break
            }
        case "/theme":
            app.settings.theme = query["to"] == "white" ? .white : .dark
        case "/open":
            if let target = query["url"].flatMap(URL.init(string:)) {
                app.browser.openTab(url: target)
            }
        case "/addsite":
            if let target = query["url"].flatMap(URL.init(string:)), var site = app.library.addSite(url: target, name: query["name"]) {
                site.searchTemplate = query["search"]
                app.library.updateSite(site)
            }
        case "/eval":
            evaluate(query["js"] ?? "", world: query["world"] == "cineon" ? WebKitEnvironment.world : .page, app: app)
        case "/mediaeval":
            guard let tab = app.browser.selected, let webView = tab.webView else {
                write("no web view")
                return
            }
            webView.evaluateJavaScript(query["js"] ?? "", in: tab.mediaFrame, in: WebKitEnvironment.world) { result in
                switch result {
                case .success(let value): write("\(value)")
                case .failure(let error): write("error: \(error)")
                }
            }
        case "/searchselect":
            if let search = app.browser.search,
               let result = search.results.first(where: { $0.site.host == query["host"] }) {
                search.select(result.id)
            }
        case "/importreport":
            // Counts only, so a test never prints anyone's browsing.
            Task {
                let started = Date.now
                let sources = await Task.detached { BrowserImporter.discover(root: DebugImportRoot.url ?? BrowserImporter.applicationSupport) }.value
                var lines = ["discoverSeconds=\(Date.now.timeIntervalSince(started))", "sources=\(sources.count)"]
                for source in sources {
                    let scanStart = Date.now
                    let scan = await Task.detached { BrowserImporter.scan(source) }.value
                    let scanSeconds = Date.now.timeIntervalSince(scanStart)
                    lines.append("source browser=\(source.browser) history=\(source.historyCount) saved=\(source.bookmarkCount + source.pinnedCount) scanSeconds=\(scanSeconds) sites=\(scan.sites.count) titles=\(scan.titles.count) pages=\(scan.pages.count)")
                    if query["apply"] == source.browser {
                        let applyStart = Date.now
                        let result = app.library.applyImport(ImportSelection(
                            sites: scan.sites, titles: scan.titles.map { ($0, $0.suggestedStatus) }, pages: scan.pages
                        ))
                        lines.append("applied seconds=\(Date.now.timeIntervalSince(applyStart)) sites=\(result.sites) titles=\(result.titles) pages=\(result.pages)")
                        for title in result.newTitleIDs {
                            app.session.metadata.enrich(titleID: title.id, altName: title.altName, inBackground: true)
                        }
                    }
                }
                write(lines.joined(separator: "\n"))
            }
        case "/windowclick":
            // Window coordinates from the top left, for driving native screens.
            guard let window = app.window else { return }
            if window.isMiniaturized { window.deminiaturize(nil) }
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            let point = NSPoint(x: Double(query["x"] ?? "") ?? 0, y: window.frame.height - (Double(query["y"] ?? "") ?? 0))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                    guard let event = NSEvent.mouseEvent(
                        with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0
                    ) else { continue }
                    window.sendEvent(event)
                }
            }
        case "/fullscreen":
            guard let window = app.window else { return }
            if window.styleMask.contains(.fullScreen) != (query["on"] == "1") { window.toggleFullScreen(nil) }
        case "/windowsize":
            guard let window = app.window, let width = query["w"].flatMap(Double.init), let height = query["h"].flatMap(Double.init) else { return }
            var frame = window.frame
            frame.origin.y += frame.height - height
            frame.size = NSSize(width: width, height: height)
            window.setFrame(frame, display: true, animate: query["animate"] == "1")
        case "/sitepref":
            app.session.shields.update(host: query["host"]) { prefs in
                if let value = query["trackingOff"] { prefs.trackingOff = value == "1" }
                if let value = query["shieldsOff"] { prefs.shieldsOff = value == "1" }
            }
        case "/hibernate":
            for tab in app.browser.tabs where tab.id != app.browser.selectedID { tab.hibernate() }
        case "/selecttab":
            app.browser.selectTab(atIndex: Int(query["i"] ?? "") ?? 0)
        case "/closetab":
            if let tab = app.browser.selected { app.browser.close(tab) }
        case "/settings":
            if let minimum = query["minimumSeconds"].flatMap(Double.init) { app.settings.minimumSecondsToTrack = minimum }
            if let ambient = query["ambient"] { app.settings.ambientLight = ambient == "1" }
            if let metadata = query["metadata"] { app.settings.fetchMetadata = metadata == "1" }
            if let frames = query["frames"] { app.settings.keepFrames = frames == "1" }
            if let button = query["downloadButton"] { app.settings.showDownloadButton = button == "1" }
            if let captions = query["captions"].flatMap(CaptionStyle.init(rawValue:)) { app.settings.captionStyle = captions }
            if let boost = query["voiceBoost"] { app.settings.voiceBoost = boost == "1" }
            if let bin = query["binWatched"] { app.settings.binWatchedDownloads = bin == "1" }
            if let next = query["playNext"] { app.settings.playNextDownload = next == "1" }
            if let alerts = query["alerts"] { app.settings.newEpisodeAlerts = alerts == "1" }
            if let cloud = query["cloud"] { app.settings.cloudBackup = cloud == "1" }
            if let pet = query["sharePet"] { app.settings.sharePet = pet == "1" }
        case "/click":
            click(x: Double(query["x"] ?? "") ?? 0, y: Double(query["y"] ?? "") ?? 0, app: app)
        case "/state":
            dumpState(app: app)
        case "/commandbar":
            app.openCommandBar(seed: query["seed"] ?? "")
        case "/detail":
            app.detailTitleID = query["id"].flatMap(Int64.init)
        case "/resume":
            if let target = query["url"].flatMap(URL.init(string:)) {
                let tab = app.browser.openTab(url: nil)
                tab.expectedResumeDuration = query["expected"].flatMap(Double.init)
                tab.load(target, resumingAt: query["at"].flatMap(Double.init))
            }
        case "/banner":
            if let tab = app.browser.selected {
                app.session.autopilot.handleBanner(["banner": query["banner"] ?? "", "action": query["action"] ?? ""], tab: tab)
            }
        case "/removesites":
            for site in app.library.sites { app.library.removeSite(site.id) }
        case "/deletesession":
            if let id = query["id"].flatMap(Int64.init) { app.library.deleteSession(id) }
        case "/download":
            if let tab = app.browser.selected { app.session.downloads.download(from: tab) }
        case "/downloads":
            let downloads = app.session.downloads!
            let lines = downloads.items.map { item in
                [
                    "download", "id=\(item.id)", "status=\(item.status.rawValue)", "kind=\(item.kind.rawValue)",
                    "name=\(item.fileBaseName)", "bytes=\(item.bytes)", "total=\(item.totalBytes)",
                    "fraction=\(downloads.fraction(item))", "file=\(item.file ?? "-")", "subtitles=\(item.subtitles.count)",
                    "error=\(item.error ?? "-")", "source=\(item.sourceURL.absoluteString)", "title=\(item.titleID ?? -1)",
                ].joined(separator: "\t")
            }
            let tab = app.browser.selected
            let sources = (tab?.sources ?? []).map { "source \($0.kind.rawValue) current=\($0.isCurrent) \($0.url.absoluteString)" }
            write((["best=\(tab?.bestSource?.url.absoluteString ?? "-")", "folder=\(downloads.folder.path)"] + sources + lines + ["end=1"]).joined(separator: "\n"))
        case "/keepwatching":
            if let target = query["url"].flatMap(URL.init(string:)) { app.resume(url: target, at: query["at"].flatMap(Double.init)) }
        case "/sleep":
            switch query["mode"] {
            case "end": app.startSleepTimer(.endOfItem)
            case "cancel": app.cancelSleepTimer()
            case "seconds": app.startSleepTimer(seconds: Double(query["s"] ?? "") ?? 30)
            default: app.startSleepTimer(.minutes(Int(query["m"] ?? "") ?? 30))
            }
        case "/sleepstate":
            let timer = app.sleepTimer
            write([
                "active=\(timer != nil)", "mode=\(timer.map { "\($0.mode)" } ?? "-")", "fading=\(timer?.isFading ?? false)",
                "remaining=\(app.sleepTimerRemaining ?? -1)", "end=1",
            ].joined(separator: "\n"))
        case "/nowplaying":
            write((app.nowPlaying.published.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" } + ["end=1"]).joined(separator: "\n"))
        case "/remote":
            app.nowPlaying.handlers[query["cmd"] ?? ""]?(Double(query["to"] ?? "") ?? 0)
        case "/voiceboost":
            Task {
                let tab = app.browser.selected
                let level = await tab?.evaluateInPlayer("__cineon.boostLevel()") as? Double ?? -2
                let volume = await tab?.evaluateInPlayer("__cineon.volume()") as? Double ?? -2
                write(["state=\(tab?.boostState.rawValue ?? "-")", "level=\(level)", "volume=\(volume)", "end=1"].joined(separator: "\n"))
            }
        case "/subs2":
            guard let tab = app.browser.selected else { break }
            if query["clear"] == "1" { tab.clearSecondSubtitles(); break }
            if let file = query["file"] {
                if let track = SubtitleTrack.load(path: file) { tab.showSecondSubtitles(track) }
            } else if let index = query["index"].flatMap(Int.init), tab.subtitleChoices.indices.contains(index) {
                let url = tab.subtitleChoices[index].url
                Task { _ = await tab.showSecondSubtitles(from: url) }
            }
        case "/subs2state":
            Task {
                let tab = app.browser.selected
                let text = await tab?.evaluateInPlayer("__cineon.secondSubtitleText()") as? String ?? "-"
                let choices = tab?.subtitleChoices.map { "\($0.label)|\($0.url.absoluteString)" }.joined(separator: ",") ?? ""
                write(["track=\(tab?.secondSubtitles?.label ?? "-")", "text=\(text)", "choices=\(choices)", "end=1"].joined(separator: "\n"))
            }
        case "/localsubs":
            guard let playback = app.localPlayback else { break }
            if let path = query["add"] { _ = playback.addSubtitles(from: URL(fileURLWithPath: path)) }
            if let second = query["second"].flatMap(Int.init), playback.subtitleTracks.indices.contains(second) {
                playback.secondSubtitleID = playback.subtitleTracks[second].id
            }
        case "/season":
            guard let tab = app.browser.selected else { return }
            if query["from"] == "series" {
                app.session.seasons.startSeries(from: tab)
            } else {
                app.session.seasons.start(from: tab, fromCurrent: query["from"] == "current")
            }
        case "/seasoncancel":
            app.session.seasons.cancel()
        case "/seasonconfirm":
            app.session.seasons.confirm()
        case "/seasonresume":
            app.session.seasons.resume()
        case "/seasonstate":
            let job = app.session.seasons.job
            let proposal = app.session.seasons.proposal
            write([
                "running=\(app.session.seasons.isRunning)", "finished=\(job?.isFinished ?? false)",
                "looking=\(app.session.seasons.isLooking)", "paused=\(job?.isPaused ?? false)",
                "scope=\(job?.scope.rawValue ?? "-")", "label=\(job?.label ?? "-")",
                "proposal=\(proposal?.job.episodes.map(\.shortLabel).joined(separator: ",") ?? "-")",
                "proposalBytes=\(proposal?.totalBytes ?? 0)", "proposalFits=\(proposal?.fits ?? false)",
                "episodes=\(job?.episodes.map(\.shortLabel).joined(separator: ",") ?? "-")",
                "queued=\(job?.queued.map(\.shortLabel).joined(separator: ",") ?? "-")",
                "missed=\(job?.missed.map(\.shortLabel).joined(separator: ",") ?? "-")",
                "current=\(job?.current?.shortLabel ?? "-")", "end=1",
            ].joined(separator: "\n"))
        case "/upnext":
            write(["next=\(app.upNext.map { "\($0.item.id)" } ?? "-")", "playing=\(app.localPlayback?.downloadID ?? -1)",
                   "ended=\(app.localPlayback?.didEnd ?? false)", "end=1"].joined(separator: "\n"))
            if query["play"] == "1" { app.playUpNext() }
        case "/fakeepisodes":
            if let id = query["title"].flatMap(Int64.init) {
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withFullDate]
                let list = (query["list"] ?? "").split(separator: ",").compactMap { entry -> EpisodeInfo? in
                    let parts = entry.split(separator: ":")
                    let numbers = parts.first?.split(separator: "x").compactMap { Int($0) } ?? []
                    guard numbers.count == 2 else { return nil }
                    let released = parts.count > 1 ? formatter.date(from: String(parts[1])) : nil
                    return EpisodeInfo(season: numbers[0], episode: numbers[1], released: released)
                }
                app.session.metadata.testEpisodes[id] = list
            }
        case "/checknew":
            Task {
                await app.session.alerts.check(force: true)
                let alerts = app.session.alerts.alerts.values.map { "alert \($0.titleID) latest=\($0.latest.shortLabel) new=\($0.newCount)" }
                write((alerts + ["fresh=\(app.session.alerts.fresh.count)", "notified=\(app.session.alerts.lastNotificationForTests ?? "-")", "end=1"]).joined(separator: "\n"))
            }
        case "/deletetitle":
            if let id = query["id"].flatMap(Int64.init) { app.library.delete(id) }
        case "/addtitle":
            if let name = query["name"] {
                let added = app.library.addTitle(
                    name: name, year: query["year"].flatMap(Int.init), kind: TitleKind(rawValue: query["kind"] ?? "") ?? .film,
                    status: TitleStatus(rawValue: query["status"] ?? "") ?? .watched, posterURL: nil, overview: nil
                )
                write("id=\(added?.id ?? -1)\nend=1")
            }
        case "/sharecard":
            let ok = ShareCard.write(stats: app.session.stats, pet: app.session.pet, name: app.session.profile.name,
                                     to: AppPaths.root.appendingPathComponent("share-card.png"))
            write("written=\(ok)\nend=1")
        case "/rate":
            if let id = query["id"].flatMap(Int64.init) {
                app.library.setRating(id, halves: query["halves"].flatMap(Int.init))
            }
        case "/cloud":
            let cloud = app.session.cloud!
            Task {
                if query["do"] == "sync" { await cloud.sync() }
                write([
                    "lastSync=\(cloud.lastSync.map { "\($0.timeIntervalSince1970)" } ?? "-")", "error=\(cloud.lastError ?? "-")",
                    "count=\(cloud.cloudCount)", "key=\(app.session.together.recoveryCode)", "end=1",
                ].joined(separator: "\n"))
            }
        case "/adopt":
            if let code = query["code"] {
                Task {
                    let ok = await app.session.together.adopt(recoveryCode: code)
                    if ok { await app.session.cloud.sync() }
                    write("adopted=\(ok)\nend=1")
                }
            }
        case "/stats":
            let stats = app.session.stats
            write([
                "hours=\(stats.estimatedHours)", "tracked=\(stats.trackedHours)", "films=\(stats.filmsWatched)",
                "episodes=\(stats.episodesFinished)", "rated=\(stats.rated)", "average=\(stats.averageRating ?? -1)",
                "genre=\(stats.favouriteGenre ?? "-")", "genres=\(stats.genres.prefix(4).map { "\($0.name):\(String(format: "%.2f", $0.weight))" }.joined(separator: ","))",
                "streak=\(stats.currentStreak)", "longest=\(stats.longestStreak)", "sessions=\(stats.sessions)",
                "pet=\(app.session.pet.code)", "species=\(app.session.pet.speciesLabel)", "end=1",
            ].joined(separator: "\n"))
        case "/intent":
            Task {
                switch query["name"] {
                case "playpause": _ = try? await PlayPauseIntent().perform()
                case "continue": _ = try? await ContinueWatchingIntent().perform()
                case "next": _ = try? await NextEpisodeIntent().perform()
                case "sleep":
                    let intent = SleepTimerIntent()
                    intent.minutes = Int(query["minutes"] ?? "") ?? 30
                    _ = try? await intent.perform()
                case "profile": _ = try? await OpenProfileIntent().perform()
                default: break
                }
            }
        case "/playdownload":
            if let id = query["id"].flatMap(Int64.init), let item = app.session.downloads.item(id) { app.playDownload(item) }
        case "/player":
            let playback = app.localPlayback
            write([
                "playing=\(playback?.isPlaying ?? false)", "position=\(playback?.position ?? -1)",
                "duration=\(playback?.duration ?? -1)", "caption=\(playback?.caption ?? "-")",
                "tracks=\(playback?.subtitleTracks.count ?? 0)", "route=\(app.route)",
                "ambient=\(app.ambient.level) \(app.ambient.zones.first ?? .black)",
                "windowVisible=\(app.window?.occlusionState.contains(.visible) ?? false)", "end=1",
            ].joined(separator: "\n"))
        case "/playerseek":
            if let playback = app.localPlayback, let to = query["to"].flatMap(Double.init) {
                playback.skip(by: to - playback.position)
            }
        case "/together":
            let together = app.session.together!
            if let code = query["code"] { together.enter(code: code) }
            if query["party"] == "start" { together.startParty() }
            if query["party"] == "leave" { together.leaveParty() }
            if let emoji = query["react"] { together.react(emoji) }
            if let text = query["say"] { together.say(text) }
            if let id = query["challenge"].flatMap(Int64.init), let title = app.library.titles[id] { together.createChallenge(for: title) }
            if query["sharewatched"] == "1" { together.shareWatched() }
            if let index = query["addshared"].flatMap(Int.init), let card = together.openedShares.first?.titles[safe: index] {
                together.addToBacklog(card)
            }
            if query["refresh"] == "1" { Task { await together.refreshChallenges() } }
            if query["dump"] == "1" {
                var lines = [
                    "person=\(together.personID ?? "-")",
                    "party=\(together.party.map { "\($0.code)|host=\($0.hostName)|playing=\($0.playing)|position=\($0.expectedPosition)|members=\($0.members.map(\.name).joined(separator: ","))" } ?? "-")",
                    "isHost=\(together.isHost)",
                    "shareCode=\(together.lastShareCode ?? "-")",
                    "shares=\(together.openedShares.map { "\($0.code):\($0.titles.map(\.name).joined(separator: ";"))" }.joined(separator: ","))",
                    "messages=\(together.party?.messages.map { "\($0.name):\($0.text)" }.joined(separator: "|") ?? "-")",
                    "pets=\(together.party?.members.map { "\($0.name):\($0.pet ?? "-")" }.joined(separator: ",") ?? "-")",
                ]
                for summary in together.challenges {
                    let state = together.details[summary.code]
                    let members = state?.members.map { "\($0.name):\($0.fraction):\($0.label)" }.joined(separator: ",") ?? "-"
                    lines.append("challenge=\(summary.code)|\(summary.title.name)|total=\(Int(summary.totalEpisodes))|winner=\(state?.winnerName ?? "-")|\(members)")
                }
                lines.append("end=1")
                write(lines.joined(separator: "\n"))
            }
        case "/moment":
            if let tab = app.browser.selected { app.session.frames.saveMoment(tab: tab) }
        case "/findelsewhere":
            if let tab = app.browser.selected { app.session.rescue.findElsewhere(tab: tab) }
        case "/rescuetake":
            if let tab = app.browser.selected, let first = tab.rescue?.options.first { app.session.rescue.take(first, tab: tab) }
        case "/stallseconds":
            app.browser.selected?.playerCommand("setStallSeconds(\(query["s"] ?? "30"))")
        case "/cinema":
            app.toggleCinema()
        case "/seed":
            seedDemo(app: app)
        case "/profiles":
            app.isProfilePickerVisible = query["show"] != "0"
        case "/addprofile":
            let profile = app.profiles.add(name: query["name"] ?? "Guest")
            if query["switch"] == "1" { app.switchProfile(to: profile) }
        case "/switchprofile":
            if let profile = app.profiles.profiles.first(where: { $0.name == query["name"] }) {
                app.switchProfile(to: profile)
            }
        case "/sheet":
            switch query["kind"] {
            case "addsite": app.sheet = .addSite(prefill: nil)
            case "addtitle": app.sheet = .addTitle(query: query["q"])
            case "relink": app.sheet = .relink
            case "import": app.sheet = .importBrowser
            default: app.sheet = nil
            }
        case "/filterupdate":
            Task {
                let ok = await app.filters.update()
                write("filterupdate \(ok)")
            }
        default:
            write("unknown \(path)")
        }
    }

    private static func evaluate(_ js: String, world: WKContentWorld, app: AppModel) {
        guard let webView = app.browser.selected?.webView else {
            write("no web view")
            return
        }
        webView.evaluateJavaScript(js, in: nil, in: world) { result in
            switch result {
            case .success(let value): write("\(value)")
            case .failure(let error): write("error: \(error)")
            }
        }
    }

    /// Clicks through the real event path, so pages see a trusted click with a user gesture.
    private static func click(x: Double, y: Double, app: AppModel) {
        guard let webView = app.browser.selected?.webView, let window = webView.window else {
            write("no web view")
            return
        }
        // AppKit swallows clicks on a window that isn't key, so bring it forward first.
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        // x and y are page coordinates from the web view's top left.
        let inWindow = webView.convert(NSPoint(x: x, y: webView.isFlipped ? y : webView.bounds.height - y), to: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                guard let event = NSEvent.mouseEvent(
                    with: type, location: inWindow, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0
                ) else { continue }
                window.sendEvent(event)
            }
            write("clicked \(x),\(y) key=\(window.isKeyWindow)")
        }
    }

    private static func dumpState(app: AppModel) {
        let tab = app.browser.selected
        let lines = [
            "profile=\(app.session.profile.name)",
            "profileid=\(app.session.profile.id.uuidString)",
            "route=\(app.route)",
            "url=\(tab?.url?.absoluteString ?? "-")",
            "title=\(tab?.title ?? "-")",
            "parsed=\(tab?.parsed.map { "\($0.name)|\($0.year ?? 0)|S\($0.ref.season)E\($0.ref.episode)|\($0.kindHint.rawValue)|\($0.confidence)" } ?? "-")",
            "media=\(tab?.media.map { "\($0.position)/\($0.duration) playing=\($0.isPlaying)" } ?? "-")",
            "track=\(tab?.track?.titleID ?? -1)",
            "blocked=\(tab?.blocked ?? ShieldStats())",
            "framesBlocked=\(tab?.ambientFramesBlocked ?? false)",
            "fullscreen=\(tab?.webView?.fullscreenState.rawValue ?? -1)",
            "hasSuperview=\(tab?.webView?.superview != nil)",
            "windowVisible=\(app.window?.occlusionState.contains(.visible) ?? false)",
            "appActive=\(NSApp.isActive)",
            "ambientOn=\(app.settings.ambientLight)",
            "ambient=\(app.ambient.level) \(app.ambient.zones.first ?? .black)",
            "tabs=\(app.browser.tabs.count)",
            "rules=\(app.filters.compiled.count)/\(app.filters.totalRules)",
            "tablist=\(app.browser.tabs.map { "\($0.url?.absoluteString ?? "-")[\($0.isHibernated ? "h" : "a")]" }.joined(separator: ","))",
            "search=\(app.browser.search?.results.map(\.url.absoluteString).joined(separator: ",") ?? "-")",
            "toast=\(app.toasts.current?.message ?? "-")",
            "banner=\(tab?.lastBannerForTests ?? "-")",
            "rescue=\(tab?.rescue.map { "\($0.reason)|\($0.stage)|\($0.options.map { "\($0.siteName):\($0.url.path):\($0.isStrong)" }.joined(separator: ";"))|\($0.countdown ?? -1)" } ?? "-")",
            "failure=\(tab?.failure?.host ?? "-")",
            "frames=\(app.library.framesBySession.values.reduce(0) { $0 + $1.count })",
            "sites=\(app.library.sites.map { "\($0.host)|\($0.searchTemplate ?? "-")" }.joined(separator: ","))",
            "cinema=\(app.isCinema)",
            "theater=\(tab?.isTheaterOn ?? false)",
            "canGoBack=\(tab?.canGoBack ?? false)",
            "status=\(app.filters.status)",
            "window=\(app.window?.windowNumber ?? -1)",
            "lights=\(app.window.map(TrafficLights.report) ?? "-")",
            "version=\(Updater.shared.version)",
            "canUpdate=\(Updater.shared.canCheck)",
            "updateEvent=\(Updater.shared.lastEvent)",
            "memory=\(residentMegabytes())MB",
        ]
        write(lines.joined(separator: "\n"))
    }

    private static func residentMegabytes() -> Int {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Int(info.resident_size / 1_048_576) : -1
    }

    /// Fills a throwaway profile with real titles, for reviewing the design with content.
    private static func seedDemo(app: AppModel) {
        let library = app.library
        let now = Date.now
        let items: [(String, Int, TitleKind, TitleStatus, String)] = [
            ("Dune: Part Two", 2024, .film, .watching, "tt15239678"),
            ("Severance", 2022, .series, .watching, "tt11280740"),
            ("Spirited Away", 2001, .cartoon, .watching, "tt0245429"),
            ("Oppenheimer", 2023, .film, .watched, "tt15398776"),
            ("Blade Runner 2049", 2017, .film, .watched, "tt1856101"),
            ("The Bear", 2022, .series, .watched, "tt14452776"),
            ("Parasite", 2019, .film, .watched, "tt6751668"),
            ("Arrival", 2016, .film, .backlog, "tt2543164"),
            ("Past Lives", 2023, .film, .backlog, "tt13238346"),
            ("Andor", 2022, .series, .backlog, "tt9253284"),
            ("Princess Mononoke", 1997, .cartoon, .backlog, "tt0119698"),
            ("The Zone of Interest", 2023, .film, .backlog, "tt7160372"),
            ("Shogun", 2024, .series, .backlog, "tt2788316"),
        ]
        for (index, item) in items.enumerated() {
            let (name, year, kind, status, imdb) = item
            guard let title = library.addTitle(name: name, year: year, kind: kind, status: status, imdbID: imdb) else { continue }
            Task {
                let hits = await MetadataClient.search(name)
                let hit = hits.first { $0.id == imdb } ?? MetadataHit(id: imdb, name: name, year: year, kind: kind)
                app.session.metadata.apply(hit: hit, to: title.id)
            }
            guard status != .backlog else { continue }
            let duration = kind == .series ? 3100.0 : 8700.0
            let ref = kind == .series ? EpisodeRef(season: 2, episode: index + 1) : .none
            let host = ["flixhub.example", "kino.example", "uaserial.example"][index % 3]
            let url = URL(string: "https://\(host)/watch/\(name.lowercased().replacingOccurrences(of: " ", with: "-"))")!
            let position = status == .watched ? duration : duration * [0.36, 0.62, 0.18][index % 3]
            let at = now.addingTimeInterval(Double(-index * 40000 - 3000))
            library.saveProgress(WatchProgress(
                titleID: title.id, ref: ref, urlKey: URLKey.make(url), url: url, host: host, position: position,
                duration: duration, finished: status == .watched, updatedAt: at
            ))
            _ = library.saveSession(WatchSession(
                id: 0, titleID: title.id, ref: ref, episodeName: nil, url: url, host: host,
                startedAt: at.addingTimeInterval(-position), endedAt: at, watchedSeconds: position,
                startPosition: 0, endPosition: position, duration: duration, finished: status == .watched
            ))
        }
    }
}
#endif

#if DEBUG
extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
#endif
