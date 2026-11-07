// The pet's enumerations, as string unions whose values are the Swift case names (the apps' raw values).
// Port of the enums in Cineon/Profile/PixelPet.swift by way of windows/Cineon.Core/Profile/PixelPet.cs.
//
// NOTE: the order of every list below is part of the `p1` code format. Only ever append new cases at the
// end. Each type has a companion object of the same name: `all` (in code order), `ordinal`, `label`,
// `fromRaw`, plus the C# extension members (`PetStage.next`, `PetGenre.species`...).

function lookup<T extends string>(all: readonly T[]) {
  const index = new Map<string, number>(all.map((value, i) => [value, i]));
  return {
    all,
    /** Position in the list: what the `p1` code stores. */
    ordinal(value: T): number {
      return index.get(value) ?? -1;
    },
    /** The value for a raw (Swift case) name, or null. */
    fromRaw(raw: string): T | null {
      return index.has(raw) ? (raw as T) : null;
    },
  };
}

// MARK: Species

const SPECIES = [
  "fox", "turtle", "cat", "frog", "raccoon", "raven", "ghost", "robot", "dragon", "owl", "slime", "bunny",
  "puppy", "songbird", "hedgehog",
] as const;
export type PetSpecies = (typeof SPECIES)[number];

const SPECIES_LABELS: Record<PetSpecies, string> = {
  fox: "Fox", turtle: "Turtle", cat: "Cat", frog: "Frog", raccoon: "Raccoon", raven: "Raven", ghost: "Ghost",
  robot: "Robot", dragon: "Dragon", owl: "Owl", slime: "Slime", bunny: "Bunny", puppy: "Puppy",
  songbird: "Songbird", hedgehog: "Hedgehog",
};

export const PetSpecies = {
  ...lookup<PetSpecies>(SPECIES),
  label: (species: PetSpecies): string => SPECIES_LABELS[species],
};

// MARK: Stage

const STAGES = ["baby", "teen", "adult", "legend"] as const;
export type PetStage = (typeof STAGES)[number];

const STAGE_LABELS: Record<PetStage, string> = { baby: "Baby", teen: "Teen", adult: "Adult", legend: "Legend" };
const STAGE_MINIMUMS: Record<PetStage, number> = { baby: 0, teen: 10, adult: 60, legend: 200 };

export const PetStage = {
  ...lookup<PetStage>(STAGES),
  label: (stage: PetStage): string => STAGE_LABELS[stage],
  /** Experience needed to reach this stage. */
  minimumExperience: (stage: PetStage): number => STAGE_MINIMUMS[stage],
  next(stage: PetStage): PetStage | null {
    return STAGES[STAGES.indexOf(stage) + 1] ?? null;
  },
  fromExperience(experience: number): PetStage {
    const xp = Number.isFinite(experience) ? experience : 0;
    let found: PetStage = "baby";
    for (const stage of STAGES) if (xp >= STAGE_MINIMUMS[stage]) found = stage;
    return found;
  },
};

// MARK: Mood

const MOODS = ["happy", "content", "bored", "sleepy"] as const;
export type PetMood = (typeof MOODS)[number];

const MOOD_LABELS: Record<PetMood, string> = { happy: "Happy", content: "Content", bored: "Misses you", sleepy: "Sleepy" };

export const PetMood = {
  ...lookup<PetMood>(MOODS),
  label: (mood: PetMood): string => MOOD_LABELS[mood],
  fromDaysSinceLastWatch(days: number | null | undefined): PetMood {
    if (days == null) return "sleepy";
    if (days <= 1) return "happy";
    if (days <= 5) return "content";
    if (days <= 14) return "bored";
    return "sleepy";
  },
};

// MARK: Accessory

const ACCESSORIES = [
  "none", "headband", "explorerHat", "scarf", "partyHat", "fedora", "shades", "horns", "glasses3D", "wizardHat",
  "magnifier", "propellerCap", "bow", "bowtie", "specs", "helmet", "cowboyHat", "headphones", "popcorn",
] as const;
export type PetAccessory = (typeof ACCESSORIES)[number];

const ACCESSORY_LABELS: Record<PetAccessory, string> = {
  none: "Nothing", headband: "Headband", explorerHat: "Explorer hat", scarf: "Scarf", partyHat: "Party hat",
  fedora: "Fedora", shades: "Shades", horns: "Little horns", glasses3D: "3D glasses", wizardHat: "Wizard hat",
  magnifier: "Magnifying glass", propellerCap: "Propeller cap", bow: "Bow", bowtie: "Bow tie",
  specs: "Reading glasses", helmet: "Helmet", cowboyHat: "Cowboy hat", headphones: "Headphones",
  popcorn: "Popcorn",
};

const HATS = new Set<PetAccessory>([
  "explorerHat", "partyHat", "fedora", "wizardHat", "propellerCap", "helmet", "cowboyHat", "headphones",
]);

export const PetAccessory = {
  ...lookup<PetAccessory>(ACCESSORIES),
  label: (accessory: PetAccessory): string => ACCESSORY_LABELS[accessory],
  /** Hats that a Legend's crown replaces. */
  isHat: (accessory: PetAccessory): boolean => HATS.has(accessory),
};

// MARK: Tone

const TONES = ["classic", "sunny", "dusk"] as const;
/** Colour variant of the species palette. */
export type PetTone = (typeof TONES)[number];

const TONE_LABELS: Record<PetTone, string> = { classic: "Classic", sunny: "Sunny", dusk: "Dusk" };

export const PetTone = {
  ...lookup<PetTone>(TONES),
  label: (tone: PetTone): string => TONE_LABELS[tone],
};

// MARK: Genre

/** Canonical genres, ordered by how common they are (also the tie-break order). */
const GENRES = [
  "action", "drama", "adventure", "crime", "comedy", "thriller", "fantasy", "sciFi", "mystery", "horror",
  "animation", "biography", "war", "sport", "romance", "history", "family", "short", "western", "music",
  "documentary", "musical", "realityTV", "talkShow", "gameShow", "news", "filmNoir",
] as const;
export type PetGenre = (typeof GENRES)[number];

const GENRE_LABELS: Record<PetGenre, string> = {
  action: "Action", drama: "Drama", adventure: "Adventure", crime: "Crime", comedy: "Comedy",
  thriller: "Thriller", fantasy: "Fantasy", sciFi: "Sci-Fi", mystery: "Mystery", horror: "Horror",
  animation: "Animation", biography: "Biography", war: "War", sport: "Sport", romance: "Romance",
  history: "History", family: "Family", short: "Short", western: "Western", music: "Music",
  documentary: "Documentary", musical: "Musical", realityTV: "Reality-TV", talkShow: "Talk-Show",
  gameShow: "Game-Show", news: "News", filmNoir: "Film-Noir",
};

const GENRE_SPECIES: Record<PetGenre, PetSpecies> = {
  action: "fox", adventure: "turtle", drama: "cat",
  comedy: "frog", realityTV: "frog", talkShow: "frog", gameShow: "frog",
  crime: "raccoon", filmNoir: "raccoon", western: "raccoon",
  thriller: "raven", horror: "ghost", sciFi: "robot", fantasy: "dragon",
  mystery: "owl", documentary: "owl", biography: "owl", history: "owl", news: "owl",
  animation: "slime", short: "slime", romance: "bunny", family: "puppy", sport: "puppy",
  music: "songbird", musical: "songbird", war: "hedgehog",
};

const GENRE_ACCESSORIES: Record<PetGenre, PetAccessory> = {
  action: "headband", sport: "headband", adventure: "explorerHat", drama: "scarf",
  comedy: "partyHat", gameShow: "partyHat", crime: "fedora", filmNoir: "fedora", thriller: "shades",
  horror: "horns", sciFi: "glasses3D", fantasy: "wizardHat", mystery: "magnifier",
  animation: "propellerCap", romance: "bow", family: "bowtie",
  documentary: "specs", biography: "specs", history: "specs", news: "specs",
  war: "helmet", western: "cowboyHat", music: "headphones", musical: "headphones",
  short: "popcorn", realityTV: "popcorn", talkShow: "popcorn",
};

const DUSK_GENRES = new Set<PetGenre>(["horror", "thriller", "crime", "war", "filmNoir", "mystery"]);
const SUNNY_GENRES = new Set<PetGenre>([
  "comedy", "romance", "family", "animation", "music", "musical", "adventure", "gameShow", "realityTV",
]);

const GENRE_ALIASES: ReadonlyMap<string, PetGenre> = (() => {
  const map = new Map<string, PetGenre>();
  for (const genre of GENRES) map.set(genre.toLowerCase(), genre);
  const extra: Record<string, PetGenre> = {
    scifi: "sciFi", sciencefiction: "sciFi", sf: "sciFi", scfi: "sciFi",
    superhero: "action", martialarts: "action",
    suspense: "thriller", psychological: "thriller",
    noir: "filmNoir", neonoir: "filmNoir",
    animated: "animation", anime: "animation", cartoon: "animation",
    biopic: "biography", bio: "biography",
    historical: "history", period: "history",
    sports: "sport", kids: "family", children: "family", childrens: "family",
    doc: "documentary", docs: "documentary", docuseries: "documentary", documentaries: "documentary",
    reality: "realityTV", realitytv: "realityTV", talk: "talkShow",
    talkshow: "talkShow", gameshow: "gameShow", romcom: "romance",
    romantic: "romance", comedies: "comedy", standup: "comedy",
    warpolitics: "war", politics: "news", soap: "drama", tvmovie: "drama",
    scififantasy: "sciFi", actionadventure: "action",
  };
  for (const [key, genre] of Object.entries(extra)) map.set(key, genre);
  return map;
})();

/** Swift's `CharacterSet.alphanumerics`: Unicode letters, marks and numbers. */
const ALPHANUMERIC = /^[\p{L}\p{M}\p{N}]+$/u;

/**
 * `name.lowercased()` keeping only letters, marks and numbers. Lower-cases one code point at a time, as
 * Swift does (no final-sigma context); U+0130 becomes i + combining dot, as in Swift and the C# port.
 */
export function genreKey(name: string): string {
  let key = "";
  for (const ch of name) {
    if (ch === "İ") {
      key += "i̇";
      continue;
    }
    const lower = ch.toLowerCase();
    if (ALPHANUMERIC.test(lower)) key += lower;
  }
  return key;
}

export const PetGenre = {
  ...lookup<PetGenre>(GENRES),
  /** Display name, IMDb style. */
  label: (genre: PetGenre): string => GENRE_LABELS[genre],
  species: (genre: PetGenre): PetSpecies => GENRE_SPECIES[genre],
  accessory: (genre: PetGenre): PetAccessory => GENRE_ACCESSORIES[genre],
  tone(genre: PetGenre): PetTone {
    if (DUSK_GENRES.has(genre)) return "dusk";
    if (SUNNY_GENRES.has(genre)) return "sunny";
    return "classic";
  },
  /**
   * Swift's `Genre(name:)`: lower-cased, letters, marks and digits only, then looked up with aliases.
   * "Sci-Fi", "science fiction" and "SciFi" are all `sciFi`.
   */
  fromName(name: string): PetGenre | null {
    return GENRE_ALIASES.get(genreKey(name)) ?? null;
  },
};

// MARK: Frame parts

const EYES = ["open", "closed", "happy", "heavy"] as const;
export type PetEyes = (typeof EYES)[number];
export const PetEyes = lookup<PetEyes>(EYES);

const MOUTHS = ["smile", "grin", "flat", "small"] as const;
export type PetMouth = (typeof MOUTHS)[number];
export const PetMouth = lookup<PetMouth>(MOUTHS);

const EFFECTS = ["none", "zzz", "heart", "dots"] as const;
export type PetEffect = (typeof EFFECTS)[number];
export const PetEffect = lookup<PetEffect>(EFFECTS);

/** How much of the 24×24 canvas a pet view shows (Swift's `PixelPetView.Framing`). */
export type PetFraming =
  /** `tight` below 40 CSS px, `stage` from 40. */
  | "automatic"
  /** The whole 24×24 canvas: size differences between stages show. */
  | "stage"
  /** Cropped to the pet: fills small avatars. */
  | "tight";
