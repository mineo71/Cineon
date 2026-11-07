// Sprite and overlay data and lookups. Port of PetArt in Cineon/Profile/PixelPet.swift by way of
// windows/Cineon.Core/Profile/PetArt.cs; the grids are copied verbatim (species art in petArtSpecies.ts).

import { K, makePalette, Overlay, SHARED_COLORS, type Sprite } from "./petArtBuild";
import { PALETTE_SPECS, SPRITE_SETS } from "./petArtSpecies";
import { PetSpecies, PetTone, type PetAccessory, type PetStage } from "./petTypes";

export { K, Overlay, type Patch, type Sprite, type SpriteSet, spriteKey, makePalette } from "./petArtBuild";

// MARK: Overlays

const crown = new Overlay(`
  .o.o.o.
  oyoyoyo
  oyyyyyo
  oyryuyo
  ooooooo
  `, 1);

const hats: ReadonlyMap<PetAccessory, Overlay> = new Map<PetAccessory, Overlay>([
  ["partyHat", new Overlay(`
    ...y...
    ..oyo..
    ..oro..
    .orrro.
    .oyyyo.
    orrrrro
    ooooooo
    `, 1)],
  ["wizardHat", new Overlay(`
    ....o....
    ...ovo...
    ...ovo...
    ..ovvvo..
    ..ovyvo..
    .ovvvvvo.
    ooooooooo
    oVVVVVVVo
    ooooooooo
    `, 2)],
  ["fedora", new Overlay(`
    ..ooooo..
    .onnnnno.
    .oNNNNNo.
    onnnnnnno
    ooooooooo
    `, 1)],
  ["cowboyHat", new Overlay(`
    ...ooooo...
    ..onnnnno..
    o.oNNNNNo.o
    onooooooono
    .onnnnnnno.
    ..ooooooo..
    `, 1)],
  ["explorerHat", new Overlay(`
    ...ooo...
    ..ohhho..
    .ohhhhho.
    .oHHHHHo.
    ohhhhhhho
    ooooooooo
    `, 1)],
  ["helmet", new Overlay(`
    ..ooooo..
    .ommmmmo.
    ommjmmmmo
    ommmmmjmo
    ojjjjjjjo
    ooooooooo
    `, 1)],
  ["propellerCap", new Overlay(`
    .rrrouuu.
    ....o....
    ..ooooo..
    .oyrrruo.
    oyyrrruuo
    ooooooooo
    `, 1)],
]);

/** Left horn; its bottom-right pixel sits on the skull. */
const horn = new Overlay(`
  o...
  oro.
  orRo
  .oro
  `);

const bow = new Overlay(`
  oo...oo
  oppopPo
  opPPPPo
  oppopPo
  oo...oo
  `, 2);

const bowtie = new Overlay(`
  oo...oo
  orroRRo
  orRRRRo
  orroRRo
  oo...oo
  `, 1);

const popcorn = new Overlay(`
  .wyw.
  wywyw
  orwro
  orwro
  orwro
  .ooo.
  `);

const magnifier = new Overlay(`
  .ooo..
  owqqo.
  oqqqo.
  .ooon.
  ....nn
  `);

const zSmall = new Overlay(`
  uuu
  .u.
  uuu
  `);

const zBig = new Overlay(`
  uuuu
  ..u.
  .u..
  uuuu
  `);

const heart = new Overlay(`
  pp.pp
  ppppp
  .ppp.
  ..p..
  `);

const heartSmall = new Overlay(`
  p.p
  .p.
  `);

const bubble = new Overlay(`
  .ooooooo.
  owwwwwwwo
  owwwwwwwo
  owwwwwwwo
  .ooooooo.
  .o.......
  o........
  `);

// MARK: Lookup

const sprites: readonly (readonly Sprite[])[] = PetSpecies.all.map((species) => {
  const set = SPRITE_SETS[species];
  return [set.baby, set.teen, set.adult];
});

const palettes: readonly (readonly Uint32Array[])[] = PetSpecies.all.map((species) =>
  PetTone.all.map((tone) => makePalette(PALETTE_SPECS[species][tone])));

export const PetArt = {
  centerX: 11,
  groundY: 23,

  crown, hats, horn, bow, bowtie, popcorn, magnifier, zSmall, zBig, heart, heartSmall, bubble,

  /** The sprite for a species at a stage (Legends use the adult sprite). */
  spriteFor(species: PetSpecies, stage: PetStage): Sprite {
    const i = stage === "baby" ? 0 : stage === "teen" ? 1 : 2;
    return sprites[PetSpecies.ordinal(species)]![i]!;
  },

  /** 128 entries indexed by key byte: 0xFFRRGGBB, or 0 where the key has no colour. */
  palette(species: PetSpecies, tone: PetTone): Uint32Array {
    return palettes[PetSpecies.ordinal(species)]![PetTone.ordinal(tone)]!;
  },

  /** Palette text for a species and tone (`o=… b=…`). */
  paletteSpec(species: PetSpecies, tone: PetTone): string {
    return PALETTE_SPECS[species][tone];
  },

  /** Shared accessory colours, `key=rrggbb` separated by spaces. */
  shared: SHARED_COLORS,

  /** Keys every palette must define (the sprite keys plus `e`). */
  spriteKeys: new Set([".", "o", "b", "s", "l", "a", "c", "d", "w", "t", "e", "i", "E", "M"]) as ReadonlySet<string>,

  /** Keys of the shared accessory colours. */
  sharedKeys: new Set(SHARED_COLORS.split(" ").filter((p) => p.length > 0).map((p) => p[0]!)) as ReadonlySet<string>,

  /** Every overlay with its name, for checks. */
  allOverlays(): { name: string; overlay: Overlay }[] {
    const list = [
      { name: "crown", overlay: crown }, { name: "horn", overlay: horn }, { name: "bow", overlay: bow },
      { name: "bowtie", overlay: bowtie }, { name: "popcorn", overlay: popcorn },
      { name: "magnifier", overlay: magnifier }, { name: "zSmall", overlay: zSmall }, { name: "zBig", overlay: zBig },
      { name: "heart", overlay: heart }, { name: "heartSmall", overlay: heartSmall }, { name: "bubble", overlay: bubble },
    ];
    const sortedHats = [...hats].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [accessory, overlay] of sortedHats) list.push({ name: accessory, overlay });
    return list;
  },

  K,
};
