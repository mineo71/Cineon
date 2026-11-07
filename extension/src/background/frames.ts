// Port of Browser/FrameCollector.swift (FrameImage, FrameState, FrameCollector), checked against
// windows/Cineon.App/Browser/FrameCollector.cs, and the ambient light sampling of
// AppModel.tickAmbient / sampleWindow.
//
// A frame comes from the player first (media.js's `capture`: the picture itself, when the video's
// pixels may be read), else from a photograph of the tab (`tabs.captureVisibleTab`, which like the
// Mac's window capture sees hardware-decoded video) cropped to where the picture sits. Pixel work
// goes through `ImageOps` (createImageBitmap and OffscreenCanvas, in Chrome's service worker and
// Firefox's event page alike), so the decisions run on Node in tests.

import { FilmFrame, Timecode } from "../core/data";
import type { SessionContext } from "./context";
import { detach } from "./env";
import type { Platform } from "./platform";
import type { LiveTrack, MediaEvent, TabState } from "./tabState";

// MARK: Images

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A decoded image ImageOps can draw from. */
export interface ImageHandle {
  readonly width: number;
  readonly height: number;
}

export interface ImageOps {
  /** JPEG/PNG bytes or a `data:` URL; null when it can't be decoded. */
  decode(source: Uint8Array | string): Promise<ImageHandle | null>;
  /** RGBA pixels of `rect` (the whole image when null) drawn at `width` × `height`. */
  sample(image: ImageHandle, rect: Rect | null, width: number, height: number): Promise<Uint8ClampedArray | null>;
  /** `rect` (or all) as JPEG, scaled so its longest side is at most `maxPixel` (never up). */
  jpeg(image: ImageHandle, rect: Rect | null, maxPixel: number, quality: number): Promise<Uint8Array | null>;
  release?(image: ImageHandle): void;
}

interface BitmapHandle extends ImageHandle {
  readonly bitmap: ImageBitmap;
}

/** The bytes of a base64 `data:` URL, or null. */
export function dataUrlBytes(url: string): Uint8Array | null {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma === -1 || !url.slice(0, comma).includes(";base64")) return null;
  try {
    const binary = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** ImageOps over createImageBitmap and OffscreenCanvas. */
export function canvasImageOps(): ImageOps {
  const draw = (image: ImageHandle, rect: Rect | null, width: number, height: number) => {
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    const context = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = width * height <= 64 * 64 ? "medium" : "high";
    const r = rect ?? { x: 0, y: 0, width: image.width, height: image.height };
    context.drawImage((image as BitmapHandle).bitmap, r.x, r.y, r.width, r.height, 0, 0, canvas.width, canvas.height);
    return { canvas, context };
  };
  return {
    async decode(source) {
      try {
        const bytes = typeof source === "string" ? dataUrlBytes(source) : source;
        if (!bytes) return null;
        const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
        return { width: bitmap.width, height: bitmap.height, bitmap } satisfies BitmapHandle;
      } catch {
        return null;
      }
    },
    async sample(image, rect, width, height) {
      try {
        const drawn = draw(image, rect, width, height);
        return drawn ? drawn.context.getImageData(0, 0, width, height).data : null;
      } catch {
        return null;
      }
    },
    async jpeg(image, rect, maxPixel, quality) {
      try {
        const r = rect ?? { x: 0, y: 0, width: image.width, height: image.height };
        const scale = Math.min(1, maxPixel / Math.max(r.width, r.height));
        const width = Math.round(r.width * scale);
        const height = Math.round(r.height * scale);
        if (width <= 0 || height <= 0) return null;
        const drawn = draw(image, r, width, height);
        if (!drawn) return null;
        const blob = await drawn.canvas.convertToBlob({ type: "image/jpeg", quality });
        return new Uint8Array(await blob.arrayBuffer());
      } catch {
        return null;
      }
    },
    release(image) {
      try {
        (image as BitmapHandle).bitmap.close();
      } catch {
        // Already gone.
      }
    },
  };
}

export interface Grade {
  brightness: number;
  contrast: number;
  colour: number;
}

/** Judges frames (the Mac's FrameImage). */
export const FrameImage = {
  /** The tiny copy a frame is judged from: plenty to tell a scene from an empty screen. */
  gradeWidth: 32,
  gradeHeight: 18,

  /** Brightness (mean luma), contrast (its standard deviation) and colour (mean chroma) of RGBA pixels. */
  grade(rgba: ArrayLike<number>, width: number, height: number): Grade {
    const count = width * height;
    if (count <= 0) return { brightness: 0, contrast: 0, colour: 0 };
    const lumas = new Float64Array(count);
    let lumaSum = 0;
    let colourSum = 0;
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      const r = (rgba[i] ?? 0) / 255;
      const g = (rgba[i + 1] ?? 0) / 255;
      const b = (rgba[i + 2] ?? 0) / 255;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumas[p] = luma;
      lumaSum += luma;
      colourSum += Math.max(r, g, b) - Math.min(r, g, b);
    }
    const mean = lumaSum / count;
    let variance = 0;
    for (let p = 0; p < count; p++) variance += (lumas[p]! - mean) * (lumas[p]! - mean);
    variance /= count;
    return { brightness: mean, contrast: Math.sqrt(variance), colour: colourSum / count };
  },

  /** A black screen, a fade, or video the browser won't let anyone photograph. */
  isBlank(grade: Grade): boolean {
    return grade.brightness < 0.035 || grade.contrast < 0.012;
  },

  interest(grade: Grade): number {
    return grade.contrast * 2 + grade.colour + Math.min(grade.brightness, 0.5) * 0.3;
  },

  /** Six `[r, g, b]` zones from a 3×2 sample, left to right, top row first (ColorZones.sample). */
  zones(rgba: ArrayLike<number>): number[][] {
    const zones: number[][] = [];
    for (let p = 0; p < 6; p++) zones.push([rgba[p * 4] ?? 0, rgba[p * 4 + 1] ?? 0, rgba[p * 4 + 2] ?? 0]);
    return zones;
  },
};

// MARK: Collecting

type Capture =
  | { kind: "frame"; jpeg: Uint8Array; grade: Grade; position: number; duration: number }
  /** The controls are probably showing, or the picture hasn't caught up with a jump. */
  | { kind: "later" }
  | { kind: "blank" }
  | { kind: "failed" };

/** What media.js's `capture(maxWidth, quality)` returns. */
interface CaptureInfo {
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  t?: unknown;
  d?: unknown;
  idle?: unknown;
  url?: unknown;
  settled?: unknown;
  data?: unknown;
}

const n = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export interface FrameCollectorOptions {
  images?: ImageOps;
  /** New frame file names (a UUID, upper-case as the apps write them). */
  uuid?: () => string;
}

/** Keeps a few real frames from everything watched, on this computer only, for the timeline. */
export class FrameCollector {
  /** Enough to scrub through a session, little enough that a film costs under a megabyte. */
  static readonly framesPerSession = 14;
  static readonly frameWidth = 480;
  static readonly momentWidth = 1600;

  private readonly images: ImageOps;
  private readonly uuid: () => string;
  private readonly pending = new Set<Promise<unknown>>();
  /** Tabs whose media.js was asked to sample ambient light. */
  private readonly ambientOn = new Set<number>();
  private isSamplingAmbient = false;
  private ambientFails = 0;

  constructor(
    private readonly ctx: SessionContext,
    private readonly platform: Platform,
    options: FrameCollectorOptions = {},
  ) {
    this.images = options.images ?? canvasImageOps();
    this.uuid = options.uuid ?? (() => crypto.randomUUID().toUpperCase());
  }

  private get library() {
    return this.ctx.library;
  }

  private now(): number {
    return this.ctx.clock.now();
  }

  private run(work: Promise<unknown>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    detach(work);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.ctx.clock.schedule(ms, resolve));
  }

  /** The tab is in front, so a photograph of its window shows it. */
  private isOnScreen(tab: TabState): boolean {
    return tab.active && this.ctx.browser.selected?.id === tab.id;
  }

  /** Called by the tracker with every report of a tracked video. */
  tick(event: MediaEvent, tab: TabState, track: LiveTrack): void {
    if (!this.ctx.settings.keepFrames || event.type !== "tick" || event.paused || tab.frameState.isCapturing || !this.isOnScreen(tab)) return;

    if (tab.frameState.sessionId !== track.session.id) {
      const existing = this.library.frames(track.session.id).filter((f) => !f.isMoment);
      tab.frameState.sessionId = track.session.id;
      tab.frameState.count = existing.length;
      let latest: FilmFrame | null = null;
      for (const frame of existing) if (latest == null || frame.at > latest.at) latest = frame;
      tab.frameState.lastPosition = latest?.position ?? null;
    }
    const state = tab.frameState;
    if (state.count >= FrameCollector.framesPerSession || this.now() < state.notBefore || event.position / event.duration >= 0.93) return;

    const spacing = Math.max(90, event.duration / FrameCollector.framesPerSession);
    if (state.lastPosition != null) {
      if (Math.abs(event.position - state.lastPosition) < spacing) return;
    } else if (track.session.watchedSeconds < 20) {
      // Give it a moment first, past whatever the player shows at the very start.
      return;
    }

    state.isCapturing = true;
    this.run(
      (async () => {
        const result = await this.capture(tab, FrameCollector.frameWidth, 0.72, true);
        tab.frameState.isCapturing = false;
        const frames = tab.frameState;
        switch (result.kind) {
          case "frame": {
            const current = tab.track;
            if (!current) return;
            await this.store(result.jpeg, result.grade, result.position, tab.url, current, false);
            frames.count += 1;
            frames.lastPosition = result.position;
            frames.blanks = 0;
            break;
          }
          case "later":
            frames.notBefore = this.now() + 4000;
            break;
          case "blank": {
            // A dark scene passes, so keep trying. Protected video stays black, so try less and less.
            frames.blanks += 1;
            const wait = Math.min(300, 20 * 2 ** (frames.blanks - 1));
            frames.notBefore = this.now() + wait * 1000;
            break;
          }
          case "failed":
            frames.notBefore = this.now() + 30_000;
            break;
        }
        this.ctx.browser.changed(tab);
      })(),
    );
  }

  // MARK: Moments

  /** Saves the frame on screen, on purpose. Works even with collecting switched off. */
  async saveMoment(tab: TabState): Promise<void> {
    if (!tab.media) {
      this.ctx.toasts.show("Play something first, then save the moment you like", { tab });
      return;
    }
    // Pressed just after a jump, the picture needs a moment to catch up.
    let result: Capture = { kind: "later" };
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await this.sleep(800);
      result = await this.capture(tab, FrameCollector.momentWidth, 0.88, false);
      if (result.kind === "frame") break;
    }
    if (result.kind !== "frame") {
      this.ctx.browser.showBanner(tab, {
        id: "moment",
        text: "Couldn't save this frame. Some sites protect their video from being captured.",
        timeout: 4,
      });
      return;
    }
    const track = tab.track;
    if (!track) {
      this.ctx.browser.showBanner(tab, {
        id: "moment",
        text: "Cineon is still working out what this is. Try again in a few seconds.",
        timeout: 4,
      });
      return;
    }
    await this.store(result.jpeg, result.grade, result.position, tab.url, track, true);
    this.ctx.browser.mediaCommand(tab, "flash");
    this.ctx.browser.showBanner(tab, { id: "moment", text: `Saved this moment at ${Timecode.string(result.position)}`, timeout: 3 });
  }

  // MARK: Capturing

  /**
   * Asks the player for the frame first, which gives a clean picture with no controls on it. Most
   * video is cross-origin and won't allow that, so the fallback is to photograph the tab, cropped
   * to where the picture sits.
   */
  private async capture(tab: TabState, maxPixel: number, quality: number, waitForStillMouse: boolean): Promise<Capture> {
    const info = (await this.ctx.browser.evaluateInPlayer(tab, "capture", maxPixel, quality).catch(() => null)) as CaptureInfo | null;
    const position = n(info?.t);
    if (!info || position == null) return { kind: "failed" };
    const duration = n(info.d) ?? 0;
    if (info.settled === false) return { kind: "later" };

    if (typeof info.data === "string") {
      const jpeg = dataUrlBytes(info.data);
      const grade = jpeg ? await this.gradeBytes(jpeg) : null;
      if (jpeg && grade && !FrameImage.isBlank(grade)) return { kind: "frame", jpeg, grade, position, duration };
      // A blank canvas can just mean this kind of video doesn't draw there. Photograph it instead.
    }

    const idle = n(info.idle);
    if (waitForStillMouse && idle != null && idle < 2500) return { kind: "later" };
    const rect = await this.pictureRect(tab, info);
    if (!rect) return { kind: "failed" };
    const photo = await this.photograph(tab, rect);
    if (!photo) return { kind: "failed" };
    try {
      const pixels = await this.images.sample(photo.image, photo.crop, FrameImage.gradeWidth, FrameImage.gradeHeight);
      if (!pixels) return { kind: "failed" };
      const grade = FrameImage.grade(pixels, FrameImage.gradeWidth, FrameImage.gradeHeight);
      if (FrameImage.isBlank(grade)) return { kind: "blank" };
      const jpeg = await this.images.jpeg(photo.image, photo.crop, maxPixel, quality);
      return jpeg ? { kind: "frame", jpeg, grade, position, duration } : { kind: "failed" };
    } finally {
      this.images.release?.(photo.image);
    }
  }

  private async gradeBytes(jpeg: Uint8Array): Promise<Grade | null> {
    const image = await this.images.decode(jpeg);
    if (!image) return null;
    try {
      const pixels = await this.images.sample(image, null, FrameImage.gradeWidth, FrameImage.gradeHeight);
      return pixels ? FrameImage.grade(pixels, FrameImage.gradeWidth, FrameImage.gradeHeight) : null;
    } finally {
      this.images.release?.(image);
    }
  }

  /** Where the picture sits in the tab, in CSS pixels of the top frame's viewport. */
  async pictureRect(tab: TabState, known?: CaptureInfo): Promise<Rect | null> {
    const info = known ?? ((await this.ctx.browser.evaluateInPlayer(tab, "capture", 1, 0.1).catch(() => null)) as CaptureInfo | null);
    if (!info) return null;
    let x = n(info.x);
    let y = n(info.y);
    const width = n(info.w);
    const height = n(info.h);
    if (x == null || y == null || width == null || height == null || !(width > 40) || !(height > 40)) return null;
    if (tab.mediaFrame != null && tab.mediaFrame.frameId !== 0) {
      // The player is in a frame, so its numbers are relative to that frame.
      const url = typeof info.url === "string" ? info.url : "";
      const outer = (await this.ctx.browser.evaluateInPage(tab, "frameRect", url, width, height).catch(() => null)) as {
        x?: unknown;
        y?: unknown;
      } | null;
      const ox = n(outer?.x);
      const oy = n(outer?.y);
      if (ox == null || oy == null) return null;
      x += ox;
      y += oy;
    }
    return { x, y, width, height };
  }

  /** The tab as on screen, decoded, with the picture's crop in its pixels. */
  private async photograph(tab: TabState, rect: Rect): Promise<{ image: ImageHandle; crop: Rect } | null> {
    // A photograph of the window shows whichever tab is in front.
    if (!tab.active || tab.windowId < 0) return null;
    const viewport = (await this.platform.page.call(tab.id, 0, "__cineonContent", "viewport", []).catch(() => null)) as {
      width?: unknown;
      height?: unknown;
      dpr?: unknown;
    } | null;
    const shot = await this.platform.tabs.captureVisibleTab(tab.windowId, 90).catch(() => null);
    if (!shot) return null;
    const image = await this.images.decode(shot);
    if (!image) return null;
    const viewWidth = n(viewport?.width);
    const viewHeight = n(viewport?.height);
    // The screenshot is in device pixels: the viewport's CSS width maps onto its whole width,
    // which takes care of both the display's scale and the page's zoom.
    const scale = viewWidth != null && viewWidth > 0 ? image.width / viewWidth : (n(viewport?.dpr) ?? 1);
    const bounds = { width: viewWidth ?? image.width / scale, height: viewHeight ?? image.height / scale };
    const left = Math.max(0, rect.x);
    const top = Math.max(0, rect.y);
    const right = Math.min(bounds.width, rect.x + rect.width);
    const bottom = Math.min(bounds.height, rect.y + rect.height);
    if (!(right - left > 40) || !(bottom - top > 40)) {
      this.images.release?.(image);
      return null;
    }
    const crop = {
      x: Math.round(left * scale),
      y: Math.round(top * scale),
      width: Math.min(image.width - Math.round(left * scale), Math.round((right - left) * scale)),
      height: Math.min(image.height - Math.round(top * scale), Math.round((bottom - top) * scale)),
    };
    return { image, crop };
  }

  // MARK: Storing

  private async store(jpeg: Uint8Array, grade: Grade, position: number, url: string | null, track: LiveTrack, isMoment: boolean): Promise<void> {
    const titleId = this.library.currentId(track.titleId);
    if (titleId == null) return;
    await this.library.addFrame(
      FilmFrame.make({
        sessionId: track.session.id,
        titleId,
        ref: track.ref,
        position,
        url,
        file: `${titleId}/${this.uuid()}.jpg`,
        isMoment,
        // A moment someone chose always represents its session.
        interest: FrameImage.interest(grade) + (isMoment ? 10 : 0),
        at: this.now() / 1000,
      }),
      jpeg,
    );
  }

  // MARK: Ambient light

  /** media.js's `ambient` report: six `[r, g, b]` zones, 0–255. */
  receiveAmbient(tab: TabState, zones: unknown): void {
    const parsed = FrameCollector.parseZones(zones);
    if (!parsed) return;
    tab.ambient = parsed;
    this.ctx.browser.changed(tab);
  }

  static parseZones(value: unknown): number[][] | null {
    if (!Array.isArray(value) || value.length !== 6) return null;
    const zones: number[][] = [];
    for (const zone of value) {
      if (!Array.isArray(zone) || zone.length !== 3 || !zone.every((c) => typeof c === "number" && Number.isFinite(c))) return null;
      zones.push(zone.map((c: number) => Math.max(0, Math.min(255, c))));
    }
    return zones;
  }

  /**
   * Every 1.5 s while something plays (AppModel.tickAmbient): light follows the film in the tab in
   * front, read from the video when the page allows it and from a small photograph of the tab when
   * it doesn't. Tabs that aren't in front or playing any more stop sampling.
   */
  ambientTick(): void {
    const selected = this.ctx.browser.selected;
    const target =
      this.ctx.settings.ambientLight && selected && selected.active && selected.media?.isPlaying === true ? selected : null;
    for (const id of [...this.ambientOn]) {
      if (id === target?.id) continue;
      this.ambientOn.delete(id);
      const tab = this.ctx.browser.registry.get(id);
      if (tab) this.ctx.browser.setAmbient(tab, false);
    }
    if (!target) return;
    if (!this.ambientOn.has(target.id)) {
      this.ambientOn.add(target.id);
      this.ctx.browser.setAmbient(target, true);
    }
    // The page won't let the video be read. Photograph the tab instead, which sees it.
    if (!target.ambientFramesBlocked || this.isSamplingAmbient || this.ambientFails >= 3) return;
    this.isSamplingAmbient = true;
    this.run(
      (async () => {
        try {
          const zones = await this.sampleTab(target);
          if (!zones) {
            this.ambientFails += 1;
            return;
          }
          this.ambientFails = 0;
          target.ambient = zones;
          this.ctx.browser.changed(target);
        } finally {
          this.isSamplingAmbient = false;
        }
      })(),
    );
  }

  /** Six zones of the picture (or the whole tab, when its place isn't known) from a photograph. */
  private async sampleTab(tab: TabState): Promise<number[][] | null> {
    const rect = (await this.pictureRect(tab)) ?? { x: 0, y: 0, width: 100_000, height: 100_000 };
    const photo = await this.photograph(tab, rect);
    if (!photo) return null;
    try {
      const pixels = await this.images.sample(photo.image, photo.crop, 3, 2);
      return pixels ? FrameImage.zones(pixels) : null;
    } finally {
      this.images.release?.(photo.image);
    }
  }

  /** Waits for captures in flight (tests and debug). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
