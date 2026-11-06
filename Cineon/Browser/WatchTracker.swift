import Foundation

/// One report from `media.js`.
nonisolated struct MediaEvent: Sendable {
    var type: String
    var position: Double
    var duration: Double
    var paused: Bool
    var muted: Bool
    var rate: Double
    var width: Int
    var height: Int
    var isTopFrame: Bool
    var frameURL: String
    var userActivated: Bool

    init?(_ body: Any) {
        guard let d = body as? [String: Any], let type = d["type"] as? String else { return nil }
        self.type = type
        position = (d["t"] as? NSNumber)?.doubleValue ?? 0
        duration = (d["d"] as? NSNumber)?.doubleValue ?? 0
        paused = (d["paused"] as? NSNumber)?.boolValue ?? true
        muted = (d["muted"] as? NSNumber)?.boolValue ?? false
        rate = (d["rate"] as? NSNumber)?.doubleValue ?? 1
        width = (d["w"] as? NSNumber)?.intValue ?? 0
        height = (d["h"] as? NSNumber)?.intValue ?? 0
        isTopFrame = (d["top"] as? NSNumber)?.boolValue ?? false
        frameURL = d["frame"] as? String ?? ""
        userActivated = (d["active"] as? NSNumber)?.boolValue ?? true
    }
}

/// What the interface shows about the video in a tab.
struct MediaState: Equatable {
    var position: Double
    var duration: Double
    var isPlaying: Bool
    var rate: Double
    var fraction: Double { duration > 0 ? min(1, position / duration) : 0 }
}

/// The session being recorded in a tab.
struct LiveTrack {
    var titleID: Int64
    var ref: EpisodeRef
    var urlKey: String
    var session: WatchSession
    var lastFlush: Date
    var startedWith: Double
    var finishedAnnounced: Bool
}

/// Turns raw playback reports into timeline sessions and saved positions.
///
/// Rows are updated in place as playback goes on, so there's no "end session" step to miss:
/// quit, crash or close the tab and the timeline is still right to within ten seconds.
final class WatchTracker {
    /// Anything shorter is an ad, a trailer or a preview.
    static let minimumDuration = 240.0
    /// Coming back to the same thing within this time continues the same timeline entry.
    static let mergeWindow: TimeInterval = 30 * 60
    private static let flushInterval: TimeInterval = 10

    private unowned let session: ProfileSession

    init(session: ProfileSession) {
        self.session = session
    }

    private var library: LibraryStore { session.library }
    private var settings: AppSettings { session.settings }

    // MARK: Playback reports

    func handle(_ event: MediaEvent, tab: BrowserTab) {
        guard event.duration >= Self.minimumDuration else {
            // A short clip ended and the film may start next, so don't clear anything.
            return
        }

        // Silent video nobody asked for is a banner, however long it is. Sound, or a click
        // anywhere on the page, is what makes it someone watching.
        if event.muted, !event.userActivated { return }

        tab.media = MediaState(
            position: event.position,
            duration: event.duration,
            isPlaying: !event.paused && event.type != "ended",
            rate: event.rate
        )

        // Only the moment playback starts. Doing this on every tick makes two tabs fight forever.
        if event.type == "play", settings.pauseOtherTabs {
            session.browser.pauseOthers(than: tab)
        }

        let now = Date.now
        if let last = tab.lastPlaybackReport, !event.paused {
            // Real time passed, capped so that sleep or a stall doesn't count as watching.
            tab.playedSeconds += min(now.timeIntervalSince(last), 6)
        }
        tab.lastPlaybackReport = event.paused ? nil : now

        if let track = tab.track, let url = tab.url, track.urlKey != URLKey.make(url) {
            flush(tab: tab, event: event)
            tab.track = nil
            tab.playedSeconds = 0
        }

        if tab.track == nil, !event.paused, tab.playedSeconds >= settings.minimumSecondsToTrack {
            begin(tab: tab, event: event)
        }

        guard let track = tab.track else { return }
        session.frames.tick(event, tab: tab, track: track)

        let isFinished = event.type == "ended" || event.position / event.duration >= settings.finishThreshold
        if isFinished, !track.finishedAnnounced {
            markFinished(tab: tab, event: event)
        }

        let due = now.timeIntervalSince(track.lastFlush) >= Self.flushInterval
        if due || event.type == "pause" || event.type == "ended" {
            flush(tab: tab, event: event)
        }
        session.autopilot.tick(event, tab: tab, track: track)
    }

    /// Asked once per video, when its length becomes known: where should it start?
    func resumePosition(for event: MediaEvent, tab: BrowserTab) -> Double? {
        guard event.duration >= Self.minimumDuration else { return nil }

        if let explicit = tab.pendingResume {
            tab.pendingResume = nil
            let expected = tab.expectedResumeDuration
            tab.expectedResumeDuration = nil
            guard explicit > 1 else { return nil }
            // A very different length is another cut at best, and another film at worst.
            if let expected, abs(expected - event.duration) > max(180, expected * 0.1) {
                session.toasts.show(
                    "This video's length is different, so Cineon stayed at the start",
                    action: Toast.Action(title: "Jump to \(Timecode.string(explicit))") { [weak tab] in
                        tab?.seek(to: explicit)
                    }
                )
                return nil
            }
            return explicit
        }

        guard settings.autoResume, let url = tab.url else { return nil }
        let key = URLKey.make(url)

        var saved = try? session.db.progress(urlKey: key)
        if saved == nil, let parsed = tab.parsed,
           let title = library.find(name: parsed.name, altName: parsed.altName, year: parsed.year) {
            // Same film on a different site. Trust it only if the lengths roughly agree.
            if let elsewhere = try? session.db.progress(titleID: title.id, ref: parsed.ref),
               abs(elsewhere.duration - event.duration) < max(120, event.duration * 0.08) {
                saved = elsewhere
            }
        }
        guard let saved, saved.position >= 30, !saved.finished,
              saved.position < event.duration * 0.95, saved.position < event.duration - 60
        else { return nil }

        let position = saved.position
        session.toasts.show(
            "Resumed at \(Timecode.string(position))",
            action: Toast.Action(title: "Start over") { [weak tab] in
                tab?.seek(to: 0)
            }
        )
        return position
    }

    /// The page changed. Save what we had and get ready for whatever plays next.
    func tabNavigated(_ tab: BrowserTab) {
        session.autopilot.willLeave(tab: tab)
        tab.frameState = FrameState()
        if tab.track != nil {
            if let media = tab.media { writeFlush(tab: tab, position: media.position, duration: media.duration) }
            tab.track = nil
        }
        tab.media = nil
        tab.playedSeconds = 0
        tab.lastPlaybackReport = nil
    }

    // MARK: Sessions

    private func begin(tab: BrowserTab, event: MediaEvent) {
        guard let url = tab.url else { return }
        let key = URLKey.make(url)
        if (try? session.db.isIgnored(urlKey: key)) == true { return }
        if session.shields.prefs(for: url.host).trackingOff { return }

        let (titleID, ref, episodeName) = resolveTitle(tab: tab, urlKey: key, url: url)
        guard let titleID else { return }

        library.recordWatchStart(titleID: titleID)
        session.metadata.enrich(titleID: titleID, altName: tab.parsed?.altName)

        let now = Date.now
        let host = url.host ?? ""
        let row: WatchSession
        if let recent = try? session.db.latestSession(titleID: titleID, ref: ref, after: now.addingTimeInterval(-Self.mergeWindow)) {
            row = recent
        } else {
            row = library.saveSession(WatchSession(
                id: 0, titleID: titleID, ref: ref, episodeName: episodeName, url: url, host: host, startedAt: now,
                endedAt: now, watchedSeconds: 0, startPosition: event.position, endPosition: event.position,
                duration: event.duration, finished: false
            ))
        }
        // Seconds played before tracking started still count as watched.
        let alreadyPlayed = tab.playedSeconds
        tab.playedSeconds = 0
        tab.linkedTitleID = titleID
        tab.track = LiveTrack(
            titleID: titleID, ref: ref, urlKey: key, session: row, lastFlush: now,
            startedWith: row.watchedSeconds + alreadyPlayed, finishedAnnounced: false
        )
        writeFlush(tab: tab, position: event.position, duration: event.duration)
        if let track = tab.track { session.autopilot.trackBegan(tab: tab, track: track) }
    }

    private func resolveTitle(tab: BrowserTab, urlKey: String, url: URL) -> (Int64?, EpisodeRef, String?) {
        // A correction made by hand always wins.
        if let link = try? session.db.link(urlKey: urlKey), library.titles[link.titleID] != nil {
            return (link.titleID, link.ref, nil)
        }

        var parsed = tab.parsed
        if parsed == nil, let meta = tab.pageMeta { parsed = TitleParser.parse(meta) }
        if parsed == nil {
            var meta = PageMeta()
            meta.url = url.absoluteString
            meta.title = tab.title
            parsed = TitleParser.parse(meta)
        }
        guard let parsed else { return (nil, .none, nil) }
        tab.parsed = parsed

        if let existing = library.find(name: parsed.name, altName: parsed.altName, year: parsed.year) {
            return (existing.id, parsed.ref, parsed.episodeName)
        }
        let created = library.addTitle(
            name: parsed.name, year: parsed.year, kind: parsed.kindHint, status: .watching,
            posterURL: parsed.posterURL, overview: parsed.overview
        )
        return (created?.id, parsed.ref, parsed.episodeName)
    }

    private func flush(tab: BrowserTab, event: MediaEvent) {
        writeFlush(tab: tab, position: event.position, duration: event.duration)
    }

    private func writeFlush(tab: BrowserTab, position: Double, duration: Double) {
        guard var track = tab.track else { return }
        // A background lookup may have merged this title into one already in the library.
        guard let currentID = library.currentID(track.titleID) else {
            tab.track = nil
            return
        }
        track.titleID = currentID
        track.session.titleID = currentID
        tab.linkedTitleID = currentID
        let now = Date.now
        track.session.endedAt = now
        track.session.watchedSeconds = track.startedWith + tab.playedSeconds
        track.session.endPosition = position
        track.session.duration = duration
        track.session.url = tab.url ?? track.session.url
        track.session.host = tab.url?.host ?? track.session.host
        track.session.finished = track.session.finished || track.finishedAnnounced
        track.session = library.saveSession(track.session)
        track.lastFlush = now
        tab.track = track

        library.saveProgress(WatchProgress(
            titleID: track.titleID, ref: track.ref, urlKey: track.urlKey, url: tab.url, host: tab.url?.host ?? "",
            position: position, duration: duration, finished: track.finishedAnnounced, updatedAt: now
        ))
    }

    private func markFinished(tab: BrowserTab, event: MediaEvent) {
        guard var track = tab.track, let title = library.titles[track.titleID] else { return }
        track.finishedAnnounced = true
        tab.track = track
        flush(tab: tab, event: event)

        if track.ref.isEpisode {
            session.toasts.show("Finished season \(track.ref.season), episode \(track.ref.episode) of \(title.name)")
        } else {
            library.setStatus(title.id, .watched)
            session.toasts.show("Finished \(title.name). Moved to Watched.")
        }
    }

    // MARK: Corrections

    /// "This page is actually that film." Remembered for this address, and moves any records.
    func relink(tab: BrowserTab, to titleID: Int64, ref: EpisodeRef) {
        guard let url = tab.url else { return }
        let key = URLKey.make(url)
        try? session.db.setLink(urlKey: key, titleID: titleID, ref: ref)
        if let track = tab.track, track.titleID != titleID {
            let old = track.titleID
            let hasOtherRecords = (library.sessions(titleID: old).count > 1)
            if hasOtherRecords {
                tabNavigated(tab)
            } else {
                library.merge(from: old, into: titleID)
                tab.track = nil
            }
        }
        tab.linkedTitleID = titleID
        tab.playedSeconds = max(tab.playedSeconds, settings.minimumSecondsToTrack)
    }

    /// "Nothing on this site is a film." Removes the current entry, and stops tracking the site.
    func stopTrackingSite(tab: BrowserTab) {
        ignore(tab: tab)
        session.shields.update(host: tab.url?.host) { $0.trackingOff = true }
    }

    /// "This isn't a film." Stops tracking this page for good.
    func ignore(tab: BrowserTab) {
        guard let url = tab.url else { return }
        try? session.db.ignore(urlKey: URLKey.make(url))
        if let track = tab.track {
            let sessions = library.sessions(titleID: track.titleID)
            if sessions.count <= 1, let title = library.titles[track.titleID], title.status == .watching,
               library.progressList(titleID: title.id).count <= 1 {
                library.delete(title.id)
            } else {
                library.deleteSession(track.session.id)
            }
        }
        tab.track = nil
        tab.linkedTitleID = nil
        tab.playedSeconds = 0
    }
}
