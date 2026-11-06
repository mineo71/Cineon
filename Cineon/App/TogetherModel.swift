import AppKit
import Foundation
import Observation

/// Watching with friends: share codes for lists, watch parties that follow the host, and races
/// to the end of a series. Nothing goes to the server until someone starts or joins something.
@Observable
final class TogetherModel {
    private(set) var party: PartyState?
    private(set) var isHost = false
    private(set) var challenges: [ChallengeSummary] = []
    private(set) var details: [String: ChallengeState] = [:]
    private(set) var openedShares: [ShareInfo] = []
    private(set) var lastShareCode: String?
    private(set) var isWorking = false
    private(set) var personID: String?

    @ObservationIgnored private unowned let session: ProfileSession
    @ObservationIgnored private let client: TogetherClient?
    @ObservationIgnored private var identity: TogetherIdentity
    @ObservationIgnored private var partyTimer: Timer?
    @ObservationIgnored private var challengeTimer: Timer?
    @ObservationIgnored private var partyTabID: UUID?
    @ObservationIgnored private var lastSent: (position: Double, playing: Bool, rate: Double, at: Date)?
    @ObservationIgnored private var lastCorrection = Date.distantPast
    @ObservationIgnored private var lastPoll = Date.distantPast
    @ObservationIgnored private var lastHeartbeat = Date.distantPast
    @ObservationIgnored private var isTicking = false
    @ObservationIgnored private var seenReactions = Set<String>()
    @ObservationIgnored private var seenMessages = Set<String>()
    /// Milliseconds since 1970 when this person got into the party.
    @ObservationIgnored private var joinedAt: Double = 0
    @ObservationIgnored private var reported: [String: String] = [:]
    @ObservationIgnored private var knownWinners: [String: String?] = [:]
    @ObservationIgnored private var lastChallengeRefresh = Date.distantPast
    @ObservationIgnored private var askedToPressPlay = false

    init(session: ProfileSession) {
        self.session = session
        client = TogetherClient.configured
        identity = TogetherIdentity.load(profile: session.profile)
        personID = identity.personId
        // A party doesn't survive a restart: the film and everyone's place in it have moved on.
        if identity.partyCode != nil {
            identity.partyCode = nil
            identity.save(profile: session.profile.id)
        }
    }

    var isAvailable: Bool { client != nil }
    var myName: String { session.profile.name }

    func start() {
        guard client != nil else { return }
        challengeTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.challengeTick() }
        }
        guard identity.personId != nil else { return }
        Task {
            await refreshChallenges()
            for code in identity.openedShares { await loadShare(code, remember: false) }
        }
    }

    func stop() {
        challengeTimer?.invalidate()
        challengeTimer = nil
        if party != nil { leaveParty() }
    }

    // MARK: Identity

    private func register() async throws -> TogetherClient {
        guard let client else { throw TogetherError(message: "Together isn't set up in this build") }
        let pet = session.settings.sharePet ? session.pet.code : nil
        if identity.personId == nil || identity.name != myName || identity.pet != pet {
            var args: [String: Any] = ["deviceSecret": identity.secret, "name": myName]
            // An empty code takes the pet off, where leaving it out would keep the old one.
            args["pet"] = pet ?? ""
            let reply: Registered = try await client.mutation("people:register", args)
            identity.personId = reply.personId
            identity.name = myName
            identity.pet = pet
            personID = reply.personId
            identity.save(profile: session.profile.id)
        }
        return client
    }

    /// The server and this profile's secret, registering first if needed. For the cloud backup.
    func authorized() async throws -> (client: TogetherClient, secret: String) {
        let client = try await register()
        return (client, identity.secret)
    }

    /// Lets this profile be found again from another one, or after starting over.
    var recoveryCode: String { identity.secret }

    /// Takes over the identity a recovery code belongs to: its ratings, lists and challenges.
    func adopt(recoveryCode raw: String) async -> Bool {
        let code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard code.count >= 32, code != identity.secret, Data(base64Encoded: code) != nil else { return false }
        identity.secret = code
        identity.personId = nil
        identity.pet = nil
        identity.save(profile: session.profile.id)
        personID = nil
        do { _ = try await register() } catch { return false }
        await refreshChallenges()
        return true
    }

    /// Sends a changed pet or name to friends' screens.
    func refreshIdentity() {
        guard identity.personId != nil else { return }
        Task { _ = try? await register() }
    }

    private func perform(_ action: String, _ work: @escaping () async throws -> Void) {
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                try await work()
            } catch {
                session.toasts.show("Couldn't \(action): \(error.localizedDescription)")
            }
        }
    }

    // MARK: Codes

    /// Opens whatever a friend's code points to: a list, a party or a challenge.
    func enter(code raw: String) {
        let code = ShareCode.normalize(raw)
        guard code.count == 6 else {
            session.toasts.show("Codes have six letters and digits, like K7Q-2MX")
            return
        }
        perform("open that code") { [self] in
            let client = try await register()
            guard let found: CodeKind? = try await client.query("codes:resolve", ["code": code]), let found else {
                throw TogetherError(message: "No party, list or challenge has that code")
            }
            switch found.kind {
            case "share": await loadShare(code, remember: true)
            case "party": try await joinParty(code)
            case "challenge": try await joinChallenge(code)
            default: throw TogetherError(message: "Cineon doesn't know that kind of code yet")
            }
        }
    }

    private func copy(_ code: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(ShareCode.display(code), forType: .string)
    }

    // MARK: Sharing lists

    func shareWatched() {
        let titles = session.library.watched.prefix(500).map(TitleCard.init)
        guard !titles.isEmpty else {
            session.toasts.show("Nothing in Watched to share yet")
            return
        }
        share(label: "\(myName)'s watched films", titles: Array(titles))
    }

    func share(title: Title) {
        share(label: title.name, titles: [TitleCard(title)])
    }

    private func share(label: String, titles: [TitleCard]) {
        perform("share") { [self] in
            let client = try await register()
            let reply: CodeReply = try await client.mutation("shares:create", [
                "deviceSecret": identity.secret, "label": label, "titles": titles.map(\.json),
            ])
            lastShareCode = reply.code
            copy(reply.code)
            session.toasts.show("Code \(ShareCode.display(reply.code)) copied. Send it to a friend.")
        }
    }

    private func loadShare(_ code: String, remember: Bool) async {
        guard let client else { return }
        guard let share = try? await client.query("shares:get", ["code": code], as: ShareInfo?.self) else {
            if remember { session.toasts.show("That list is gone") }
            return
        }
        openedShares.removeAll { $0.code == share.code }
        openedShares.insert(share, at: 0)
        if remember {
            identity.openedShares.removeAll { $0 == share.code }
            identity.openedShares.insert(share.code, at: 0)
            identity.openedShares = Array(identity.openedShares.prefix(20))
            identity.save(profile: session.profile.id)
            session.app?.go(.together)
        }
    }

    func forgetShare(_ code: String) {
        openedShares.removeAll { $0.code == code }
        identity.openedShares.removeAll { $0 == code }
        identity.save(profile: session.profile.id)
    }

    /// Adds a friend's film to the backlog, filling in its poster and details.
    func addToBacklog(_ card: TitleCard) {
        let library = session.library
        if let existing = card.imdbId.flatMap({ id in library.titles.values.first { $0.imdbID == id } })
            ?? library.find(name: card.name, year: card.year) {
            if existing.status == .none { library.setStatus(existing.id, .backlog) }
            session.toasts.show("\(existing.name) is already in your \(library.titles[existing.id]?.status.label.lowercased() ?? "library")")
            return
        }
        guard let added = library.addTitle(
            name: card.name, year: card.year, kind: card.titleKind, status: .backlog, imdbID: card.imdbId, posterURL: card.posterURL
        ) else { return }
        if let id = card.imdbId {
            session.metadata.apply(hit: MetadataHit(id: id, name: card.name, year: card.year, kind: card.titleKind, posterURL: card.posterURL), to: added.id)
        } else {
            session.metadata.enrich(titleID: added.id)
        }
        session.toasts.show("Added \(card.name) to backlog")
    }

    func hasInLibrary(_ card: TitleCard) -> Bool {
        let library = session.library
        if let id = card.imdbId, library.titles.values.contains(where: { $0.imdbID == id && $0.status != .none }) { return true }
        return library.find(name: card.name, year: card.year).map { $0.status != .none } ?? false
    }

    // MARK: Watch party

    /// Starts a party from the film playing in the current tab.
    func startParty() {
        guard let tab = session.browser.selected, let url = tab.url, let media = tab.media, media.duration >= WatchTracker.minimumDuration else {
            session.toasts.show("Start the film first, then invite people to it")
            return
        }
        let card = tab.linkedTitleID.flatMap { session.library.titles[$0] }.map(TitleCard.init)
            ?? tab.parsed.map { TitleCard(name: $0.name, year: $0.year, kind: $0.kindHint.rawValue) }
        perform("start the party") { [self] in
            let client = try await register()
            var args: [String: Any] = [
                "deviceSecret": identity.secret, "pageUrl": url.absoluteString, "position": media.position,
                "playing": media.isPlaying, "rate": media.rate,
            ]
            if let card { args["title"] = card.json }
            let reply: CodeReply = try await client.mutation("parties:create", args)
            partyTabID = tab.id
            isHost = true
            lastSent = (media.position, media.isPlaying, media.rate, .now)
            identity.partyCode = reply.code
            identity.save(profile: session.profile.id)
            party = try await client.query("parties:get", partyQuery(reply.code))
            joinedAt = party?.now ?? Date.now.timeIntervalSince1970 * 1000
            copy(reply.code)
            session.toasts.show("Party \(ShareCode.display(reply.code)) started. The code is copied.")
            startPartyLoop()
        }
    }

    private func joinParty(_ code: String) async throws {
        let client = try await register()
        if party != nil { leaveParty() }
        let state: PartyState = try await client.mutation("parties:join", ["deviceSecret": identity.secret, "code": code])
        party = state
        joinedAt = state.now
        isHost = state.hostId == identity.personId
        identity.partyCode = code
        identity.save(profile: session.profile.id)
        askedToPressPlay = false
        if let url = URL(string: state.pageUrl) {
            let tab = session.browser.openTab(url: url, select: true)
            partyTabID = tab.id
            session.app?.go(.web)
        }
        session.toasts.show("Joined \(state.hostName)'s party")
        startPartyLoop()
    }

    func leaveParty() {
        guard let code = party?.code ?? identity.partyCode else { return }
        partyTimer?.invalidate()
        partyTimer = nil
        party = nil
        isHost = false
        partyTabID = nil
        lastSent = nil
        identity.partyCode = nil
        identity.save(profile: session.profile.id)
        guard let client else { return }
        let secret = identity.secret
        Task { _ = try? await client.mutation("parties:leave", ["deviceSecret": secret, "code": code], as: NullReply.self) }
    }

    /// A line of chat to everyone in the party.
    func say(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, let code = party?.code, !text.isEmpty else { return }
        let secret = identity.secret
        Task {
            do {
                _ = try await client.mutation("parties:say", ["deviceSecret": secret, "code": code, "text": String(text.prefix(280))], as: NullReply.self)
                lastPoll = .distantPast
            } catch {
                session.toasts.show("Couldn't send that: \(error.localizedDescription)")
            }
        }
    }

    func react(_ emoji: String) {
        guard let client, let code = party?.code else { return }
        let secret = identity.secret
        Task { _ = try? await client.mutation("parties:react", ["deviceSecret": secret, "code": code, "emoji": emoji], as: NullReply.self) }
    }

    func copyPartyCode() {
        guard let code = party?.code else { return }
        copy(code)
        session.toasts.show("Code \(ShareCode.display(code)) copied")
    }

    /// A fresh `t` each time, or the server answers from its cache with a stale clock.
    private func partyQuery(_ code: String) -> [String: Any] {
        ["code": code, "t": Date.now.timeIntervalSince1970 * 1000]
    }

    private var partyTab: BrowserTab? {
        session.browser.tabs.first { $0.id == partyTabID }
    }

    private func startPartyLoop() {
        partyTimer?.invalidate()
        partyTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.partyTick() }
        }
    }

    private func partyTick() {
        guard !isTicking, let client, let code = party?.code else { return }
        isTicking = true
        Task {
            defer { isTicking = false }
            if isHost { await sendHostState(client, code: code) }
            // Members follow every second. The host only needs to see who's there and reactions.
            if !isHost || Date.now.timeIntervalSince(lastPoll) > 2.5 {
                lastPoll = .now
                // A dropped connection is just a missed second. Only the server saying so ends the party.
                let fetched: PartyState?
                do {
                    fetched = try await client.query("parties:get", partyQuery(code))
                } catch {
                    return
                }
                guard let state = fetched, !state.ended else {
                    if !isHost { session.toasts.show("The party is over") }
                    leaveParty()
                    return
                }
                party = state
                showNewReactions(state)
                showNewMessages(state)
                if !isHost { await follow(state) }
            }
            // Members only ever read, so without this they'd drop off everyone's list after 30 s.
            if Date.now.timeIntervalSince(lastHeartbeat) > 5 {
                lastHeartbeat = .now
                _ = try? await client.mutation("parties:heartbeat", ["deviceSecret": identity.secret, "code": code], as: NullReply.self)
            }
        }
    }

    /// The player's own clock, which is fresher than the reports it sends every few seconds.
    private func playerState(_ tab: BrowserTab) async -> (position: Double, playing: Bool, rate: Double)? {
        guard let state = await tab.evaluateInPlayer("window.__cineon ? __cineon.state() : null") as? [String: Any],
              let position = (state["t"] as? NSNumber)?.doubleValue
        else { return nil }
        let paused = (state["paused"] as? NSNumber)?.boolValue ?? true
        return (position, !paused, (state["rate"] as? NSNumber)?.doubleValue ?? 1)
    }

    private func sendHostState(_ client: TogetherClient, code: String) async {
        guard let tab = partyTab, let now = await playerState(tab) else { return }
        let expected = lastSent.map { last in
            last.playing ? last.position + Date.now.timeIntervalSince(last.at) * last.rate : last.position
        } ?? -100
        let changed = lastSent?.playing != now.playing || lastSent?.rate != now.rate || abs(expected - now.position) > 1.5
        let due = Date.now.timeIntervalSince(lastSent?.at ?? .distantPast) > 4
        guard changed || due else { return }
        lastSent = (now.position, now.playing, now.rate, .now)
        var args: [String: Any] = [
            "deviceSecret": identity.secret, "code": code, "position": now.position, "playing": now.playing, "rate": now.rate,
        ]
        if let url = tab.url?.absoluteString, url != party?.pageUrl { args["pageUrl"] = url }
        _ = try? await client.mutation("parties:update", args, as: NullReply.self)
    }

    /// Keeps a member's player with the host's: same page, same second, playing or paused.
    private func follow(_ state: PartyState) async {
        guard let tab = partyTab else {
            if let url = URL(string: state.pageUrl) {
                partyTabID = session.browser.openTab(url: url, select: false).id
            }
            return
        }
        if let target = URL(string: state.pageUrl), let current = tab.url, URLKey.make(target) != URLKey.make(current) {
            tab.load(target)
            return
        }
        guard let mine = await playerState(tab) else { return }
        if abs(mine.rate - state.rate) > 0.01 { tab.setRate(state.rate) }
        if state.playing != mine.playing {
            if state.playing {
                tab.playerCommand("play()")
                // A page may only start sound after a click. Ask once.
                if !askedToPressPlay {
                    askedToPressPlay = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self, weak tab] in
                        guard let self, let tab, self.party?.playing == true, tab.media?.isPlaying != true else { return }
                        tab.showBanner(id: "party", text: "\(state.hostName) is playing. Press play to join in.", timeout: 6)
                    }
                }
            } else {
                tab.pausePlayback()
            }
        }
        // Don't chase small drifts, and give a jump time to land before judging it.
        let target = state.expectedPosition
        if abs(mine.position - target) > 2.5, Date.now.timeIntervalSince(lastCorrection) > 3 {
            lastCorrection = .now
            tab.seek(to: target)
        }
    }

    private func showNewMessages(_ state: PartyState) {
        for message in state.messages {
            guard seenMessages.insert(message.id).inserted else { continue }
            // Messages from before joining are history, not news.
            guard message.personId != personID, message.at >= joinedAt else { continue }
            let text = "\(message.name): \(message.text)"
            if let tab = partyTab, session.app?.route == .web {
                tab.showBanner(id: "chat", text: text, timeout: 5)
            } else if session.app?.route != .together {
                session.toasts.show(text)
            }
        }
    }

    private func showNewReactions(_ state: PartyState) {
        for reaction in state.reactions {
            let key = "\(reaction.name)|\(reaction.emoji)|\(reaction.at)"
            guard seenReactions.insert(key).inserted, reaction.name != myName else { continue }
            let text = "\(reaction.name) \(reaction.emoji)"
            if let tab = partyTab, session.app?.route == .web {
                tab.showBanner(id: "reaction", text: text, timeout: 3)
            } else {
                session.toasts.show(text)
            }
        }
    }

    // MARK: Challenges

    /// "First to finish": everyone who joins shows with how far they've got.
    func createChallenge(for title: Title) {
        perform("start the challenge") { [self] in
            let client = try await register()
            var total = 1
            if title.kind == .series || title.kind == .cartoon {
                let episodes = await session.metadata.episodes(for: title).filter { $0.season > 0 }
                total = max(1, episodes.count)
            }
            let reply: CodeReply = try await client.mutation("challenges:create", [
                "deviceSecret": identity.secret, "title": TitleCard(title).json, "totalEpisodes": total,
            ])
            copy(reply.code)
            session.toasts.show("Challenge \(ShareCode.display(reply.code)) started. The code is copied.")
            reported[reply.code] = nil
            await refreshChallenges()
            session.app?.go(.together)
        }
    }

    private func joinChallenge(_ code: String) async throws {
        let client = try await register()
        let state: ChallengeState = try await client.mutation("challenges:join", ["deviceSecret": identity.secret, "code": code])
        details[code] = state
        if !hasInLibrary(state.title) { addToBacklog(state.title) }
        session.toasts.show("You're in: first to finish \(state.title.name)")
        await refreshChallenges()
        session.app?.go(.together)
    }

    func leaveChallenge(_ code: String) {
        perform("leave the challenge") { [self] in
            let client = try await register()
            _ = try await client.mutation("challenges:leave", ["deviceSecret": identity.secret, "code": code], as: NullReply.self)
            challenges.removeAll { $0.code == code }
            details[code] = nil
        }
    }

    func copyChallengeCode(_ code: String) {
        copy(code)
        session.toasts.show("Code \(ShareCode.display(code)) copied")
    }

    private func challengeTick() {
        guard identity.personId != nil else { return }
        // Every few seconds while you're looking, once a minute otherwise.
        let looking = session.app?.route == .together
        guard looking || Date.now.timeIntervalSince(lastChallengeRefresh) > 60 else { return }
        Task { await refreshChallenges() }
    }

    func refreshChallenges() async {
        guard let client, identity.personId != nil else { return }
        lastChallengeRefresh = .now
        guard let mine: [ChallengeSummary] = try? await client.query("challenges:mine", ["deviceSecret": identity.secret]) else { return }
        challenges = mine
        for summary in mine {
            await report(summary, client: client)
            if let state = try? await client.query("challenges:get", ["code": summary.code], as: ChallengeState?.self) {
                details[summary.code] = state
                announceWinner(state)
            }
        }
    }

    private func announceWinner(_ state: ChallengeState) {
        let previous = knownWinners[state.code]
        knownWinners[state.code] = state.winnerName
        // Only news counts: a winner already there when Cineon opened isn't announced again.
        guard let previous, previous == nil, let winner = state.winnerName else { return }
        if state.winnerId == identity.personId {
            session.toasts.show("You finished \(state.title.name) first!")
        } else {
            session.toasts.show("\(winner) finished \(state.title.name) first")
        }
    }

    private func report(_ summary: ChallengeSummary, client: TogetherClient) async {
        let progress = localProgress(summary.title, total: Int(summary.totalEpisodes))
        let signature = "\(Int(progress.fraction * 1000))|\(progress.watched)|\(progress.finished)"
        guard reported[summary.code] != signature else { return }
        do {
            _ = try await client.mutation("challenges:report", [
                "deviceSecret": identity.secret, "code": summary.code, "fraction": progress.fraction,
                "watchedEpisodes": progress.watched, "label": progress.label, "finished": progress.finished,
            ], as: NullReply.self)
            reported[summary.code] = signature
        } catch {}
    }

    /// How far this person has got with a title, from their own library.
    func localProgress(_ card: TitleCard, total: Int) -> (fraction: Double, watched: Int, label: String, finished: Bool) {
        let library = session.library
        let title = card.imdbId.flatMap { id in library.titles.values.first { $0.imdbID == id } }
            ?? library.find(name: card.name, year: card.year)
        guard let title else { return (0, 0, "Not started", false) }
        let threshold = session.settings.finishThreshold
        let rows = library.progressList(titleID: title.id)

        if card.titleKind == .series || card.titleKind == .cartoon || rows.contains(where: { $0.ref.isEpisode }) {
            let episodes = rows.filter(\.ref.isEpisode)
            let done = episodes.filter { $0.finished || $0.fraction >= threshold }
            let count = max(1, total)
            let partial = episodes.filter { !($0.finished || $0.fraction >= threshold) }.max { $0.updatedAt < $1.updatedAt }?.fraction ?? 0
            let finished = (total > 0 && done.count >= total) || title.status == .watched
            let fraction = finished ? 1 : min(0.999, (Double(done.count) + partial) / Double(count))
            let latest = episodes.max { $0.updatedAt < $1.updatedAt }?.ref
            var label = "\(done.count) of \(count) episodes"
            if finished { label = "Finished" } else if let latest { label += " · on \(latest.shortLabel)" }
            return (fraction, done.count, label, finished)
        }

        let latest = rows.max { $0.updatedAt < $1.updatedAt }
        let finished = title.status == .watched || latest?.finished == true || (latest?.fraction ?? 0) >= threshold
        let fraction = finished ? 1 : latest?.fraction ?? 0
        return (fraction, finished ? 1 : 0, finished ? "Finished" : fraction > 0 ? "\(Int(fraction * 100))% in" : "Not started", finished)
    }
}

/// For calls whose answer is just `null`.
nonisolated struct NullReply: Decodable, Sendable {
    init(from decoder: any Decoder) throws {}
}
