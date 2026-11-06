import Foundation

/// The episode after this one, and how to get there.
struct NextEpisodeTarget {
    var ref: EpisodeRef
    var name: String?
    /// In the page's own episode list, which is better than reloading when it's there.
    var isOnPage: Bool
    var isNextInSeason: Bool
    var url: URL?
}

/// What the autopilot knows about the video in one tab. Starts over on every page.
struct AutopilotState {
    var rules: [SkipRule] = []
    var jump: SkipLearner.Jump?
    var proposedIntro: (from: Double, to: Double)?
    var didAskAboutIntro = false
    var lastSkip: (from: Double, to: Double)?

    var target: NextEpisodeTarget?
    var isResolving = false
    var isResolved = false
    var didOffer = false
    var isCountingDown = false
    var isDeclined = false
    var didMove = false
    /// A sleep timer is waiting for this episode to end, so nothing should start after it.
    var isHeldForSleep = false
}

/// Where someone left an episode, to spot them skipping its credits.
struct EpisodeExit {
    var titleID: Int64
    var ref: EpisodeRef
    var remaining: Double
    var duration: Double
    var at: Date
}

/// Skips what you skip and moves on to the next episode. Everything here is a guess from watching
/// someone's habits, so every action can be undone or turned down right where it happens.
final class EpisodeAutopilot {
    private unowned let session: ProfileSession

    init(session: ProfileSession) {
        self.session = session
    }

    private var settings: AppSettings { session.settings }
    private var library: LibraryStore { session.library }

    // MARK: Rules

    private func loadRules(titleID: Int64, tab: BrowserTab) {
        guard let host = tab.url?.host else { return }
        tab.autopilot.rules = (try? session.db.skipRules(titleID: titleID, site: SkipLearner.siteKey(host))) ?? []
    }

    private func introSkips(in tab: BrowserTab) -> [[String: Any]] {
        guard settings.learnSkips else { return [] }
        return tab.autopilot.rules.filter { $0.kind == .intro }.map {
            ["kind": $0.kind.rawValue, "from": $0.start, "to": $0.end]
        }
    }

    private func pushSkips(to tab: BrowserTab) {
        guard let data = try? JSONSerialization.data(withJSONObject: introSkips(in: tab)),
              let json = String(data: data, encoding: .utf8)
        else { return }
        tab.playerCommand("setSkips(\(json))")
    }

    /// Asked as soon as a video's length is known, which can be before tracking begins, so that
    /// an intro in the first seconds is still caught.
    func skips(for event: MediaEvent, tab: BrowserTab) -> [[String: Any]]? {
        guard let parsed = tab.parsed, parsed.ref.isEpisode,
              let title = library.find(name: parsed.name, altName: parsed.altName, year: parsed.year)
        else { return nil }
        loadRules(titleID: title.id, tab: tab)
        let skips = introSkips(in: tab)
        return skips.isEmpty ? nil : skips
    }

    // MARK: Following playback

    func trackBegan(tab: BrowserTab, track: LiveTrack) {
        if settings.learnSkips, let exit = tab.lastEpisodeExit, exit.titleID == track.titleID, exit.ref != track.ref,
           Date.now.timeIntervalSince(exit.at) < 180 {
            noteCredits(remaining: exit.remaining, duration: exit.duration, titleID: track.titleID, tab: tab)
        }
        tab.lastEpisodeExit = nil
        loadRules(titleID: track.titleID, tab: tab)
        pushSkips(to: tab)
    }

    func tick(_ event: MediaEvent, tab: BrowserTab, track: LiveTrack) {
        settleJump(tab: tab, track: track)
        guard track.ref.isEpisode, settings.autoNextEpisode, !tab.autopilot.isDeclined, !tab.autopilot.didMove else { return }

        let ended = event.type == "ended"
        // Pausing during the countdown means they're not ready to move on. A video that reaches
        // its end also reports a pause, which is why it has to be away from the end to count.
        if event.type == "pause", tab.autopilot.isCountingDown, event.duration - event.position > 1 {
            tab.autopilot.isCountingDown = false
            tab.playerCommand("clearBanner('next')")
            return
        }
        if event.paused, !ended { return }
        let remaining = event.duration - event.position
        let credits = tab.autopilot.rules.first { $0.kind == .credits }
        let reachedCredits = credits.map { remaining <= $0.start } ?? false
        let nearEnd = event.position / event.duration >= settings.finishThreshold
        guard ended || reachedCredits || nearEnd else { return }

        // Moving on by itself takes more certainty than offering to: the episode is really over,
        // or two earlier episodes agreed on where the credits start.
        let isSure = ended || (reachedCredits && (credits?.sightings ?? 0) >= 2)
        offerNext(tab: tab, track: track, countdown: isSure)
    }

    /// Called before a page's records are saved and cleared.
    func willLeave(tab: BrowserTab) {
        if let track = tab.track, track.ref.isEpisode, let media = tab.media, !tab.autopilot.didMove {
            tab.lastEpisodeExit = EpisodeExit(
                titleID: track.titleID, ref: track.ref, remaining: media.duration - media.position,
                duration: media.duration, at: .now
            )
        }
        tab.autopilot = AutopilotState()
    }

    // MARK: Learning intros

    func handleJump(_ body: Any, tab: BrowserTab) {
        guard settings.learnSkips, let dict = body as? [String: Any],
              let from = (dict["from"] as? NSNumber)?.doubleValue, let to = (dict["to"] as? NSNumber)?.doubleValue
        else { return }
        let now = Date.now
        if let extended = tab.autopilot.jump?.extended(from: from, to: to, at: now) {
            tab.autopilot.jump = extended
        } else {
            tab.autopilot.jump = to > from ? SkipLearner.Jump(from: from, to: to, lastAt: now) : nil
        }
    }

    /// Waits for the jumping to stop before deciding what it was.
    private func settleJump(tab: BrowserTab, track: LiveTrack) {
        guard let jump = tab.autopilot.jump, Date.now.timeIntervalSince(jump.lastAt) > SkipLearner.mergeWindow else { return }
        tab.autopilot.jump = nil
        guard track.ref.isEpisode, let duration = tab.media?.duration,
              SkipLearner.isIntro(from: jump.from, to: jump.to, duration: duration),
              let title = library.titles[track.titleID]
        else { return }

        if var known = tab.autopilot.rules.first(where: { $0.kind == .intro }),
           abs(known.start - jump.from) <= 20, abs(known.end - jump.to) <= 20 {
            known.sightings += 1
            known.updatedAt = .now
            try? session.db.saveSkipRule(known)
            return
        }
        guard !tab.autopilot.didAskAboutIntro else { return }
        tab.autopilot.didAskAboutIntro = true
        tab.autopilot.proposedIntro = (jump.from, jump.to)
        tab.showBanner(
            id: "intro",
            text: "Skip \(Timecode.string(jump.from)) to \(Timecode.string(jump.to)) in every episode of \(title.name)?",
            actions: [("always", "Always skip", true), ("no", "No", false)],
            timeout: 12
        )
    }

    private func saveIntro(from: Double, to: Double, tab: BrowserTab) {
        guard let track = tab.track, let host = tab.url?.host else { return }
        let rule = SkipRule(
            id: 0, titleID: track.titleID, site: SkipLearner.siteKey(host), kind: .intro, start: from, end: to,
            sightings: 1, misses: 0, updatedAt: .now
        )
        try? session.db.saveSkipRule(rule)
        loadRules(titleID: track.titleID, tab: tab)
        pushSkips(to: tab)
        tab.showBanner(id: "saved", text: "Cineon will skip this from now on", timeout: 3)
    }

    /// Each episode you leave early with the same time left adds confidence about the credits.
    private func noteCredits(remaining: Double, duration: Double, titleID: Int64, tab: BrowserTab) {
        guard SkipLearner.isCredits(remaining: remaining, duration: duration), let host = tab.url?.host else { return }
        let site = SkipLearner.siteKey(host)
        let existing = (try? session.db.skipRules(titleID: titleID, site: site))?.first { $0.kind == .credits }
        var rule = existing ?? SkipRule(
            id: 0, titleID: titleID, site: site, kind: .credits, start: remaining, end: 0, sightings: 0, misses: 0, updatedAt: .now
        )
        if SkipLearner.agree(rule.start, remaining) {
            rule.sightings += 1
            // Never earlier than the shortest time seen, so an ending isn't cut off.
            rule.start = min(rule.start, remaining)
        } else {
            rule.sightings = 1
            rule.start = remaining
        }
        rule.updatedAt = .now
        try? session.db.saveSkipRule(rule)
    }

    // MARK: What the player reports

    func handleSkipped(_ body: Any, tab: BrowserTab) {
        guard let dict = body as? [String: Any],
              let from = (dict["from"] as? NSNumber)?.doubleValue, let to = (dict["to"] as? NSNumber)?.doubleValue
        else { return }
        tab.autopilot.lastSkip = (from, to)
        tab.showBanner(id: "skipped", text: "Skipped intro", actions: [("undo", "Undo", false)], timeout: 6)
    }

    func handleBanner(_ body: Any, tab: BrowserTab) {
        guard let dict = body as? [String: Any], let banner = dict["banner"] as? String, let action = dict["action"] as? String else { return }
        switch (banner, action) {
        case ("intro", "always"):
            if let proposed = tab.autopilot.proposedIntro { saveIntro(from: proposed.from, to: proposed.to, tab: tab) }
        case ("skipped", "undo"):
            undoSkip(tab: tab)
        case ("next", "play"):
            playNext(tab: tab, byHand: true)
        case ("next", "auto"):
            playNext(tab: tab, byHand: false)
        case ("next", "no"):
            tab.autopilot.isDeclined = true
            tab.autopilot.isCountingDown = false
        case ("rescue", "find"):
            tab.playerCommand("exitFullscreen()")
            session.rescue.findElsewhere(tab: tab)
        default:
            break
        }
    }

    private func undoSkip(tab: BrowserTab) {
        guard let last = tab.autopilot.lastSkip else { return }
        tab.seek(to: last.from)
        guard var rule = tab.autopilot.rules.first(where: { $0.kind == .intro }) else { return }
        rule.misses += 1
        if rule.misses >= 2 {
            try? session.db.deleteSkipRule(rule.id)
            tab.autopilot.rules.removeAll { $0.id == rule.id }
            pushSkips(to: tab)
            tab.showBanner(id: "saved", text: "Cineon won't skip this any more", timeout: 3)
        } else {
            rule.updatedAt = .now
            try? session.db.saveSkipRule(rule)
        }
    }

    // MARK: Next episode

    private func offerNext(tab: BrowserTab, track: LiveTrack, countdown: Bool) {
        guard !tab.autopilot.isHeldForSleep else { return }
        guard !tab.autopilot.isCountingDown, countdown || !tab.autopilot.didOffer else { return }
        guard tab.autopilot.isResolved else {
            guard !tab.autopilot.isResolving else { return }
            tab.autopilot.isResolving = true
            Task { [weak self, weak tab] in
                guard let self, let tab else { return }
                let target = await self.findNext(tab: tab, track: track)
                // The person may have moved on while this was being worked out.
                guard tab.track?.urlKey == track.urlKey || tab.media != nil else { return }
                tab.autopilot.target = target
                tab.autopilot.isResolved = true
                tab.autopilot.isResolving = false
                if !tab.autopilot.isDeclined, !tab.autopilot.didMove {
                    self.offerNext(tab: tab, track: track, countdown: countdown)
                }
            }
            return
        }
        guard let target = tab.autopilot.target else { return }
        tab.autopilot.didOffer = true
        tab.autopilot.isCountingDown = countdown
        let name = target.name.map { ", \($0)" } ?? ""
        tab.showBanner(
            id: "next",
            text: "Next: \(target.ref.shortLabel)\(name)",
            actions: [("play", "Play now", true), ("no", "Not now", false)],
            seconds: countdown ? 10 : nil,
            onExpire: countdown ? "auto" : nil,
            timeout: countdown ? nil : 14
        )
    }

    private func findNext(tab: BrowserTab, track: LiveTrack) async -> NextEpisodeTarget? {
        let episodes: [EpisodeInfo]
        if let title = library.titles[track.titleID] {
            episodes = await session.metadata.episodes(for: title)
        } else {
            episodes = []
        }
        for ref in NextEpisode.candidates(after: track.ref, episodes: episodes) {
            let isNextInSeason = ref.season == track.ref.season && ref.episode == track.ref.episode + 1
            let name = episodes.first { $0.season == ref.season && $0.episode == ref.episode }?.name
            let onPage = await tab.evaluateInPage(
                "window.__cineon ? __cineon.hasEpisode(\(ref.season),\(ref.episode),\(isNextInSeason)) : false"
            ) as? Bool ?? false
            let address = tab.url.flatMap { EpisodeLinks.url(from: $0, current: track.ref, target: ref) }
            if onPage {
                return NextEpisodeTarget(ref: ref, name: name, isOnPage: true, isNextInSeason: isNextInSeason, url: address)
            }
            guard let address else { continue }
            if case .alive = await SiteProbe.check(address) {
                return NextEpisodeTarget(ref: ref, name: name, isOnPage: false, isNextInSeason: isNextInSeason, url: address)
            }
        }
        return nil
    }

    /// The next episode now, from a media key, Siri or the menu.
    func skipToNext(tab: BrowserTab) {
        guard let track = tab.track else {
            session.toasts.show("Cineon doesn't know which episode this is")
            return
        }
        if tab.autopilot.isResolved {
            if tab.autopilot.target == nil { session.toasts.show("This looks like the last episode") }
            playNext(tab: tab, byHand: true)
            return
        }
        Task { [weak self, weak tab] in
            guard let self, let tab else { return }
            let target = await self.findNext(tab: tab, track: track)
            tab.autopilot.target = target
            tab.autopilot.isResolved = true
            if target == nil { self.session.toasts.show("This looks like the last episode") }
            self.playNext(tab: tab, byHand: true)
        }
    }

    private func playNext(tab: BrowserTab, byHand: Bool) {
        if !byHand, tab.autopilot.isHeldForSleep { return }
        guard let target = tab.autopilot.target else { return }
        tab.autopilot.didMove = true
        if byHand, settings.learnSkips, let track = tab.track, let media = tab.media {
            noteCredits(remaining: media.duration - media.position, duration: media.duration, titleID: track.titleID, tab: tab)
        }
        Task { [weak tab] in
            guard let tab else { return }
            if target.isOnPage {
                let opened = await tab.evaluateInPage(
                    "__cineon.openEpisode(\(target.ref.season),\(target.ref.episode),\(target.isNextInSeason))"
                ) as? Bool ?? false
                if opened { return }
            }
            guard let url = target.url else { return }
            // Changing only the fragment doesn't reload a page, and these sites read it on load.
            let onlyFragmentChanges = tab.webView?.url?.withoutFragment == url.withoutFragment
            tab.loadToKeepWatching(url)
            if onlyFragmentChanges { tab.webView?.reload() }
        }
    }
}

extension URL {
    fileprivate var withoutFragment: String {
        var parts = URLComponents(url: self, resolvingAgainstBaseURL: false)
        parts?.fragment = nil
        return parts?.string ?? absoluteString
    }
}
