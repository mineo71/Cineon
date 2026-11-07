// The plain data a pet is drawn with: a pose (PetFrame), a region of the canvas (PetCrop) and a rendered
// 24×24 frame (PetBitmap). Ports of the same types in windows/Cineon.Core/Profile/PixelPet.cs.

import type { PetEffect, PetEyes, PetMouth } from "./petTypes";

export interface PetPoint {
  readonly x: number;
  readonly y: number;
}

export interface PetRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * One drawable moment: what the pet is doing at a given time (Swift's `PixelPet.Frame`).
 * `PetFrame.make()` is Swift's `Frame()`: no lift, open eyes, smile, no effect.
 */
export interface PetFrame {
  lift: number;
  eyes: PetEyes;
  mouth: PetMouth;
  effect: PetEffect;
  effectStep: number;
  /** Legend twinkle phase 0..<6, null for other stages. */
  sparkle: number | null;
}

export const PetFrame = {
  make(parts: Partial<PetFrame> = {}): PetFrame {
    return { lift: 0, eyes: "open", mouth: "smile", effect: "none", effectStep: 0, sparkle: null, ...parts };
  },
  /** Value equality: redraw only when the frame changes. */
  equals(a: PetFrame, b: PetFrame): boolean {
    return a.lift === b.lift && a.eyes === b.eyes && a.mouth === b.mouth && a.effect === b.effect
      && a.effectStep === b.effectStep && a.sparkle === b.sparkle;
  },
};

/** Square region of the 24×24 canvas to show. */
export interface PetCrop {
  readonly x: number;
  readonly y: number;
  readonly side: number;
}

export const PetCrop = {
  /** The whole canvas. */
  canvas: Object.freeze({ x: 0, y: 0, side: 24 }) as PetCrop,
};

/** A rendered 24×24 frame. 0 is transparent, anything else is 0xFFRRGGBB (always opaque). */
export class PetBitmap {
  static readonly size = 24;

  /** Row-major, 24 × 24, unsigned 0xAARRGGBB. */
  readonly pixels = new Uint32Array(PetBitmap.size * PetBitmap.size);

  /** The colour at (x, y); 0 outside the canvas. */
  get(x: number, y: number): number {
    const n = PetBitmap.size;
    return x >= 0 && x < n && y >= 0 && y < n ? this.pixels[y * n + x]! : 0;
  }

  /** Sets (x, y); ignored outside the canvas. */
  set(x: number, y: number, argb: number): void {
    const n = PetBitmap.size;
    if (x < 0 || x >= n || y < 0 || y >= n) return;
    this.pixels[y * n + x] = argb;
  }

  /**
   * The crop (the whole canvas by default) as RGBA bytes, one quad per pet pixel, rows top down: an
   * ImageData's `data`. Scale it up with nearest-neighbour only (`imageSmoothingEnabled = false`).
   */
  toRgba(crop: PetCrop = PetCrop.canvas): Uint8ClampedArray<ArrayBuffer> {
    const bytes = new Uint8ClampedArray(crop.side * crop.side * 4);
    for (let row = 0; row < crop.side; row++) {
      for (let col = 0; col < crop.side; col++) {
        writeRgba(bytes, (row * crop.side + col) * 4, this.get(crop.x + col, crop.y + row));
      }
    }
    return bytes;
  }

  equals(other: PetBitmap | null | undefined): boolean {
    if (!other) return false;
    for (let i = 0; i < this.pixels.length; i++) if (this.pixels[i] !== other.pixels[i]) return false;
    return true;
  }
}

/**
 * Writes 0xAARRGGBB as RGBA. Pet colours are opaque or fully transparent, so this is the same as the
 * apps' premultiplied BGRA with the channels in canvas order.
 */
export function writeRgba(bytes: Uint8ClampedArray, offset: number, argb: number): void {
  const a = argb >>> 24;
  if (a === 0) {
    bytes[offset] = bytes[offset + 1] = bytes[offset + 2] = bytes[offset + 3] = 0;
    return;
  }
  bytes[offset] = (argb >>> 16) & 0xff;
  bytes[offset + 1] = (argb >>> 8) & 0xff;
  bytes[offset + 2] = argb & 0xff;
  bytes[offset + 3] = a;
}
