import Foundation
import WebKit

nonisolated struct FilterListInfo: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let summary: String
    let updateURL: URL?
}

/// Owns the compiled rule lists. Lists are global, since compiled bytecode is identical for every
/// profile, while each profile chooses which of them to switch on.
@Observable
final class FilterEngine {
    static let catalog: [FilterListInfo] = [
        FilterListInfo(
            id: "easylist", name: "EasyList", summary: "The main list of ads",
            updateURL: URL(string: "https://easylist.to/easylist/easylist.txt")
        ),
        FilterListInfo(
            id: "easyprivacy", name: "EasyPrivacy", summary: "Trackers and analytics",
            updateURL: URL(string: "https://easylist.to/easylist/easyprivacy.txt")
        ),
        FilterListInfo(
            id: "ublock", name: "uBlock filters", summary: "Extra rules from the uBlock Origin project",
            updateURL: URL(string: "https://ublockorigin.github.io/uAssets/filters/filters.txt")
        ),
        FilterListInfo(
            id: "peterlowe", name: "Peter Lowe's list", summary: "Ad and tracking servers",
            updateURL: URL(string: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext")
        ),
        FilterListInfo(
            id: "cineon-streaming", name: "Cineon streaming", summary: "Pop-under networks used by streaming sites",
            updateURL: nil
        ),
    ]

    enum Status: Equatable {
        case idle
        case preparing(String)
        case failed(String)
    }

    private(set) var status: Status = .idle
    private(set) var ruleCounts: [String: Int] = [:]
    private(set) var compiled: [String: WKContentRuleList] = [:]
    private(set) var isReady = false
    /// Bumped whenever the compiled set changes, so controllers can re-apply it.
    private(set) var generation = 0 {
        didSet { onChange?() }
    }
    @ObservationIgnored var onChange: (() -> Void)?
    /// When the lists were last downloaded. Nil means still on the copies built into the app.
    private(set) var lastUpdated: Date?

    private let store: WKContentRuleListStore
    private let directory: URL
    private let defaults = UserDefaults.standard
    private static let countsKey = "filters.ruleCounts"
    private static let lastUpdatedKey = "filters.lastUpdated"
    private static let firstSeenKey = "filters.firstSeen"
    /// Raising this forces every list to be converted again after a converter change.
    private static let converterVersion = 3

    init() {
        directory = AppPaths.root.appendingPathComponent("Filters", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        store = WKContentRuleListStore.default() ?? WKContentRuleListStore(url: directory)
        ruleCounts = (defaults.dictionary(forKey: Self.countsKey) as? [String: Int]) ?? [:]
        lastUpdated = defaults.object(forKey: Self.lastUpdatedKey) as? Date
        if defaults.object(forKey: Self.firstSeenKey) == nil { defaults.set(Date.now, forKey: Self.firstSeenKey) }
    }

    private func identifier(for id: String) -> String { "cineon.\(id).v\(Self.converterVersion)" }

    /// Loads compiled lists from disk, which takes milliseconds, and compiles any that are missing.
    func prepare() async {
        var missing: [FilterListInfo] = []
        for info in Self.catalog {
            if let list = await lookUp(identifier(for: info.id)) {
                compiled[info.id] = list
            } else {
                missing.append(info)
            }
        }
        if !compiled.isEmpty { generation += 1 }
        isReady = true

        guard !missing.isEmpty else { return }
        for (index, info) in missing.enumerated() {
            status = .preparing("Preparing ad blocker, \(index + 1) of \(missing.count)")
            guard let text = readSource(id: info.id) else { continue }
            await compile(info.id, text: text)
        }
        status = .idle
    }

    private func lookUp(_ id: String) async -> WKContentRuleList? {
        await withCheckedContinuation { continuation in
            store.lookUpContentRuleList(forIdentifier: id) { list, _ in
                continuation.resume(returning: list)
            }
        }
    }

    private func readSource(id: String) -> String? {
        let downloaded = directory.appendingPathComponent("\(id).txt")
        if let text = try? String(contentsOf: downloaded, encoding: .utf8) { return text }
        guard let bundled = Bundle.main.url(forResource: id, withExtension: "txt", subdirectory: "Filters") else { return nil }
        return try? String(contentsOf: bundled, encoding: .utf8)
    }

    @discardableResult
    private func compile(_ id: String, text: String) async -> Bool {
        let output = await Task.detached(priority: .utility) { FilterConverter.convert(text) }.value
        let identifier = identifier(for: id)
        let result: Result<WKContentRuleList, any Error> = await withCheckedContinuation { continuation in
            store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: output.json) { list, error in
                if let list {
                    continuation.resume(returning: .success(list))
                } else {
                    continuation.resume(returning: .failure(error ?? SQLError(message: "Compile failed")))
                }
            }
        }
        switch result {
        case .success(let list):
            compiled[id] = list
            ruleCounts[id] = output.ruleCount
            defaults.set(ruleCounts, forKey: Self.countsKey)
            generation += 1
            return true
        case .failure(let error):
            status = .failed("\(id): \(error.localizedDescription)")
            return false
        }
    }

    /// Once a week across the whole app. The built-in lists count as fresh on first launch, and
    /// downloading and compiling costs a few hundred megabytes for a moment, so it's worth avoiding.
    func updateIfDue() async {
        let base = lastUpdated ?? (defaults.object(forKey: Self.firstSeenKey) as? Date) ?? .now
        guard Date.now.timeIntervalSince(base) > 7 * 24 * 3600 else { return }
        _ = await update()
    }

    /// Downloads fresh copies, then recompiles. Rules already in use keep working until the swap.
    func update() async -> Bool {
        var changed = false
        let lists = Self.catalog.filter { $0.updateURL != nil }
        for (index, info) in lists.enumerated() {
            guard let url = info.updateURL else { continue }
            status = .preparing("Updating \(info.name), \(index + 1) of \(lists.count)")
            do {
                let (data, response) = try await URLSession.shared.data(from: url)
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let text = String(data: data, encoding: .utf8),
                      text.count > 1000
                else { continue }
                try text.write(to: directory.appendingPathComponent("\(info.id).txt"), atomically: true, encoding: .utf8)
                if await compile(info.id, text: text) { changed = true }
            } catch {
                continue
            }
        }
        status = .idle
        if changed {
            lastUpdated = .now
            defaults.set(lastUpdated, forKey: Self.lastUpdatedKey)
        }
        return changed
    }

    var totalRules: Int { ruleCounts.values.reduce(0, +) }
}

nonisolated enum AppPaths {
    /// A test run with throwaway data. It mustn't ask for permissions that would stick to the real app.
    static let isScratch = ProcessInfo.processInfo.environment["CINEON_DATA_DIR"] != nil
        || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    static let root: URL = {
        let dir: URL
        let environment = ProcessInfo.processInfo.environment
        if let override = environment["CINEON_DATA_DIR"] {
            // Lets test runs use a throwaway folder and leave real data alone.
            dir = URL(fileURLWithPath: override, isDirectory: true)
        } else if environment["XCTestConfigurationFilePath"] != nil {
            dir = FileManager.default.temporaryDirectory.appendingPathComponent("CineonTests-\(UUID().uuidString)", isDirectory: true)
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            dir = base.appendingPathComponent("Cineon", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    static func profile(_ id: UUID) -> URL {
        let dir = root.appendingPathComponent("Profiles/\(id.uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
