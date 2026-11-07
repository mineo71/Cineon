// Everything PixelPetView and PetCanvas in PixelPet.swift decide, as plain data: which pose, which crop, and
// the exact device-pixel rectangles the Mac fills. Every pet pixel is an exact square of whole device
// pixels, so the art stays crisp; any leftover space is split evenly around it. Port of
// windows/Cineon.Core/Profile/PetCanvas.cs, plus `draw` for an HTML canvas.

import { PetBitmap, PetCrop, type PetFrame, writeRgba } from "./petBitmap";
import { PixelPet } from "./pixelPet";
import type { PetFraming } from "./petTypes";

/** One filled rectangle of a drawn pet, in CSS px (or device pixels from `deviceRects`). */
export interface PetFill {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 0xAARRGGBB. */
  readonly argb: number;
}

/** A filled run in whole device pixels: [x0, x1) × [y0, y1). */
export interface PetDeviceRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly argb: number;
}

/** A drawn pet: RGBA bytes, rows top down, `pixelWidth × 4` per row (an ImageData's data). */
export interface PetImage {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface PetFrameOptions {
  framing?: PetFraming;
  /** Default true. Still avatars (top bar, Together lists, share card) pass false. */
  animated?: boolean;
  /** `matchMedia("(prefers-reduced-motion: reduce)").matches`: draws the resting frame. */
  reduceMotion?: boolean;
  /** A fixed time (seconds) gives that one frame (previews, snapshots). */
  time?: number | null;
  /** The clock for animated views; default `PetCanvas.now()`. */
  now?: number | null;
}

/** The 2D context calls `draw` makes. A CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D fits. */
export interface PetCanvasContext {
  imageSmoothingEnabled: boolean;
  createImageData(width: number, height: number): { readonly data: Uint8ClampedArray };
  /** Takes what `createImageData` returned. */
  putImageData(image: unknown, dx: number, dy: number): void;
}

/** What `draw` needs of a canvas. An HTMLCanvasElement or OffscreenCanvas fits. */
export interface PetCanvasElement {
  width: number;
  height: number;
  /** Set to the CSS size when present (HTMLCanvasElement), so one canvas pixel is one device pixel. */
  readonly style?: { width: string; height: string };
  getContext(contextId: "2d"): PetCanvasContext | null;
}

/** Swift's `.rounded()`: to nearest, halves away from zero. */
function round(value: number): number {
  const r = Math.round(Math.abs(value));
  return value < 0 ? -r : r;
}

const REFERENCE_DATE_MS = Date.UTC(2001, 0, 1);

export const PetCanvas = {
  /** The Mac's `TimelineView(.animation(minimumInterval: 0.1))`: about 10 fps, in milliseconds. */
  frameInterval: 100,

  /** Seconds since 2001-01-01 UTC, the clock the Mac animates with (`timeIntervalSinceReferenceDate`). */
  now(): number {
    return PetCanvas.timeSinceReferenceDate(new Date());
  },

  timeSinceReferenceDate(date: Date | number): number {
    return ((typeof date === "number" ? date : date.getTime()) - REFERENCE_DATE_MS) / 1000;
  },

  /** Below 40 CSS px `automatic` crops to the pet so avatars stay readable. */
  isTight(size: number, framing: PetFraming = "automatic"): boolean {
    return framing === "stage" ? false : framing === "tight" ? true : size < 40;
  },

  /**
   * Tight crops keep the bob to one pixel so the head never leaves the frame, and drop the floating effects
   * that would be cut off at the crop edge (eyes and mouth still show the mood).
   */
  adjusted(frame: PetFrame, tight: boolean): PetFrame {
    if (!tight) return frame;
    return { ...frame, lift: Math.min(frame.lift, 1), effect: "none", sparkle: null };
  },

  /**
   * The pose to draw now, already `adjusted` for the framing. A fixed `time` gives that one frame; otherwise
   * animated views use `now` (default `PetCanvas.now()`) and still ones, or reduced motion, the resting frame.
   */
  frameFor(pet: PixelPet, size: number, options: PetFrameOptions = {}): PetFrame {
    const { framing = "automatic", animated = true, reduceMotion = false, time = null, now = null } = options;
    let frame: PetFrame;
    if (time != null) frame = pet.frameAt(time);
    else if (animated && !reduceMotion) frame = pet.frameAt(now ?? PetCanvas.now());
    else frame = pet.restingFrame;
    return PetCanvas.adjusted(frame, PetCanvas.isTight(size, framing));
  },

  /** The part of the canvas to show in a `width` × `height` CSS px view at `scale` device pixels per px. */
  cropFor(pet: PixelPet, tight: boolean, width: number, height: number, scale: number): PetCrop {
    if (!tight) return PetCrop.canvas;
    return PixelPet.tightCrop(pet.contentBounds, Math.trunc(Math.min(width, height) * Math.max(scale, 1)));
  },

  /**
   * The rectangles the Mac fills, in whole device pixels, merged into horizontal runs of one colour.
   * Exact port of `PetCanvas.draw`.
   */
  deviceRects(bitmap: PetBitmap, crop: PetCrop, width: number, height: number, scale: number): PetDeviceRect[] {
    const rects: PetDeviceRect[] = [];
    const n = crop.side;
    const s = Math.max(scale, 1);
    const side = Math.min(width, height) * s;
    const raw = side / n;
    // Whole device pixels per cell when possible, so every pixel is a crisp square.
    const cell = raw >= 1 ? Math.floor(raw) : raw;
    const ox = Math.floor((width * s - cell * n) / 2);
    const oy = Math.floor((height * s - cell * n) / 2);
    for (let row = 0; row < n; row++) {
      const y0 = round(oy + row * cell);
      const y1 = round(oy + (row + 1) * cell);
      if (!(y1 > y0)) continue;
      let col = 0;
      while (col < n) {
        const c = bitmap.get(crop.x + col, crop.y + row);
        let run = 1;
        while (col + run < n && bitmap.get(crop.x + col + run, crop.y + row) === c) run += 1;
        if (c !== 0) {
          const x0 = round(ox + col * cell);
          const x1 = round(ox + (col + run) * cell);
          if (x1 > x0) rects.push({ x0, y0, x1, y1, argb: c });
        }
        col += run;
      }
    }
    return rects;
  },

  /** `deviceRects` in CSS px (device pixels ÷ scale): fill each with its colour, antialiasing off. */
  layout(bitmap: PetBitmap, crop: PetCrop, width: number, height: number, scale: number): PetFill[] {
    const s = Math.max(scale, 1);
    return PetCanvas.deviceRects(bitmap, crop, width, height, scale).map((r) => ({
      x: r.x0 / s, y: r.y0 / s, width: (r.x1 - r.x0) / s, height: (r.y1 - r.y0) / s, argb: r.argb,
    }));
  },

  /**
   * Draws `bitmap` into a transparent `pixelWidth` × `pixelHeight` device-pixel buffer, laid out exactly as
   * the Mac lays it out in a view of that many points at scale 1.
   */
  renderBitmap(bitmap: PetBitmap, crop: PetCrop, pixelWidth: number, pixelHeight: number): PetImage {
    return rasterize(PetCanvas.deviceRects(bitmap, crop, pixelWidth, pixelHeight, 1), pixelWidth, pixelHeight);
  },

  /**
   * The whole view in one call: `frame` (from `frameFor`) drawn for a `size` × `size` CSS px view at `scale`
   * (`devicePixelRatio`), with the Mac's device-pixel layout for that size and scale. The buffer is
   * ceil(size × scale) device pixels square; show it at `pixelWidth / scale` CSS px so nothing resamples.
   */
  render(pet: PixelPet, frame: PetFrame, size: number, scale: number, framing: PetFraming = "automatic"): PetImage {
    const s = Math.max(scale, 1);
    const pixels = Math.max(Math.ceil(size * s), 1);
    // Layout rounds the view's frame to whole device pixels before the canvas draws (SwiftUI does), so the
    // canvas gets round(size × scale) device pixels.
    const drawn = round(size * s) / s;
    const crop = PetCanvas.cropFor(pet, PetCanvas.isTight(size, framing), drawn, drawn, s);
    return rasterize(PetCanvas.deviceRects(pet.bitmap(frame), crop, drawn, drawn, s), pixels, pixels);
  },

  /**
   * Draws the pet onto `canvas` at device pixels: sizes the canvas to `render`'s buffer, sets its CSS size
   * to `pixelWidth / scale` px (when it has a style), turns smoothing off and puts the pixels. Call it with
   * `devicePixelRatio` as `scale`, again when that changes, and on each tick whose frame changed.
   */
  draw(
    canvas: PetCanvasElement, pet: PixelPet, frame: PetFrame, size: number, scale: number,
    framing: PetFraming = "automatic",
  ): PetImage {
    const image = PetCanvas.render(pet, frame, size, scale, framing);
    if (canvas.width !== image.pixelWidth) canvas.width = image.pixelWidth;
    if (canvas.height !== image.pixelHeight) canvas.height = image.pixelHeight;
    if (canvas.style) {
      const s = Math.max(scale, 1);
      canvas.style.width = `${image.pixelWidth / s}px`;
      canvas.style.height = `${image.pixelHeight / s}px`;
    }
    const context = canvas.getContext("2d");
    if (!context) return image;
    // Nearest-neighbour if anything scales it (it shouldn't: one canvas pixel is one device pixel).
    context.imageSmoothingEnabled = false;
    const data = context.createImageData(image.pixelWidth, image.pixelHeight);
    data.data.set(image.rgba);
    context.putImageData(data, 0, 0);
    return image;
  },
};

function rasterize(rects: readonly PetDeviceRect[], pixelWidth: number, pixelHeight: number): PetImage {
  const bytes = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);
  for (const { x0, y0, x1, y1, argb } of rects) {
    for (let y = Math.max(y0, 0); y < Math.min(y1, pixelHeight); y++) {
      for (let x = Math.max(x0, 0); x < Math.min(x1, pixelWidth); x++) {
        writeRgba(bytes, (y * pixelWidth + x) * 4, argb);
      }
    }
  }
  return { pixelWidth, pixelHeight, rgba: bytes };
}
