// Dumps what the Mac's pixel pet makes of a fixed set of inputs, so the Windows port can be checked
// against it byte for byte. PetDump.cs builds the same text in C#, and PixelPetMacParityTests compares FNV-1a hashes; the
// constants there come from this program.
//
// Run on a Mac, from the repo root:
//   swiftc -O -swift-version 6 -default-isolation MainActor -parse-as-library Cineon/Profile/PixelPet.swift \
//     windows/Cineon.Core.Tests/Profile/MacParity/PetDump.swift -o /tmp/petdump
//   /tmp/petdump /tmp/petdump-out
// It prints one hash per section and writes each section to <dir>/<section>.txt. To diff against Windows,
// run the tests with CINEON_PET_DUMP=<other dir> and diff the two folders.

import AppKit
import SwiftUI

struct SplitMix {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    mutating func below(_ n: Int) -> Int { Int(next() % UInt64(n)) }
}

func fnv(_ pixels: [UInt32]) -> UInt64 {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for p in pixels {
        for shift in stride(from: 0, to: 32, by: 8) {
            hash ^= UInt64((p >> UInt32(shift)) & 0xFF)
            hash = hash &* 0x0000_0100_0000_01b3
        }
    }
    return hash
}

func fnvBytes(_ bytes: [UInt8]) -> UInt64 {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for b in bytes {
        hash ^= UInt64(b)
        hash = hash &* 0x0000_0100_0000_01b3
    }
    return hash
}

func hex(_ v: UInt64) -> String { String(v, radix: 16) }

func eyes(_ e: PixelPet.Frame.Eyes) -> Int {
    switch e { case .open: 0; case .closed: 1; case .happy: 2; case .heavy: 3 }
}

func mouth(_ m: PixelPet.Frame.Mouth) -> Int {
    switch m { case .smile: 0; case .grin: 1; case .flat: 2; case .small: 3 }
}

func effect(_ e: PixelPet.Frame.Effect) -> Int {
    switch e { case .none: 0; case .zzz: 1; case .heart: 2; case .dots: 3 }
}

/// `frame(at:)` with the Legend twinkle phase capped at 5, as the Windows port does. On the Mac,
/// `Int(phase(1.8) / 0.3)` can round up to 6 for a phase just under 1.8 (e.g. name 335 at 0.25 s), and the
/// renderer then indexes past its 6-entry table and traps.
func frameAt(_ pet: PixelPet, _ t: Double) -> PixelPet.Frame {
    var frame = pet.frame(at: t)
    if let sparkle = frame.sparkle, sparkle > 5 { frame.sparkle = 5 }
    return frame
}

func frameText(_ f: PixelPet.Frame) -> String {
    "\(f.lift),\(eyes(f.eyes)),\(mouth(f.mouth)),\(effect(f.effect)),\(f.effectStep),\(f.sparkle ?? -1)"
}

let genreNames = [
    "Action", "Drama", "Adventure", "Crime", "Comedy", "Thriller", "Fantasy", "Sci-Fi", "Mystery",
    "Horror", "Animation", "Biography", "War", "Sport", "Romance", "History", "Family", "Short",
    "Western", "Music", "Documentary", "Musical", "Reality-TV", "Talk-Show", "Game-Show", "News",
    "Film-Noir", "Science Fiction", "Bollywood", "", "Action & Adventure", "Sci-Fi & Fantasy", "War & Politics",
    "Crime/Drama", "Kids, Family", "a+b", ",,,", "&", "  thriller ", "HORROR", "sci fi", "sci\u{2011}fi",
    "\u{212A}ids", "\u{130}history", "H\u{130}STORY", "\u{FF28}\u{FF4F}\u{FF52}\u{FF52}\u{FF4F}\u{FF52}",
    "\u{41C}\u{443}\u{437}\u{438}\u{43A}\u{430}", "Docu-Series", "Rom-Com", "Stand-Up", "TV Movie", "neo-noir",
    "Children's", "Martial Arts", "Super-hero", "Sci-Fi&Fantasy", "Action/Adventure/Comedy", "action+drama",
    "A\u{E7}\u{E3}o", "Com\u{E9}die", "Ani\u{301}me", "\u{FF21}nime", "anime\u{0}", "\u{FEFF}Drama", "Dra\u{200B}ma",
    "Drama\u{1F3AC}", "\u{661}\u{662}drama", "\u{216B}", "sf", "SF", "Scfi", "realitytv", "realityTV", "filmNoir",
    "talkShow", "gameShow", "sciFi", "Sci-Fi & Fantasy & Horror", "Western/", "/Western",
]

func randomTraits(_ rng: inout SplitMix) -> PetTraits {
    let count = rng.below(7)
    var genres: [GenreWeight] = []
    for _ in 0..<count {
        let name = genreNames[rng.below(genreNames.count)]
        let kind = rng.below(25)
        let weight: Double
        switch kind {
        case 0: weight = .nan
        case 1: weight = .infinity
        case 2: weight = -.infinity
        case 3: weight = Double(rng.below(5000)) / 100
        default: weight = Double(rng.below(53)) - 2
        }
        genres.append(GenreWeight(name: name, weight: weight))
    }
    let hoursKind = rng.below(10)
    let hours: Double
    switch hoursKind {
    case 0: hours = 0
    case 1: hours = .nan
    case 2: hours = Double(rng.below(100_000_000)) / 7
    default: hours = Double(rng.below(3_000_000)) / 1000
    }
    let titles = rng.below(2001)
    let negative = rng.below(20) == 0
    let daysKind = rng.below(3)
    let days: Int? = daysKind == 0 ? nil : rng.below(404) - 3
    let seedKind = rng.below(4)
    let seed: String
    switch seedKind {
    case 0: seed = "seed-\(rng.next())"
    case 1: seed = String(rng.next(), radix: 16, uppercase: true)
    case 2: seed = "\u{DC}n\u{EF}c\u{F8}d\u{E9}-\(rng.below(1000))"
    default: seed = ""
    }
    return PetTraits(genres: genres, hoursWatched: hours, titlesFinished: negative ? titles - 2500 : titles,
                     daysSinceLastWatch: days, seed: seed)
}

func traitPets() -> [PixelPet] {
    var rng = SplitMix(state: 42)
    return (0..<3000).map { _ in PixelPet.make(from: randomTraits(&rng)) }
}

// MARK: Sections

func renders() -> String {
    let times: [Double] = [0, 0.25, 0.9, 1.7, 3.1, 4.4, -7.3, 1234.56, 7.77e8]
    var out = ""
    var index = 0
    for s in PixelPet.Species.allCases {
        for st in PixelPet.Stage.allCases {
            for a in PixelPet.Accessory.allCases {
                for tn in PixelPet.Tone.allCases {
                    for m in PixelPet.Mood.allCases {
                        let pet = PixelPet(species: s, stage: st, accessory: a, tone: tn, mood: m,
                                           level: 1 + index % 99, nameIndex: (index * 37) % 1024)
                        index += 1
                        var line = pet.code + " " + hex(fnv(pet.bitmap().pixels))
                        for t in times { line += " " + hex(fnv(pet.bitmap(frame: frameAt(pet, t)).pixels)) }
                        out += line + "\n"
                    }
                }
            }
        }
    }
    return out
}

func pixels() -> String {
    // A few whole bitmaps, pixel by pixel, for readable diffs.
    var out = ""
    let pets = [
        PixelPet(species: .fox, stage: .legend, accessory: .scarf, tone: .sunny, mood: .happy, level: 19, nameIndex: 7),
        PixelPet(species: .ghost, stage: .teen, accessory: .horns, tone: .dusk, mood: .sleepy, level: 5, nameIndex: 300),
        PixelPet(species: .robot, stage: .adult, accessory: .glasses3D, tone: .classic, mood: .bored, level: 9, nameIndex: 1023),
        PixelPet(species: .owl, stage: .baby, accessory: .headphones, tone: .classic, mood: .content, level: 1, nameIndex: 0),
    ]
    for pet in pets {
        for frame in [pet.restingFrame, frameAt(pet, 0.35), frameAt(pet, 2.2)] {
            out += pet.code + " " + frameText(frame) + "\n"
            let bitmap = pet.bitmap(frame: frame)
            for y in 0..<PetBitmap.size {
                out += (0..<PetBitmap.size).map { x in
                    let p = bitmap[x, y]
                    return p == 0 ? "......" : String(format: "%06x", p & 0xFF_FFFF)
                }.joined(separator: " ") + "\n"
            }
        }
    }
    return out
}

func frames() -> String {
    var out = ""
    for nameIndex in stride(from: 0, to: 1024, by: 37) {
        for mood in PixelPet.Mood.allCases {
            for stage in [PixelPet.Stage.adult, .legend] {
                let pet = PixelPet(species: .cat, stage: stage, mood: mood, nameIndex: nameIndex)
                var line = pet.code + " r:" + frameText(pet.restingFrame)
                for i in 0...1080 { line += " " + frameText(frameAt(pet, Double(i) * 0.037 - 20.0)) }
                for i in 0..<600 { line += " " + frameText(frameAt(pet, 815_000_000 + Double(i) * 0.1)) }
                out += line + "\n"
            }
        }
    }
    return out
}

func traits() -> String {
    var out = ""
    var rng = SplitMix(state: 42)
    for _ in 0..<3000 {
        let t = randomTraits(&rng)
        let pet = PixelPet.make(from: t)
        let g = PixelPet.growth(for: t)
        let ranked = PixelPet.rankedGenres(t.genres).map(\.rawValue).joined(separator: ",")
        out += "\(pet.code) \(pet.name) | \(pet.blurb) | \(pet.accessibilityDescription) | "
        out += "\(hex(g.experience.bitPattern)) \(g.level) \(g.stage.rawValue) \(g.nextStage?.rawValue ?? "-") "
        out += "\(hex(g.experienceToNextStage.bitPattern)) \(hex(g.progress.bitPattern)) | \(ranked)\n"
    }
    return out
}

func genres() -> String {
    var out = ""
    for (i, name) in genreNames.enumerated() {
        out += "\(i) \(PixelPet.Genre(name: name)?.rawValue ?? "-")\n"
    }
    for genre in PixelPet.Genre.allCases {
        out += "\(genre.rawValue) \(genre.label) \(genre.species.rawValue) \(genre.accessory.rawValue) \(genre.tone.rawValue)\n"
    }
    return out
}

func codes() -> String {
    let alphabet = Array("0123456789abcdefghjkmnpqrstvwxyz")
    var inputs: [String] = [
        "", "p1-", "p1", "hello world", "p1-!!!!!!!!!!", "p1-0000000000", "p1-iiiiiiiiii", "\u{1F98A}\u{1F98A}\u{1F98A}",
        String(repeating: "z", count: 500), "p1-\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}",
        "p1-\u{1F98A}\u{1F98A}\u{1F98A}\u{1F98A}\u{1F98A}", "p1-\u{212A}000000000",
    ]
    for check in alphabet {
        inputs.append("p1-z0000010a" + String(check))
        inputs.append("p1-00000" + "00" + "00" + String(check))
        inputs.append("p1-00000" + "38" + "00" + String(check))
        inputs.append("p1-00000" + "01" + "00" + String(check))
        inputs.append("p1-e3i30" + "33" + "zz" + String(check))
    }
    for pet in traitPets().prefix(40) {
        let code = pet.code
        inputs += [
            code.uppercased(), " \t" + code + "\n", "\u{A0}" + code + "\u{2028}", "\u{200B}" + code, code + "\u{85}",
            "\u{FEFF}" + code, "\u{1680}" + code + "\r\n", String(code.dropLast()), code + "0",
            "p1_" + code.dropFirst(3), "P1-" + code.dropFirst(3), "p2-" + code.dropFirst(3),
        ]
        let chars = Array(code)
        for i in 3..<chars.count {
            for c in alphabet where c != chars[i] {
                var changed = chars
                changed[i] = c
                inputs.append(String(changed))
            }
        }
    }
    var out = ""
    for (i, text) in inputs.enumerated() {
        out += "\(i) \(PixelPet(code: text)?.code ?? "nil")\n"
    }
    return out
}

func bounds() -> String {
    var out = ""
    for s in PixelPet.Species.allCases {
        for st in PixelPet.Stage.allCases {
            for a in PixelPet.Accessory.allCases {
                let pet = PixelPet(species: s, stage: st, accessory: a)
                let b = pet.contentBounds
                var line = "\(pet.code) \(b.x),\(b.y),\(b.w),\(b.h)"
                for pixels in 0...200 {
                    let c = PixelPet.tightCrop(for: b, devicePixels: pixels)
                    line += " \(c.x),\(c.y),\(c.side)"
                }
                out += line + "\n"
            }
        }
    }
    return out
}

func art() -> String {
    var out = ""
    for s in PixelPet.Species.allCases {
        for st in [PixelPet.Stage.baby, .teen, .adult] {
            let sprite = PetArt.sprite(s, st)
            out += "\(s.rawValue) \(st.rawValue) \(sprite.width)x\(sprite.height) head \(sprite.head.x),\(sprite.head.y)"
            out += " neck \(sprite.neck) hand \(sprite.hand.x),\(sprite.hand.y) half \(sprite.headHalfWidth)"
            out += " mouth \(sprite.mouth.map { "\($0.x),\($0.y)" } ?? "-")"
            out += " eyes " + sprite.eyes.map { "\($0.x),\($0.y),\($0.w),\($0.h)" }.joined(separator: ";")
            out += " rect \(sprite.isRectangular)\n"
            for y in 0..<sprite.height {
                out += String(decoding: (0..<sprite.width).map { sprite.key($0, y) }, as: UTF8.self) + "\n"
            }
        }
        for tone in PixelPet.Tone.allCases {
            let palette = PetArt.palette(s, tone)
            out += "\(s.rawValue) \(tone.rawValue) " + palette.map { String($0, radix: 16) }.joined(separator: ",") + "\n"
        }
    }
    return out
}

/// The SwiftUI view itself, rendered offscreen: what ends up on screen, as premultiplied BGRA bytes.
@MainActor
func views() -> String {
    let pets = [
        PixelPet(species: .fox, stage: .legend, accessory: .scarf, tone: .sunny, mood: .happy, level: 19, nameIndex: 7),
        PixelPet(species: .ghost, stage: .teen, accessory: .horns, tone: .dusk, mood: .sleepy, level: 5, nameIndex: 300),
        PixelPet(species: .robot, stage: .adult, accessory: .glasses3D, tone: .classic, mood: .bored, level: 9, nameIndex: 1023),
        PixelPet(species: .owl, stage: .baby, accessory: .headphones, tone: .classic, mood: .content, level: 1, nameIndex: 0),
        PixelPet(species: .bunny, stage: .adult, accessory: .wizardHat, tone: .sunny, mood: .happy, level: 30, nameIndex: 512),
    ]
    let sizes: [CGFloat] = [20.64, 24, 28, 37.84, 40, 44, 120, 150, 168]
    var out = ""
    for pet in pets {
        for size in sizes {
            for scale in [1.0, 2.0] {
                for framing in [PixelPetView.Framing.automatic, .stage, .tight] {
                    for time in [0.0, 1.7] {
                        let renderer = ImageRenderer(content: PixelPetView(pet: pet, size: size, time: time, framing: framing))
                        renderer.scale = scale
                        guard let image = renderer.cgImage else { out += "nil\n"; continue }
                        let w = image.width, h = image.height
                        var bytes = [UInt8](repeating: 0, count: w * h * 4)
                        let space = CGColorSpace(name: CGColorSpace.sRGB)!
                        let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
                        bytes.withUnsafeMutableBytes { raw in
                            let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8,
                                                bytesPerRow: w * 4, space: space, bitmapInfo: info)!
                            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
                        }
                        let f = framing == .automatic ? "auto" : framing == .stage ? "stage" : "tight"
                        out += "\(pet.code) \(size) \(scale) \(f) \(time) \(w)x\(h) \(hex(fnvBytes(bytes)))\n"
                    }
                }
            }
        }
    }
    return out
}

@main
struct PetDump {
    @MainActor
    static func main() {
        let dir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "petdump"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let sections: [(String, () -> String)] = [
            ("renders", renders), ("pixels", pixels), ("frames", frames), ("traits", traits), ("genres", genres),
            ("codes", codes), ("bounds", bounds), ("art", art), ("views", views),
        ]
        for (name, make) in sections {
            let text = make()
            try? text.write(toFile: dir + "/" + name + ".txt", atomically: true, encoding: .utf8)
            print(name, hex(PixelPet.stableHash(text)))
        }
    }
}
