import AppKit
import AVFoundation
import Foundation
import Observation
import WebKit

/// Saves films and episodes to this Mac, from the files their players stream. What people do by
/// digging the link out of the Network tab, done with one click.
///
/// Whole files go through URLSession with the page's own cookies, address and browser name, so a
/// site sees the same visitor it served the player to. Sites that only stream playlists go through
/// AVFoundation's offline HLS, whose packages the native player opens.
@Observable
final class DownloadCenter {
    private(set) var items: [DownloadItem] = []
    /// Live progress, 0 to 1, for downloads whose size isn't known in bytes.
    private(set) var progress: [Int64: Double] = [:]

    @ObservationIgnored private unowned let session: ProfileSession
    @ObservationIgnored private let delegate = DownloadDelegate()
    @ObservationIgnored private var fileSession: URLSession!
    @ObservationIgnored private var hlsSession: AVAssetDownloadURLSession?
    @ObservationIgnored private var tasks: [Int64: URLSessionTask] = [:]
    @ObservationIgnored private var resumeData: [Int64: Data] = [:]
    @ObservationIgnored private var lastWrite: [Int64: Date] = [:]
    @ObservationIgnored private var lastPillRefresh = Date.distantPast
    @ObservationIgnored private var userAgent: String?
    /// What a queued download needs once its turn comes.
    @ObservationIgnored private var pending: [Int64: (webView: WKWebView?, subtitles: [URL])] = [:]
    @ObservationIgnored private var starting: Set<Int64> = []

    /// Downloads at the same time. More only splits the same connection and makes links expire
    /// before their turn.
    static let maxRunning = 2

    init(session: ProfileSession) {
        self.session = session
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 60 * 60 * 12
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        fileSession = URLSession(configuration: config, delegate: delegate, delegateQueue: .main)
        delegate.center = self
        items = (try? session.db.allDownloads()) ?? []
        // Whatever was running when Cineon last closed stopped with it.
        for item in items where item.status.isActive {
            var stopped = item
            stopped.status = .failed
            stopped.error = "Stopped when Cineon closed"
            save(stopped)
        }
    }

    // MARK: Reading

    var activeCount: Int { items.reduce(0) { $0 + ($1.status.isActive ? 1 : 0) } }
    var runningCount: Int { items.reduce(0) { $0 + ($1.status == .downloading ? 1 : 0) } + starting.count }
    var hasFreeSlot: Bool { runningCount < Self.maxRunning }

    func item(_ id: Int64) -> DownloadItem? { items.first { $0.id == id } }

    func fraction(_ item: DownloadItem) -> Double {
        if item.status == .done { return 1 }
        return progress[item.id] ?? item.fraction
    }

    /// The download that already holds what this tab is showing, if there is one.
    func existing(for tab: BrowserTab) -> DownloadItem? {
        let best = tab.bestSource
        if let best, let match = items.first(where: { $0.sourceURL == best.url && $0.status != .failed }) { return match }
        guard let titleID = tab.linkedTitleID else { return nil }
        let ref = tab.track?.ref ?? tab.parsed?.ref ?? .none
        return items.first { $0.titleID == titleID && $0.ref == ref && $0.status != .failed }
    }

    /// The file for something someone stopped watching on this Mac.
    func item(forFile url: URL) -> DownloadItem? {
        items.first { $0.file == url.path }
    }

    static func folder(settings: AppSettings) -> URL {
        let custom = settings.downloadsFolder.trimmingCharacters(in: .whitespaces)
        if !custom.isEmpty { return URL(fileURLWithPath: custom, isDirectory: true) }
        if ProcessInfo.processInfo.environment["CINEON_DATA_DIR"] != nil {
            // Test runs keep their files with the rest of their throwaway data.
            return AppPaths.root.appendingPathComponent("Movies", isDirectory: true)
        }
        let movies = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]
        return movies.appendingPathComponent("Cineon", isDirectory: true)
    }

    var folder: URL { Self.folder(settings: session.settings) }

    // MARK: Starting

    /// Downloads what the tab is playing. Returns false when there's nothing to download.
    @discardableResult
    func download(from tab: BrowserTab) -> Bool {
        if let existing = existing(for: tab) {
            if existing.status == .done {
                session.app?.playDownload(existing)
            } else {
                session.toasts.show("\(existing.name) is already downloading")
            }
            return true
        }
        guard let source = tab.bestSource else {
            session.toasts.show("Play the video for a moment first, so Cineon can see its file")
            return false
        }
        let title = libraryTitle(for: tab)
        let ref = tab.track?.ref ?? tab.parsed?.ref ?? .none
        let name = title?.name ?? tab.parsed?.name ?? tab.displayTitle
        let subtitles = tab.sources.filter { $0.kind == .subtitle && $0.isCurrent }.prefix(6).map(\.url)
        guard let item = enqueue(
            source: source, titleID: title?.id, ref: ref, name: name, pageURL: tab.url,
            referer: tab.sourcesFrameURL ?? tab.url?.absoluteString, duration: tab.media?.duration ?? 0,
            posterURL: title?.posterURL ?? tab.parsed?.posterURL, webView: tab.webView, subtitles: Array(subtitles)
        ) else { return false }
        let isWaiting = self.item(item.id)?.status == .queued && !starting.contains(item.id)
        session.toasts.show(isWaiting ? "Queued \(item.fileBaseName), after the ones running now" : "Downloading \(item.fileBaseName)")
        return true
    }

    /// Adds a download to the queue. It starts as soon as fewer than two are running.
    @discardableResult
    func enqueue(
        source: MediaSource, titleID: Int64?, ref: EpisodeRef, name: String, pageURL: URL?, referer: String?,
        duration: Double, posterURL: URL?, webView: WKWebView?, subtitles: [URL]
    ) -> DownloadItem? {
        var item = DownloadItem(
            id: 0, titleID: titleID, ref: ref, name: name, sourceURL: source.url, pageURL: pageURL,
            referer: referer, host: pageURL?.host ?? source.url.host ?? "",
            kind: source.kind == .hls ? .hls : .file, quality: source.quality, file: nil, subtitles: [], bytes: 0,
            totalBytes: 0, status: .queued, error: nil, position: 0, duration: duration,
            posterURL: posterURL, createdAt: .now, finishedAt: nil, playedAt: nil
        )
        guard let id = try? session.db.insertDownload(item) else { return nil }
        item.id = id
        items.insert(item, at: 0)
        pending[id] = (webView, subtitles)
        pump()
        refreshPills(force: true)
        return item
    }

    /// Starts queued downloads, oldest first, while there's room.
    private func pump() {
        for item in items.reversed() where item.status == .queued && tasks[item.id] == nil && !starting.contains(item.id) {
            guard hasFreeSlot else { return }
            starting.insert(item.id)
            let job = pending.removeValue(forKey: item.id)
            Task {
                await begin(item.id, webView: job?.webView, subtitles: job?.subtitles ?? [])
                starting.remove(item.id)
            }
        }
    }

    /// Downloads any file the way the page's player would, with its cookies and address.
    func fetch(_ url: URL, referer: String?, webView: WKWebView?) async -> Data? {
        let probe = DownloadItem(
            id: 0, titleID: nil, ref: .none, name: "", sourceURL: url, pageURL: nil, referer: referer, host: url.host ?? "",
            kind: .subtitle, quality: nil, file: nil, subtitles: [], bytes: 0, totalBytes: 0, status: .queued, error: nil,
            position: 0, duration: 0, posterURL: nil, createdAt: .now, finishedAt: nil, playedAt: nil
        )
        var request = URLRequest(url: url)
        let headers = await requestHeaders(for: probe, webView: webView)
        headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
        HTTPCookie.requestHeaderFields(with: await cookies(for: url)).forEach { request.setValue($1, forHTTPHeaderField: $0) }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode ?? 200 < 400, !data.isEmpty
        else { return nil }
        return data
    }

    /// Adds a subtitle file someone picked to a download, copied next to it.
    func addSubtitles(_ file: URL, to id: Int64) -> String? {
        guard var item = item(id), let data = try? Data(contentsOf: file) else { return nil }
        let folder = item.fileURL?.deletingLastPathComponent() ?? self.folder
        let ext = file.pathExtension.lowercased() == "srt" ? "srt" : "vtt"
        let stem = file.deletingPathExtension().lastPathComponent
        let label = SubtitleTrack.label(for: file, index: item.subtitles.count)
        let base = label.isEmpty || label.hasPrefix("Track") ? stem : label.lowercased()
        let target = Self.unique(folder.appendingPathComponent("\(item.fileBaseName).\(base).\(ext)"))
        guard (try? data.write(to: target)) != nil else { return nil }
        item.subtitles.append(target.path)
        save(item)
        return target.path
    }

    /// The downloaded episode after this one, if it's on this Mac.
    func nextEpisode(after item: DownloadItem) -> DownloadItem? {
        guard let titleID = item.titleID, item.ref.isEpisode else { return nil }
        return items
            .filter { $0.titleID == titleID && $0.status == .done && $0.ref.isEpisode && $0.fileURL != nil }
            .filter { ($0.ref.season, $0.ref.episode) > (item.ref.season, item.ref.episode) }
            .min { ($0.ref.season, $0.ref.episode) < ($1.ref.season, $1.ref.episode) }
    }

    /// A watched episode goes to the Bin, where it can still be put back from.
    func binWatched(_ id: Int64) {
        guard let item = item(id), item.ref.isEpisode, item.status == .done else { return }
        remove(id)
        session.toasts.show("Moved \(item.fileBaseName) to the Bin, since you've watched it")
    }

    /// The library's entry for what the tab shows, added if it isn't there yet, so the copy on
    /// this Mac has a poster, and watching it lands on the timeline.
    func libraryTitle(for tab: BrowserTab) -> Title? {
        let library = session.library
        if let id = tab.linkedTitleID, let title = library.titles[id] { return title }
        guard let parsed = tab.parsed else { return nil }
        if let found = library.find(name: parsed.name, altName: parsed.altName, year: parsed.year) { return found }
        guard let added = library.addTitle(
            name: parsed.name, year: parsed.year, kind: parsed.kindHint, status: .none,
            posterURL: parsed.posterURL, overview: parsed.overview
        ) else { return nil }
        session.metadata.enrich(titleID: added.id, altName: parsed.altName)
        return added
    }

    func retry(_ id: Int64) {
        guard var item = item(id), !item.status.isActive else { return }
        item.status = .queued
        item.error = nil
        save(item)
        pump()
    }

    func cancel(_ id: Int64) {
        guard let task = tasks[id] else {
            // Still waiting for its turn.
            if var item = item(id), item.status == .queued {
                pending[id] = nil
                item.status = .failed
                item.error = "Stopped"
                save(item)
                refreshPills(force: true)
            }
            return
        }
        if let download = task as? URLSessionDownloadTask {
            download.cancel { [weak self] data in
                Task { @MainActor in if let data { self?.resumeData[id] = data } }
            }
        } else {
            task.cancel()
        }
    }

    /// Moves the file to the Bin, where it can still be recovered, and forgets the download.
    func remove(_ id: Int64) {
        cancel(id)
        guard let item = item(id) else { return }
        let files = ([item.file] + item.subtitles.map(Optional.some)).compactMap { $0 }.map { URL(fileURLWithPath: $0) }
        let existing = files.filter { FileManager.default.fileExists(atPath: $0.path) }
        if !existing.isEmpty { NSWorkspace.shared.recycle(existing) }
        try? session.db.deleteDownload(id)
        items.removeAll { $0.id == id }
        progress[id] = nil
        resumeData[id] = nil
        refreshPills(force: true)
    }

    func showInFinder(_ item: DownloadItem) {
        if let url = item.fileURL, FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            NSWorkspace.shared.open(folder)
        }
    }

    /// Remembers where playback stopped, and for how long the file runs.
    func notePlayback(_ id: Int64, position: Double, duration: Double) {
        guard var item = item(id) else { return }
        item.position = position
        if duration > 0 { item.duration = duration }
        item.playedAt = .now
        save(item)
    }

    /// Stops everything when the profile closes. A background session's name can only be in use
    /// once, so it has to go too, or this profile couldn't download streams after switching back.
    func suspendAll() {
        for (_, task) in tasks { task.cancel() }
        tasks.removeAll()
        fileSession.invalidateAndCancel()
        hlsSession?.invalidateAndCancel()
        hlsSession = nil
    }

    // MARK: Running

    private func begin(_ id: Int64, webView: WKWebView?, subtitles: [URL]) async {
        guard var item = item(id) else { return }
        let headers = await requestHeaders(for: item, webView: webView)
        let cookies = await cookies(for: item.sourceURL)
        guard self.item(id)?.status == .queued else { return }
        item.status = .downloading
        save(item)

        switch item.kind {
        case .hls:
            startPlaylist(item, headers: headers, cookies: cookies)
        case .file, .subtitle:
            var request = URLRequest(url: item.sourceURL)
            headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
            HTTPCookie.requestHeaderFields(with: cookies).forEach { request.setValue($1, forHTTPHeaderField: $0) }
            let task: URLSessionDownloadTask
            if let data = resumeData.removeValue(forKey: id) {
                task = fileSession.downloadTask(withResumeData: data)
            } else {
                task = fileSession.downloadTask(with: request)
            }
            delegate.ids[ObjectIdentifier(task)] = id
            tasks[id] = task
            task.resume()
        }
        if !subtitles.isEmpty { await saveSubtitles(subtitles, for: id, headers: headers, cookies: cookies) }
    }

    private func startPlaylist(_ item: DownloadItem, headers: [String: String], cookies: [HTTPCookie]) {
        if hlsSession == nil {
            let config = URLSessionConfiguration.background(withIdentifier: "app.cineon.hls.\(session.profile.id.uuidString)")
            let created = AVAssetDownloadURLSession(configuration: config, assetDownloadDelegate: delegate, delegateQueue: .main)
            // Anything left from an earlier run belongs to nobody now.
            created.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
            hlsSession = created
        }
        guard let hlsSession else { return }
        var options: [String: Any] = [AVURLAssetHTTPCookiesKey: cookies]
        if let agent = headers["User-Agent"] { options[AVURLAssetHTTPUserAgentKey] = agent }
        // Not in the public API, and widely relied on. Without it the Referer some CDNs check is missing.
        options["AVURLAssetHTTPHeaderFieldsKey"] = headers.filter { $0.key != "User-Agent" }
        let asset = AVURLAsset(url: item.sourceURL, options: options)
        let config = AVAssetDownloadConfiguration(asset: asset, title: item.fileBaseName)
        let task = hlsSession.makeAssetDownloadTask(downloadConfiguration: config)
        delegate.ids[ObjectIdentifier(task)] = item.id
        tasks[item.id] = task
        task.resume()
    }

    private func requestHeaders(for item: DownloadItem, webView: WKWebView?) async -> [String: String] {
        if userAgent == nil, let webView, let agent = await webView.runScript("navigator.userAgent") as? String {
            userAgent = agent
        }
        var headers = ["Accept": "*/*"]
        if let userAgent { headers["User-Agent"] = userAgent }
        if let referer = item.referer, !referer.isEmpty { headers["Referer"] = referer }
        if let referer = item.referer.flatMap(URL.init(string:)), let scheme = referer.scheme, let host = referer.host,
           !DomainName.isSameSite(host, item.sourceURL.host) {
            headers["Origin"] = "\(scheme)://\(host)" + (referer.port.map { ":\($0)" } ?? "")
        }
        return headers
    }

    /// The profile's cookies that this address would be sent, logins included.
    private func cookies(for url: URL) async -> [HTTPCookie] {
        guard let host = url.host?.lowercased() else { return [] }
        let all = await session.webKit.dataStore.httpCookieStore.allCookies()
        return all.filter { cookie in
            let domain = cookie.domain.lowercased()
            let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
            let domainMatches = host == bare || host.hasSuffix("." + bare)
            let pathMatches = url.path.isEmpty || url.path.hasPrefix(cookie.path)
            return domainMatches && pathMatches && (!cookie.isSecure || url.scheme == "https")
        }
    }

    private func saveSubtitles(_ urls: [URL], for id: Int64, headers: [String: String], cookies: [HTTPCookie]) async {
        var saved: [String] = []
        let folder = self.folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (index, url) in urls.enumerated() {
            var request = URLRequest(url: url)
            headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
            HTTPCookie.requestHeaderFields(with: cookies).forEach { request.setValue($1, forHTTPHeaderField: $0) }
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode ?? 200 < 400, !data.isEmpty,
                  let item = item(id)
            else { continue }
            let ext = url.pathExtension.lowercased() == "srt" ? "srt" : "vtt"
            let label = SubtitleTrack.label(for: url, index: index)
            let target = Self.unique(folder.appendingPathComponent("\(item.fileBaseName).\(label).\(ext)"))
            guard (try? data.write(to: target)) != nil else { continue }
            saved.append(target.path)
        }
        guard !saved.isEmpty, var item = item(id) else { return }
        item.subtitles += saved
        save(item)
    }

    // MARK: Delegate events

    fileprivate func wrote(_ id: Int64, bytes: Int64, total: Int64) {
        guard var item = item(id) else { return }
        item.bytes = bytes
        if total > 0 { item.totalBytes = total }
        if item.totalBytes > 0 { progress[id] = Double(bytes) / Double(item.totalBytes) }
        // Keep the row current without writing the database many times a second.
        if Date.now.timeIntervalSince(lastWrite[id] ?? .distantPast) > 3 {
            lastWrite[id] = .now
            save(item)
        } else if let index = items.firstIndex(where: { $0.id == id }) {
            items[index] = item
        }
        refreshPills()
    }

    fileprivate func loaded(_ id: Int64, fraction: Double) {
        progress[id] = fraction
        refreshPills()
    }

    fileprivate func finished(_ id: Int64, stagedAt staged: URL, suggestedName: String?, response: URLResponse?) {
        guard var item = item(id) else { return }
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            try? FileManager.default.removeItem(at: staged)
            fail(id, message: Self.explain(status: http.statusCode))
            return
        }
        let folder = self.folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let ext = Self.fileExtension(staged: staged, suggested: suggestedName, source: item.sourceURL, kind: item.kind)
        let target = Self.unique(folder.appendingPathComponent("\(item.fileBaseName).\(ext)"))
        do {
            try FileManager.default.moveItem(at: staged, to: target)
        } catch {
            fail(id, message: "Couldn't save into \(folder.lastPathComponent): \(error.localizedDescription)")
            return
        }
        item.file = target.path
        item.status = .done
        item.error = nil
        item.finishedAt = .now
        let size = Self.size(of: target)
        if size > 0 {
            item.bytes = size
            item.totalBytes = size
        }
        tasks[id] = nil
        progress[id] = nil
        save(item)
        refreshPills(force: true)
        pump()
        session.toasts.show(
            "Saved \(item.fileBaseName)",
            action: Toast.Action(title: "Play") { [weak self] in
                guard let self, let item = self.item(id) else { return }
                self.session.app?.playDownload(item)
            }
        )
        Task { await self.readDuration(id) }
    }

    fileprivate func failed(_ id: Int64, error: (any Error)?) {
        tasks[id] = nil
        progress[id] = nil
        guard let error else { return }
        let ns = error as NSError
        if let data = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data { resumeData[id] = data }
        if ns.code == NSURLErrorCancelled {
            fail(id, message: "Stopped")
        } else {
            fail(id, message: ns.localizedDescription)
        }
    }

    private func fail(_ id: Int64, message: String) {
        guard var item = item(id) else { return }
        tasks[id] = nil
        progress[id] = nil
        item.status = .failed
        item.error = message
        save(item)
        refreshPills(force: true)
        pump()
    }

    private func readDuration(_ id: Int64) async {
        guard let url = item(id)?.fileURL else { return }
        let asset = AVURLAsset(url: url)
        guard let duration = try? await asset.load(.duration), duration.seconds.isFinite, duration.seconds > 0,
              var item = item(id)
        else { return }
        item.duration = duration.seconds
        save(item)
    }

    // MARK: Helpers

    private func save(_ item: DownloadItem) {
        try? session.db.updateDownload(item)
        if let index = items.firstIndex(where: { $0.id == item.id }) { items[index] = item }
    }

    /// Updates the download button on every page that shows one. At most once a second while
    /// a download runs, so it doesn't flood the page.
    func refreshPills(force: Bool = false) {
        guard force || Date.now.timeIntervalSince(lastPillRefresh) > 1 else { return }
        lastPillRefresh = .now
        for tab in session.browser.tabs where tab.webView != nil { tab.refreshDownloadPill() }
    }

    private static func explain(status: Int) -> String {
        switch status {
        case 401, 403: "The site refused. The link may have expired: open the page and download again."
        case 404, 410: "The file is gone from the site."
        default: "The site answered with an error (\(status))."
        }
    }

    nonisolated static func unique(_ url: URL) -> URL {
        var target = url
        var counter = 2
        let folder = url.deletingLastPathComponent()
        let ext = url.pathExtension
        // "Name.en.vtt" keeps both of its extensions.
        let base = url.deletingPathExtension().lastPathComponent
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent("\(base) \(counter)" + (ext.isEmpty ? "" : ".\(ext)"))
            counter += 1
        }
        return target
    }

    private static func fileExtension(staged: URL, suggested: String?, source: URL, kind: MediaSource.Kind) -> String {
        if kind == .hls || staged.pathExtension == "movpkg" { return "movpkg" }
        let known: Set<String> = ["mp4", "m4v", "mov", "webm", "mkv"]
        for candidate in [suggested.map { ($0 as NSString).pathExtension }, source.pathExtension] {
            if let ext = candidate?.lowercased(), known.contains(ext) { return ext }
        }
        return "mp4"
    }

    nonisolated static func size(of url: URL) -> Int64 {
        let manager = FileManager.default
        var isFolder: ObjCBool = false
        guard manager.fileExists(atPath: url.path, isDirectory: &isFolder) else { return 0 }
        if !isFolder.boolValue {
            return (try? manager.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
        }
        var total: Int64 = 0
        let enumerator = manager.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey])
        while let file = enumerator?.nextObject() as? URL {
            total += Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }
}

/// URLSession and AVFoundation call back on the main queue, but through protocols that aren't
/// marked for it. This shim takes the calls and hands them to the center.
private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate, AVAssetDownloadDelegate, @unchecked Sendable {
    nonisolated(unsafe) weak var center: DownloadCenter?
    /// Keyed by the task itself: the file and stream sessions each count task numbers from 1.
    nonisolated(unsafe) var ids: [ObjectIdentifier: Int64] = [:]
    nonisolated(unsafe) private var packages: [ObjectIdentifier: URL] = [:]

    nonisolated func urlSession(
        _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
    ) {
        guard let id = ids[ObjectIdentifier(downloadTask)] else { return }
        MainActor.assumeIsolated {
            center?.wrote(id, bytes: totalBytesWritten, total: totalBytesExpectedToWrite)
        }
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = ids[ObjectIdentifier(downloadTask)] else { return }
        // The file is deleted as soon as this returns, so move it somewhere safe first.
        let staged = FileManager.default.temporaryDirectory.appendingPathComponent("cineon-\(UUID().uuidString).part")
        guard (try? FileManager.default.moveItem(at: location, to: staged)) != nil else { return }
        let suggested = downloadTask.response?.suggestedFilename
        let response = downloadTask.response
        MainActor.assumeIsolated {
            center?.finished(id, stagedAt: staged, suggestedName: suggested, response: response)
        }
    }

    nonisolated func urlSession(
        _ session: URLSession, assetDownloadTask: AVAssetDownloadTask, didLoad timeRange: CMTimeRange,
        totalTimeRangesLoaded loadedTimeRanges: [NSValue], timeRangeExpectedToLoad: CMTimeRange
    ) {
        guard let id = ids[ObjectIdentifier(assetDownloadTask)] else { return }
        let expected = timeRangeExpectedToLoad.duration.seconds
        guard expected.isFinite, expected > 0 else { return }
        let loaded = loadedTimeRanges.reduce(0.0) { $0 + $1.timeRangeValue.duration.seconds }
        MainActor.assumeIsolated { center?.loaded(id, fraction: min(1, loaded / expected)) }
    }

    nonisolated func urlSession(_ session: URLSession, assetDownloadTask: AVAssetDownloadTask, didFinishDownloadingTo location: URL) {
        packages[ObjectIdentifier(assetDownloadTask)] = location
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let id = ids.removeValue(forKey: ObjectIdentifier(task)) else { return }
        let package = packages.removeValue(forKey: ObjectIdentifier(task))
        MainActor.assumeIsolated {
            if error == nil, let package, task is AVAssetDownloadTask {
                center?.finished(id, stagedAt: package, suggestedName: nil, response: nil)
            } else if error != nil || task is AVAssetDownloadTask {
                center?.failed(id, error: error ?? NSError(domain: "Cineon", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "The stream couldn't be saved. It may be protected.",
                ]))
            } else {
                // A whole file already reported how it ended, error page included, when it finished.
                center?.failed(id, error: nil)
            }
        }
    }
}
