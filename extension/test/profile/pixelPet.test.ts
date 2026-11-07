// Port of windows/Cineon.Core.Tests/Profile/PixelPetTests.cs (itself CineonTests/PixelPetTests.swift):
// same cases and expectations, plus the canvas helper.

import {
  PetAccessory, PetArt, PetBitmap, PetCanvas, PetCrop, PetFrame, PetGenre, PetMood, PetSpecies, PetStage,
  PetTone, PetTraits, PixelPet, type GenreWeight, type PetCanvasElement, type PetEyes,
} from "../../src/core/profile";

// MARK: Helpers

const MASK64 = (1n << 64n) - 1n;

/** Small deterministic generator so failures are reproducible. */
class SplitMix {
  constructor(private state: bigint) {}

  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
  }

  /** Uniform in lo...hi (inclusive). */
  int(lo: number, hi: number): number {
    return lo + Number(this.next() % BigInt(hi - lo + 1));
  }

  double(lo: number, hi: number): number {
    return lo + Number(this.next() >> 11n) * (1.0 / 2 ** 53) * (hi - lo);
  }

  bool(): boolean {
    return (this.next() & 1n) === 1n;
  }

  shuffle<T>(list: T[]): void {
    for (let i = list.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
  }
}

const GENRE_NAMES = [
  "Action", "Drama", "Adventure", "Crime", "Comedy", "Thriller", "Fantasy", "Sci-Fi", "Mystery",
  "Horror", "Animation", "Biography", "War", "Sport", "Romance", "History", "Family", "Short",
  "Western", "Music", "Documentary", "Musical", "Reality-TV", "Talk-Show", "Game-Show", "News",
  "Film-Noir", "Science Fiction", "Bollywood", "", "Action & Adventure",
];

function uuidFromBytes(bytes: number[]): string {
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomTraits(rng: SplitMix): PetTraits {
  const count = rng.int(0, 6);
  const genres: GenreWeight[] = [];
  for (let i = 0; i < count; i++) genres.push({ name: GENRE_NAMES[rng.int(0, GENRE_NAMES.length - 1)]!, weight: rng.int(-2, 50) });
  const bytes = new Array<number>(16).fill(0);
  bytes[0] = rng.int(0, 255);
  for (let i = 1; i < 15; i++) bytes[i] = i;
  bytes[15] = rng.int(0, 255);
  return {
    genres,
    hoursWatched: rng.double(0, 3000),
    titlesFinished: rng.int(0, 2000),
    daysSinceLastWatch: rng.bool() ? null : rng.int(-3, 400),
    seed: PetTraits.seedFor(uuidFromBytes(bytes)),
  };
}

function traits(
  genres: [string, number][],
  { hours = 0, titles = 0, days = 0 as number | null, seed = "8E1F3C1A-7A43-4C1B-9C0B-2B7D1D6C9A11" } = {},
): PetTraits {
  return {
    genres: genres.map(([name, weight]) => ({ name, weight })),
    hoursWatched: hours, titlesFinished: titles, daysSinceLastWatch: days, seed,
  };
}

const opaque = (bitmap: PetBitmap) => bitmap.pixels.filter((p) => p !== 0).length;

function expectSamePet(a: PixelPet | null, b: PixelPet | null) {
  expect(a).not.toBeNull();
  expect(a!.equals(b)).toBe(true);
}

// MARK: Determinism

test("same traits give the same pet and code", () => {
  const rng = new SplitMix(1n);
  for (let i = 0; i < 200; i++) {
    const t = randomTraits(rng);
    const a = PixelPet.make(t), b = PixelPet.make(t);
    expectSamePet(a, b);
    expect(a.code).toBe(b.code);
    expect(a.name).toBe(b.name);
    expect(a.blurb).toBe(b.blurb);
  }
});

test("genre order does not matter", () => {
  const rng = new SplitMix(2n);
  for (let i = 0; i < 200; i++) {
    const t = randomTraits(rng);
    const pet = PixelPet.make(t);
    const shuffled = [...t.genres];
    rng.shuffle(shuffled);
    expectSamePet(pet, PixelPet.make({ ...t, genres: shuffled }));
  }
});

test("a known seed gives a known name", () => {
  // FNV-1a is stable across launches; this pins the name tables and hash.
  const pet = PixelPet.make(traits([["Horror", 3]], { seed: "seed-a" }));
  expect(pet.nameIndex).toBe(PixelPet.nameIndexFor("seed-a", "ghost"));
  expect(PixelPet.stableHash("a")).toBe(0xaf63dc4c8601ec8cn);
  expect(PixelPet.stableHash("")).toBe(0xcbf29ce484222325n);
});

// MARK: Codes

test("the code round-trips for random traits", () => {
  const rng = new SplitMix(3n);
  const allowed = "0123456789abcdefghjkmnpqrstvwxyz-";
  for (let i = 0; i < 1000; i++) {
    const pet = PixelPet.make(randomTraits(rng));
    const code = pet.code;
    expect(code.startsWith("p1-")).toBe(true);
    expect(code.length).toBeLessThanOrEqual(40);
    expect([...code].every((c) => allowed.includes(c))).toBe(true);
    expectSamePet(pet, PixelPet.fromCode(code));
  }
});

test("the code round-trips for every combination", () => {
  for (const species of PetSpecies.all)
    for (const stage of PetStage.all)
      for (const accessory of PetAccessory.all)
        for (const tone of PetTone.all)
          for (const mood of PetMood.all)
            for (const [level, nameIndex] of [[1, 0], [99, 1023], [42, 517]] as const) {
              const pet = new PixelPet({ species, stage, accessory, tone, mood, level, nameIndex });
              expect(pet.equals(PixelPet.fromCode(pet.code))).toBe(true);
            }
});

test("the code is tolerant of case and whitespace", () => {
  const pet = PixelPet.make(traits([["Sci-Fi", 4]], { titles: 30 }));
  expectSamePet(pet, PixelPet.fromCode("  " + pet.code.toUpperCase() + "\n"));
});

test("the code rejects garbage", () => {
  const pet = PixelPet.make(traits([["Comedy", 4]], { titles: 30 }));
  const code = pet.code;
  const rejects = [
    "", "p1-", "p1", "p2-" + code.slice(3), "p0-" + code.slice(3), code + "0",
    code.slice(0, -1), "hello world", "p1-!!!!!!!!!!", "p1-0000000000", "p1-iiiiiiiiii",
    "\u{1F98A}\u{1F98A}\u{1F98A}", "z".repeat(500), "p1-\0\0\0\0\0\0\0\0\0\0",
  ];
  for (const text of rejects) expect(PixelPet.fromCode(text), `accepted ${text}`).toBeNull();
  expect(PixelPet.fromCode(null)).toBeNull();
  expect(PixelPet.fromCode(undefined)).toBeNull();
  // Any single-character change breaks the checksum or a range check (or is another valid pet).
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const chars = [...code];
  for (let i = 3; i < chars.length; i++) {
    const original = chars[i]!;
    for (const c of alphabet) {
      if (c === original) continue;
      chars[i] = c;
      const other = PixelPet.fromCode(chars.join(""));
      if (other) expect(pet.equals(other)).toBe(false);
    }
    chars[i] = original;
  }
});

test("the code rejects out-of-range fields even with a valid checksum", () => {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  // Species "z" (31) does not exist; try every possible checksum character.
  for (const check of alphabet) {
    expect(PixelPet.fromCode("p1-z0000010a" + check)).toBeNull();
    expect(PixelPet.fromCode("p1-00000" + "00" + "00" + check)).toBeNull(); // level 0
    expect(PixelPet.fromCode("p1-00000" + "38" + "00" + check)).toBeNull(); // level 104
  }
});

test("JSON uses the code", () => {
  const pet = PixelPet.make(traits([["Fantasy", 9], ["Romance", 3]], { titles: 90, days: 3 }));
  const json = JSON.stringify([pet]);
  expect(json).toBe(`["${pet.code}"]`);
  const back = (JSON.parse(json) as string[]).map((code) => PixelPet.fromCode(code));
  expectSamePet(back[0]!, pet);
  expect(PixelPet.fromCode(JSON.parse(`"nope"`) as string)).toBeNull();
});

// MARK: Genres

test("the favourite genre drives the species", () => {
  const cases: [string, PetSpecies][] = [
    ["Horror", "ghost"], ["Action", "fox"], ["Adventure", "turtle"], ["Drama", "cat"],
    ["Comedy", "frog"], ["Crime", "raccoon"], ["Thriller", "raven"], ["Sci-Fi", "robot"],
    ["Science Fiction", "robot"], ["sci fi", "robot"], ["Fantasy", "dragon"], ["Mystery", "owl"],
    ["Documentary", "owl"], ["Biography", "owl"], ["History", "owl"], ["Animation", "slime"],
    ["Romance", "bunny"], ["Family", "puppy"], ["Sport", "puppy"], ["Western", "raccoon"],
    ["Music", "songbird"], ["Musical", "songbird"], ["War", "hedgehog"], ["Film-Noir", "raccoon"],
    ["Reality-TV", "frog"], ["Talk-Show", "frog"], ["Game-Show", "frog"], ["News", "owl"],
    ["Short", "slime"], ["HORROR", "ghost"], ["  thriller ", "raven"],
  ];
  for (const [name, species] of cases) {
    expect(PixelPet.make(traits([[name, 1]])).species).toBe(species);
    const filler = name === "Drama" ? "Comedy" : "Drama";
    expect(PixelPet.make(traits([[filler, 3], [name, 10]])).species).toBe(species);
  }
  const horrorFan = traits([["Comedy", 4], ["Horror", 25], ["Drama", 7], ["Thriller", 3]]);
  expect(PixelPet.make(horrorFan).species).toBe("ghost");
  expect(PixelPet.make(horrorFan).speciesLabel).toBe("Ghost");
});

test("aliases merge before ranking", () => {
  // "Sci-Fi" 3 + "Science Fiction" 3 beats "Action" 5.
  const pet = PixelPet.make(traits([["Action", 5], ["Sci-Fi", 3], ["Science Fiction", 3]]));
  expect(pet.species).toBe("robot");
  expect(pet.accessory).toBe("headband");
});

test("ties break by commonness", () => {
  const pet = PixelPet.make(traits([["Horror", 5], ["Action", 5]]));
  expect(pet.species).toBe("fox");
  expect(pet.accessory).toBe("horns");
});

test("the second genre picks the accessory and the third the tone", () => {
  const pet = PixelPet.make(traits([["Horror", 10], ["Sci-Fi", 6], ["Comedy", 2]]));
  expect(pet.species).toBe("ghost");
  expect(pet.accessory).toBe("glasses3D");
  expect(pet.tone).toBe("sunny");
  for (const genre of PetGenre.all) {
    const p = PixelPet.make(traits([["Drama", 10], [genre, 5], ["Horror", 1]]));
    if (genre !== "drama") expect(p.accessory).toBe(PetGenre.accessory(genre));
  }
});

test("unknown and empty genres still make a valid pet", () => {
  const inputs: [string, number][][] = [
    [], [["Bollywood", 10]], [["", 3]], [["Horror", 0]], [["Horror", -4]], [["Horror", NaN]],
    [["Horror", Infinity]], [["???", 1], ["Telenovela", 2]],
  ];
  for (const genres of inputs) {
    const pet = PixelPet.make(traits(genres));
    expect(pet.species).toBe("slime");
    expect(pet.accessory).toBe("none");
    expectSamePet(pet, PixelPet.fromCode(pet.code));
    expect(pet.name).not.toBe("");
    expect(pet.blurb).not.toBe("");
    expect(opaque(pet.bitmap())).not.toBe(0);
  }
  // Unknown names next to a known one are ignored.
  expect(PixelPet.make(traits([["Bollywood", 50], ["War", 1]])).species).toBe("hedgehog");
  // Combined names split into their parts.
  expect(PixelPet.make(traits([["Sci-Fi & Fantasy", 10], ["Drama", 4]])).species).toBe("robot");
});

// MARK: Stage, level, mood

test("stage thresholds", () => {
  const cases: [number, number, PetStage][] = [
    [0, 0, "baby"], [9.99, 0, "baby"], [10, 0, "teen"], [0, 6, "baby"], [0, 7, "teen"],
    [59.9, 0, "teen"], [60, 0, "adult"], [0, 40, "adult"], [199.9, 0, "adult"], [200, 0, "legend"],
    [0, 133, "adult"], [0, 134, "legend"], [0, 240, "legend"], [5000, 900, "legend"],
    [-50, -3, "baby"], [NaN, 0, "baby"], [Infinity, 0, "baby"],
  ];
  for (const [hours, titles, stage] of cases) {
    const pet = PixelPet.make(traits([["Drama", 1]], { hours, titles }));
    expect(pet.stage).toBe(stage);
    expect(pet.stageLabel).toBe(PetStage.label(stage));
  }
  expect(PetStage.all.map(PetStage.label)).toEqual(["Baby", "Teen", "Adult", "Legend"]);
  expect(PetStage.ordinal("baby")).toBeLessThan(PetStage.ordinal("teen"));
  expect(PetStage.ordinal("adult")).toBeLessThan(PetStage.ordinal("legend"));
});

test("levels", () => {
  expect(PixelPet.make(traits([], { hours: 0, titles: 0 })).level).toBe(1);
  expect(PixelPet.make(traits([], { hours: 3, titles: 0 })).level).toBe(2);
  expect(PixelPet.make(traits([], { hours: 0, titles: 240 })).level).toBe(19); // xp 360
  expect(PixelPet.make(traits([], { hours: 1e9, titles: 0 })).level).toBe(99);
  let last = 0;
  for (let i = 0; i * 7.5 <= 10_000; i++) {
    const level = PixelPet.levelForExperience(i * 7.5);
    expect(level).toBeGreaterThanOrEqual(last);
    expect(level).toBeGreaterThanOrEqual(1);
    expect(level).toBeLessThanOrEqual(99);
    last = level;
  }
});

test("growth progress", () => {
  const g = PixelPet.growth(traits([], { hours: 0, titles: 20 })); // xp 30
  expect(g.stage).toBe("teen");
  expect(g.nextStage).toBe("adult");
  expect(g.experienceToNextStage).toBeCloseTo(30, 9);
  expect(g.progress).toBeCloseTo(0.4, 9);
  const legend = PixelPet.growth(traits([], { titles: 240 }));
  expect(legend.nextStage).toBeNull();
  expect(legend.progress).toBe(1);
});

test("mood thresholds", () => {
  const cases: [number | null, PetMood][] = [
    [null, "sleepy"], [-2, "happy"], [0, "happy"], [1, "happy"], [2, "content"],
    [5, "content"], [6, "bored"], [14, "bored"], [15, "sleepy"], [365, "sleepy"],
  ];
  for (const [days, mood] of cases) expect(PixelPet.make(traits([["Comedy", 1]], { days })).mood).toBe(mood);
  expect(PetMood.label("sleepy")).toBe("Sleepy");
  expect(PetMood.label("happy")).toBe("Happy");
});

test("a real library's shape", () => {
  // Counts from the real library, most first; ~0 tracked hours, 240 finished titles.
  const names = [
    "Action", "Drama", "Adventure", "Crime", "Comedy", "Thriller", "Fantasy", "Sci-Fi",
    "Mystery", "Horror", "Animation", "Biography", "War", "Sport", "Romance", "History",
    "Family", "Short", "Western", "Music", "Documentary",
  ];
  const genres = names.map((name, offset): [string, number] => [name, 120 - offset * 5]);
  const pet = PixelPet.make(traits(genres, { hours: 0.4, titles: 240, days: 1 }));
  expect(pet.species).toBe("fox");
  expect(pet.accessory).toBe("scarf");
  expect(pet.tone).toBe("sunny");
  expect(pet.stage).toBe("legend");
  expect(pet.mood).toBe("happy");
  expect(pet.level).toBe(19);
});

// MARK: Names and text

test("names are short and clean", () => {
  const blocked = [
    "ass", "cum", "fag", "gay", "jap", "kike", "loli", "nazi", "nig", "paki", "pedo", "piss",
    "poo", "porn", "puta", "puto", "rape", "sex", "shit", "slut", "tit", "fuk", "coon", "homo",
    "suki", "chichi", "hui", "huj", "pizd", "blya", "gay",
  ];
  const names = new Set<string>();
  for (let index = 0; index < PixelPet.nameCount; index++) {
    const name = new PixelPet({ species: "cat", stage: "baby", nameIndex: index }).name;
    names.add(name);
    expect(name.length).toBeGreaterThanOrEqual(3);
    expect(name.length).toBeLessThanOrEqual(7);
    expect(name[0]).toBe(name[0]!.toUpperCase());
    for (const bad of blocked) expect(name.toLowerCase()).not.toContain(bad);
  }
  expect(names.size).toBeGreaterThan(900);
  expect(PixelPet.nameHeads.length * PixelPet.nameTails.length).toBe(PixelPet.nameCount);
});

test("labels and blurbs exist", () => {
  for (const species of PetSpecies.all) {
    for (let index = 0; index < 6; index++) {
      const pet = new PixelPet({ species, stage: "adult", nameIndex: index });
      expect(pet.speciesLabel).not.toBe("");
      expect(pet.blurb).not.toBe("");
      expect(pet.blurb.length).toBeLessThanOrEqual(70);
      expect(pet.accessibilityDescription).toContain(pet.name);
    }
  }
});

// MARK: Art

test("every sprite is rectangular and uses known keys", () => {
  const allowed = new Set([...PetArt.spriteKeys, ...PetArt.sharedKeys]);
  const beaked = new Set<PetSpecies>(["raven", "owl", "songbird"]);
  for (const species of PetSpecies.all) {
    for (const stage of PetStage.all) {
      const sprite = PetArt.spriteFor(species, stage);
      const label = `${species} ${stage}`;
      expect(sprite.isRectangular, label).toBe(true);
      expect(sprite.keys.length).toBe(sprite.width * sprite.height);
      expect(sprite.eyes.length).toBe(2);
      for (const eye of sprite.eyes) expect(eye.w * eye.h).toBe(4);
      if (!beaked.has(species)) expect(sprite.mouth, label).not.toBeNull();
      // Fits the 24×24 canvas when placed.
      const left = PetArt.centerX - sprite.head.x;
      expect(left, label).toBeGreaterThanOrEqual(0);
      expect(left + sprite.width, label).toBeLessThanOrEqual(PetBitmap.size);
      expect(sprite.height, label).toBeLessThanOrEqual(PetBitmap.size);
      expect(sprite.head.y).toBeGreaterThanOrEqual(0);
      expect(sprite.head.y).toBeLessThan(sprite.height);
      expect(sprite.neck).toBeGreaterThanOrEqual(0);
      expect(sprite.neck).toBeLessThan(sprite.height);
      for (const key of sprite.keys) expect(allowed.has(String.fromCharCode(key)), `${label} uses ${String.fromCharCode(key)}`).toBe(true);
      for (const tone of PetTone.all) {
        const palette = PetArt.palette(species, tone);
        for (const key of new Set(sprite.keys)) {
          if (key === PetArt.K(".") || key === PetArt.K("E")) continue;
          expect(palette[key], `${label} ${tone} lacks ${String.fromCharCode(key)}`).not.toBe(0);
        }
        for (const key of "eiowt") expect(palette[PetArt.K(key)]).not.toBe(0);
      }
    }
  }
});

test("every overlay is rectangular and uses known keys", () => {
  const allowed = new Set([...PetArt.spriteKeys, ...PetArt.sharedKeys]);
  for (const { name, overlay } of PetArt.allOverlays()) {
    expect(overlay.isRectangular, name).toBe(true);
    expect(overlay.width * overlay.height, name).toBeGreaterThan(0);
    for (const key of overlay.keys) expect(allowed.has(String.fromCharCode(key)), `${name} uses ${String.fromCharCode(key)}`).toBe(true);
  }
  for (const accessory of PetAccessory.all) {
    if (PetAccessory.isHat(accessory) && accessory !== "headphones") expect(PetArt.hats.has(accessory), accessory).toBe(true);
  }
});

test("every combination renders", () => {
  for (const species of PetSpecies.all) {
    for (const stage of PetStage.all) {
      const bare = new PixelPet({ species, stage }).bitmap();
      for (const accessory of PetAccessory.all) {
        for (const mood of PetMood.all) {
          const pet = new PixelPet({ species, stage, accessory, mood });
          for (const t of [0.0, 0.25, 0.9, 1.7, 3.1, 4.4]) expect(pet.bitmap(pet.frameAt(t)).pixels.length).toBe(576);
          const still = pet.bitmap();
          expect(opaque(still), `${species} ${stage}`).toBeGreaterThan(60);
          if (accessory !== "none" && !(stage === "legend" && PetAccessory.isHat(accessory))) {
            expect(still.equals(new PixelPet({ species, stage, mood }).bitmap()), `${accessory} invisible on ${species} ${stage}`).toBe(false);
          }
        }
      }
      // Babies are smaller than adults.
      if (stage === "baby") expect(opaque(bare)).toBeLessThan(opaque(new PixelPet({ species, stage: "adult" }).bitmap()));
    }
  }
});

test("frames", () => {
  const sleepy = new PixelPet({ species: "owl", stage: "teen", mood: "sleepy" });
  const legend = new PixelPet({ species: "fox", stage: "legend", mood: "happy" });
  for (let i = 0; i < 200; i++) {
    const t = i * 0.1;
    expect(sleepy.frameAt(t).eyes).toBe("closed");
    expect(sleepy.frameAt(t).effect).toBe("zzz");
    expect(legend.frameAt(t).sparkle).not.toBeNull();
    expect(sleepy.frameAt(t).sparkle).toBeNull();
    expect(legend.frameAt(t).lift).toBeGreaterThanOrEqual(0);
    expect(legend.frameAt(t).lift).toBeLessThanOrEqual(3);
    expect(PetFrame.equals(legend.frameAt(t), legend.frameAt(t))).toBe(true);
  }
  const content = new PixelPet({ species: "cat", stage: "adult", mood: "content" });
  const eyes = new Set<PetEyes>(Array.from({ length: 200 }, (_, i) => content.frameAt(i * 0.05).eyes));
  expect(eyes).toEqual(new Set(["open", "closed"])); // it blinks
  expect(new PixelPet({ species: "cat", stage: "adult", mood: "bored" }).restingFrame.effect).toBe("dots");
  expect(sleepy.restingFrame.eyes).toBe("closed");
  expect(content.restingFrame.lift).toBe(0);
});

test("a tight crop stays inside the canvas", () => {
  for (const species of PetSpecies.all) {
    for (const stage of PetStage.all) {
      const pet = new PixelPet({ species, stage, accessory: "wizardHat" });
      const bounds = pet.contentBounds;
      for (const pixels of [12, 16, 24, 32, 40, 48, 56, 72, 96, 200]) {
        const crop = PixelPet.tightCrop(bounds, pixels);
        expect(crop.side).toBeGreaterThanOrEqual(12);
        expect(crop.side).toBeLessThanOrEqual(24);
        expect(crop.x).toBeGreaterThanOrEqual(0);
        expect(crop.y).toBeGreaterThanOrEqual(0);
        expect(crop.x + crop.side).toBeLessThanOrEqual(24);
        expect(crop.y + crop.side).toBeLessThanOrEqual(24);
      }
    }
  }
});

// MARK: Windows additions

test("the twinkle phase never leaves the table", () => {
  // On the Mac, name 335 at 0.25 s rounds the Legend twinkle phase up to 6 and the renderer traps.
  const pet = new PixelPet({ species: "fox", stage: "legend", nameIndex: 335 });
  expect(pet.frameAt(0.25).sparkle).toBe(5);
  expect(pet.bitmap(pet.frameAt(0.25)).pixels.length).toBe(576);
});

test("raw values are the Swift case names", () => {
  expect(PetAccessory.fromRaw("glasses3D")).toBe("glasses3D");
  expect(PetAccessory.fromRaw("explorerHat")).toBe("explorerHat");
  expect(PetGenre.fromRaw("sciFi")).toBe("sciFi");
  expect(PetGenre.fromRaw("realityTV")).toBe("realityTV");
  expect(PetSpecies.fromRaw("songbird")).toBe("songbird");
  expect(PetAccessory.fromRaw("cowboyHat")).toBe("cowboyHat");
  expect(PetSpecies.fromRaw("Fox")).toBeNull();
  for (const genre of PetGenre.all) expect(PetGenre.fromRaw(genre)).toBe(genre);
  expect(PetGenre.label("sciFi")).toBe("Sci-Fi");
  expect(PetGenre.label("documentary")).toBe("Documentary");
});

test("the seed is the Mac's upper-case UUID", () => {
  expect(PetTraits.seedFor("8e1f3c1a-7a43-4c1b-9c0b-2b7d1d6c9a11")).toBe("8E1F3C1A-7A43-4C1B-9C0B-2B7D1D6C9A11");
});

test("the canvas draws whole device pixels", () => {
  const pet = new PixelPet({ species: "fox", stage: "adult", accessory: "scarf" });
  // 168 px at 1.5×: 252 device pixels, 10 per cell on the whole 24×24 stage, 6 left over each side.
  const frame = PetCanvas.frameFor(pet, 168, { animated: false });
  const image = PetCanvas.render(pet, frame, 168, 1.5);
  expect(image.pixelWidth).toBe(252);
  expect(image.rgba.length).toBe(252 * 252 * 4);
  const rects = PetCanvas.deviceRects(pet.bitmap(frame), PetCrop.canvas, 168, 168, 1.5);
  for (const r of rects) {
    expect((r.x0 - 6) % 10).toBe(0);
    expect((r.y0 - 6) % 10).toBe(0);
  }
  // Every opaque cell becomes a 10×10 block of its colour, RGBA.
  const bitmap = pet.bitmap(frame);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const offset = ((6 + y * 10) * 252 + 6 + x * 10) * 4;
      const argb = bitmap.get(x, y);
      expect(image.rgba[offset + 3]).toBe(argb === 0 ? 0 : 255);
      if (argb !== 0) expect(image.rgba[offset]).toBe((argb >>> 16) & 0xff);
    }
  }
  // Small avatars crop to the pet and drop floating effects.
  expect(PetCanvas.isTight(28, "automatic")).toBe(true);
  expect(PetCanvas.isTight(40, "automatic")).toBe(false);
  const sleepy = new PixelPet({ species: "cat", stage: "adult", mood: "sleepy" });
  expect(PetCanvas.frameFor(sleepy, 28, { animated: false }).effect).toBe("none");
  expect(PetCanvas.frameFor(sleepy, 120, { animated: false }).effect).toBe("zzz");
  expect(pet.bitmap().toRgba().length).toBe(24 * 24 * 4);
});

// MARK: Extension additions

test("draw sizes the canvas to device pixels and puts the image without smoothing", () => {
  const pet = new PixelPet({ species: "owl", stage: "teen", accessory: "specs", mood: "happy" });
  let put: { data: Uint8ClampedArray; dx: number; dy: number } | null = null;
  const context = {
    imageSmoothingEnabled: true,
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(image: unknown, dx: number, dy: number) {
      put = { data: (image as { data: Uint8ClampedArray }).data, dx, dy };
    },
  };
  const canvas: PetCanvasElement = {
    width: 300, height: 150, style: { width: "", height: "" }, getContext: () => context,
  };
  const frame = PetCanvas.frameFor(pet, 44, { time: 1.7 });
  const image = PetCanvas.draw(canvas, pet, frame, 44, 2);
  expect(canvas.width).toBe(88);
  expect(canvas.height).toBe(88);
  expect(canvas.style).toEqual({ width: "44px", height: "44px" });
  expect(context.imageSmoothingEnabled).toBe(false);
  expect(put!.dx).toBe(0);
  expect(put!.dy).toBe(0);
  expect([...put!.data]).toEqual([...image.rgba]);
  expect(image.rgba.some((b) => b !== 0)).toBe(true);
});

// Compile-time only: the DOM's canvases fit the helper's interfaces.
export function canvasesFit(element: HTMLCanvasElement, offscreen: OffscreenCanvas): PetCanvasElement[] {
  return [element, offscreen];
}
