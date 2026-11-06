import Foundation
import XCTest
@testable import Cineon

final class PixelPetTests: XCTestCase {
    // MARK: Helpers

    /// Small deterministic generator so failures are reproducible.
    private struct SplitMix: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    private static let genreNames = [
        "Action", "Drama", "Adventure", "Crime", "Comedy", "Thriller", "Fantasy", "Sci-Fi", "Mystery",
        "Horror", "Animation", "Biography", "War", "Sport", "Romance", "History", "Family", "Short",
        "Western", "Music", "Documentary", "Musical", "Reality-TV", "Talk-Show", "Game-Show", "News",
        "Film-Noir", "Science Fiction", "Bollywood", "", "Action & Adventure",
    ]

    private func randomTraits(_ rng: inout SplitMix) -> PetTraits {
        let count = Int.random(in: 0...6, using: &rng)
        let genres = (0..<count).map { _ in
            GenreWeight(
                name: Self.genreNames.randomElement(using: &rng)!,
                weight: Double(Int.random(in: -2...50, using: &rng))
            )
        }
        return PetTraits(
            genres: genres,
            hoursWatched: Double.random(in: 0...3000, using: &rng),
            titlesFinished: Int.random(in: 0...2000, using: &rng),
            daysSinceLastWatch: Bool.random(using: &rng) ? nil : Int.random(in: -3...400, using: &rng),
            seed: UUID(uuid: (
                UInt8.random(in: 0...255, using: &rng), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
                UInt8.random(in: 0...255, using: &rng)
            )).uuidString
        )
    }

    private func traits(_ genres: [(String, Double)], hours: Double = 0, titles: Int = 0,
                        days: Int? = 0, seed: String = "8E1F3C1A-7A43-4C1B-9C0B-2B7D1D6C9A11") -> PetTraits {
        PetTraits(
            genres: genres.map { GenreWeight(name: $0.0, weight: $0.1) },
            hoursWatched: hours, titlesFinished: titles, daysSinceLastWatch: days, seed: seed
        )
    }

    // MARK: Determinism

    func testSameTraitsGiveSamePetAndCode() {
        var rng = SplitMix(state: 1)
        for _ in 0..<200 {
            let t = randomTraits(&rng)
            let a = PixelPet.make(from: t), b = PixelPet.make(from: t)
            XCTAssertEqual(a, b)
            XCTAssertEqual(a.code, b.code)
            XCTAssertEqual(a.name, b.name)
            XCTAssertEqual(a.blurb, b.blurb)
        }
    }

    func testGenreOrderDoesNotMatter() {
        var rng = SplitMix(state: 2)
        for _ in 0..<200 {
            var t = randomTraits(&rng)
            let pet = PixelPet.make(from: t)
            t.genres.shuffle(using: &rng)
            XCTAssertEqual(PixelPet.make(from: t), pet)
        }
    }

    func testKnownSeedGivesKnownName() {
        // FNV-1a is stable across launches; this pins the name tables and hash.
        let pet = PixelPet.make(from: traits([("Horror", 3)], seed: "seed-a"))
        XCTAssertEqual(pet.nameIndex, PixelPet.nameIndex(seed: "seed-a", species: .ghost))
        XCTAssertEqual(PixelPet.stableHash("a"), 0xaf63_dc4c_8601_ec8c)
        XCTAssertEqual(PixelPet.stableHash(""), 0xcbf2_9ce4_8422_2325)
    }

    // MARK: Codes

    func testCodeRoundTripsForRandomTraits() {
        var rng = SplitMix(state: 3)
        let allowed = Set("0123456789abcdefghjkmnpqrstvwxyz-")
        for _ in 0..<1000 {
            let pet = PixelPet.make(from: randomTraits(&rng))
            let code = pet.code
            XCTAssertTrue(code.hasPrefix("p1-"))
            XCTAssertLessThanOrEqual(code.count, 40)
            XCTAssertTrue(code.allSatisfy(allowed.contains), code)
            XCTAssertEqual(PixelPet(code: code), pet, code)
        }
    }

    func testCodeRoundTripsForEveryCombination() {
        for species in PixelPet.Species.allCases {
            for stage in PixelPet.Stage.allCases {
                for accessory in PixelPet.Accessory.allCases {
                    for tone in PixelPet.Tone.allCases {
                        for mood in PixelPet.Mood.allCases {
                            for (level, name) in [(1, 0), (99, 1023), (42, 517)] {
                                let pet = PixelPet(species: species, stage: stage, accessory: accessory,
                                                   tone: tone, mood: mood, level: level, nameIndex: name)
                                XCTAssertEqual(PixelPet(code: pet.code), pet)
                            }
                        }
                    }
                }
            }
        }
    }

    func testCodeIsTolerantOfCaseAndWhitespace() {
        let pet = PixelPet.make(from: traits([("Sci-Fi", 4)], titles: 30))
        XCTAssertEqual(PixelPet(code: "  " + pet.code.uppercased() + "\n"), pet)
    }

    func testCodeRejectsGarbage() {
        let pet = PixelPet.make(from: traits([("Comedy", 4)], titles: 30))
        let code = pet.code
        let rejects = [
            "", "p1-", "p1", "p2-" + code.dropFirst(3), "p0-" + code.dropFirst(3), code + "0",
            String(code.dropLast()), "hello world", "p1-!!!!!!!!!!", "p1-0000000000", "p1-iiiiiiiiii",
            "🦊🦊🦊", String(repeating: "z", count: 500), "p1-\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}",
        ]
        for text in rejects {
            XCTAssertNil(PixelPet(code: text), "accepted \(text.debugDescription)")
        }
        // Any single-character change breaks the checksum or a range check (or is another valid pet).
        let alphabet = Array("0123456789abcdefghjkmnpqrstvwxyz")
        var chars = Array(code)
        for i in 3..<chars.count {
            let original = chars[i]
            for c in alphabet where c != original {
                chars[i] = c
                if let other = PixelPet(code: String(chars)) { XCTAssertNotEqual(other, pet) }
            }
            chars[i] = original
        }
    }

    func testCodeRejectsOutOfRangeFieldsEvenWithValidChecksum() {
        let alphabet = Array("0123456789abcdefghjkmnpqrstvwxyz")
        // Species "z" (31) does not exist; try every possible checksum character.
        for check in alphabet {
            XCTAssertNil(PixelPet(code: "p1-z0000010a" + String(check)))
            XCTAssertNil(PixelPet(code: "p1-00000" + "00" + "00" + String(check))) // level 0
            XCTAssertNil(PixelPet(code: "p1-00000" + "38" + "00" + String(check))) // level 104
        }
    }

    func testCodableUsesCode() throws {
        let pet = PixelPet.make(from: traits([("Fantasy", 9), ("Romance", 3)], titles: 90, days: 3))
        let data = try JSONEncoder().encode([pet])
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "[\"\(pet.code)\"]")
        XCTAssertEqual(try JSONDecoder().decode([PixelPet].self, from: data), [pet])
        XCTAssertThrowsError(try JSONDecoder().decode([PixelPet].self, from: Data("[\"nope\"]".utf8)))
    }

    // MARK: Genres

    func testFavouriteGenreDrivesSpecies() {
        let cases: [(String, PixelPet.Species)] = [
            ("Horror", .ghost), ("Action", .fox), ("Adventure", .turtle), ("Drama", .cat),
            ("Comedy", .frog), ("Crime", .raccoon), ("Thriller", .raven), ("Sci-Fi", .robot),
            ("Science Fiction", .robot), ("sci fi", .robot), ("Fantasy", .dragon), ("Mystery", .owl),
            ("Documentary", .owl), ("Biography", .owl), ("History", .owl), ("Animation", .slime),
            ("Romance", .bunny), ("Family", .puppy), ("Sport", .puppy), ("Western", .raccoon),
            ("Music", .songbird), ("Musical", .songbird), ("War", .hedgehog), ("Film-Noir", .raccoon),
            ("Reality-TV", .frog), ("Talk-Show", .frog), ("Game-Show", .frog), ("News", .owl),
            ("Short", .slime), ("HORROR", .ghost), ("  thriller ", .raven),
        ]
        for (name, species) in cases {
            XCTAssertEqual(PixelPet.make(from: traits([(name, 1)])).species, species, name)
            let filler = name == "Drama" ? "Comedy" : "Drama"
            XCTAssertEqual(PixelPet.make(from: traits([(filler, 3), (name, 10)])).species, species, name)
        }
        let horrorFan = traits([("Comedy", 4), ("Horror", 25), ("Drama", 7), ("Thriller", 3)])
        XCTAssertEqual(PixelPet.make(from: horrorFan).species, .ghost)
        XCTAssertEqual(PixelPet.make(from: horrorFan).speciesLabel, "Ghost")
    }

    func testAliasesMergeBeforeRanking() {
        // "Sci-Fi" 3 + "Science Fiction" 3 beats "Action" 5.
        let pet = PixelPet.make(from: traits([("Action", 5), ("Sci-Fi", 3), ("Science Fiction", 3)]))
        XCTAssertEqual(pet.species, .robot)
        XCTAssertEqual(pet.accessory, .headband)
    }

    func testTiesBreakByCommonness() {
        let pet = PixelPet.make(from: traits([("Horror", 5), ("Action", 5)]))
        XCTAssertEqual(pet.species, .fox)
        XCTAssertEqual(pet.accessory, .horns)
    }

    func testSecondGenrePicksAccessoryAndThirdPicksTone() {
        let pet = PixelPet.make(from: traits([("Horror", 10), ("Sci-Fi", 6), ("Comedy", 2)]))
        XCTAssertEqual(pet.species, .ghost)
        XCTAssertEqual(pet.accessory, .glasses3D)
        XCTAssertEqual(pet.tone, .sunny)
        for genre in PixelPet.Genre.allCases {
            let p = PixelPet.make(from: traits([("Drama", 10), (genre.rawValue, 5), ("Horror", 1)]))
            if genre != .drama { XCTAssertEqual(p.accessory, genre.accessory, genre.rawValue) }
        }
    }

    func testUnknownAndEmptyGenresStillMakeAValidPet() {
        let inputs: [[(String, Double)]] = [
            [], [("Bollywood", 10)], [("", 3)], [("Horror", 0)], [("Horror", -4)], [("Horror", .nan)],
            [("Horror", .infinity)], [("???", 1), ("Telenovela", 2)],
        ]
        for genres in inputs {
            let pet = PixelPet.make(from: traits(genres))
            XCTAssertEqual(pet.species, .slime, "\(genres)")
            XCTAssertEqual(pet.accessory, .none)
            XCTAssertEqual(PixelPet(code: pet.code), pet)
            XCTAssertFalse(pet.name.isEmpty)
            XCTAssertFalse(pet.blurb.isEmpty)
            XCTAssertEqual(pet.bitmap().pixels.filter { $0 != 0 }.isEmpty, false)
        }
        // Unknown names next to a known one are ignored.
        XCTAssertEqual(PixelPet.make(from: traits([("Bollywood", 50), ("War", 1)])).species, .hedgehog)
        // Combined names split into their parts.
        XCTAssertEqual(PixelPet.make(from: traits([("Sci-Fi & Fantasy", 10), ("Drama", 4)])).species, .robot)
    }

    // MARK: Stage, level, mood

    func testStageThresholds() {
        let cases: [(Double, Int, PixelPet.Stage)] = [
            (0, 0, .baby), (9.99, 0, .baby), (10, 0, .teen), (0, 6, .baby), (0, 7, .teen),
            (59.9, 0, .teen), (60, 0, .adult), (0, 40, .adult), (199.9, 0, .adult), (200, 0, .legend),
            (0, 133, .adult), (0, 134, .legend), (0, 240, .legend), (5000, 900, .legend),
            (-50, -3, .baby), (.nan, 0, .baby), (.infinity, 0, .baby),
        ]
        for (hours, titles, stage) in cases {
            let pet = PixelPet.make(from: traits([("Drama", 1)], hours: hours, titles: titles))
            XCTAssertEqual(pet.stage, stage, "hours \(hours), titles \(titles)")
            XCTAssertEqual(pet.stageLabel, stage.label)
        }
        XCTAssertEqual(PixelPet.Stage.allCases.map(\.label), ["Baby", "Teen", "Adult", "Legend"])
        XCTAssertTrue(PixelPet.Stage.baby < .teen && PixelPet.Stage.adult < .legend)
    }

    func testLevels() {
        XCTAssertEqual(PixelPet.make(from: traits([], hours: 0, titles: 0)).level, 1)
        XCTAssertEqual(PixelPet.make(from: traits([], hours: 3, titles: 0)).level, 2)
        XCTAssertEqual(PixelPet.make(from: traits([], hours: 0, titles: 240)).level, 19) // xp 360
        XCTAssertEqual(PixelPet.make(from: traits([], hours: 1e9, titles: 0)).level, 99)
        var last = 0
        for xp in stride(from: 0.0, through: 10_000, by: 7.5) {
            let level = PixelPet.level(forExperience: xp)
            XCTAssertGreaterThanOrEqual(level, last)
            XCTAssertTrue((1...99).contains(level))
            last = level
        }
    }

    func testGrowthProgress() {
        let g = PixelPet.growth(for: traits([], hours: 0, titles: 20)) // xp 30
        XCTAssertEqual(g.stage, .teen)
        XCTAssertEqual(g.nextStage, .adult)
        XCTAssertEqual(g.experienceToNextStage, 30, accuracy: 1e-9)
        XCTAssertEqual(g.progress, 0.4, accuracy: 1e-9)
        let legend = PixelPet.growth(for: traits([], titles: 240))
        XCTAssertNil(legend.nextStage)
        XCTAssertEqual(legend.progress, 1)
    }

    func testMoodThresholds() {
        let cases: [(Int?, PixelPet.Mood)] = [
            (nil, .sleepy), (-2, .happy), (0, .happy), (1, .happy), (2, .content), (5, .content),
            (6, .bored), (14, .bored), (15, .sleepy), (365, .sleepy),
        ]
        for (days, mood) in cases {
            XCTAssertEqual(PixelPet.make(from: traits([("Comedy", 1)], days: days)).mood, mood, "\(String(describing: days))")
        }
        XCTAssertEqual(PixelPet.Mood.sleepy.label, "Sleepy")
        XCTAssertEqual(PixelPet.Mood.happy.label, "Happy")
    }

    func testRealLibraryShape() {
        // Counts from the real library, most first; ~0 tracked hours, 240 finished titles.
        let names = ["Action", "Drama", "Adventure", "Crime", "Comedy", "Thriller", "Fantasy", "Sci-Fi",
                     "Mystery", "Horror", "Animation", "Biography", "War", "Sport", "Romance", "History",
                     "Family", "Short", "Western", "Music", "Documentary"]
        let genres = names.enumerated().map { ($0.element, Double(120 - $0.offset * 5)) }
        let pet = PixelPet.make(from: traits(genres, hours: 0.4, titles: 240, days: 1))
        XCTAssertEqual(pet.species, .fox)
        XCTAssertEqual(pet.accessory, .scarf)
        XCTAssertEqual(pet.tone, .sunny)
        XCTAssertEqual(pet.stage, .legend)
        XCTAssertEqual(pet.mood, .happy)
        XCTAssertEqual(pet.level, 19)
    }

    // MARK: Names and text

    func testNamesAreShortAndClean() {
        let blocked = ["ass", "cum", "fag", "gay", "jap", "kike", "loli", "nazi", "nig", "paki", "pedo", "piss",
                       "poo", "porn", "puta", "puto", "rape", "sex", "shit", "slut", "tit", "fuk", "coon", "homo",
                       "suki", "chichi", "hui", "huj", "pizd", "blya", "gay"]
        var names = Set<String>()
        for index in 0..<PixelPet.nameCount {
            let pet = PixelPet(species: .cat, stage: .baby, nameIndex: index)
            let name = pet.name
            names.insert(name)
            XCTAssertTrue((3...7).contains(name.count), name)
            XCTAssertTrue(name.first!.isUppercase, name)
            for bad in blocked { XCTAssertFalse(name.lowercased().contains(bad), name) }
        }
        XCTAssertGreaterThan(names.count, 900)
        XCTAssertEqual(PixelPet.nameHeads.count * PixelPet.nameTails.count, PixelPet.nameCount)
    }

    func testLabelsAndBlurbsExist() {
        for species in PixelPet.Species.allCases {
            for index in 0..<6 {
                let pet = PixelPet(species: species, stage: .adult, nameIndex: index)
                XCTAssertFalse(pet.speciesLabel.isEmpty)
                XCTAssertFalse(pet.blurb.isEmpty)
                XCTAssertLessThanOrEqual(pet.blurb.count, 70, pet.blurb)
                XCTAssertTrue(pet.accessibilityDescription.contains(pet.name))
            }
        }
    }

    // MARK: Art

    func testEverySpriteIsRectangularAndUsesKnownKeys() {
        let allowed = PetArt.spriteKeys.union(PetArt.sharedKeys)
        for species in PixelPet.Species.allCases {
            for stage in PixelPet.Stage.allCases {
                let sprite = PetArt.sprite(species, stage)
                let label = "\(species) \(stage)"
                XCTAssertTrue(sprite.isRectangular, label)
                XCTAssertEqual(sprite.keys.count, sprite.width * sprite.height, label)
                XCTAssertEqual(sprite.eyes.count, 2, label)
                for eye in sprite.eyes { XCTAssertEqual(eye.w * eye.h, 4, label) }
                let beaked: Set<PixelPet.Species> = [.raven, .owl, .songbird]
                if !beaked.contains(species) { XCTAssertNotNil(sprite.mouth, label) }
                // Fits the 24×24 canvas when placed.
                let left = PetArt.centerX - sprite.head.x
                XCTAssertGreaterThanOrEqual(left, 0, label)
                XCTAssertLessThanOrEqual(left + sprite.width, PetBitmap.size, label)
                XCTAssertLessThanOrEqual(sprite.height, PetBitmap.size, label)
                XCTAssertTrue((0..<sprite.height).contains(sprite.head.y), label)
                XCTAssertTrue((0..<sprite.height).contains(sprite.neck), label)
                for key in sprite.keys {
                    XCTAssertTrue(allowed.contains(Character(UnicodeScalar(key))), "\(label) uses \(UnicodeScalar(key))")
                }
                for tone in PixelPet.Tone.allCases {
                    let palette = PetArt.palette(species, tone)
                    for key in Set(sprite.keys) where key != PetArt.k(".") && key != PetArt.k("E") {
                        XCTAssertNotEqual(palette[Int(key)], 0, "\(label) \(tone) lacks \(UnicodeScalar(key))")
                    }
                    for key in ["e", "i", "o", "w", "t"] { XCTAssertNotEqual(palette[Int(PetArt.k(Character(key)))], 0) }
                }
            }
        }
    }

    func testEveryOverlayIsRectangularAndUsesKnownKeys() {
        let allowed = PetArt.spriteKeys.union(PetArt.sharedKeys)
        for (name, overlay) in PetArt.allOverlays {
            XCTAssertTrue(overlay.isRectangular, name)
            XCTAssertGreaterThan(overlay.width * overlay.height, 0, name)
            for key in overlay.keys {
                XCTAssertTrue(allowed.contains(Character(UnicodeScalar(key))), "\(name) uses \(UnicodeScalar(key))")
            }
        }
        for accessory in PixelPet.Accessory.allCases where accessory.isHat && accessory != .headphones {
            XCTAssertNotNil(PetArt.hats[accessory], accessory.rawValue)
        }
    }

    func testEveryCombinationRenders() {
        for species in PixelPet.Species.allCases {
            for stage in PixelPet.Stage.allCases {
                let bare = PixelPet(species: species, stage: stage).bitmap()
                for accessory in PixelPet.Accessory.allCases {
                    for mood in PixelPet.Mood.allCases {
                        let pet = PixelPet(species: species, stage: stage, accessory: accessory, mood: mood)
                        for t in [0.0, 0.25, 0.9, 1.7, 3.1, 4.4] {
                            let bitmap = pet.bitmap(frame: pet.frame(at: t))
                            XCTAssertEqual(bitmap.pixels.count, 576)
                        }
                        let still = pet.bitmap()
                        XCTAssertGreaterThan(still.pixels.filter { $0 != 0 }.count, 60, "\(species) \(stage)")
                        if accessory != .none, !(stage == .legend && accessory.isHat) {
                            XCTAssertNotEqual(still, PixelPet(species: species, stage: stage, mood: mood).bitmap(),
                                              "\(accessory) invisible on \(species) \(stage)")
                        }
                    }
                }
                // Babies are smaller than adults.
                if stage == .baby {
                    let adult = PixelPet(species: species, stage: .adult).bitmap()
                    XCTAssertLessThan(bare.pixels.filter { $0 != 0 }.count, adult.pixels.filter { $0 != 0 }.count)
                }
            }
        }
    }

    func testFrames() {
        let sleepy = PixelPet(species: .owl, stage: .teen, mood: .sleepy)
        let legend = PixelPet(species: .fox, stage: .legend, mood: .happy)
        for t in stride(from: 0.0, to: 20, by: 0.1) {
            XCTAssertEqual(sleepy.frame(at: t).eyes, .closed)
            XCTAssertEqual(sleepy.frame(at: t).effect, .zzz)
            XCTAssertNotNil(legend.frame(at: t).sparkle)
            XCTAssertNil(sleepy.frame(at: t).sparkle)
            XCTAssertTrue((0...3).contains(legend.frame(at: t).lift))
            XCTAssertEqual(legend.frame(at: t), legend.frame(at: t))
        }
        let content = PixelPet(species: .cat, stage: .adult, mood: .content)
        let eyes = Set(stride(from: 0.0, to: 10, by: 0.05).map { content.frame(at: $0).eyes })
        XCTAssertEqual(eyes, [.open, .closed]) // it blinks
        XCTAssertEqual(PixelPet(species: .cat, stage: .adult, mood: .bored).restingFrame.effect, .dots)
        XCTAssertEqual(sleepy.restingFrame.eyes, .closed)
        XCTAssertEqual(content.restingFrame.lift, 0)
    }

    func testTightCropStaysInsideCanvas() {
        for species in PixelPet.Species.allCases {
            for stage in PixelPet.Stage.allCases {
                let pet = PixelPet(species: species, stage: stage, accessory: .wizardHat)
                let bounds = pet.contentBounds
                for pixels in [12, 16, 24, 32, 40, 48, 56, 72, 96, 200] {
                    let crop = PixelPet.tightCrop(for: bounds, devicePixels: pixels)
                    XCTAssertTrue((12...24).contains(crop.side))
                    XCTAssertGreaterThanOrEqual(crop.x, 0)
                    XCTAssertGreaterThanOrEqual(crop.y, 0)
                    XCTAssertLessThanOrEqual(crop.x + crop.side, 24)
                    XCTAssertLessThanOrEqual(crop.y + crop.side, 24)
                }
            }
        }
    }
}
