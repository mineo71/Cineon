// Builds sprites and overlays from their text grids. Port of the builders in PetArt (PixelPet.swift and
// windows/Cineon.Core/Profile/PetArt.cs). Grids use one character per pixel:
//
//     .  transparent      o  outline         e  eye ink (palette)
//     b  base             s  shade           l  light
//     a  accent (belly, muzzle)              c  detail (ears, cheeks, beak)
//     d  dark detail      w  white           t  tongue
//     E  eye (drawn by mood)                 M  mouth anchor (drawn by mood)
//
// Overlays may also use the shared accessory colours (r R y Y g G p P u U n N h H v V m j q k K).

import type { PetPoint, PetRect } from "./petBitmap";

const DOT = 46;

/** The key byte of an art character (its ASCII value; '.' for anything else). */
export function K(c: string): number {
  const code = c.charCodeAt(0);
  return code < 128 ? code : DOT;
}

export interface Sprite {
  readonly width: number;
  readonly height: number;
  /** Row-major key bytes, width × height. */
  readonly keys: Uint8Array;
  /** Centre of the top of the skull (hats sit here). */
  readonly head: PetPoint;
  /** Row of the chin/neck line (scarves, bow ties). */
  readonly neck: number;
  /** Bottom-left of held props. */
  readonly hand: PetPoint;
  readonly eyes: readonly PetRect[];
  readonly mouth: PetPoint | null;
  readonly headHalfWidth: number;
  /** False when the source rows had different lengths (an authoring mistake). */
  readonly isRectangular: boolean;
}

/** The key at (x, y); '.' outside the sprite. */
export function spriteKey(sprite: Sprite, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= sprite.width || y >= sprite.height) return DOT;
  return sprite.keys[y * sprite.width + x]!;
}

export class Overlay {
  readonly width: number;
  readonly height: number;
  readonly keys: Uint8Array;
  /** Rows below the anchor where the bottom row lands. */
  readonly dy: number;
  readonly isRectangular: boolean;

  constructor(text: string, dy = 0) {
    const grid = rows(text);
    const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
    this.width = width;
    this.height = grid.length;
    const keys = new Uint8Array(width * grid.length).fill(DOT);
    grid.forEach((row, y) => keys.set(row, y * width));
    this.keys = keys;
    this.dy = dy;
    this.isRectangular = new Set(grid.map((row) => row.length)).size <= 1;
  }

  key(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return DOT;
    return this.keys[y * this.width + x]!;
  }
}

/** A piece painted over a sprite after mirroring. `under`: only fills transparent cells (tails behind bodies). */
export interface Patch {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly under: boolean;
}

export function patch(x: number, y: number, text: string, under = true): Patch {
  return { x, y, text, under };
}

export interface SpriteSet {
  readonly baby: Sprite;
  readonly teen: Sprite;
  readonly adult: Sprite;
}

/** Non-empty rows, each trimmed, as key bytes. */
export function rows(text: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) out.push(Uint8Array.from(trimmed, (c) => c.charCodeAt(0) & 0xff));
  }
  return out;
}

/** Builds a symmetric sprite from its left half (including the centre column). */
export function sym(half: string, head: number, neck: number, hand: [number, number], patches: Patch[] = []): Sprite {
  const halves = rows(half);
  const full = halves.map((row) => {
    const mirrored = new Uint8Array(row.length * 2 - 1);
    mirrored.set(row);
    for (let i = 0; i < row.length - 1; i++) mirrored[row.length + i] = row[row.length - 2 - i]!;
    return mirrored;
  });
  const sameLength = (grid: Uint8Array[]) => new Set(grid.map((row) => row.length)).size === 1;
  const rectangular = sameLength(halves) && patches.every((p) => sameLength(rows(p.text)));
  return build(full, (halves[0]?.length ?? 1) - 1, head, neck, hand, patches, rectangular);
}

export function build(
  grid: Uint8Array[], headX: number, headY: number, neck: number, hand: [number, number], patches: Patch[],
  rectangular: boolean,
): Sprite {
  let width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  let height = grid.length;
  for (const p of patches) {
    const pr = rows(p.text);
    width = Math.max(width, p.x + pr.reduce((max, row) => Math.max(max, row.length), 0));
    height = Math.max(height, p.y + pr.length);
  }
  const keys = new Uint8Array(width * height).fill(DOT);
  grid.forEach((row, y) => keys.set(row, y * width));
  for (const p of patches) {
    rows(p.text).forEach((row, dy) => {
      row.forEach((key, dx) => {
        if (key === DOT) return;
        const i = (p.y + dy) * width + p.x + dx;
        if (!p.under || keys[i] === DOT) keys[i] = key;
      });
    });
  }
  // Mouth anchor: remember it, then paint it like its left neighbour.
  let mouth: PetPoint | null = null;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== K("M")) continue;
    mouth = { x: i % width, y: Math.floor(i / width) };
    keys[i] = i > 0 ? keys[i - 1]! : K("b");
  }
  // Eyes: connected runs of E.
  const eyes: PetRect[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== K("E") || seen.has(i)) continue;
    const stack = [i];
    let minX = width, minY = height, maxX = 0, maxY = 0;
    seen.add(i);
    while (stack.length > 0) {
      const j = stack.pop()!;
      const x = j % width, y = Math.floor(j / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (keys[n] === K("E") && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    eyes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  eyes.sort((a, b) => a.x - b.x);
  // Half width of the head: distance from centre to the widest outline at eye level.
  let half = 4;
  if (eyes.length > 0) {
    const eyeRow = eyes[0]!.y;
    let x = headX;
    while (x < width - 1
      && !(keys[eyeRow * width + x] === K("o") && (x + 1 >= width || keys[eyeRow * width + x + 1] === DOT))) {
      x += 1;
    }
    half = x - headX;
  }
  return {
    width, height, keys, head: { x: headX, y: headY }, neck, hand: { x: hand[0], y: hand[1] }, eyes, mouth,
    headHalfWidth: half, isRectangular: rectangular,
  };
}

/** The accessory colours every palette shares. */
export const SHARED_COLORS =
  "w=fff8ef t=ff6b8a r=e8473f R=a8292f y=ffd23f Y=e09b1a g=c9cfdd G=6b7187 p=ff7eb6 P=d2468a u=4f8cff U=2f4fa8 n=8a5a3c N=5e3a26 h=e2c58a H=b0905a v=7b5cff V=4f36c4 m=6fae4f j=3f7a37 q=4fe0e8 k=1d1b26 K=4a4a5e";

/** 128 entries indexed by key byte: 0xFFRRGGBB, or 0 where the key has no colour. */
export function makePalette(spec: string): Uint32Array {
  const table = new Uint32Array(128);
  for (const pair of `${SHARED_COLORS} ${spec}`.split(" ")) {
    if (pair.length === 0) continue;
    const parts = pair.split("=").filter((part) => part.length > 0);
    if (parts.length !== 2 || parts[0]!.charCodeAt(0) >= 128 || !/^[0-9a-fA-F]{1,8}$/.test(parts[1]!)) continue;
    table[parts[0]!.charCodeAt(0)] = (0xff000000 | parseInt(parts[1]!, 16)) >>> 0;
  }
  if (table[K("e")] === 0) table[K("e")] = table[K("o")]!;
  if (table[K("i")] === 0) table[K("i")] = table[K("o")]!;
  return table;
}
