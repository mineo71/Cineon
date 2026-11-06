import Foundation
import Observation

struct Profile: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var createdAt: Date
    /// The last poster this person watched. Their avatar on the picker, so it's always current.
    var lastPosterURL: URL?
}

/// The list of people using this Mac. Everything else about a profile lives in its own database.
@Observable
final class ProfileStore {
    private(set) var profiles: [Profile] = []
    private(set) var lastUsedID: UUID?
    var askOnLaunch: Bool {
        didSet { save() }
    }

    private struct Stored: Codable {
        var profiles: [Profile]
        var lastUsedID: UUID?
        var askOnLaunch: Bool
    }

    private static var fileURL: URL { AppPaths.root.appendingPathComponent("profiles.json") }

    init() {
        if let data = try? Data(contentsOf: Self.fileURL),
           let stored = try? JSONDecoder().decode(Stored.self, from: data), !stored.profiles.isEmpty {
            profiles = stored.profiles
            lastUsedID = stored.lastUsedID
            askOnLaunch = stored.askOnLaunch
        } else {
            let accountName = NSFullUserName().components(separatedBy: " ").first ?? "Me"
            let first = Profile(id: UUID(), name: accountName.prefix(1).uppercased() + accountName.dropFirst(), createdAt: .now)
            profiles = [first]
            lastUsedID = first.id
            askOnLaunch = false
            save()
        }
    }

    var lastUsed: Profile {
        profiles.first { $0.id == lastUsedID } ?? profiles[0]
    }

    func markUsed(_ id: UUID) {
        lastUsedID = id
        save()
    }

    @discardableResult
    func add(name: String) -> Profile {
        let profile = Profile(id: UUID(), name: name, createdAt: .now)
        profiles.append(profile)
        // More than one person now, so ask who's watching next time.
        if profiles.count == 2 { askOnLaunch = true }
        save()
        return profile
    }

    func rename(_ id: UUID, to name: String) {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else { return }
        profiles[index].name = name
        save()
    }

    func setPoster(_ id: UUID, url: URL?) {
        guard let index = profiles.firstIndex(where: { $0.id == id }), profiles[index].lastPosterURL != url else { return }
        profiles[index].lastPosterURL = url
        save()
    }

    /// Removes the person and everything they did, including their cookies and logins.
    func delete(_ id: UUID) {
        guard profiles.count > 1 else { return }
        profiles.removeAll { $0.id == id }
        if lastUsedID == id { lastUsedID = profiles.first?.id }
        try? FileManager.default.removeItem(at: AppPaths.profile(id))
        save()
    }

    private func save() {
        let stored = Stored(profiles: profiles, lastUsedID: lastUsedID, askOnLaunch: askOnLaunch)
        guard let data = try? JSONEncoder().encode(stored) else { return }
        try? data.write(to: Self.fileURL, options: .atomic)
    }
}
