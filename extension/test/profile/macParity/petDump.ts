// The TypeScript twin of windows/Cineon.Core.Tests/Profile/MacParity/PetDump.cs (itself the twin of
// PetDump.swift): the same inputs, the same text, line for line. The expected hashes in
// pixelPetMacParity.test.ts are what the Swift program printed when compiled with Cineon/Profile/PixelPet.swift.

import {
  Fnv64, PetAccessory, PetArt, PetCanvas, PetGenre, PetMood, PetSpecies, PetStage, PetTone, PixelPet,
  type GenreWeight, type PetBitmap, type PetFrame, type PetFraming, type PetTraits,
} from "../../../src/core/profile";
import { PetEffect, PetEyes, PetMouth } from "../../../src/core/profile/petTypes";

const MASK64 = (1n << 64n) - 1n;

/** SplitMix64, as in the dumps on the Mac and Windows. */
export class SplitMix {
  constructor(private state: bigint) {}

  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
  }

  below(n: number): number {
    return Number(this.next() % BigInt(n));
  }
}

export function fnvPixels(pixels: Uint32Array): string {
  return new Fnv64().uint32s(pixels).hex();
}

export function fnvBytes(bytes: ArrayLike<number>): string {
  return new Fnv64().bytes(bytes).hex();
}

/** C#'s `BitConverter.DoubleToUInt64Bits(v).ToString("x")`. */
export function doubleBitsHex(v: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  return view.getBigUint64(0).toString(16);
}

/** Swift's description of a Double: "24.0", "20.64". */
export function swiftDouble(v: number): string {
  return Number.isInteger(v) && Math.abs(v) < 1e15 ? v.toFixed(1) : String(v);
}

export function frameText(f: PetFrame): string {
  return `${f.lift},${PetEyes.ordinal(f.eyes)},${PetMouth.ordinal(f.mouth)},${PetEffect.ordinal(f.effect)},${f.effectStep},${f.sparkle ?? -1}`;
}

export const GENRE_NAMES: readonly string[] = [
  "Action", "Drama", "Adventure", "Crime", "Comedy", "Thriller", "Fantasy", "Sci-Fi", "Mystery",
  "Horror", "Animation", "Biography", "War", "Sport", "Romance", "History", "Family", "Short",
  "Western", "Music", "Documentary", "Musical", "Reality-TV", "Talk-Show", "Game-Show", "News",
  "Film-Noir", "Science Fiction", "Bollywood", "", "Action & Adventure", "Sci-Fi & Fantasy", "War & Politics",
  "Crime/Drama", "Kids, Family", "a+b", ",,,", "&", "  thriller ", "HORROR", "sci fi", "sci‑fi",
  "Kids", "İhistory", "HİSTORY", "Ｈｏｒｒｏｒ",
  "Музика", "Docu-Series", "Rom-Com", "Stand-Up", "TV Movie", "neo-noir",
  "Children's", "Martial Arts", "Super-hero", "Sci-Fi&Fantasy", "Action/Adventure/Comedy", "action+drama",
  "Ação", "Comédie", "Aníme", "Ａnime", "anime\0", "﻿Drama", "Dra​ma",
  "Drama\u{1F3AC}", "١٢drama", "Ⅻ", "sf", "SF", "Scfi", "realitytv", "realityTV", "filmNoir",
  "talkShow", "gameShow", "sciFi", "Sci-Fi & Fantasy & Horror", "Western/", "/Western",
];

function randomTraits(rng: SplitMix): PetTraits {
  const count = rng.below(7);
  const genres: GenreWeight[] = [];
  for (let i = 0; i < count; i++) {
    const name = GENRE_NAMES[rng.below(GENRE_NAMES.length)]!;
    const kind = rng.below(25);
    let weight: number;
    switch (kind) {
      case 0: weight = NaN; break;
      case 1: weight = Infinity; break;
      case 2: weight = -Infinity; break;
      case 3: weight = rng.below(5000) / 100.0; break;
      default: weight = rng.below(53) - 2.0;
    }
    genres.push({ name, weight });
  }
  const hoursKind = rng.below(10);
  let hours: number;
  switch (hoursKind) {
    case 0: hours = 0; break;
    case 1: hours = NaN; break;
    case 2: hours = rng.below(100_000_000) / 7.0; break;
    default: hours = rng.below(3_000_000) / 1000.0;
  }
  const titles = rng.below(2001);
  const negative = rng.below(20) === 0;
  const daysKind = rng.below(3);
  const days = daysKind === 0 ? null : rng.below(404) - 3;
  const seedKind = rng.below(4);
  let seed: string;
  switch (seedKind) {
    case 0: seed = "seed-" + rng.next().toString(); break;
    case 1: seed = rng.next().toString(16).toUpperCase(); break;
    case 2: seed = "Ünïcødé-" + rng.below(1000); break;
    default: seed = "";
  }
  return { genres, hoursWatched: hours, titlesFinished: negative ? titles - 2500 : titles, daysSinceLastWatch: days, seed };
}

function traitPets(): PixelPet[] {
  const rng = new SplitMix(42n);
  const pets: PixelPet[] = [];
  for (let i = 0; i < 3000; i++) pets.push(PixelPet.make(randomTraits(rng)));
  return pets;
}

// MARK: Sections

export function renders(): string {
  const times = [0, 0.25, 0.9, 1.7, 3.1, 4.4, -7.3, 1234.56, 7.77e8];
  const out: string[] = [];
  let index = 0;
  for (const species of PetSpecies.all)
    for (const stage of PetStage.all)
      for (const accessory of PetAccessory.all)
        for (const tone of PetTone.all)
          for (const mood of PetMood.all) {
            const pet = new PixelPet({ species, stage, accessory, tone, mood, level: 1 + (index % 99), nameIndex: (index * 37) % 1024 });
            index += 1;
            let line = `${pet.code} ${fnvPixels(pet.bitmap().pixels)}`;
            for (const t of times) line += ` ${fnvPixels(pet.bitmap(pet.frameAt(t)).pixels)}`;
            out.push(line + "\n");
          }
  return out.join("");
}

export const SAMPLE_PETS: readonly PixelPet[] = [
  new PixelPet({ species: "fox", stage: "legend", accessory: "scarf", tone: "sunny", mood: "happy", level: 19, nameIndex: 7 }),
  new PixelPet({ species: "ghost", stage: "teen", accessory: "horns", tone: "dusk", mood: "sleepy", level: 5, nameIndex: 300 }),
  new PixelPet({ species: "robot", stage: "adult", accessory: "glasses3D", tone: "classic", mood: "bored", level: 9, nameIndex: 1023 }),
  new PixelPet({ species: "owl", stage: "baby", accessory: "headphones", tone: "classic", mood: "content", level: 1, nameIndex: 0 }),
];

function bitmapRows(bitmap: PetBitmap): string {
  let out = "";
  for (let y = 0; y < 24; y++) {
    const cells: string[] = [];
    for (let x = 0; x < 24; x++) {
      const p = bitmap.get(x, y);
      cells.push(p === 0 ? "......" : (p & 0xffffff).toString(16).padStart(6, "0"));
    }
    out += cells.join(" ") + "\n";
  }
  return out;
}

export function pixels(): string {
  let out = "";
  for (const pet of SAMPLE_PETS) {
    for (const frame of [pet.restingFrame, pet.frameAt(0.35), pet.frameAt(2.2)]) {
      out += `${pet.code} ${frameText(frame)}\n`;
      out += bitmapRows(pet.bitmap(frame));
    }
  }
  return out;
}

export function frames(): string {
  const out: string[] = [];
  for (let nameIndex = 0; nameIndex < 1024; nameIndex += 37) {
    for (const mood of PetMood.all) {
      for (const stage of ["adult", "legend"] as const) {
        const pet = new PixelPet({ species: "cat", stage, mood, nameIndex });
        const parts = [`${pet.code} r:${frameText(pet.restingFrame)}`];
        for (let i = 0; i <= 1080; i++) parts.push(frameText(pet.frameAt(i * 0.037 - 20.0)));
        for (let i = 0; i < 600; i++) parts.push(frameText(pet.frameAt(815_000_000 + i * 0.1)));
        out.push(parts.join(" ") + "\n");
      }
    }
  }
  return out.join("");
}

export function traits(): string {
  let out = "";
  const rng = new SplitMix(42n);
  for (let i = 0; i < 3000; i++) {
    const t = randomTraits(rng);
    const pet = PixelPet.make(t);
    const g = PixelPet.growth(t);
    const ranked = PixelPet.rankedGenres(t.genres).join(",");
    out += `${pet.code} ${pet.name} | ${pet.blurb} | ${pet.accessibilityDescription} | `;
    out += `${doubleBitsHex(g.experience)} ${g.level} ${g.stage} ${g.nextStage ?? "-"} `;
    out += `${doubleBitsHex(g.experienceToNextStage)} ${doubleBitsHex(g.progress)} | ${ranked}\n`;
  }
  return out;
}

export function genres(): string {
  let out = "";
  GENRE_NAMES.forEach((name, i) => {
    out += `${i} ${PetGenre.fromName(name) ?? "-"}\n`;
  });
  for (const genre of PetGenre.all) {
    out += `${genre} ${PetGenre.label(genre)} ${PetGenre.species(genre)} ${PetGenre.accessory(genre)} ${PetGenre.tone(genre)}\n`;
  }
  return out;
}

export function codes(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const inputs: string[] = [
    "", "p1-", "p1", "hello world", "p1-!!!!!!!!!!", "p1-0000000000", "p1-iiiiiiiiii", "\u{1F98A}\u{1F98A}\u{1F98A}",
    "z".repeat(500), "p1-\0\0\0\0\0\0\0\0\0\0",
    "p1-\u{1F98A}\u{1F98A}\u{1F98A}\u{1F98A}\u{1F98A}", "p1-K000000000",
  ];
  for (const check of alphabet) {
    inputs.push("p1-z0000010a" + check);
    inputs.push("p1-00000" + "00" + "00" + check);
    inputs.push("p1-00000" + "38" + "00" + check);
    inputs.push("p1-00000" + "01" + "00" + check);
    inputs.push("p1-e3i30" + "33" + "zz" + check);
  }
  for (const pet of traitPets().slice(0, 40)) {
    const code = pet.code;
    inputs.push(
      code.toUpperCase(), " \t" + code + "\n", " " + code + " ", "​" + code, code + "\u0085",
      "﻿" + code, " " + code + "\r\n", code.slice(0, -1), code + "0",
      "p1_" + code.slice(3), "P1-" + code.slice(3), "p2-" + code.slice(3),
    );
    const chars = [...code];
    for (let i = 3; i < chars.length; i++) {
      for (const c of alphabet) {
        if (c === chars[i]) continue;
        const changed = [...chars];
        changed[i] = c;
        inputs.push(changed.join(""));
      }
    }
  }
  return inputs.map((input, i) => `${i} ${PixelPet.fromCode(input)?.code ?? "nil"}\n`).join("");
}

export function bounds(): string {
  let out = "";
  for (const species of PetSpecies.all)
    for (const stage of PetStage.all)
      for (const accessory of PetAccessory.all) {
        const pet = new PixelPet({ species, stage, accessory });
        const b = pet.contentBounds;
        out += `${pet.code} ${b.x},${b.y},${b.w},${b.h}`;
        for (let px = 0; px <= 200; px++) {
          const c = PixelPet.tightCrop(b, px);
          out += ` ${c.x},${c.y},${c.side}`;
        }
        out += "\n";
      }
  return out;
}

export function art(): string {
  let out = "";
  for (const species of PetSpecies.all) {
    for (const stage of ["baby", "teen", "adult"] as const) {
      const sprite = PetArt.spriteFor(species, stage);
      out += `${species} ${stage} ${sprite.width}x${sprite.height} head ${sprite.head.x},${sprite.head.y}`;
      out += ` neck ${sprite.neck} hand ${sprite.hand.x},${sprite.hand.y} half ${sprite.headHalfWidth}`;
      out += ` mouth ${sprite.mouth ? `${sprite.mouth.x},${sprite.mouth.y}` : "-"}`;
      out += " eyes " + sprite.eyes.map((e) => `${e.x},${e.y},${e.w},${e.h}`).join(";");
      out += ` rect ${sprite.isRectangular ? "true" : "false"}\n`;
      for (let y = 0; y < sprite.height; y++) {
        out += String.fromCharCode(...sprite.keys.subarray(y * sprite.width, (y + 1) * sprite.width)) + "\n";
      }
    }
    for (const tone of PetTone.all) {
      out += `${species} ${tone} ` + [...PetArt.palette(species, tone)].map((p) => p.toString(16)).join(",") + "\n";
    }
  }
  return out;
}

export const VIEW_SIZES = [20.64, 24, 28, 37.84, 40, 44, 120, 150, 168];

/** RGBA to the apps' BGRA order (pet colours are opaque, so premultiplying changes nothing). */
export function rgbaToBgra(rgba: Uint8ClampedArray): Uint8Array {
  const bgra = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    bgra[i] = rgba[i + 2]!;
    bgra[i + 1] = rgba[i + 1]!;
    bgra[i + 2] = rgba[i]!;
    bgra[i + 3] = rgba[i + 3]!;
  }
  return bgra;
}

/** What PixelPetView puts on screen, hashed as premultiplied BGRA (the Mac side renders the SwiftUI view). */
export function views(): string {
  const pets = [
    ...SAMPLE_PETS,
    new PixelPet({ species: "bunny", stage: "adult", accessory: "wizardHat", tone: "sunny", mood: "happy", level: 30, nameIndex: 512 }),
  ];
  let out = "";
  for (const pet of pets)
    for (const size of VIEW_SIZES)
      for (const scale of [1.0, 2.0])
        for (const framing of ["automatic", "stage", "tight"] as PetFraming[])
          for (const time of [0.0, 1.7]) {
            const frame = PetCanvas.frameFor(pet, size, { framing, time });
            const image = PetCanvas.render(pet, frame, size, scale, framing);
            const f = framing === "automatic" ? "auto" : framing;
            out += `${pet.code} ${swiftDouble(size)} ${swiftDouble(scale)} ${f} ${swiftDouble(time)} `;
            out += `${image.pixelWidth}x${image.pixelHeight} ${fnvBytes(rgbaToBgra(image.rgba))}\n`;
          }
  return out;
}

export const SECTIONS: readonly { name: string; make: () => string }[] = [
  { name: "renders", make: renders }, { name: "pixels", make: pixels }, { name: "frames", make: frames },
  { name: "traits", make: traits }, { name: "genres", make: genres }, { name: "codes", make: codes },
  { name: "bounds", make: bounds }, { name: "art", make: art }, { name: "views", make: views },
];
