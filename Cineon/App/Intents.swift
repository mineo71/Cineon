import AppIntents
import Foundation

// Siri and Shortcuts. Every intent runs inside Cineon, opening it first when it isn't running.

nonisolated struct TitleEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Film or Series")
    static let defaultQuery = TitleEntityQuery()

    var id: Int
    var name: String
    var year: Int?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: year.map { "\($0)" }.map { LocalizedStringResource(stringLiteral: $0) })
    }
}

nonisolated struct TitleEntityQuery: EntityStringQuery {
    @MainActor
    private func all() -> [TitleEntity] {
        guard let library = AppModel.shared?.library else { return [] }
        return library.titles.values
            .sorted { ($0.lastWatchedAt ?? $0.addedAt) > ($1.lastWatchedAt ?? $1.addedAt) }
            .map { TitleEntity(id: Int($0.id), name: $0.name, year: $0.year) }
    }

    func entities(for identifiers: [Int]) async throws -> [TitleEntity] {
        let wanted = Set(identifiers)
        return await all().filter { wanted.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [TitleEntity] {
        let needle = string.lowercased()
        return await all().filter { $0.name.lowercased().contains(needle) }
    }

    func suggestedEntities() async throws -> [TitleEntity] {
        await MainActor.run {
            guard let library = AppModel.shared?.library else { return [] }
            return library.continueWatching.prefix(12).map { TitleEntity(id: Int($0.title.id), name: $0.title.name, year: $0.title.year) }
        }
    }
}

struct ContinueWatchingIntent: AppIntent {
    static let title: LocalizedStringResource = "Continue Watching"
    static let description = IntentDescription("Carries on with what you watched last, or a film or series you name.")
    static let openAppWhenRun = true

    @Parameter(title: "Film or Series")
    var title: TitleEntity?

    @MainActor
    func perform() async throws -> some IntentResult {
        AppModel.shared?.continueWatching(titleID: title.map { Int64($0.id) })
        return .result()
    }
}

nonisolated struct PlayPauseIntent: AppIntent {
    static let title: LocalizedStringResource = "Play or Pause"
    static let description = IntentDescription("Plays or pauses what's on in Cineon.")

    @MainActor
    func perform() async throws -> some IntentResult {
        AppModel.shared?.togglePlayback()
        return .result()
    }
}

nonisolated struct NextEpisodeIntent: AppIntent {
    static let title: LocalizedStringResource = "Next Episode"
    static let description = IntentDescription("Moves on to the next episode of what's playing.")

    @MainActor
    func perform() async throws -> some IntentResult {
        AppModel.shared?.playNextEpisode()
        return .result()
    }
}

struct SleepTimerIntent: AppIntent {
    static let title: LocalizedStringResource = "Set a Sleep Timer"
    static let description = IntentDescription("Fades out and pauses playback after a while. Zero minutes means at the end of what's on.")

    @Parameter(title: "Minutes", default: 30, inclusiveRange: (0, 240))
    var minutes: Int

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let app = AppModel.shared else { return .result(dialog: "Cineon isn't ready yet") }
        if minutes <= 0 {
            app.startSleepTimer(.endOfItem)
            return .result(dialog: "Cineon will stop at the end of this")
        }
        app.startSleepTimer(.minutes(minutes))
        return .result(dialog: "Cineon will stop in \(minutes) minutes")
    }
}

nonisolated struct OpenDownloadsIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Downloads"
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppModel.shared?.go(.downloads)
        return .result()
    }
}

nonisolated struct OpenProfileIntent: AppIntent {
    static let title: LocalizedStringResource = "Open My Profile"
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppModel.shared?.go(.profile)
        return .result()
    }
}

nonisolated struct RateFilmsIntent: AppIntent {
    static let title: LocalizedStringResource = "Rate My Films"
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppModel.shared?.go(.rate)
        return .result()
    }
}

nonisolated struct CineonShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ContinueWatchingIntent(),
            phrases: ["Continue watching in \(.applicationName)", "Carry on watching in \(.applicationName)"],
            shortTitle: "Continue Watching", systemImageName: "play.circle"
        )
        AppShortcut(
            intent: PlayPauseIntent(),
            phrases: ["Pause \(.applicationName)", "Play \(.applicationName)"],
            shortTitle: "Play or Pause", systemImageName: "playpause"
        )
        AppShortcut(
            intent: NextEpisodeIntent(),
            phrases: ["Next episode in \(.applicationName)"],
            shortTitle: "Next Episode", systemImageName: "forward.end"
        )
        AppShortcut(
            intent: SleepTimerIntent(),
            phrases: ["Set a sleep timer in \(.applicationName)", "\(.applicationName) sleep timer"],
            shortTitle: "Sleep Timer", systemImageName: "moon.zzz"
        )
        AppShortcut(
            intent: RateFilmsIntent(),
            phrases: ["Rate my films in \(.applicationName)"],
            shortTitle: "Rate Films", systemImageName: "star.leadinghalf.filled"
        )
        AppShortcut(
            intent: OpenProfileIntent(),
            phrases: ["Show my \(.applicationName) profile"],
            shortTitle: "My Profile", systemImageName: "person.crop.circle"
        )
    }
}
