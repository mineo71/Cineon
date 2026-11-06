import SwiftUI

// MARK: - Inputs

/// One genre and how much of it the person watches. Any non-negative scale works
/// (title counts, hours); only the relative order matters.
nonisolated struct GenreWeight: Sendable, Hashable {
    var name: String
    var weight: Double

    init(name: String, weight: Double) {
        self.name = name
        self.weight = weight
    }
}

/// Everything the generator looks at. Same traits always give the same pet.
nonisolated struct PetTraits: Sendable, Hashable {
    /// Any order, any weights ≥ 0 (others are ignored); may be empty.
    var genres: [GenreWeight]
    var hoursWatched: Double
    var titlesFinished: Int
    /// `nil` means the person has never watched anything.
    var daysSinceLastWatch: Int?
    /// Stable per profile (a UUID string). Drives the name and small variations.
    var seed: String

    init(
        genres: [GenreWeight] = [],
        hoursWatched: Double = 0,
        titlesFinished: Int = 0,
        daysSinceLastWatch: Int? = nil,
        seed: String
    ) {
        self.genres = genres
        self.hoursWatched = hoursWatched
        self.titlesFinished = titlesFinished
        self.daysSinceLastWatch = daysSinceLastWatch
        self.seed = seed
    }
}

// MARK: - Pet

/// A small pixel-art creature that stands for someone's taste in films.
///
/// Species comes from the favourite genre, the accessory from the second, the
/// colour tone from the third; stage and level from how much they have watched;
/// mood from how recently. Encodes to a short versioned `code` that friends can
/// decode; `Codable` uses that same code string.
nonisolated struct PixelPet: Sendable, Hashable, Codable {
    var species: Species
    var stage: Stage
    var accessory: Accessory
    var tone: Tone
    var mood: Mood
    /// 1...99.
    var level: Int
    /// Index into the name syllable tables, 0..<1024. See `name`.
    var nameIndex: Int

    init(
        species: Species,
        stage: Stage,
        accessory: Accessory = .none,
        tone: Tone = .classic,
        mood: Mood = .content,
        level: Int = 1,
        nameIndex: Int = 0
    ) {
        self.species = species
        self.stage = stage
        self.accessory = accessory
        self.tone = tone
        self.mood = mood
        self.level = min(max(level, 1), PixelPet.maxLevel)
        self.nameIndex = min(max(nameIndex, 0), PixelPet.nameCount - 1)
    }

    static let maxLevel = 99

    // NOTE: the order of cases in every enum below is part of the `p1` code
    // format. Only ever append new cases at the end.

    nonisolated enum Species: String, CaseIterable, Sendable, Codable {
        case fox, turtle, cat, frog, raccoon, raven, ghost, robot
        case dragon, owl, slime, bunny, puppy, songbird, hedgehog

        var label: String {
            switch self {
            case .fox: "Fox"
            case .turtle: "Turtle"
            case .cat: "Cat"
            case .frog: "Frog"
            case .raccoon: "Raccoon"
            case .raven: "Raven"
            case .ghost: "Ghost"
            case .robot: "Robot"
            case .dragon: "Dragon"
            case .owl: "Owl"
            case .slime: "Slime"
            case .bunny: "Bunny"
            case .puppy: "Puppy"
            case .songbird: "Songbird"
            case .hedgehog: "Hedgehog"
            }
        }
    }

    nonisolated enum Stage: String, CaseIterable, Sendable, Codable, Comparable {
        case baby, teen, adult, legend

        var label: String {
            switch self {
            case .baby: "Baby"
            case .teen: "Teen"
            case .adult: "Adult"
            case .legend: "Legend"
            }
        }

        /// Experience needed to reach this stage.
        var minimumExperience: Double {
            switch self {
            case .baby: 0
            case .teen: 10
            case .adult: 60
            case .legend: 200
            }
        }

        init(experience: Double) {
            let xp = experience.isFinite ? experience : 0
            self = Stage.allCases.last { xp >= $0.minimumExperience } ?? .baby
        }

        var next: Stage? {
            let all = Stage.allCases
            guard let index = all.firstIndex(of: self), index + 1 < all.count else { return nil }
            return all[index + 1]
        }

        static func < (lhs: Stage, rhs: Stage) -> Bool {
            lhs.minimumExperience < rhs.minimumExperience
        }
    }

    nonisolated enum Mood: String, CaseIterable, Sendable, Codable {
        case happy, content, bored, sleepy

        init(daysSinceLastWatch days: Int?) {
            guard let days else { self = .sleepy; return }
            switch days {
            case ...1: self = .happy
            case 2...5: self = .content
            case 6...14: self = .bored
            default: self = .sleepy
            }
        }

        var label: String {
            switch self {
            case .happy: "Happy"
            case .content: "Content"
            case .bored: "Misses you"
            case .sleepy: "Sleepy"
            }
        }
    }

    nonisolated enum Accessory: String, CaseIterable, Sendable, Codable {
        case none, headband, explorerHat, scarf, partyHat, fedora, shades, horns
        case glasses3D, wizardHat, magnifier, propellerCap, bow, bowtie, specs
        case helmet, cowboyHat, headphones, popcorn

        var label: String {
            switch self {
            case .none: "Nothing"
            case .headband: "Headband"
            case .explorerHat: "Explorer hat"
            case .scarf: "Scarf"
            case .partyHat: "Party hat"
            case .fedora: "Fedora"
            case .shades: "Shades"
            case .horns: "Little horns"
            case .glasses3D: "3D glasses"
            case .wizardHat: "Wizard hat"
            case .magnifier: "Magnifying glass"
            case .propellerCap: "Propeller cap"
            case .bow: "Bow"
            case .bowtie: "Bow tie"
            case .specs: "Reading glasses"
            case .helmet: "Helmet"
            case .cowboyHat: "Cowboy hat"
            case .headphones: "Headphones"
            case .popcorn: "Popcorn"
            }
        }

        /// Hats that a Legend's crown replaces.
        var isHat: Bool {
            switch self {
            case .explorerHat, .partyHat, .fedora, .wizardHat, .propellerCap,
                 .helmet, .cowboyHat, .headphones:
                true
            default:
                false
            }
        }
    }

    /// Colour variant of the species palette.
    nonisolated enum Tone: String, CaseIterable, Sendable, Codable {
        case classic, sunny, dusk

        var label: String {
            switch self {
            case .classic: "Classic"
            case .sunny: "Sunny"
            case .dusk: "Dusk"
            }
        }
    }

    /// Canonical genres. Names from Cinemeta/IMDb/TMDB map onto these.
    nonisolated enum Genre: String, CaseIterable, Sendable {
        // Ordered by how common they are; also the tie-break order.
        case action, drama, adventure, crime, comedy, thriller, fantasy, sciFi
        case mystery, horror, animation, biography, war, sport, romance, history
        case family, short, western, music, documentary, musical, realityTV
        case talkShow, gameShow, news, filmNoir

        /// Display name, IMDb style.
        var label: String {
            switch self {
            case .sciFi: "Sci-Fi"
            case .realityTV: "Reality-TV"
            case .talkShow: "Talk-Show"
            case .gameShow: "Game-Show"
            case .filmNoir: "Film-Noir"
            default: rawValue.prefix(1).uppercased() + rawValue.dropFirst()
            }
        }

        init?(name: String) {
            let key = String(name.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains))
            guard let genre = Genre.aliases[key] else { return nil }
            self = genre
        }

        private static let aliases: [String: Genre] = {
            var map: [String: Genre] = [:]
            for genre in Genre.allCases { map[genre.rawValue.lowercased()] = genre }
            let extra: [String: Genre] = [
                "scifi": .sciFi, "sciencefiction": .sciFi, "sf": .sciFi, "scfi": .sciFi,
                "superhero": .action, "martialarts": .action,
                "suspense": .thriller, "psychological": .thriller,
                "noir": .filmNoir, "neonoir": .filmNoir,
                "animated": .animation, "anime": .animation, "cartoon": .animation,
                "biopic": .biography, "bio": .biography,
                "historical": .history, "period": .history,
                "sports": .sport, "kids": .family, "children": .family, "childrens": .family,
                "doc": .documentary, "docs": .documentary, "docuseries": .documentary,
                "documentaries": .documentary,
                "reality": .realityTV, "realitytv": .realityTV, "talk": .talkShow,
                "talkshow": .talkShow, "gameshow": .gameShow, "romcom": .romance,
                "romantic": .romance, "comedies": .comedy, "standup": .comedy,
                "warpolitics": .war, "politics": .news, "soap": .drama, "tvmovie": .drama,
                "scififantasy": .sciFi, "actionadventure": .action,
            ]
            map.merge(extra) { _, new in new }
            return map
        }()

        var species: Species {
            switch self {
            case .action: .fox
            case .adventure: .turtle
            case .drama: .cat
            case .comedy, .realityTV, .talkShow, .gameShow: .frog
            case .crime, .filmNoir, .western: .raccoon
            case .thriller: .raven
            case .horror: .ghost
            case .sciFi: .robot
            case .fantasy: .dragon
            case .mystery, .documentary, .biography, .history, .news: .owl
            case .animation, .short: .slime
            case .romance: .bunny
            case .family, .sport: .puppy
            case .music, .musical: .songbird
            case .war: .hedgehog
            }
        }

        var accessory: Accessory {
            switch self {
            case .action, .sport: .headband
            case .adventure: .explorerHat
            case .drama: .scarf
            case .comedy, .gameShow: .partyHat
            case .crime, .filmNoir: .fedora
            case .thriller: .shades
            case .horror: .horns
            case .sciFi: .glasses3D
            case .fantasy: .wizardHat
            case .mystery: .magnifier
            case .animation: .propellerCap
            case .romance: .bow
            case .family: .bowtie
            case .documentary, .biography, .history, .news: .specs
            case .war: .helmet
            case .western: .cowboyHat
            case .music, .musical: .headphones
            case .short, .realityTV, .talkShow: .popcorn
            }
        }

        var tone: Tone {
            switch self {
            case .horror, .thriller, .crime, .war, .filmNoir, .mystery: .dusk
            case .comedy, .romance, .family, .animation, .music, .musical, .adventure,
                 .gameShow, .realityTV:
                .sunny
            default: .classic
            }
        }
    }
}

// MARK: - Generator

nonisolated extension PixelPet {
    /// Experience points: hours plus 1.5 per finished title.
    static func experience(hoursWatched: Double, titlesFinished: Int) -> Double {
        let hours = hoursWatched.isFinite ? max(hoursWatched, 0) : 0
        return hours + 1.5 * Double(max(titlesFinished, 0))
    }

    static func level(forExperience xp: Double) -> Int {
        let xp = xp.isFinite ? max(xp, 0) : 0
        return min(1 + Int(xp.squareRoot()), maxLevel)
    }

    static func make(from traits: PetTraits) -> PixelPet {
        let ranked = rankedGenres(traits.genres)
        let species = ranked.first?.species ?? .slime
        let accessory = ranked.count > 1 ? ranked[1].accessory : .none
        let tone: Tone
        if ranked.count > 2 {
            tone = ranked[2].tone
        } else {
            let tones = Tone.allCases
            tone = tones[Int((stableHash(traits.seed) >> 20) % UInt64(tones.count))]
        }
        let xp = experience(hoursWatched: traits.hoursWatched, titlesFinished: traits.titlesFinished)
        return PixelPet(
            species: species,
            stage: Stage(experience: xp),
            accessory: accessory,
            tone: tone,
            mood: Mood(daysSinceLastWatch: traits.daysSinceLastWatch),
            level: level(forExperience: xp),
            nameIndex: nameIndex(seed: traits.seed, species: species)
        )
    }

    /// Known genres with positive weight, merged by alias, heaviest first.
    /// Input order never matters; ties go to the more common genre.
    static func rankedGenres(_ genres: [GenreWeight]) -> [Genre] {
        var parts: [(Genre, Double)] = []
        for entry in genres where entry.weight.isFinite && entry.weight > 0 {
            if let genre = Genre(name: entry.name) {
                parts.append((genre, entry.weight))
                continue
            }
            // "Action & Adventure", "Sci-Fi & Fantasy", "Crime/Drama"...
            let pieces = entry.name
                .split(whereSeparator: { "&/,+".contains($0) })
                .compactMap { Genre(name: String($0)) }
            for genre in pieces { parts.append((genre, entry.weight / Double(pieces.count))) }
        }
        let order = Genre.allCases
        // Sum in a canonical order so float rounding never depends on input order.
        parts.sort { ($0.0.index(in: order), $0.1) < ($1.0.index(in: order), $1.1) }
        var totals: [Genre: Double] = [:]
        for (genre, weight) in parts { totals[genre, default: 0] += weight }
        return totals.keys.sorted { a, b in
            let wa = totals[a] ?? 0, wb = totals[b] ?? 0
            return wa != wb ? wa > wb : a.index(in: order) < b.index(in: order)
        }
    }

    /// FNV-1a, 64-bit. Stable across launches, unlike `hashValue`.
    static func stableHash(_ text: String) -> UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return hash
    }
}

nonisolated private extension CaseIterable where Self: Equatable {
    nonisolated func index(in all: AllCases) -> Int {
        all.distance(from: all.startIndex, to: all.firstIndex(of: self) ?? all.startIndex)
    }
}

// MARK: - Growth (for progress UI)

nonisolated extension PixelPet {
    nonisolated struct Growth: Sendable, Hashable {
        var experience: Double
        var level: Int
        var stage: Stage
        var nextStage: Stage?
        /// Experience still needed for the next stage (0 at Legend).
        var experienceToNextStage: Double
        /// 0...1 progress through the current stage (1 at Legend).
        var progress: Double
    }

    static func growth(for traits: PetTraits) -> Growth {
        let xp = experience(hoursWatched: traits.hoursWatched, titlesFinished: traits.titlesFinished)
        let stage = Stage(experience: xp)
        guard let next = stage.next else {
            return Growth(experience: xp, level: level(forExperience: xp), stage: stage, nextStage: nil,
                          experienceToNextStage: 0, progress: 1)
        }
        let span = next.minimumExperience - stage.minimumExperience
        return Growth(
            experience: xp,
            level: level(forExperience: xp),
            stage: stage,
            nextStage: next,
            experienceToNextStage: max(next.minimumExperience - xp, 0),
            progress: min(max((xp - stage.minimumExperience) / span, 0), 1)
        )
    }
}

// MARK: - Labels, name, blurb

nonisolated extension PixelPet {
    var speciesLabel: String { species.label }
    var stageLabel: String { stage.label }
    var moodLabel: String { mood.label }
    var accessoryLabel: String { accessory.label }

    static let nameCount = 1024

    static let nameHeads = [
        "Mo", "Pi", "Bi", "Lu", "Ko", "Nu", "Ha", "Ze", "Ru", "Fi", "Zu", "Bo", "Mi", "Ka", "Yo", "Ne",
        "Ku", "Wa", "Yu", "Do", "Ki", "Ba", "Lo", "Gu", "Na", "Ri", "Po", "Ju", "Sa", "Te", "Ro", "Me",
    ]
    static let nameTails = [
        "chi", "xel", "mo", "bo", "ko", "ni", "pip", "lo", "mi", "by", "ra", "nu", "zu", "pa", "ki", "ru",
        "no", "ji", "pom", "bun", "sa", "mu", "do", "ri", "po", "tsu", "bi", "ppo", "na", "ku", "fi", "mel",
    ]

    var name: String {
        let heads = PixelPet.nameHeads, tails = PixelPet.nameTails
        return heads[(nameIndex / tails.count) % heads.count] + tails[nameIndex % tails.count]
    }

    static func nameIndex(seed: String, species: Species) -> Int {
        Int(stableHash(seed + "|" + species.rawValue) % UInt64(nameCount))
    }

    /// One short line of personality.
    var blurb: String {
        let lines = PixelPet.blurbs[species] ?? ["Loves a good film night."]
        return lines[nameIndex % lines.count]
    }

    private static let blurbs: [Species: [String]] = [
        .fox: ["Raised on action, never looks back at explosions.",
               "Does its own stunts. Mostly off the sofa.",
               "Always ready for the sequel."],
        .turtle: ["Slow walker, big explorer.",
                  "Packs snacks for every quest, even to the kitchen.",
                  "Has been to every map in the opening credits."],
        .cat: ["Cries at every ending, denies it every time.",
               "Sits in the dark, judging the cinematography.",
               "Prefers a long, quiet character study."],
        .frog: ["Laughs at the trailer, laughs harder at the bloopers.",
                "Ribbit is short for one more episode.",
                "Knows every catchphrase by heart."],
        .raccoon: ["Solves the heist before the reveal.",
                   "Steals your popcorn. Calls it a setup.",
                   "Wears the mask, keeps the secrets."],
        .raven: ["Raised on thrillers, sleeps with one eye open.",
                 "Saw the twist coming three scenes ago.",
                 "Trusts nobody in the first act."],
        .ghost: ["Says it isn't scared. Watches through its fingers.",
                 "Haunts the sofa after midnight.",
                 "Boo is its review of every jump scare."],
        .robot: ["Computes plot holes at 60 frames per second.",
                 "Dreams of electric sheep and director's cuts.",
                 "Beep boop: one more space opera."],
        .dragon: ["Hoards Blu-rays instead of gold.",
                  "Reads every appendix of every saga.",
                  "Breathes fire at bad CGI."],
        .owl: ["Has a theory about the ending. And a backup theory.",
               "Stays up for the extended edition.",
               "Pauses to read the footnotes."],
        .slime: ["Still figuring out its favourite genre.",
                 "Absorbs every cartoon it can find.",
                 "Squishes happily through the credits."],
        .bunny: ["Hops straight to the happy ending.",
                 "Keeps a list of perfect first-date films.",
                 "Believes in love at first scene."],
        .puppy: ["Wags at the opening credits.",
                 "Brings the remote back every single time.",
                 "Cheers for the underdog. Always."],
        .songbird: ["Hums the score for days after.",
                    "Knows every soundtrack by heart.",
                    "Sings along. Loudly."],
        .hedgehog: ["Small, spiky, brave through any battle scene.",
                    "Never leaves a film unfinished.",
                    "Salutes the end credits."],
    ]

    var accessibilityDescription: String {
        var text = "\(name), a \(moodLabel.lowercased()) \(stageLabel.lowercased()) \(speciesLabel.lowercased()), level \(level)"
        if accessory != .none { text += ", with \(accessory.label.lowercased())" }
        return text
    }
}

// MARK: - Code

nonisolated extension PixelPet {
    static let codePrefix = "p1-"
    private static let codeAlphabet = Array("0123456789abcdefghjkmnpqrstvwxyz")

    /// Compact, URL-safe, versioned: `p1-` + 10 base-32 characters (13 total).
    var code: String {
        let fields = [
            species.index(in: Species.allCases), stage.index(in: Stage.allCases),
            accessory.index(in: Accessory.allCases), tone.index(in: Tone.allCases),
            mood.index(in: Mood.allCases), level / 32, level % 32, nameIndex / 32, nameIndex % 32,
        ]
        let body = String(fields.map { PixelPet.codeAlphabet[$0] })
        return PixelPet.codePrefix + body + String(PixelPet.codeAlphabet[PixelPet.checksum(body)])
    }

    init?(code: String) {
        let text = code.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard text.hasPrefix(PixelPet.codePrefix) else { return nil }
        let chars = Array(text.dropFirst(PixelPet.codePrefix.count))
        guard chars.count == 10 else { return nil }
        var values: [Int] = []
        for char in chars {
            guard let value = PixelPet.codeAlphabet.firstIndex(of: char) else { return nil }
            values.append(value)
        }
        let body = String(chars.prefix(9))
        guard values[9] == PixelPet.checksum(body) else { return nil }
        let species = Species.allCases, stages = Stage.allCases, accessories = Accessory.allCases
        let tones = Tone.allCases, moods = Mood.allCases
        let level = values[5] * 32 + values[6]
        let nameIndex = values[7] * 32 + values[8]
        guard values[0] < species.count, values[1] < stages.count, values[2] < accessories.count,
              values[3] < tones.count, values[4] < moods.count,
              (1...PixelPet.maxLevel).contains(level), nameIndex < PixelPet.nameCount
        else { return nil }
        self.init(
            species: species[values[0]], stage: stages[values[1]], accessory: accessories[values[2]],
            tone: tones[values[3]], mood: moods[values[4]], level: level, nameIndex: nameIndex
        )
    }

    private static func checksum(_ body: String) -> Int {
        Int(stableHash(codePrefix + body) % UInt64(codeAlphabet.count))
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        guard let pet = PixelPet(code: text) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not a pet code: \(text)")
        }
        self = pet
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(code)
    }
}

// MARK: - Animation frames

nonisolated extension PixelPet {
    /// One drawable moment: what the pet is doing at a given time.
    nonisolated struct Frame: Sendable, Hashable {
        nonisolated enum Eyes: Sendable, Hashable { case open, closed, happy, heavy }
        nonisolated enum Mouth: Sendable, Hashable { case smile, grin, flat, small }
        nonisolated enum Effect: Sendable, Hashable { case none, zzz, heart, dots }

        var lift = 0
        var eyes: Eyes = .open
        var mouth: Mouth = .smile
        var effect: Effect = .none
        var effectStep = 0
        /// Legend twinkle phase 0..<6, nil for other stages.
        var sparkle: Int?
    }

    /// A still pose that still tells the mood (used for `animated: false` and Reduce Motion).
    var restingFrame: Frame {
        var frame = Frame(mouth: baseMouth)
        switch mood {
        case .happy: frame.effect = .heart; frame.effectStep = 3
        case .content: break
        case .bored: frame.eyes = .heavy; frame.effect = .dots; frame.effectStep = 3
        case .sleepy: frame.eyes = .closed; frame.effect = .zzz; frame.effectStep = 5
        }
        if stage == .legend { frame.sparkle = 2 }
        return frame
    }

    private var baseMouth: Frame.Mouth {
        switch mood {
        case .happy: .grin
        case .content: .smile
        case .bored: .flat
        case .sleepy: .small
        }
    }

    /// The frame at `time` (seconds, any epoch). Each pet runs slightly out of
    /// phase with others so a row of avatars doesn't blink in unison.
    func frame(at time: TimeInterval) -> Frame {
        let t = time + Double(nameIndex) * 0.37
        func phase(_ period: Double) -> Double {
            let r = t.truncatingRemainder(dividingBy: period)
            return r < 0 ? r + period : r
        }
        var frame = Frame(mouth: baseMouth)
        let blinkPeriod = 3.3 + Double(nameIndex % 5) * 0.35
        let blinking = phase(blinkPeriod) < 0.15
        switch mood {
        case .happy:
            let u = phase(5.2)
            if u < 0.5 {
                frame.lift = [1, 2, 3, 2, 1][min(Int(u / 0.1), 4)]
                frame.eyes = .happy
            } else {
                frame.lift = phase(0.8) < 0.4 ? 1 : 0
                frame.eyes = u < 0.9 ? .happy : (blinking ? .closed : .open)
            }
            if u >= 0.3, u < 2.1 {
                frame.effect = .heart
                frame.effectStep = Int((u - 0.3) / 0.3)
            }
        case .content:
            frame.lift = phase(1.6) < 0.8 ? 0 : 1
            frame.eyes = blinking ? .closed : .open
        case .bored:
            frame.lift = phase(2.4) < 1.2 ? 0 : 1
            frame.eyes = blinking ? .closed : .heavy
            let u = phase(4.5)
            if u >= 1.0 {
                frame.effect = .dots
                frame.effectStep = min(Int((u - 1.0) / 0.5) + 1, 3)
            }
        case .sleepy:
            frame.lift = phase(3.0) < 1.5 ? 0 : 1
            frame.eyes = .closed
            frame.effect = .zzz
            frame.effectStep = Int(phase(2.8) / 0.4)
        }
        if stage == .legend { frame.sparkle = Int(phase(1.8) / 0.3) }
        return frame
    }
}

// MARK: - Bitmap

/// A rendered 24×24 frame. 0 is transparent, anything else is 0xFFRRGGBB.
nonisolated struct PetBitmap: Sendable, Hashable {
    static let size = 24
    var pixels = [UInt32](repeating: 0, count: size * size)

    subscript(x: Int, y: Int) -> UInt32 {
        get { (0..<Self.size).contains(x) && (0..<Self.size).contains(y) ? pixels[y * Self.size + x] : 0 }
        set {
            guard (0..<Self.size).contains(x), (0..<Self.size).contains(y) else { return }
            pixels[y * Self.size + x] = newValue
        }
    }
}

nonisolated extension PixelPet {
    func bitmap(frame: Frame? = nil) -> PetBitmap {
        var renderer = PetRenderer(pet: self, frame: frame ?? restingFrame)
        return renderer.render()
    }
}

nonisolated private struct PetRenderer {
    let pet: PixelPet
    let frame: PixelPet.Frame
    let sprite: PetArt.Sprite
    let colors: [UInt32]
    let ox: Int
    let oy: Int
    var out = PetBitmap()

    init(pet: PixelPet, frame: PixelPet.Frame) {
        self.pet = pet
        self.frame = frame
        sprite = PetArt.sprite(pet.species, pet.stage)
        colors = PetArt.palette(pet.species, pet.tone)
        ox = PetArt.centerX - sprite.head.x
        oy = PetArt.groundY - (sprite.height - 1) - frame.lift
    }

    func color(_ key: UInt8) -> UInt32 { colors[Int(key & 0x7F)] }
    var outline: UInt32 { color(PetArt.k("o")) }

    mutating func put(_ x: Int, _ y: Int, _ c: UInt32) {
        if c != 0 { out[x, y] = c }
    }

    /// Sprite-space put.
    mutating func sput(_ x: Int, _ y: Int, _ c: UInt32) { put(ox + x, oy + y, c) }

    mutating func render() -> PetBitmap {
        drawBody()
        drawEyes()
        drawMouth()
        drawAccessory()
        if pet.stage == .legend { stamp(PetArt.crown, at: sprite.head, dy: PetArt.crown.dy) }
        drawEffect()
        drawSparkles()
        return out
    }

    mutating func drawBody() {
        for y in 0..<sprite.height {
            for x in 0..<sprite.width {
                let key = sprite.key(x, y)
                if key != PetArt.k(".") { sput(x, y, color(key)) }
            }
        }
    }

    /// Colour just above an eye: what an eyelid would be.
    func lidColor(_ eye: PetArt.Rect) -> UInt32 {
        for (x, y) in [(eye.x, eye.y - 1), (eye.x - 1, eye.y), (eye.x + eye.w, eye.y)] {
            let key = sprite.key(x, y)
            if key != PetArt.k("."), key != PetArt.k("o"), key != PetArt.k("E") { return color(key) }
        }
        return color(PetArt.k("b"))
    }

    mutating func drawEyes() {
        let eye = color(PetArt.k("e"))
        let shine = color(PetArt.k("w"))
        let heavyLid = color(PetArt.k("s"))
        for (index, rect) in sprite.eyes.enumerated() {
            let lid = lidColor(rect)
            let isLeft = index == 0
            for dy in 0..<rect.h {
                for dx in 0..<rect.w {
                    let last = dy == rect.h - 1
                    var c = eye
                    switch frame.eyes {
                    case .open:
                        if dx == 0, dy == 0, rect.w > 1, rect.h > 1 { c = shine }
                    case .heavy:
                        if dy == 0, rect.h > 1 { c = heavyLid }
                    case .closed:
                        if !last { c = lid }
                    case .happy:
                        // ◠ ◠ : top row plus the outer corner below it.
                        let outer = isLeft ? dx == 0 : dx == rect.w - 1
                        if dy > 0, !(dy == 1 && outer) { c = lid }
                    }
                    sput(rect.x + dx, rect.y + dy, c)
                }
            }
        }
    }

    mutating func drawMouth() {
        guard let m = sprite.mouth else { return }
        let ink = color(PetArt.k("i"))
        let tongue = color(PetArt.k("t"))
        let offsets: [(Int, Int, UInt32)]
        switch frame.mouth {
        case .smile: offsets = [(-1, 0, ink), (1, 0, ink), (0, 1, ink)]
        case .grin: offsets = [(-1, 0, ink), (0, 0, ink), (1, 0, ink), (0, 1, tongue)]
        case .flat: offsets = [(-1, 0, ink), (0, 0, ink), (1, 0, ink)]
        case .small: offsets = [(0, 0, ink)]
        }
        for (dx, dy, c) in offsets { sput(m.x + dx, m.y + dy, c) }
    }

    /// Stamps an overlay so its bottom row lands `dy` rows below `anchor`, centred on it.
    mutating func stamp(_ overlay: PetArt.Overlay, at anchor: PetArt.Point, dy: Int, dx: Int = 0) {
        let left = anchor.x + dx - overlay.width / 2
        let top = anchor.y + dy - (overlay.height - 1)
        for y in 0..<overlay.height {
            for x in 0..<overlay.width {
                let key = overlay.key(x, y)
                if key != PetArt.k(".") { sput(left + x, top + y, color(key)) }
            }
        }
    }

    /// First outline cell left and right of `x` on `row`.
    func silhouette(row: Int, from x: Int) -> (left: Int, right: Int) {
        let o = PetArt.k("o")
        var l = x, r = x
        if sprite.key(x, row) == o { return (x, x) }
        while l > 0, sprite.key(l, row) != o { l -= 1 }
        while r < sprite.width - 1, sprite.key(r, row) != o { r += 1 }
        return (l, r)
    }

    mutating func drawAccessory() {
        let accessory = pet.accessory
        if pet.stage == .legend, accessory.isHat { return }
        let ink = outline
        switch accessory {
        case .none:
            return
        case .specs, .shades, .glasses3D:
            drawGlasses(accessory)
        case .headband:
            guard let top = sprite.eyes.map(\.y).min() else { return }
            let row = top - 2
            let (l, r) = silhouette(row: row, from: sprite.head.x)
            let red = color(PetArt.k("r")), dark = color(PetArt.k("R"))
            for x in l...r { sput(x, row, x == l || x == r ? dark : red) }
            sput(r + 1, row, red); sput(r + 2, row + 1, red); sput(r + 1, row + 1, dark)
            sput(r + 2, row + 2, dark)
        case .headphones:
            guard let top = sprite.eyes.map(\.y).min() else { return }
            let (l, r) = silhouette(row: top, from: sprite.head.x)
            let band = color(PetArt.k("K")), cup = color(PetArt.k("r"))
            let crown = sprite.head.y - 1
            for y in stride(from: crown + 1, through: top - 1, by: 1) { sput(l, y, band); sput(r, y, band) }
            for x in stride(from: l + 1, through: r - 1, by: 1) { sput(x, crown, band) }
            for side in [l - 1, r] {
                for y in top - 1...top + 2 {
                    for x in side...side + 1 {
                        let edge = y == top - 1 || y == top + 2 || x == side && side < l || x == side + 1 && side == r
                        sput(x, y, edge ? ink : cup)
                    }
                }
            }
        case .scarf:
            let row = sprite.neck
            let (l, r) = silhouette(row: row, from: sprite.head.x)
            let red = color(PetArt.k("r")), dark = color(PetArt.k("R"))
            for x in l...r {
                sput(x, row, x == l || x == r ? ink : red)
                sput(x, row + 1, x == l || x == r ? ink : dark)
            }
            // Hanging end.
            let tx = r - 3
            for y in row + 2...row + 4 { sput(tx, y, red); sput(tx + 1, y, dark); sput(tx - 1, y, ink); sput(tx + 2, y, ink) }
            sput(tx, row + 5, ink); sput(tx + 1, row + 5, ink)
        case .bowtie:
            stamp(PetArt.bowtie, at: PetArt.Point(x: sprite.head.x, y: sprite.neck), dy: 1)
        case .popcorn:
            stampLeft(PetArt.popcorn, at: sprite.hand)
        case .magnifier:
            stampLeft(PetArt.magnifier, at: sprite.hand)
        case .bow:
            stamp(PetArt.bow, at: sprite.head, dy: PetArt.bow.dy, dx: sprite.headHalfWidth - 2)
        case .horns:
            let spread = max(2, sprite.headHalfWidth / 2 - 1)
            let horn = PetArt.horn
            for side in [-1, 1] {
                let baseX = sprite.head.x + side * spread
                for y in 0..<horn.height {
                    for x in 0..<horn.width {
                        let key = horn.key(x, y)
                        guard key != PetArt.k(".") else { continue }
                        // Authored as the left horn; mirrored for the right one.
                        let dx = side < 0 ? x - (horn.width - 1) : (horn.width - 1) - x
                        sput(baseX + dx, sprite.head.y + 1 - (horn.height - 1) + y, color(key))
                    }
                }
            }
        default:
            guard let overlay = PetArt.hats[accessory] else { return }
            stamp(overlay, at: sprite.head, dy: overlay.dy)
        }
    }

    /// Bottom-left of the overlay at `anchor`.
    mutating func stampLeft(_ overlay: PetArt.Overlay, at anchor: PetArt.Point) {
        let top = anchor.y - (overlay.height - 1)
        for y in 0..<overlay.height {
            for x in 0..<overlay.width {
                let key = overlay.key(x, y)
                if key != PetArt.k(".") { sput(anchor.x + x, top + y, color(key)) }
            }
        }
    }

    mutating func drawGlasses(_ kind: PixelPet.Accessory) {
        guard sprite.eyes.count == 2 else { return }
        let a = sprite.eyes[0], b = sprite.eyes[1]
        let ink = outline
        let fill: [UInt32]
        switch kind {
        case .shades: fill = [color(PetArt.k("k")), color(PetArt.k("k"))]
        case .glasses3D: fill = [color(PetArt.k("r")), color(PetArt.k("q"))]
        default: fill = [0, 0]
        }
        for (i, eye) in [a, b].enumerated() {
            let x0 = eye.x - 1, x1 = eye.x + eye.w, y0 = eye.y - 1, y1 = eye.y + eye.h
            for y in y0...y1 {
                for x in x0...x1 {
                    let border = x == x0 || x == x1 || y == y0 || y == y1
                    let corner = (x == x0 || x == x1) && (y == y0 || y == y1)
                    if border {
                        if kind == .specs, corner { continue }
                        sput(x, y, ink)
                    } else if fill[i] != 0 {
                        sput(x, y, fill[i])
                    }
                }
            }
            if kind == .shades { sput(eye.x, eye.y, color(PetArt.k("w"))) }
        }
        // Bridge.
        let bridgeY = a.y - (kind == .specs ? 0 : 1)
        for x in stride(from: a.x + a.w + 1, to: b.x - 1, by: 1) { sput(x, bridgeY, ink) }
    }

    mutating func drawEffect() {
        guard frame.effect != .none else { return }
        // Effects float in the air next to the head; they don't bob with the body.
        let ax = PetArt.centerX + sprite.headHalfWidth - 1
        let ay = PetArt.groundY - (sprite.height - 1) + sprite.head.y
        let step = frame.effectStep
        switch frame.effect {
        case .none:
            break
        case .zzz:
            // Small z, then a big Z drifting up and right.
            if step < 6 { stampFree(PetArt.zSmall, x: ax, y: ay - 3 - step / 3) }
            if step >= 2, step < 7 { stampFree(PetArt.zBig, x: ax + 3, y: ay - 8 - (step - 2) / 3) }
        case .heart:
            guard step < 6 else { return }
            let glyph = step == 0 ? PetArt.heartSmall : PetArt.heart
            stampFree(glyph, x: ax + 1, y: ay - 4 - step)
        case .dots:
            let bubble = PetArt.bubble
            let bx = min(ax, PetBitmap.size - bubble.width), by = max(ay - 7, 0)
            stampFree(bubble, x: bx, y: by)
            let ink = colors[Int(PetArt.k("K"))]
            for i in 0..<min(step, 3) { put(bx + 2 + i * 2, by + 2, ink) }
        }
    }

    /// Canvas-space stamp with top-left at (x, y); clipped at the canvas edges.
    mutating func stampFree(_ overlay: PetArt.Overlay, x: Int, y: Int) {
        let maxX = PetBitmap.size - overlay.width
        let left = min(x, maxX)
        let top = max(y, 0)
        for oy in 0..<overlay.height {
            for ox in 0..<overlay.width {
                let key = overlay.key(ox, oy)
                if key != PetArt.k(".") { put(left + ox, top + oy, colors[Int(key & 0x7F)]) }
            }
        }
    }

    mutating func drawSparkles() {
        guard let phase = frame.sparkle else { return }
        let gold = colors[Int(PetArt.k("y"))], white = colors[Int(PetArt.k("w"))]
        let left = ox - 1, right = min(ox + sprite.width, PetArt.centerX + sprite.headHalfWidth + 2)
        let top = PetArt.groundY - (sprite.height - 1) + sprite.head.y
        let spots = [(left, top + 3, phase), (right, top + 8, (phase + 3) % 6), (left + 1, PetArt.groundY - 2, (phase + 2) % 6)]
        for (x, y, p) in spots {
            let reach = [0, 1, 2, 1, 0, -1][p]
            guard reach >= 0 else { continue }
            put(x, y, reach == 0 ? gold : white)
            for d in stride(from: 1, through: reach, by: 1) {
                put(x - d, y, gold); put(x + d, y, gold); put(x, y - d, gold); put(x, y + d, gold)
            }
        }
    }
}

// MARK: - Art

/// Sprite and overlay data. Grids use one character per pixel:
///
///     .  transparent      o  outline         e  eye ink (palette)
///     b  base             s  shade           l  light
///     a  accent (belly, muzzle)              c  detail (ears, cheeks, beak)
///     d  dark detail      w  white           t  tongue
///     E  eye (drawn by mood)                 M  mouth anchor (drawn by mood)
///
/// Overlays may also use the shared accessory colours (r R y Y g G p P u U n N h H v V m j q k K).
nonisolated enum PetArt {
    static let centerX = 11
    static let groundY = 23

    static func k(_ c: Character) -> UInt8 { c.asciiValue ?? 46 }

    nonisolated struct Point: Sendable, Hashable { var x: Int; var y: Int }
    nonisolated struct Rect: Sendable, Hashable { var x: Int; var y: Int; var w: Int; var h: Int }

    nonisolated struct Sprite: Sendable {
        let width: Int
        let height: Int
        let keys: [UInt8]
        /// Centre of the top of the skull (hats sit here).
        let head: Point
        /// Row of the chin/neck line (scarves, bow ties).
        let neck: Int
        /// Bottom-left of held props.
        let hand: Point
        let eyes: [Rect]
        let mouth: Point?
        let headHalfWidth: Int
        /// False when the source rows had different lengths (an authoring mistake).
        let isRectangular: Bool

        func key(_ x: Int, _ y: Int) -> UInt8 {
            guard x >= 0, y >= 0, x < width, y < height else { return 46 }
            return keys[y * width + x]
        }
    }

    nonisolated struct Overlay: Sendable {
        let width: Int
        let height: Int
        let keys: [UInt8]
        /// Rows below the anchor where the bottom row lands.
        let dy: Int
        let isRectangular: Bool

        init(_ text: String, dy: Int = 0) {
            let rows = PetArt.rows(text)
            let width = rows.map(\.count).max() ?? 0
            self.width = width
            height = rows.count
            keys = rows.flatMap { $0 + [UInt8](repeating: 46, count: width - $0.count) }
            self.dy = dy
            isRectangular = Set(rows.map(\.count)).count <= 1
        }

        func key(_ x: Int, _ y: Int) -> UInt8 {
            guard x >= 0, y >= 0, x < width, y < height else { return 46 }
            return keys[y * width + x]
        }
    }

    nonisolated struct Patch: Sendable {
        var x: Int
        var y: Int
        var text: String
        /// Only fills transparent cells (tails behind bodies).
        var under = true
    }

    static func rows(_ text: String) -> [[UInt8]] {
        text.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map { Array($0.utf8) }
    }

    /// Builds a symmetric sprite from its left half (including the centre column).
    static func sym(
        _ half: String, head: Int, neck: Int, hand: (Int, Int), patches: [Patch] = []
    ) -> Sprite {
        let halves = rows(half)
        let full = halves.map { $0 + $0.dropLast().reversed() }
        let rectangular = Set(halves.map(\.count)).count == 1
            && patches.allSatisfy { Set(rows($0.text).map(\.count)).count == 1 }
        return build(full, headX: (halves.first?.count ?? 1) - 1, headY: head, neck: neck, hand: hand,
                     patches: patches, rectangular: rectangular)
    }

    static func build(
        _ grid: [[UInt8]], headX: Int, headY: Int, neck: Int, hand: (Int, Int), patches: [Patch],
        rectangular: Bool
    ) -> Sprite {
        var width = grid.map(\.count).max() ?? 0
        var height = grid.count
        for patch in patches {
            let pr = rows(patch.text)
            width = max(width, patch.x + (pr.map(\.count).max() ?? 0))
            height = max(height, patch.y + pr.count)
        }
        var keys = [UInt8](repeating: 46, count: width * height)
        for (y, row) in grid.enumerated() {
            for (x, key) in row.enumerated() { keys[y * width + x] = key }
        }
        for patch in patches {
            for (dy, row) in rows(patch.text).enumerated() {
                for (dx, key) in row.enumerated() where key != 46 {
                    let i = (patch.y + dy) * width + patch.x + dx
                    if !patch.under || keys[i] == 46 { keys[i] = key }
                }
            }
        }
        // Mouth anchor: remember it, then paint it like its left neighbour.
        var mouth: Point?
        for i in keys.indices where keys[i] == k("M") {
            mouth = Point(x: i % width, y: i / width)
            keys[i] = i > 0 ? keys[i - 1] : k("b")
        }
        // Eyes: connected runs of E.
        var eyes: [Rect] = []
        var seen = Set<Int>()
        for i in keys.indices where keys[i] == k("E") && !seen.contains(i) {
            var stack = [i], minX = width, minY = height, maxX = 0, maxY = 0
            seen.insert(i)
            while let j = stack.popLast() {
                let x = j % width, y = j / width
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]
                where nx >= 0 && ny >= 0 && nx < width && ny < height {
                    let n = ny * width + nx
                    if keys[n] == k("E"), !seen.contains(n) { seen.insert(n); stack.append(n) }
                }
            }
            eyes.append(Rect(x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1))
        }
        eyes.sort { $0.x < $1.x }
        // Half width of the head: distance from centre to the widest outline at eye level.
        var half = 4
        if let eyeRow = eyes.first?.y {
            var x = headX
            while x < width - 1, !(keys[eyeRow * width + x] == k("o") && (x + 1 >= width || keys[eyeRow * width + x + 1] == 46)) { x += 1 }
            half = x - headX
        }
        return Sprite(
            width: width, height: height, keys: keys, head: Point(x: headX, y: headY), neck: neck,
            hand: Point(x: hand.0, y: hand.1), eyes: eyes, mouth: mouth, headHalfWidth: half,
            isRectangular: rectangular
        )
    }

    // MARK: Lookup

    private static let sprites: [[Sprite]] = PixelPet.Species.allCases.map { species in
        let set = art(species)
        return [set.baby, set.teen, set.adult]
    }

    static func sprite(_ species: PixelPet.Species, _ stage: PixelPet.Stage) -> Sprite {
        let s = PixelPet.Species.allCases.firstIndex(of: species) ?? 0
        let i: Int
        switch stage {
        case .baby: i = 0
        case .teen: i = 1
        case .adult, .legend: i = 2
        }
        return sprites[s][i]
    }

    private static let palettes: [[[UInt32]]] = PixelPet.Species.allCases.map { species in
        PixelPet.Tone.allCases.map { tone in makePalette(paletteSpec(species, tone)) }
    }

    static func palette(_ species: PixelPet.Species, _ tone: PixelPet.Tone) -> [UInt32] {
        let s = PixelPet.Species.allCases.firstIndex(of: species) ?? 0
        let t = PixelPet.Tone.allCases.firstIndex(of: tone) ?? 0
        return palettes[s][t]
    }

    /// Keys every palette must define (the sprite keys plus `e`).
    static let spriteKeys: Set<Character> = [".", "o", "b", "s", "l", "a", "c", "d", "w", "t", "e", "i", "E", "M"]

    /// Every overlay, for checks.
    static var allOverlays: [(name: String, overlay: Overlay)] {
        var list: [(String, Overlay)] = [
            ("crown", crown), ("horn", horn), ("bow", bow), ("bowtie", bowtie), ("popcorn", popcorn),
            ("magnifier", magnifier), ("zSmall", zSmall), ("zBig", zBig), ("heart", heart),
            ("heartSmall", heartSmall), ("bubble", bubble),
        ]
        for (accessory, overlay) in hats.sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
            list.append((accessory.rawValue, overlay))
        }
        return list
    }

    /// Keys of the shared accessory colours.
    static var sharedKeys: Set<Character> {
        Set(shared.split(separator: " ").compactMap(\.first))
    }

    static let shared = "w=fff8ef t=ff6b8a r=e8473f R=a8292f y=ffd23f Y=e09b1a g=c9cfdd G=6b7187 p=ff7eb6 P=d2468a u=4f8cff U=2f4fa8 n=8a5a3c N=5e3a26 h=e2c58a H=b0905a v=7b5cff V=4f36c4 m=6fae4f j=3f7a37 q=4fe0e8 k=1d1b26 K=4a4a5e"

    static func makePalette(_ spec: String) -> [UInt32] {
        var table = [UInt32](repeating: 0, count: 128)
        for pair in (shared + " " + spec).split(separator: " ") {
            let parts = pair.split(separator: "=")
            guard parts.count == 2, let key = parts[0].first?.asciiValue, let rgb = UInt32(parts[1], radix: 16) else { continue }
            table[Int(key)] = 0xFF00_0000 | rgb
        }
        if table[Int(k("e"))] == 0 { table[Int(k("e"))] = table[Int(k("o"))] }
        if table[Int(k("i"))] == 0 { table[Int(k("i"))] = table[Int(k("o"))] }
        return table
    }

    // MARK: Overlays

    static let crown = Overlay("""
        .o.o.o.
        oyoyoyo
        oyyyyyo
        oyryuyo
        ooooooo
        """, dy: 1)

    static let hats: [PixelPet.Accessory: Overlay] = [
        .partyHat: Overlay("""
            ...y...
            ..oyo..
            ..oro..
            .orrro.
            .oyyyo.
            orrrrro
            ooooooo
            """, dy: 1),
        .wizardHat: Overlay("""
            ....o....
            ...ovo...
            ...ovo...
            ..ovvvo..
            ..ovyvo..
            .ovvvvvo.
            ooooooooo
            oVVVVVVVo
            ooooooooo
            """, dy: 2),
        .fedora: Overlay("""
            ..ooooo..
            .onnnnno.
            .oNNNNNo.
            onnnnnnno
            ooooooooo
            """, dy: 1),
        .cowboyHat: Overlay("""
            ...ooooo...
            ..onnnnno..
            o.oNNNNNo.o
            onooooooono
            .onnnnnnno.
            ..ooooooo..
            """, dy: 1),
        .explorerHat: Overlay("""
            ...ooo...
            ..ohhho..
            .ohhhhho.
            .oHHHHHo.
            ohhhhhhho
            ooooooooo
            """, dy: 1),
        .helmet: Overlay("""
            ..ooooo..
            .ommmmmo.
            ommjmmmmo
            ommmmmjmo
            ojjjjjjjo
            ooooooooo
            """, dy: 1),
        .propellerCap: Overlay("""
            .rrrouuu.
            ....o....
            ..ooooo..
            .oyrrruo.
            oyyrrruuo
            ooooooooo
            """, dy: 1),
    ]

    /// Left horn; its bottom-right pixel sits on the skull.
    static let horn = Overlay("""
        o...
        oro.
        orRo
        .oro
        """)

    static let bow = Overlay("""
        oo...oo
        oppopPo
        opPPPPo
        oppopPo
        oo...oo
        """, dy: 2)

    static let bowtie = Overlay("""
        oo...oo
        orroRRo
        orRRRRo
        orroRRo
        oo...oo
        """, dy: 1)

    static let popcorn = Overlay("""
        .wyw.
        wywyw
        orwro
        orwro
        orwro
        .ooo.
        """)

    static let magnifier = Overlay("""
        .ooo..
        owqqo.
        oqqqo.
        .ooon.
        ....nn
        """)

    static let zSmall = Overlay("""
        uuu
        .u.
        uuu
        """)

    static let zBig = Overlay("""
        uuuu
        ..u.
        .u..
        uuuu
        """)

    static let heart = Overlay("""
        pp.pp
        ppppp
        .ppp.
        ..p..
        """)

    static let heartSmall = Overlay("""
        p.p
        .p.
        """)

    static let bubble = Overlay("""
        .ooooooo.
        owwwwwwwo
        owwwwwwwo
        owwwwwwwo
        .ooooooo.
        .o.......
        o........
        """)
}

// MARK: - Species art

nonisolated extension PetArt {
    nonisolated struct SpriteSet: Sendable {
        let baby: Sprite
        let teen: Sprite
        let adult: Sprite
    }

    static func art(_ species: PixelPet.Species) -> SpriteSet {
        switch species {
        case .fox: fox
        case .turtle: turtle
        case .cat: cat
        case .frog: frog
        case .raccoon: raccoon
        case .raven: raven
        case .ghost: ghost
        case .robot: robot
        case .dragon: dragon
        case .owl: owl
        case .slime: slime
        case .bunny: bunny
        case .puppy: puppy
        case .songbird: songbird
        case .hedgehog: hedgehog
        }
    }

    /// Palette per species and tone: o outline, b base, s shade, l light, a accent, c detail, d dark detail
    /// (optional e eye ink, i mouth ink; both default to the outline).
    static func paletteSpec(_ species: PixelPet.Species, _ tone: PixelPet.Tone) -> String {
        switch (species, tone) {
        case (.fox, .classic): "o=2a1a1f b=f2873a s=c95a26 l=ffb066 a=fff3e2 c=5b2f25 d=ff9aa2"
        case (.fox, .sunny): "o=2e1c14 b=f7b538 s=d4861f l=ffd77a a=fff7e6 c=7a4a1e d=ff9f8f"
        case (.fox, .dusk): "o=1e2130 b=8c96a8 s=646d80 l=b6bfcd a=f4f6fa c=3b4150 d=f1a0b5"

        case (.turtle, .classic): "o=1f2a1a b=9ad86a s=6aac48 l=c6f09c a=b07a3e c=7a4e26 d=d9a45c"
        case (.turtle, .sunny): "o=2a2414 b=b4e66e s=84b844 l=dcf8a8 a=e0a030 c=a86a1a d=f7cd6a"
        case (.turtle, .dusk): "o=161c2a b=7fc4b0 s=559a88 l=b0eadc a=5e6a8a c=3c4560 d=8e9abc"

        case (.cat, .classic): "o=241c2b b=9aa0b8 s=6e7390 l=c4c9db a=eef0f6 c=ff9ab0 d=5d6280"
        case (.cat, .sunny): "o=2e1c16 b=f0a860 s=d08040 l=ffd09a a=fff4e4 c=ff8f8f d=c06a2c"
        case (.cat, .dusk): "o=15121c b=4a4560 s=343048 l=6a6588 a=8c86aa c=ff8fb0 d=2a2638 e=ffd23f"

        case (.frog, .classic): "o=1c2a1e b=7ccf5a s=4f9c3c l=b4ec8a a=eaf7b8 c=ff8fa3 d=3a7a2e"
        case (.frog, .sunny): "o=2e2010 b=f5c542 s=d99a28 l=ffe48a a=fff6d6 c=ff8f8f d=c07a1c"
        case (.frog, .dusk): "o=141c30 b=4f8fe0 s=3463a8 l=8ab8ff a=d8e8ff c=ff9fd0 d=1f3a70"

        case (.raccoon, .classic): "o=1d1a22 b=9c9caa s=6e6e7e l=c6c6d0 a=f0f0f4 c=403c4a d=5a5866 e=0c0a10"
        case (.raccoon, .sunny): "o=2a1e16 b=c0a088 s=957a64 l=dcc4ae a=fbf3ea c=4e3a30 d=6e5646 e=120c08"
        case (.raccoon, .dusk): "o=12121c b=6a6c86 s=4c4e66 l=8e90aa a=dcdcea c=26263a d=3a3c52 e=e8e4ff"

        case (.raven, .classic): "o=14121c b=3d3a5c s=2a2742 l=6f6a9a a=8a85b8 c=f2c14e d=23203a e=0a0810"
        case (.raven, .sunny): "o=1a1420 b=4a3a6a s=33284c l=8070b0 a=a090d0 c=ffb040 d=2a2040 e=0a0810"
        case (.raven, .dusk): "o=0c0c14 b=2c2c3a s=1c1c28 l=58586e a=70708a c=d0d4e0 d=141420 e=ff4a5a"

        case (.ghost, .classic): "o=2a2340 b=f4f2ff s=c9c3ea l=ffffff a=e2def8 c=ffa6c9 d=8a80c0"
        case (.ghost, .sunny): "o=1e3028 b=e6fbef s=b0e0c6 l=ffffff a=d0f2de c=ffa6b8 d=70b090"
        case (.ghost, .dusk): "o=1a1430 b=9a90d0 s=7268b0 l=c4bcf0 a=8a80c4 c=ff9fd8 d=4a4080"

        case (.robot, .classic): "o=1c2030 b=a9b8cc s=7486a0 l=d6e0ec a=5a6a88 c=ff5a5a d=1e2a44 e=5ef2ff i=5ef2ff t=2aa8c0"
        case (.robot, .sunny): "o=2a2016 b=e8c070 s=b8904a l=fde3a8 a=a07838 c=ff6a4a d=2a2238 e=8affc1 i=8affc1 t=4ab880"
        case (.robot, .dusk): "o=0e1018 b=5a6078 s=3e4358 l=7e86a2 a=2e3244 c=ff5ad0 d=10131f e=ff7ae0 i=ff7ae0 t=b04a9a"

        case (.dragon, .classic): "o=22183a b=a07ef0 s=7656c4 l=c8b0ff a=ffd98a c=fff1c8 d=6a4ab8"
        case (.dragon, .sunny): "o=2e1410 b=ff7a4a s=d8542c l=ffa878 a=ffe08a c=fff4d0 d=c03a2a"
        case (.dragon, .dusk): "o=0e2024 b=3f9a8e s=2c7268 l=6ccab8 a=d8f0c0 c=e8f4f0 d=1e5450"

        case (.owl, .classic): "o=2a1c16 b=9a6a44 s=70482c l=c89a6a a=fff1d6 c=f0a030 d=5a3a22"
        case (.owl, .sunny): "o=3a3028 b=d8d0c2 s=aaa090 l=f4efe6 a=ffffff c=f5b030 d=7a7060"
        case (.owl, .dusk): "o=161a26 b=6a7088 s=4c5068 l=9098b0 a=e0e4f0 c=f0c040 d=3a3e52"

        case (.slime, .classic): "o=12303a b=5fd3c0 s=37a698 l=a8f5e8 a=e8fffb c=ff9fb8 d=2f8c80"
        case (.slime, .sunny): "o=3a1428 b=ff9fc8 s=e070a0 l=ffc8e0 a=fff0f6 c=ff6f9f d=c05080"
        case (.slime, .dusk): "o=1a1238 b=8a6ae0 s=6248b8 l=b8a0ff a=ece6ff c=ff9fd8 d=4a3496"

        case (.bunny, .classic): "o=3a2430 b=fbf3f5 s=e0cad4 l=ffffff a=ffe6ee c=ff9fbf d=d0b0c0"
        case (.bunny, .sunny): "o=3a2418 b=e8b88a s=c8925e l=f8d8b0 a=fff0e0 c=ff9f9f d=a87040"
        case (.bunny, .dusk): "o=1e1a2a b=a8a0b8 s=80789a l=cac4d6 a=ece8f4 c=ff9fc8 d=5e5674"

        case (.puppy, .classic): "o=2e1f18 b=e8b878 s=c48e50 l=f8d8a8 a=fff4e2 c=8a5a34 d=6a4428"
        case (.puppy, .sunny): "o=2a2228 b=fbf7f0 s=ddd4c8 l=ffffff a=ffffff c=3a3236 d=2a2428"
        case (.puppy, .dusk): "o=161a24 b=9aa4b4 s=707a8c l=c4ccd8 a=f4f6fa c=5a6274 d=3e4452"

        case (.songbird, .classic): "o=3a2a14 b=ffd84a s=e8a828 l=fff0a0 a=fff8d8 c=ff8a3a d=d89020"
        case (.songbird, .sunny): "o=3a1820 b=ff9fb0 s=e07088 l=ffd0d8 a=fff0f2 c=ff8a3a d=c05068"
        case (.songbird, .dusk): "o=141c34 b=5a8ae0 s=3a62b0 l=9ab8ff a=e8f0ff c=ffb040 d=2a4a90"

        case (.hedgehog, .classic): "o=2a1c14 b=8a6040 s=5e3e28 l=b08458 a=f6dcb4 c=3a2418 d=ffa0a0"
        case (.hedgehog, .sunny): "o=2e2014 b=c89058 s=9a6a38 l=e0b07a a=fff0d8 c=3a2418 d=ffa0a0"
        case (.hedgehog, .dusk): "o=161620 b=6a6a7a s=4a4a58 l=8e8ea0 a=e8e6f0 c=1e1e28 d=ff9fc0"
        }
    }

    static let fox = SpriteSet(
        baby: sym("""
            .o.....
            .oo.ooo
            .obobbb
            obbbbbb
            obEEbbb
            obEEbbb
            obaaaao
            .oaaaaM
            ..ooaaa
            ..obbaa
            ..obbbb
            ...ooo.
            """, head: 1, neck: 8, hand: (9, 10),
            patches: [Patch(x: 10, y: 6, text: """
                .ooo
                obbo
                obao
                ooo.
                """)]),
        teen: sym("""
            .o......
            .oo.....
            .obooooo
            .obbbbbb
            obbbbbbb
            obbEEbbb
            obaEEbbb
            obaaaaao
            .oaaaaaM
            ..ooaaaa
            ..obbaaa
            ..obbaaa
            ..obbbaa
            ...ooo.o
            """, head: 2, neck: 9, hand: (11, 12),
            patches: [Patch(x: 12, y: 7, text: """
                ...oo.
                ..oaao
                .obbao
                obbbo.
                obbo..
                ooo...
                """)]),
        adult: sym("""
            .o.......
            .oo......
            .obo.....
            .obco....
            .obcboooo
            .obbbbbbb
            obbbbbbbb
            obbbEEbbb
            obaaEEbbb
            obaaaaaao
            .oaaaaaaM
            ..ooaaaaa
            ...obbaaa
            ..obbbaaa
            ..obbbaaa
            ..obbbbaa
            ..occobbb
            ...ooo.oo
            """, head: 4, neck: 11, hand: (12, 16),
            patches: [Patch(x: 13, y: 9, text: """
                ....ooo.
                ...oaaao
                ..obaaao
                ..obbbao
                .obbbbo.
                obbbbbo.
                obbbbo..
                .oooo...
                """)])
    )

    static let turtle = SpriteSet(
        baby: sym("""
            ...oooo
            ..obbbb
            .obbbbb
            .obEEbb
            oobEEbb
            odobpbM
            odaoooo
            oacdddd
            occcccc
            ooooooo
            .obo...
            .oo....
            """, head: 0, neck: 6, hand: (9, 9)),
        teen: sym("""
            ....oooo
            ...obbbb
            ..obbbbb
            ..obEEbb
            ooobEEbb
            odobpbbM
            odaobbbb
            oacaoooo
            oacacddd
            occccddd
            oaaacccc
            oooooooo
            .obbo...
            .ooo....
            """, head: 0, neck: 7, hand: (11, 12)),
        adult: sym("""
            .....oooo
            ....obbbb
            ...obbbbb
            ...obbbbb
            ..oobEEbb
            .odobEEbb
            odaobpbbM
            odaaobbbb
            oaacaoooo
            oaacacddd
            occcccddd
            oaacacddd
            oaaaacccc
            ooooooooo
            .obbo....
            .ooo.....
            """, head: 0, neck: 8, hand: (13, 14))
    )

    static let cat = SpriteSet(
        baby: sym("""
            .o.....
            .ocoooo
            obcbdbd
            obbbbbb
            obEEbbb
            obEEbbb
            obbbbac
            .obbbaM
            ..oobaa
            ..obaaa
            ..oaaob
            ...oo.o
            """, head: 1, neck: 8, hand: (9, 10),
            patches: [Patch(x: 10, y: 5, text: """
                ..oo
                .obo
                .obo
                obo.
                oo..
                """)]),
        teen: sym("""
            .o......
            .oo.....
            .ocooooo
            .occbdbd
            obbbbbbd
            obbEEbbb
            obbEEbbb
            obbbbaac
            .obbbaaM
            ..oobbaa
            ..obbaaa
            ..obaaaa
            ..oaaobb
            ...oo.oo
            """, head: 2, neck: 9, hand: (11, 12),
            patches: [Patch(x: 12, y: 5, text: """
                ..oo.
                .obdo
                .obo.
                .obo.
                .obo.
                obo..
                bo...
                """)]),
        adult: sym("""
            .o.......
            .oo......
            .oco.....
            .occooooo
            .obcbbdbd
            obbbbbbbd
            obbbbbbbb
            obbbEEbbb
            obbbEEbbb
            obbbbbaac
            .obbbbaaM
            ..oobbbaa
            ...obbbbb
            ..obbbaaa
            ..obbaaaa
            ..obbaaaa
            ..oaaobbb
            ...oo.ooo
            """, head: 3, neck: 11, hand: (12, 16),
            patches: [Patch(x: 14, y: 7, text: """
                ..oo.
                .obdo
                .obo.
                .obo.
                .obo.
                .obo.
                obo..
                bo...
                """)])
    )

    static let frog = SpriteSet(
        baby: sym("""
            .ooo...
            obbbo..
            obEEboo
            obEEbbb
            obbbbbb
            opbbbbM
            .obbbbb
            .obaaaa
            obbaaaa
            ooboooo
            oo.....
            """, head: 2, neck: 6, hand: (9, 9)),
        teen: sym("""
            .ooo....
            obbbo...
            obEEbooo
            obEEbbbb
            obbbbbbb
            opbbbbbM
            .obbbbbb
            .obaaaaa
            obbaaaaa
            obobaaaa
            obobbbbb
            oooooooo
            """, head: 2, neck: 6, hand: (11, 10)),
        adult: sym("""
            ..ooo....
            .obbbo...
            obbEEbooo
            obbEEbbbb
            obbbbbbbb
            obpbbbbbb
            obbbbbbbM
            .obbbbbbb
            .obbaaaaa
            obbaaaaaa
            obobaaaaa
            obobbaaaa
            obbobbbbb
            ooooooooo
            """, head: 2, neck: 7, hand: (13, 12))
    )

    static let raccoon = SpriteSet(
        baby: sym("""
            .oo....
            odboooo
            obbbbbb
            obaabba
            ocEEcba
            ocEEcba
            obccbao
            .obbaaM
            ..oobaa
            ..obbaa
            ..oddob
            ...oo.o
            """, head: 1, neck: 8, hand: (9, 10),
            patches: [Patch(x: 10, y: 4, text: """
                ..oo
                .odo
                .obo
                odo.
                obo.
                oo..
                """)]),
        teen: sym("""
            .oo.....
            odbooooo
            obbbbbbb
            obaabbba
            ocEEccba
            ocEEccba
            obcccbaa
            .obbaaao
            ..obaaaM
            ...oobaa
            ..obbbaa
            ..obbaaa
            ..oddobb
            ...oo.oo
            """, head: 1, neck: 9, hand: (11, 12),
            patches: [Patch(x: 12, y: 5, text: """
                ...oo
                ..odo
                ..obo
                .odo.
                .obo.
                odo..
                oo...
                """)]),
        adult: sym("""
            .oo......
            odbo.....
            odbbooooo
            obbbbbbbb
            obaaabbba
            occEEccba
            occEEccba
            obccccbaa
            .obbbaaao
            ..obbaaaM
            ...oobaaa
            ...obbbbb
            ..obbbaaa
            ..obbaaaa
            ..obbaaaa
            ..obbbaab
            ..oddobbb
            ...oo.ooo
            """, head: 2, neck: 10, hand: (12, 16),
            patches: [Patch(x: 14, y: 6, text: """
                ....oo
                ...odo
                ...obo
                ..odo.
                ..obo.
                .odo..
                .obo..
                odo...
                obo...
                oo....
                """)])
    )

    static let raven = SpriteSet(
        baby: sym("""
            ...oooo
            .oobbbb
            .obbbbb
            obllllb
            oblEElb
            oblEElb
            obbbocc
            .obbboc
            ..obbbo
            ..obsbb
            ..ooooo
            ...c..c
            """, head: 0, neck: 8, hand: (9, 10)),
        teen: sym("""
            ......o.
            ....oobo
            ..oobbbb
            .obbbbbb
            .obllllb
            .oblEElb
            .oblEElb
            .obbbocc
            ..obbboc
            ..obbbbo
            osobblll
            osobblll
            .ooobbbb
            ...ooooo
            ....c...
            """, head: 2, neck: 9, hand: (11, 13)),
        adult: sym("""
            .......o.
            .....oobo
            ...oobbbb
            ..obbbbbb
            .obllllbb
            .oblEElbb
            .oblEElbb
            .obbllocc
            ..obbbboc
            ..obbbbbo
            .oobbbbbb
            ossobllll
            ossobllll
            ossobllll
            .osobllll
            ..oobbbbb
            ...oooooo
            ....c...c
            """, head: 2, neck: 10, hand: (13, 16))
    )

    static let ghost = SpriteSet(
        baby: sym("""
            ...oooo
            .oobbbb
            .obbbbb
            obbbbbb
            obEEbbb
            obEEbbb
            obcbbbM
            obbbbbb
            osbbbbb
            obboobb
            .oo..oo
            .......
            """, head: 0, neck: 7, hand: (9, 9)),
        teen: sym("""
            ...ooooo
            ..obbbbb
            .obbbbbb
            .oblbbbb
            obbEEbbb
            obbEEbbb
            obcbbbbM
            obbbbbbb
            osbbbbbb
            osbbbbbb
            obbooobb
            .oo...oo
            ........
            """, head: 0, neck: 8, hand: (11, 10)),
        adult: sym("""
            ....ooooo
            ..oobbbbb
            .obbbbbbb
            .oblbbbbb
            obbbbbbbb
            obbbEEbbb
            obbbEEbbb
            obbcbbbbM
            obbbbbbbb
            obbbbbbbb
            osbbbbbbb
            osbbbbbbb
            osbbbbbbb
            obbboobbb
            .ooo..ooo
            .........
            """, head: 0, neck: 9, hand: (13, 12))
    )

    static let robot = SpriteSet(
        baby: sym("""
            ......o
            .....oc
            ......o
            .oooooo
            obbbbbb
            obddddd
            obdEEdd
            obdEEdd
            obddddM
            obbbbbb
            ooooooo
            ..obaaa
            ..ooooo
            ..oo.oo
            """, head: 3, neck: 10, hand: (9, 12)),
        teen: sym("""
            .......o
            ......oc
            .......o
            .ooooooo
            olllllll
            obdddddd
            obdEEddd
            obdEEddd
            obdddddM
            obbbbbbb
            oooooooo
            ..obbbbb
            .oobaaca
            ..obbbbb
            ..ooo.oo
            """, head: 3, neck: 10, hand: (11, 13)),
        adult: sym("""
            .......oo
            .......oc
            .......oo
            ........o
            .oooooooo
            .olllllll
            .obdddddd
            .obdEEddd
            .obdEEddd
            .obdddddM
            .obdddddd
            .obbbbbbb
            .oooooooo
            ...obbbbb
            .oobaaaaa
            ooobaacaa
            ..obaaaaa
            ..obbbbbb
            ...oob.ob
            ...ooo.oo
            """, head: 4, neck: 12, hand: (13, 18))
    )

    static let dragon = SpriteSet(
        baby: sym("""
            ..o....
            .oco...
            .occooo
            .obbbbb
            obbbbbb
            obEEbbb
            obEEbbb
            oblloll
            .ollllM
            ..oolll
            ..obaaa
            ..obaaa
            ...oo.o
            """, head: 2, neck: 9, hand: (9, 11),
            patches: [Patch(x: 10, y: 8, text: """
                ..o.
                .obo
                obo.
                oo..
                """)]),
        teen: sym("""
            ..o.....
            .oco....
            .occo...
            ..occooo
            .obbbbbb
            obbEEbbb
            obbEEbbb
            obblllol
            .obllllM
            ..oollll
            o.oobaaa
            odoobaaa
            oddobaaa
            .oobbbbb
            ..ooo.oo
            """, head: 3, neck: 9, hand: (11, 13),
            patches: [Patch(x: 12, y: 9, text: """
                ....o
                ...oc
                ..obo
                .obo.
                obo..
                oo...
                """)]),
        adult: sym("""
            ..o......
            .oco.....
            .occo....
            ..occoooo
            ..obbbbbb
            .obbbbbbb
            .obbEEbbb
            .obbEEbbb
            .obbbbbbb
            .obllloll
            .oblllllM
            ..oolllll
            o..oobaaa
            odoobbaaa
            oddobbaaa
            .oobbbaaa
            ...obbaaa
            ...obbbbb
            ...occobb
            ....ooo.o
            """, head: 3, neck: 11, hand: (12, 18),
            patches: [Patch(x: 13, y: 12, text: """
                .....o.
                ....oco
                ...obo.
                ..obbo.
                .obbo..
                obbo...
                ooo....
                """)])
    )

    static let owl = SpriteSet(
        baby: sym("""
            .o.....
            .oo....
            .oboooo
            obbaabb
            obaEEab
            obaEEao
            obbaaoc
            obllllo
            osldlll
            osllldl
            .oooooo
            ..c..c.
            """, head: 2, neck: 7, hand: (9, 10)),
        teen: sym("""
            .o......
            .oo.....
            .obooooo
            obbbbbbb
            obbaabbb
            obaEEabb
            obaEEaoc
            obbaaboc
            obbbbbbo
            osllllll
            osldlldl
            osllllll
            .ooooooo
            ...c...c
            """, head: 2, neck: 8, hand: (11, 12)),
        adult: sym("""
            ..o......
            ..oo.....
            ..obooooo
            .obbbbbbb
            obbbaabbb
            obbaEEabb
            obbaEEaoc
            obbbaaboc
            obbbbbbbo
            .obllllll
            osllldlld
            oslllllll
            osldllldl
            oslllllll
            .osllllll
            ..ooooooo
            ....c...c
            """, head: 2, neck: 8, hand: (13, 15))
    )

    static let slime = SpriteSet(
        baby: sym("""
            ......o
            .....ob
            ...oobb
            ..obbbb
            .oblabb
            .obEEbb
            obbEEbb
            obcbbbM
            osbbbbb
            .osssss
            ..ooooo
            """, head: 2, neck: 8, hand: (9, 9)),
        teen: sym("""
            .......o
            ......ob
            ....oobb
            ...obbbb
            ..oblabb
            .oblabbb
            .obEEbbb
            obbEEbbb
            obcbbbbM
            obbbbbbb
            osbbbbbb
            .osssbbb
            ..oooooo
            """, head: 2, neck: 10, hand: (11, 11)),
        adult: sym("""
            ........o
            .......ob
            ......obb
            ....oobbb
            ...obbbbb
            ..oblabbb
            .oblabbbb
            .obbbbbbb
            .obbEEbbb
            obbbEEbbb
            obcbbbbbM
            obbbbbbbb
            obbbbbbbb
            osbbbbbbb
            .ossbbbbb
            ..ooooooo
            """, head: 3, neck: 12, hand: (13, 14))
    )

    static let bunny = SpriteSet(
        baby: sym("""
            ..oo...
            .obo...
            .oco...
            .ocoooo
            obbbbbb
            obEEbbb
            obEEbbb
            ocbbbbc
            .obbbbM
            ..obaaa
            ..obaaa
            ...oo.o
            """, head: 3, neck: 8, hand: (9, 10)),
        teen: sym("""
            ...oo...
            ..obbo..
            ..ocbo..
            ..ocbo..
            .oocbooo
            .obbbbbb
            obbbbbbb
            obbEEbbb
            obbEEbbb
            obcbbbbc
            .obbbbbM
            ..oobbbb
            ..obaaaa
            ..obaaaa
            ...oo.oo
            """, head: 4, neck: 11, hand: (11, 13)),
        adult: sym("""
            ....oo...
            ...obbo..
            ...ocbo..
            ...ocbo..
            ...ocbo..
            ..oocbooo
            .obbbbbbb
            obbbbbbbb
            obbbEEbbb
            obbbEEbbb
            obcbbbbbc
            .obbbbbbM
            ..oobbbbb
            ..obbaaaa
            .obbaaaaa
            .obbaaaaa
            .oobbbbbb
            ..ooo.ooo
            """, head: 5, neck: 12, hand: (13, 16))
    )

    static let puppy = SpriteSet(
        baby: sym("""
            ...oooo
            ..obbbb
            .ocobbb
            occoEEb
            occoEEb
            occobaa
            .ooobao
            ..obaaM
            ..ooaaa
            ..obbaa
            ..oaaob
            ...oo.o
            """, head: 0, neck: 8, hand: (9, 10)),
        teen: sym("""
            ...ooooo
            ..obbbbb
            .occobbb
            occcobbb
            occoEEbb
            occoEEbb
            occobbaa
            .ooobaao
            ...obaaM
            ...ooaaa
            ..obbaaa
            ..obbaaa
            ..oaaobb
            ...oo.oo
            """, head: 0, neck: 9, hand: (11, 12),
            patches: [Patch(x: 12, y: 8, text: """
                ..oo
                .obo
                obo.
                oo..
                """)]),
        adult: sym("""
            ....ooooo
            ..oobbbbb
            .occobbbb
            occcobbbb
            occcobbbb
            occcobEEb
            occcobEEb
            occcobbaa
            .occobaaa
            ..ooobaao
            ....obaaM
            ....ooaaa
            ...obbbbb
            ..obbbaaa
            ..obbaaaa
            ..obbaaaa
            ..oaaobbb
            ...oo.ooo
            """, head: 0, neck: 11, hand: (12, 16),
            patches: [Patch(x: 14, y: 11, text: """
                ..oo
                .obo
                .obo
                obo.
                oo..
                """)])
    )

    static let songbird = SpriteSet(
        baby: sym("""
            ......o
            .....ob
            ...oobb
            ..obbbb
            .obbbbb
            .obEEbb
            obbEEbb
            obpbboc
            osbaaao
            osaaaaa
            .oooooo
            ...c...
            """, head: 2, neck: 8, hand: (9, 10)),
        teen: sym("""
            .......o
            ......ob
            ....oobb
            ...obbbb
            ..obbbbb
            .obEEbbb
            obbEEbbb
            obpbbboc
            osbbbbbo
            ossbaaaa
            ossbaaaa
            .osbaaaa
            ..oooooo
            .....c..
            """, head: 2, neck: 8, hand: (11, 12)),
        adult: sym("""
            ........o
            .......ob
            .....oobb
            ...oobbbb
            ..obbbbbb
            .obbbbbbb
            .obEEbbbb
            obbEEbocc
            obpbbbboc
            obbbbbbbo
            osbbbaaaa
            ossbaaaaa
            ossbaaaaa
            .osbbaaaa
            ..oobbbbb
            ....ooooo
            .....c...
            """, head: 2, neck: 10, hand: (13, 14))
    )

    static let hedgehog = SpriteSet(
        baby: sym("""
            ..o...o
            .obo.ob
            obbbobb
            obbaaaa
            obaEEaa
            obaEEaa
            obdaaac
            .obaaaM
            ..obbaa
            ..oaaob
            ...oo.o
            """, head: 2, neck: 8, hand: (9, 9)),
        teen: sym("""
            ...o...o
            ..obo.ob
            .obbbobb
            obbbaaaa
            .obaaaaa
            obaEEaaa
            .oaEEaaa
            obbdaaac
            .obbaaaM
            ..obbaaa
            ..obbaaa
            ..oaaobb
            ...oo.oo
            """, head: 2, neck: 9, hand: (11, 11)),
        adult: sym("""
            ....o...o
            ...obo.ob
            ..obbbobb
            .obbbbbbb
            obbbaaaaa
            .obaaaaaa
            obbaEEaaa
            .obaEEaaa
            obbdaaaaa
            .obbaaaac
            ..obbaaaM
            ...obbaaa
            ..obbbaaa
            ..obbaaaa
            ..obbaaaa
            ..oaaobbb
            ...oo.ooo
            """, head: 2, neck: 11, hand: (12, 15))
    )
}

// MARK: - Framing

nonisolated extension PixelPet {
    /// Square region of the 24×24 canvas to show.
    nonisolated struct Crop: Sendable, Hashable {
        var x: Int
        var y: Int
        var side: Int

        static let canvas = Crop(x: 0, y: 0, side: PetBitmap.size)
    }

    /// Bounding box of the pet itself (body, accessory, crown) on the canvas, plus one row of
    /// headroom for the idle bob. Floating effects (z's, hearts) are not included.
    var contentBounds: PetArt.Rect {
        var still = restingFrame
        still.effect = .none
        still.sparkle = nil
        let bitmap = bitmap(frame: still)
        let n = PetBitmap.size
        var minX = n, minY = n, maxX = -1, maxY = -1
        for y in 0..<n {
            for x in 0..<n where bitmap[x, y] != 0 {
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= 0 else { return PetArt.Rect(x: 0, y: 0, w: n, h: n) }
        minY = max(minY - 1, 0)
        return PetArt.Rect(x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1)
    }

    /// The square to show when filling `devicePixels` × `devicePixels`: the whole pet, unless that
    /// leaves under 2 device pixels per cell and a head-and-shoulders bust (≥ 16 cells) does better.
    static func tightCrop(for bounds: PetArt.Rect, devicePixels: Int) -> Crop {
        let n = PetBitmap.size
        let whole = min(max(bounds.w, bounds.h, 12), n)
        let bust = min(whole, 16)
        let pixels = max(devicePixels, 1)
        var side = whole
        // Only crop into a bust when the whole pet would get less than 2 device pixels per cell.
        if pixels / whole < 2, max(1, pixels / bust) > max(1, pixels / whole) {
            side = min(whole, max(pixels / max(1, pixels / bust), bust))
        }
        var x = side >= bounds.w ? bounds.x - (side - bounds.w) / 2 : PetArt.centerX - (side - 1) / 2
        var y = side >= bounds.h ? bounds.y + bounds.h - side : bounds.y
        x = min(max(x, 0), n - side)
        y = min(max(y, 0), n - side)
        return Crop(x: x, y: y, side: side)
    }
}

// MARK: - View

/// Animated pixel pet. Every pet pixel is drawn as an exact square of whole device pixels,
/// so the art stays crisp; any leftover space is split evenly around it.
///
/// Framing: below 40 pt the view crops to the pet itself so avatars stay readable;
/// from 40 pt up it shows the whole 24×24 stage, so babies look small and legends big.
struct PixelPetView: View {
    nonisolated enum Framing: Sendable, Hashable {
        /// `.tight` below 40 pt, `.stage` from 40 pt.
        case automatic
        /// The whole 24×24 canvas: size differences between stages show.
        case stage
        /// Cropped to the pet: fills small avatars.
        case tight
    }

    private let pet: PixelPet
    private let size: CGFloat
    private let animated: Bool
    private let time: TimeInterval?
    private let framing: Framing
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(pet: PixelPet, size: CGFloat, animated: Bool = true) {
        self.init(pet: pet, size: size, animated: animated, framing: .automatic)
    }

    init(pet: PixelPet, size: CGFloat, animated: Bool = true, framing: Framing) {
        self.pet = pet
        self.size = size
        self.animated = animated
        self.time = nil
        self.framing = framing
    }

    /// A single, fixed animation frame (previews and snapshots).
    init(pet: PixelPet, size: CGFloat, time: TimeInterval, framing: Framing = .automatic) {
        self.pet = pet
        self.size = size
        self.animated = false
        self.time = time
        self.framing = framing
    }

    private var isTight: Bool {
        switch framing {
        case .automatic: size < 40
        case .stage: false
        case .tight: true
        }
    }

    var body: some View {
        let crop: PetCanvas.Framing = isTight ? .tight(pet.contentBounds) : .stage
        content(crop: crop)
            .frame(width: size, height: size)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(pet.accessibilityDescription)
            .accessibilityAddTraits(.isImage)
    }

    @ViewBuilder private func content(crop: PetCanvas.Framing) -> some View {
        if let time {
            PetCanvas(pet: pet, frame: adjusted(pet.frame(at: time)), crop: crop).equatable()
        } else if animated, !reduceMotion {
            // ~10 fps; the canvas only redraws when the frame actually changes.
            TimelineView(.animation(minimumInterval: 0.1)) { context in
                PetCanvas(
                    pet: pet,
                    frame: adjusted(pet.frame(at: context.date.timeIntervalSinceReferenceDate)),
                    crop: crop
                )
                .equatable()
            }
        } else {
            PetCanvas(pet: pet, frame: adjusted(pet.restingFrame), crop: crop).equatable()
        }
    }

    /// Tight crops keep the bob to one pixel so the head never leaves the frame, and drop
    /// the floating effects that would be cut off at the crop edge (eyes and mouth still show the mood).
    private func adjusted(_ frame: PixelPet.Frame) -> PixelPet.Frame {
        guard isTight else { return frame }
        var frame = frame
        frame.lift = min(frame.lift, 1)
        frame.effect = .none
        frame.sparkle = nil
        return frame
    }
}

private struct PetCanvas: View, Equatable {
    enum Framing: Equatable {
        case stage
        case tight(PetArt.Rect)
    }

    let pet: PixelPet
    let frame: PixelPet.Frame
    let crop: Framing

    var body: some View {
        let bitmap = pet.bitmap(frame: frame)
        let framing = crop
        Canvas { context, size in
            let scale = max(context.environment.displayScale, 1)
            let crop: PixelPet.Crop
            switch framing {
            case .stage: crop = .canvas
            case .tight(let bounds):
                crop = PixelPet.tightCrop(for: bounds, devicePixels: Int(min(size.width, size.height) * scale))
            }
            PetCanvas.draw(bitmap, crop: crop, in: &context, size: size, scale: scale)
        }
    }

    static func draw(
        _ bitmap: PetBitmap, crop: PixelPet.Crop, in context: inout GraphicsContext, size: CGSize, scale: CGFloat
    ) {
        let n = crop.side
        let scale = max(scale, 1)
        let side = min(size.width, size.height) * scale
        let raw = side / CGFloat(n)
        // Whole device pixels per cell when possible, so every pixel is a crisp square.
        let cell = raw >= 1 ? raw.rounded(.down) : raw
        let ox = ((size.width * scale - cell * CGFloat(n)) / 2).rounded(.down)
        let oy = ((size.height * scale - cell * CGFloat(n)) / 2).rounded(.down)
        var paths: [UInt32: Path] = [:]
        for row in 0..<n {
            let y0 = (oy + CGFloat(row) * cell).rounded() / scale
            let y1 = (oy + CGFloat(row + 1) * cell).rounded() / scale
            guard y1 > y0 else { continue }
            var col = 0
            while col < n {
                let c = bitmap[crop.x + col, crop.y + row]
                var run = 1
                while col + run < n, bitmap[crop.x + col + run, crop.y + row] == c { run += 1 }
                if c != 0 {
                    let x0 = (ox + CGFloat(col) * cell).rounded() / scale
                    let x1 = (ox + CGFloat(col + run) * cell).rounded() / scale
                    if x1 > x0 { paths[c, default: Path()].addRect(CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)) }
                }
                col += run
            }
        }
        for (c, path) in paths {
            let color = Color(
                .sRGB,
                red: Double((c >> 16) & 0xFF) / 255,
                green: Double((c >> 8) & 0xFF) / 255,
                blue: Double(c & 0xFF) / 255
            )
            context.fill(path, with: .color(color))
        }
    }
}
