// Port of Cineon/Profile/PixelPet.swift (by way of windows/Cineon.Core/Profile/PixelPet.cs): the model, its
// shareable code, the generator and the animation poses. Rendering is in petRenderer.ts, the view logic
// (pose, crop, device pixels, canvas) in petCanvas.ts.
//
// Showing a pet (the UI does this; core has no DOM):
//  1. Your own: `PixelPet.make(stats.petTraits(PetTraits.seedFor(profile.id)))`. The seed is the profile
//     UUID in upper case, as Swift's `uuidString`, so a Mac or Windows profile gets the same pet.
//     A friend's: `PixelPet.fromCode(code)` (null: show their initial).
//  2. Every `PetCanvas.frameInterval` ms (100, the Mac's TimelineView minimumInterval), while visible and
//     animated: `const frame = PetCanvas.frameFor(pet, size, { framing, animated, reduceMotion })`; redraw
//     only when `!PetFrame.equals(frame, last)`. Still avatars or reduced motion: draw the resting frame once.
//  3. Draw with `PetCanvas.draw(canvas, pet, frame, size, devicePixelRatio, framing)`.
//  4. Accessibility: `role="img"`, `aria-label={pet.accessibilityDescription}`.

import { Fnv64, stableHash } from "./fnv";
import { PetArt } from "./petArt";
import { PetBitmap, PetFrame, type PetCrop, type PetRect } from "./petBitmap";
import { renderPet } from "./petRenderer";
import { PetAccessory, PetGenre, PetMood, PetSpecies, PetStage, PetTone } from "./petTypes";

// MARK: - Inputs

/**
 * One genre and how much of it the person watches. Any non-negative scale works (title counts, hours);
 * only the relative order matters.
 */
export interface GenreWeight {
  readonly name: string;
  readonly weight: number;
}

/** Everything the generator looks at. Same traits always give the same pet. */
export interface PetTraits {
  /** Any order, any weights ≥ 0 (others are ignored); may be empty. */
  readonly genres: readonly GenreWeight[];
  readonly hoursWatched: number;
  readonly titlesFinished: number;
  /** `null` means the person has never watched anything. */
  readonly daysSinceLastWatch: number | null;
  /** Stable per profile (a UUID string). Drives the name and small variations. */
  readonly seed: string;
}

export const PetTraits = {
  /** The seed the Mac uses for a profile: `profile.id.uuidString`, which is upper case. */
  seedFor(profileId: string): string {
    return profileId.trim().toUpperCase();
  },
};

// MARK: - Growth

export interface PetGrowth {
  readonly experience: number;
  readonly level: number;
  readonly stage: PetStage;
  readonly nextStage: PetStage | null;
  /** Experience still needed for the next stage (0 at Legend). */
  readonly experienceToNextStage: number;
  /** 0...1 progress through the current stage (1 at Legend). */
  readonly progress: number;
}

// MARK: - Pet

export interface PixelPetInit {
  species: PetSpecies;
  stage: PetStage;
  accessory?: PetAccessory;
  tone?: PetTone;
  mood?: PetMood;
  /** 1...99. */
  level?: number;
  /** 0..<1024. */
  nameIndex?: number;
}

const MAX_LEVEL = 99;
const NAME_COUNT = 1024;
const CODE_PREFIX = "p1-";
const CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const GENRE_SEPARATORS = /[&/,+]/;
const HOP_LIFT = [1, 2, 3, 2, 1];

/**
 * Swift's `CharacterSet.whitespacesAndNewlines`: white space plus U+200B ZERO WIDTH SPACE, which Foundation
 * still counts (U+FEFF is not trimmed).
 */
const CODE_WHITESPACE = new Set(
  "\u0009\u000A\u000B\u000C\u000D \u0085             ​    　",
);

function trimSet(text: string, set: ReadonlySet<string>): string {
  let start = 0, end = text.length;
  while (start < end && set.has(text[start]!)) start++;
  while (end > start && set.has(text[end - 1]!)) end--;
  return text.slice(start, end);
}

function clampInt(value: number, lo: number, hi: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), lo), hi) : lo;
}

const NAME_HEADS: readonly string[] = [
  "Mo", "Pi", "Bi", "Lu", "Ko", "Nu", "Ha", "Ze", "Ru", "Fi", "Zu", "Bo", "Mi", "Ka", "Yo", "Ne",
  "Ku", "Wa", "Yu", "Do", "Ki", "Ba", "Lo", "Gu", "Na", "Ri", "Po", "Ju", "Sa", "Te", "Ro", "Me",
];

const NAME_TAILS: readonly string[] = [
  "chi", "xel", "mo", "bo", "ko", "ni", "pip", "lo", "mi", "by", "ra", "nu", "zu", "pa", "ki", "ru",
  "no", "ji", "pom", "bun", "sa", "mu", "do", "ri", "po", "tsu", "bi", "ppo", "na", "ku", "fi", "mel",
];

const BLURBS: Readonly<Record<PetSpecies, readonly string[]>> = {
  fox: ["Raised on action, never looks back at explosions.",
    "Does its own stunts. Mostly off the sofa.",
    "Always ready for the sequel."],
  turtle: ["Slow walker, big explorer.",
    "Packs snacks for every quest, even to the kitchen.",
    "Has been to every map in the opening credits."],
  cat: ["Cries at every ending, denies it every time.",
    "Sits in the dark, judging the cinematography.",
    "Prefers a long, quiet character study."],
  frog: ["Laughs at the trailer, laughs harder at the bloopers.",
    "Ribbit is short for one more episode.",
    "Knows every catchphrase by heart."],
  raccoon: ["Solves the heist before the reveal.",
    "Steals your popcorn. Calls it a setup.",
    "Wears the mask, keeps the secrets."],
  raven: ["Raised on thrillers, sleeps with one eye open.",
    "Saw the twist coming three scenes ago.",
    "Trusts nobody in the first act."],
  ghost: ["Says it isn't scared. Watches through its fingers.",
    "Haunts the sofa after midnight.",
    "Boo is its review of every jump scare."],
  robot: ["Computes plot holes at 60 frames per second.",
    "Dreams of electric sheep and director's cuts.",
    "Beep boop: one more space opera."],
  dragon: ["Hoards Blu-rays instead of gold.",
    "Reads every appendix of every saga.",
    "Breathes fire at bad CGI."],
  owl: ["Has a theory about the ending. And a backup theory.",
    "Stays up for the extended edition.",
    "Pauses to read the footnotes."],
  slime: ["Still figuring out its favourite genre.",
    "Absorbs every cartoon it can find.",
    "Squishes happily through the credits."],
  bunny: ["Hops straight to the happy ending.",
    "Keeps a list of perfect first-date films.",
    "Believes in love at first scene."],
  puppy: ["Wags at the opening credits.",
    "Brings the remote back every single time.",
    "Cheers for the underdog. Always."],
  songbird: ["Hums the score for days after.",
    "Knows every soundtrack by heart.",
    "Sings along. Loudly."],
  hedgehog: ["Small, spiky, brave through any battle scene.",
    "Never leaves a film unfinished.",
    "Salutes the end credits."],
};

function checksum(body: string): number {
  return new Fnv64().text(CODE_PREFIX + body).mod(CODE_ALPHABET.length);
}

/**
 * A small pixel-art creature that stands for someone's taste in films.
 *
 * Species comes from the favourite genre, the accessory from the second, the colour tone from the third;
 * stage and level from how much they have watched; mood from how recently. Encodes to a short versioned
 * `code` that friends can decode; JSON uses that same code string.
 */
export class PixelPet {
  static readonly maxLevel = MAX_LEVEL;
  static readonly nameCount = NAME_COUNT;
  static readonly codePrefix = CODE_PREFIX;
  static readonly nameHeads = NAME_HEADS;
  static readonly nameTails = NAME_TAILS;

  readonly species: PetSpecies;
  readonly stage: PetStage;
  readonly accessory: PetAccessory;
  readonly tone: PetTone;
  readonly mood: PetMood;
  /** 1...99. */
  readonly level: number;
  /** Index into the name syllable tables, 0..<1024. See `name`. */
  readonly nameIndex: number;

  private bounds?: PetRect;

  constructor(init: PixelPetInit) {
    this.species = init.species;
    this.stage = init.stage;
    this.accessory = init.accessory ?? "none";
    this.tone = init.tone ?? "classic";
    this.mood = init.mood ?? "content";
    this.level = clampInt(init.level ?? 1, 1, MAX_LEVEL);
    this.nameIndex = clampInt(init.nameIndex ?? 0, 0, NAME_COUNT - 1);
  }

  equals(other: PixelPet | null | undefined): boolean {
    return !!other && this.species === other.species && this.stage === other.stage
      && this.accessory === other.accessory && this.tone === other.tone && this.mood === other.mood
      && this.level === other.level && this.nameIndex === other.nameIndex;
  }

  toString(): string {
    return this.code;
  }

  /** JSON is the code string, like the Swift `Codable` conformance. */
  toJSON(): string {
    return this.code;
  }

  // MARK: Generator

  /** Experience points: hours plus 1.5 per finished title. */
  static experience(hoursWatched: number, titlesFinished: number): number {
    const hours = Number.isFinite(hoursWatched) ? Math.max(hoursWatched, 0) : 0;
    return hours + 1.5 * Math.max(titlesFinished, 0);
  }

  static levelForExperience(experience: number): number {
    const xp = Number.isFinite(experience) ? Math.max(experience, 0) : 0;
    // Swift: min(1 + Int(xp.squareRoot()), maxLevel).
    return Math.min(1 + Math.floor(Math.min(Math.sqrt(xp), 1e9)), MAX_LEVEL);
  }

  static make(traits: PetTraits): PixelPet {
    const ranked = PixelPet.rankedGenres(traits.genres);
    const species = ranked.length > 0 ? PetGenre.species(ranked[0]!) : "slime";
    const accessory = ranked.length > 1 ? PetGenre.accessory(ranked[1]!) : "none";
    const tone = ranked.length > 2
      ? PetGenre.tone(ranked[2]!)
      : PetTone.all[Number((stableHash(traits.seed) >> 20n) % BigInt(PetTone.all.length))]!;
    const xp = PixelPet.experience(traits.hoursWatched, traits.titlesFinished);
    return new PixelPet({
      species,
      stage: PetStage.fromExperience(xp),
      accessory,
      tone,
      mood: PetMood.fromDaysSinceLastWatch(traits.daysSinceLastWatch),
      level: PixelPet.levelForExperience(xp),
      nameIndex: PixelPet.nameIndexFor(traits.seed, species),
    });
  }

  /**
   * Known genres with positive weight, merged by alias, heaviest first.
   * Input order never matters; ties go to the more common genre.
   */
  static rankedGenres(genres: Iterable<GenreWeight>): PetGenre[] {
    const parts: [PetGenre, number][] = [];
    for (const entry of genres) {
      if (!(Number.isFinite(entry.weight) && entry.weight > 0)) continue;
      const genre = PetGenre.fromName(entry.name);
      if (genre) {
        parts.push([genre, entry.weight]);
        continue;
      }
      // "Action & Adventure", "Sci-Fi & Fantasy", "Crime/Drama"...
      const pieces = entry.name.split(GENRE_SEPARATORS).filter((n) => n.length > 0)
        .map((n) => PetGenre.fromName(n)).filter((g): g is PetGenre => g !== null);
      for (const piece of pieces) parts.push([piece, entry.weight / pieces.length]);
    }
    // Sum in a canonical order so float rounding never depends on input order.
    parts.sort((a, b) => PetGenre.ordinal(a[0]) - PetGenre.ordinal(b[0]) || a[1] - b[1]);
    const totals = new Map<PetGenre, number>();
    for (const [genre, weight] of parts) totals.set(genre, (totals.get(genre) ?? 0) + weight);
    return [...totals.keys()].sort((a, b) => {
      const wa = totals.get(a)!, wb = totals.get(b)!;
      return wa > wb ? -1 : wa < wb ? 1 : PetGenre.ordinal(a) - PetGenre.ordinal(b);
    });
  }

  /** FNV-1a, 64-bit, over the UTF-8 bytes. Stable across launches and platforms. */
  static stableHash(text: string): bigint {
    return stableHash(text);
  }

  // MARK: Growth

  static growth(traits: PetTraits): PetGrowth {
    const xp = PixelPet.experience(traits.hoursWatched, traits.titlesFinished);
    const stage = PetStage.fromExperience(xp);
    const next = PetStage.next(stage);
    const level = PixelPet.levelForExperience(xp);
    if (next === null) {
      return { experience: xp, level, stage, nextStage: null, experienceToNextStage: 0, progress: 1 };
    }
    const span = PetStage.minimumExperience(next) - PetStage.minimumExperience(stage);
    return {
      experience: xp,
      level,
      stage,
      nextStage: next,
      experienceToNextStage: Math.max(PetStage.minimumExperience(next) - xp, 0),
      progress: Math.min(Math.max((xp - PetStage.minimumExperience(stage)) / span, 0), 1),
    };
  }

  // MARK: Labels, name, blurb

  get speciesLabel(): string { return PetSpecies.label(this.species); }
  get stageLabel(): string { return PetStage.label(this.stage); }
  get moodLabel(): string { return PetMood.label(this.mood); }
  get accessoryLabel(): string { return PetAccessory.label(this.accessory); }

  get name(): string {
    const tails = NAME_TAILS.length;
    return NAME_HEADS[Math.trunc(this.nameIndex / tails) % NAME_HEADS.length]! + NAME_TAILS[this.nameIndex % tails]!;
  }

  static nameIndexFor(seed: string, species: PetSpecies): number {
    return new Fnv64().text(`${seed}|${species}`).mod(NAME_COUNT);
  }

  /** One short line of personality. */
  get blurb(): string {
    const lines = BLURBS[this.species] ?? ["Loves a good film night."];
    return lines[this.nameIndex % lines.length]!;
  }

  get accessibilityDescription(): string {
    let text = `${this.name}, a ${this.moodLabel.toLowerCase()} ${this.stageLabel.toLowerCase()} `
      + `${this.speciesLabel.toLowerCase()}, level ${this.level}`;
    if (this.accessory !== "none") text += `, with ${this.accessoryLabel.toLowerCase()}`;
    return text;
  }

  // MARK: Code

  /** Compact, URL-safe, versioned: `p1-` + 10 base-32 characters (13 total). */
  get code(): string {
    const fields = [
      PetSpecies.ordinal(this.species), PetStage.ordinal(this.stage), PetAccessory.ordinal(this.accessory),
      PetTone.ordinal(this.tone), PetMood.ordinal(this.mood),
      Math.trunc(this.level / 32), this.level % 32, Math.trunc(this.nameIndex / 32), this.nameIndex % 32,
    ];
    const body = fields.map((f) => CODE_ALPHABET[f]).join("");
    return CODE_PREFIX + body + CODE_ALPHABET[checksum(body)];
  }

  /** Swift's `PixelPet(code:)`: the pet, or null for anything that isn't a valid code. */
  static fromCode(code: string | null | undefined): PixelPet | null {
    if (code == null) return null;
    const text = trimSet(code, CODE_WHITESPACE).toLowerCase();
    if (!text.startsWith(CODE_PREFIX)) return null;
    const chars = text.slice(CODE_PREFIX.length);
    if (chars.length !== 10) return null;
    // UTF-16 units, as C#; any non-alphabet unit (a surrogate too) rejects the code, as in Swift.
    const values: number[] = [];
    for (let i = 0; i < chars.length; i++) {
      const value = CODE_ALPHABET.indexOf(chars[i]!);
      if (value < 0) return null;
      values.push(value);
    }
    if (values[9] !== checksum(chars.slice(0, 9))) return null;
    const v = (i: number) => values[i]!;
    const level = v(5) * 32 + v(6);
    const nameIndex = v(7) * 32 + v(8);
    if (v(0) >= PetSpecies.all.length || v(1) >= PetStage.all.length || v(2) >= PetAccessory.all.length
      || v(3) >= PetTone.all.length || v(4) >= PetMood.all.length || level < 1 || level > MAX_LEVEL
      || nameIndex >= NAME_COUNT) {
      return null;
    }
    return new PixelPet({
      species: PetSpecies.all[v(0)]!, stage: PetStage.all[v(1)]!, accessory: PetAccessory.all[v(2)]!,
      tone: PetTone.all[v(3)]!, mood: PetMood.all[v(4)]!, level, nameIndex,
    });
  }

  // MARK: Animation frames

  /** A still pose that still tells the mood (used when not animated, and for reduced motion). */
  get restingFrame(): PetFrame {
    const frame = PetFrame.make({ mouth: this.baseMouth });
    switch (this.mood) {
      case "happy":
        frame.effect = "heart"; frame.effectStep = 3;
        break;
      case "content":
        break;
      case "bored":
        frame.eyes = "heavy"; frame.effect = "dots"; frame.effectStep = 3;
        break;
      case "sleepy":
        frame.eyes = "closed"; frame.effect = "zzz"; frame.effectStep = 5;
        break;
    }
    if (this.stage === "legend") frame.sparkle = 2;
    return frame;
  }

  private get baseMouth(): PetFrame["mouth"] {
    switch (this.mood) {
      case "happy": return "grin";
      case "content": return "smile";
      case "bored": return "flat";
      default: return "small";
    }
  }

  /**
   * The frame at `time` (seconds, any epoch; the Mac uses seconds since 2001-01-01, see `PetCanvas.now`).
   * Each pet runs slightly out of phase with others so a row of avatars doesn't blink in unison.
   */
  frameAt(time: number): PetFrame {
    const t = time + this.nameIndex * 0.37;
    const phase = (period: number) => {
      const r = t % period;
      return r < 0 ? r + period : r;
    };
    const frame = PetFrame.make({ mouth: this.baseMouth });
    const blinkPeriod = 3.3 + (this.nameIndex % 5) * 0.35;
    const blinking = phase(blinkPeriod) < 0.15;
    switch (this.mood) {
      case "happy": {
        const u = phase(5.2);
        if (u < 0.5) {
          frame.lift = HOP_LIFT[Math.min(Math.trunc(u / 0.1), 4)]!;
          frame.eyes = "happy";
        } else {
          frame.lift = phase(0.8) < 0.4 ? 1 : 0;
          frame.eyes = u < 0.9 ? "happy" : blinking ? "closed" : "open";
        }
        if (u >= 0.3 && u < 2.1) {
          frame.effect = "heart";
          frame.effectStep = Math.trunc((u - 0.3) / 0.3);
        }
        break;
      }
      case "content":
        frame.lift = phase(1.6) < 0.8 ? 0 : 1;
        frame.eyes = blinking ? "closed" : "open";
        break;
      case "bored": {
        frame.lift = phase(2.4) < 1.2 ? 0 : 1;
        frame.eyes = blinking ? "closed" : "heavy";
        const u = phase(4.5);
        if (u >= 1.0) {
          frame.effect = "dots";
          frame.effectStep = Math.min(Math.trunc((u - 1.0) / 0.5) + 1, 3);
        }
        break;
      }
      case "sleepy":
        frame.lift = phase(3.0) < 1.5 ? 0 : 1;
        frame.eyes = "closed";
        frame.effect = "zzz";
        frame.effectStep = Math.trunc(phase(2.8) / 0.4);
        break;
    }
    // Capped at 5: a phase just under 1.8 can round to 6.0 after dividing (name 335 at 0.25 s does), and
    // the Mac's renderer then indexes past its 6-entry twinkle table and traps. Same frame otherwise.
    if (this.stage === "legend") frame.sparkle = Math.min(Math.trunc(phase(1.8) / 0.3), 5);
    return frame;
  }

  // MARK: Bitmap

  /** Renders `frame` (the resting frame by default) to a 24×24 bitmap. */
  bitmap(frame: PetFrame = this.restingFrame): PetBitmap {
    return renderPet(this, frame);
  }

  // MARK: Framing

  /**
   * Bounding box of the pet itself (body, accessory, crown) on the canvas, plus one row of headroom for the
   * idle bob. Floating effects (z's, hearts) are not included.
   */
  get contentBounds(): PetRect {
    if (this.bounds) return this.bounds;
    const still = this.restingFrame;
    still.effect = "none";
    still.sparkle = null;
    const bitmap = this.bitmap(still);
    const n = PetBitmap.size;
    let minX = n, minY = n, maxX = -1, maxY = -1;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (bitmap.get(x, y) === 0) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    if (maxX < 0) return (this.bounds = { x: 0, y: 0, w: n, h: n });
    minY = Math.max(minY - 1, 0);
    return (this.bounds = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }

  /**
   * The square to show when filling `devicePixels` × `devicePixels`: the whole pet, unless that leaves under
   * 2 device pixels per cell and a head-and-shoulders bust (≥ 16 cells) does better.
   */
  static tightCrop(bounds: PetRect, devicePixels: number): PetCrop {
    const n = PetBitmap.size;
    const div = (a: number, b: number) => Math.trunc(a / b);
    const whole = Math.min(Math.max(Math.max(bounds.w, bounds.h), 12), n);
    const bust = Math.min(whole, 16);
    const pixels = Math.max(Math.trunc(devicePixels), 1);
    let side = whole;
    // Only crop into a bust when the whole pet would get less than 2 device pixels per cell.
    if (div(pixels, whole) < 2 && Math.max(1, div(pixels, bust)) > Math.max(1, div(pixels, whole))) {
      side = Math.min(whole, Math.max(div(pixels, Math.max(1, div(pixels, bust))), bust));
    }
    let x = side >= bounds.w ? bounds.x - div(side - bounds.w, 2) : PetArt.centerX - div(side - 1, 2);
    let y = side >= bounds.h ? bounds.y + bounds.h - side : bounds.y;
    x = Math.min(Math.max(x, 0), n - side);
    y = Math.min(Math.max(y, 0), n - side);
    return { x, y, side };
  }
}
