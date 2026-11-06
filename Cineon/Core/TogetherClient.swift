import Foundation
import Security

/// A film as it travels between friends: enough to show a poster and find it again.
nonisolated struct TitleCard: Codable, Hashable, Sendable {
    var name: String
    var year: Int?
    var kind: String
    var imdbId: String?
    var posterUrl: String?
    var status: String?
    var rating: Int?

    init(name: String, year: Int? = nil, kind: String = "unknown", imdbId: String? = nil, posterUrl: String? = nil) {
        self.name = name
        self.year = year
        self.kind = kind
        self.imdbId = imdbId
        self.posterUrl = posterUrl
    }

    init(_ title: Title) {
        name = title.name
        year = title.year
        kind = title.kind.rawValue
        imdbId = title.imdbID
        posterUrl = title.posterURL?.absoluteString
        status = title.status == .none ? nil : title.status.rawValue
        rating = title.ratingHalves
    }

    var posterURL: URL? { posterUrl.flatMap(URL.init(string:)) }
    var titleKind: TitleKind { TitleKind(rawValue: kind) ?? .unknown }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        year = (try? c.decodeIfPresent(Double.self, forKey: .year)).flatMap { $0 }.map { Int($0) }
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)).flatMap { $0 } ?? "unknown"
        imdbId = (try? c.decodeIfPresent(String.self, forKey: .imdbId)).flatMap { $0 }
        posterUrl = (try? c.decodeIfPresent(String.self, forKey: .posterUrl)).flatMap { $0 }
        status = (try? c.decodeIfPresent(String.self, forKey: .status)).flatMap { $0 }
        rating = (try? c.decodeIfPresent(Double.self, forKey: .rating)).flatMap { $0 }.map { Int($0) }
    }

    var json: [String: Any] {
        var out: [String: Any] = ["name": name, "kind": kind]
        if let year { out["year"] = year }
        if let imdbId { out["imdbId"] = imdbId }
        if let posterUrl { out["posterUrl"] = posterUrl }
        if let status { out["status"] = status }
        if let rating { out["rating"] = rating }
        return out
    }
}

nonisolated struct ShareInfo: Decodable, Hashable, Sendable {
    var code: String
    var label: String
    var ownerName: String
    var titles: [TitleCard]
    var createdAt: Double
}

nonisolated struct PartyMember: Decodable, Hashable, Sendable {
    var personId: String
    var name: String
    var lastSeen: Double
    /// Their pixel pet's code, when they share one.
    var pet: String?
}

nonisolated struct PartyReaction: Decodable, Hashable, Sendable {
    var name: String
    var emoji: String
    var at: Double
    var pet: String?
}

nonisolated struct PartyMessage: Decodable, Hashable, Sendable, Identifiable {
    var personId: String
    var name: String
    var pet: String?
    var text: String
    var at: Double

    var id: String { "\(personId)|\(at)|\(text.hashValue)" }
}

nonisolated struct PartyState: Decodable, Hashable, Sendable {
    var code: String
    var ended: Bool
    var hostId: String
    var hostName: String
    var title: TitleCard?
    var pageUrl: String
    var playing: Bool
    var position: Double
    var rate: Double
    var updatedAt: Double
    var now: Double
    var members: [PartyMember]
    var reactions: [PartyReaction]
    /// Chat, oldest first. Missing from servers older than chat.
    var messages: [PartyMessage]
    var hostPet: String?

    enum CodingKeys: String, CodingKey {
        case code, ended, hostId, hostName, title, pageUrl, playing, position, rate, updatedAt, now, members, reactions, messages, hostPet
    }

    init(
        code: String, ended: Bool, hostId: String, hostName: String, title: TitleCard?, pageUrl: String, playing: Bool,
        position: Double, rate: Double, updatedAt: Double, now: Double, members: [PartyMember], reactions: [PartyReaction],
        messages: [PartyMessage] = [], hostPet: String? = nil
    ) {
        self.code = code
        self.ended = ended
        self.hostId = hostId
        self.hostName = hostName
        self.title = title
        self.pageUrl = pageUrl
        self.playing = playing
        self.position = position
        self.rate = rate
        self.updatedAt = updatedAt
        self.now = now
        self.members = members
        self.reactions = reactions
        self.messages = messages
        self.hostPet = hostPet
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        ended = try c.decode(Bool.self, forKey: .ended)
        hostId = try c.decode(String.self, forKey: .hostId)
        hostName = try c.decode(String.self, forKey: .hostName)
        title = try c.decodeIfPresent(TitleCard.self, forKey: .title)
        pageUrl = try c.decode(String.self, forKey: .pageUrl)
        playing = try c.decode(Bool.self, forKey: .playing)
        position = try c.decode(Double.self, forKey: .position)
        rate = try c.decode(Double.self, forKey: .rate)
        updatedAt = try c.decode(Double.self, forKey: .updatedAt)
        now = try c.decode(Double.self, forKey: .now)
        members = try c.decode([PartyMember].self, forKey: .members)
        reactions = try c.decode([PartyReaction].self, forKey: .reactions)
        messages = (try? c.decodeIfPresent([PartyMessage].self, forKey: .messages)) ?? []
        hostPet = try? c.decodeIfPresent(String.self, forKey: .hostPet)
    }

    /// Where the host's film is right now, from the last thing the host said.
    var expectedPosition: Double {
        guard playing else { return position }
        return position + max(0, now - updatedAt) / 1000 * rate
    }
}

nonisolated struct ChallengeMember: Decodable, Hashable, Sendable {
    var personId: String
    var name: String
    var fraction: Double
    var watchedEpisodes: Double
    var label: String
    var finishedAt: Double?
    var updatedAt: Double
    var pet: String?
}

nonisolated struct ChallengeState: Decodable, Hashable, Sendable {
    var code: String
    var title: TitleCard
    var totalEpisodes: Double
    var createdAt: Double
    var creatorId: String
    var winnerId: String?
    var winnerName: String?
    var now: Double
    var members: [ChallengeMember]
}

nonisolated struct ChallengeSummary: Decodable, Hashable, Sendable {
    var code: String
    var title: TitleCard
    var totalEpisodes: Double
    var winnerName: String?
    var memberCount: Double
    var myFraction: Double
    var leaderName: String?
    var leaderFraction: Double
}

nonisolated struct CodeKind: Decodable, Sendable {
    var kind: String
}

nonisolated struct Registered: Decodable, Sendable {
    var personId: String
    var name: String
}

nonisolated struct CodeReply: Decodable, Sendable {
    var code: String
}

nonisolated struct TogetherError: LocalizedError, Sendable {
    var message: String
    var errorDescription: String? { message }
}

/// Talks to the Together server through Convex's plain HTTP API, so the app needs no SDK.
nonisolated struct TogetherClient: Sendable {
    let baseURL: URL

    static var configured: TogetherClient? {
        let environment = ProcessInfo.processInfo.environment["CINEON_TOGETHER_URL"]
        let raw = environment ?? (Bundle.main.object(forInfoDictionaryKey: "CineonTogetherURL") as? String) ?? ""
        guard !raw.isEmpty, let url = URL(string: raw), url.scheme?.hasPrefix("http") == true else { return nil }
        return TogetherClient(baseURL: url)
    }

    func query<T: Decodable>(_ path: String, _ args: [String: Any] = [:], as type: T.Type = T.self) async throws -> T {
        try await call("query", path, args)
    }

    func mutation<T: Decodable>(_ path: String, _ args: [String: Any] = [:], as type: T.Type = T.self) async throws -> T {
        try await call("mutation", path, args)
    }

    private func call<T: Decodable>(_ kind: String, _ path: String, _ args: [String: Any]) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/\(kind)"))
        request.httpMethod = "POST"
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["path": path, "args": args, "format": "json"])
        let (data, _) = try await URLSession.shared.data(for: request)
        guard let reply = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any] else {
            throw TogetherError(message: "The Together server sent something unexpected")
        }
        guard reply["status"] as? String == "success" else {
            // The server's own sentence for people, when it sent one.
            if let data = reply["errorData"] as? [String: Any], let message = data["message"] as? String {
                throw TogetherError(message: message)
            }
            throw TogetherError(message: Self.clean(reply["errorMessage"] as? String))
        }
        let value = reply["value"] ?? NSNull()
        let encoded = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        return try JSONDecoder().decode(T.self, from: encoded)
    }

    /// Convex wraps thrown errors in its own text. Keep the sentence meant for people.
    private static func clean(_ message: String?) -> String {
        guard let message else { return "The Together server didn't answer" }
        if let range = message.range(of: "Uncaught Error: ") {
            let rest = message[range.upperBound...]
            return String(rest.split(separator: "\n").first ?? Substring(rest))
                .components(separatedBy: "    at ").first?.trimmingCharacters(in: .whitespaces) ?? String(rest)
        }
        return message.split(separator: "\n").first.map(String.init) ?? message
    }
}

/// Codes show as `K7Q-2MX`, and are typed however people like.
nonisolated enum ShareCode {
    static func normalize(_ raw: String) -> String {
        raw.uppercased().filter { $0.isLetter || $0.isNumber }
    }

    static func display(_ code: String) -> String {
        let clean = normalize(code)
        guard clean.count == 6 else { return clean }
        return "\(clean.prefix(3))-\(clean.suffix(3))"
    }
}

/// Who this profile is to the server: a random key and a name, kept in the profile's folder.
nonisolated struct TogetherIdentity: Codable, Sendable {
    var secret: String
    var name: String
    var personId: String?
    var openedShares: [String] = []
    var partyCode: String?
    /// The pixel pet's code as the server last heard it.
    var pet: String?

    static func load(profile: Profile) -> TogetherIdentity {
        let url = file(profile.id)
        if let data = try? Data(contentsOf: url), let stored = try? JSONDecoder().decode(TogetherIdentity.self, from: data) {
            return stored
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let identity = TogetherIdentity(secret: Data(bytes).base64EncodedString(), name: profile.name)
        identity.save(profile: profile.id)
        return identity
    }

    func save(profile: UUID) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: Self.file(profile), options: .atomic)
    }

    private static func file(_ id: UUID) -> URL {
        AppPaths.profile(id).appendingPathComponent("together.json")
    }
}
