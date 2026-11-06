import Foundation

/// How the library is filtered and sorted. Pure, so the rules can be tested.
nonisolated struct LibraryQuery: Hashable, Sendable {
    enum List: String, CaseIterable, Sendable {
        case all, backlog, watching, watched

        var label: String {
            switch self {
            case .all: "Everything"
            case .backlog: "Backlog"
            case .watching: "Watching"
            case .watched: "Watched"
            }
        }

        func matches(_ title: Title) -> Bool {
            switch self {
            case .all: true
            case .backlog: title.status == .backlog
            case .watching: title.status == .watching
            case .watched: title.status == .watched
            }
        }
    }

    enum Kind: String, CaseIterable, Sendable {
        case any, films, series, cartoons

        var label: String {
            switch self {
            case .any: "All"
            case .films: "Films"
            case .series: "Series"
            case .cartoons: "Cartoons"
            }
        }

        func matches(_ title: Title) -> Bool {
            switch self {
            case .any: true
            case .films: title.kind == .film || title.kind == .unknown
            case .series: title.kind == .series
            case .cartoons: title.kind == .cartoon
            }
        }
    }

    enum RatingFilter: Hashable, Sendable {
        case any
        case unrated
        /// At least this many stars out of ten.
        case atLeast(Int)
        case below(Int)

        var label: String {
            switch self {
            case .any: "Any rating"
            case .unrated: "Not rated yet"
            case .atLeast(let stars): "\(stars) and up"
            case .below(let stars): "Under \(stars)"
            }
        }

        static let choices: [RatingFilter] = [.any, .unrated, .atLeast(9), .atLeast(8), .atLeast(7), .atLeast(5), .below(5)]

        func matches(_ title: Title) -> Bool {
            switch self {
            case .any: true
            case .unrated: title.ratingHalves == nil
            case .atLeast(let stars): (title.rating ?? -1) >= Double(stars)
            case .below(let stars): title.rating.map { $0 < Double(stars) } ?? false
            }
        }
    }

    enum Sort: String, CaseIterable, Sendable {
        case recent, added, ratingHigh, ratingLow, name, newest, oldest, longest

        var label: String {
            switch self {
            case .recent: "Recently watched"
            case .added: "Recently added"
            case .ratingHigh: "Highest rated"
            case .ratingLow: "Lowest rated"
            case .name: "Name"
            case .newest: "Newest first"
            case .oldest: "Oldest first"
            case .longest: "Longest first"
            }
        }
    }

    var list: List = .all
    var kind: Kind = .any
    var genres: Set<String> = []
    var rating: RatingFilter = .any
    /// The first year of a decade, such as 1990.
    var decade: Int?
    var onThisMac = false
    var text = ""
    var sort: Sort = .recent

    /// Anything narrowing the list beyond which list and kind it is.
    var hasFilters: Bool { !genres.isEmpty || rating != .any || decade != nil || onThisMac || !text.isEmpty }

    func apply(to titles: [Title], downloaded: Set<Int64> = []) -> [Title] {
        let needle = TitleParser.normalize(text)
        let kept = titles.filter { title in
            guard list.matches(title), kind.matches(title), rating.matches(title) else { return false }
            if !needle.isEmpty, !title.normName.contains(needle) { return false }
            if !genres.isEmpty {
                let own = Set(title.genres.map(ProfileStats.canonicalGenre))
                if own.isDisjoint(with: genres) { return false }
            }
            if let decade {
                guard let year = title.year, year >= decade, year < decade + 10 else { return false }
            }
            if onThisMac, !downloaded.contains(title.id) { return false }
            return true
        }
        return kept.sorted(by: order)
    }

    private func order(_ a: Title, _ b: Title) -> Bool {
        func byName() -> Bool { a.name.localizedStandardCompare(b.name) == .orderedAscending }
        switch sort {
        case .recent:
            let x = a.lastWatchedAt ?? a.finishedAt ?? a.addedAt
            let y = b.lastWatchedAt ?? b.finishedAt ?? b.addedAt
            return x == y ? byName() : x > y
        case .added:
            return a.addedAt == b.addedAt ? byName() : a.addedAt > b.addedAt
        case .ratingHigh, .ratingLow:
            // Unrated always last, whichever way.
            switch (a.ratingHalves, b.ratingHalves) {
            case let (x?, y?): return x == y ? byName() : (sort == .ratingHigh ? x > y : x < y)
            case (.some, nil): return true
            case (nil, .some): return false
            case (nil, nil): return byName()
            }
        case .name:
            return byName()
        case .newest, .oldest:
            switch (a.year, b.year) {
            case let (x?, y?): return x == y ? byName() : (sort == .newest ? x > y : x < y)
            case (.some, nil): return true
            case (nil, .some): return false
            case (nil, nil): return byName()
            }
        case .longest:
            let x = a.runtimeMinutes ?? -1
            let y = b.runtimeMinutes ?? -1
            return x == y ? byName() : x > y
        }
    }

    /// The genres present in these titles, most common first.
    static func genres(in titles: [Title]) -> [(name: String, count: Int)] {
        var counts: [String: Int] = [:]
        for title in titles {
            for genre in Set(title.genres.map(ProfileStats.canonicalGenre)) { counts[genre, default: 0] += 1 }
        }
        return counts.map { ($0.key, $0.value) }.sorted { $0.count == $1.count ? $0.name < $1.name : $0.count > $1.count }
    }

    static func decades(in titles: [Title]) -> [Int] {
        Set(titles.compactMap { $0.year.map { $0 / 10 * 10 } }.filter { $0 > 1880 }).sorted(by: >)
    }
}
