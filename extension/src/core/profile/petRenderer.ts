// Draws one pose of a pet into a 24×24 PetBitmap. Port of the Swift PetRenderer by way of
// windows/Cineon.Core/Profile/PetRenderer.cs.

import { PetArt } from "./petArt";
import { K, spriteKey, type Overlay, type Sprite } from "./petArtBuild";
import { PetBitmap, type PetFrame, type PetPoint, type PetRect } from "./petBitmap";
import { PetAccessory, type PetSpecies, type PetStage, type PetTone } from "./petTypes";

/** What the renderer needs of a pet. */
export interface RenderablePet {
  readonly species: PetSpecies;
  readonly stage: PetStage;
  readonly accessory: PetAccessory;
  readonly tone: PetTone;
}

const DOT = K(".");
const REACH = [0, 1, 2, 1, 0, -1];

export function renderPet(pet: RenderablePet, frame: PetFrame): PetBitmap {
  return new PetRenderer(pet, frame).render();
}

class PetRenderer {
  private readonly sprite: Sprite;
  private readonly colors: Uint32Array;
  private readonly ox: number;
  private readonly oy: number;
  private readonly output = new PetBitmap();

  constructor(private readonly pet: RenderablePet, private readonly frame: PetFrame) {
    this.sprite = PetArt.spriteFor(pet.species, pet.stage);
    this.colors = PetArt.palette(pet.species, pet.tone);
    this.ox = PetArt.centerX - this.sprite.head.x;
    this.oy = PetArt.groundY - (this.sprite.height - 1) - frame.lift;
  }

  private color(key: number): number {
    return this.colors[key & 0x7f]!;
  }

  private c(key: string): number {
    return this.color(K(key));
  }

  private put(x: number, y: number, c: number): void {
    if (c !== 0) this.output.set(x, y, c);
  }

  /** Sprite-space put. */
  private sPut(x: number, y: number, c: number): void {
    this.put(this.ox + x, this.oy + y, c);
  }

  render(): PetBitmap {
    this.drawBody();
    this.drawEyes();
    this.drawMouth();
    this.drawAccessory();
    if (this.pet.stage === "legend") this.stamp(PetArt.crown, this.sprite.head, PetArt.crown.dy);
    this.drawEffect();
    this.drawSparkles();
    return this.output;
  }

  private drawBody(): void {
    const sprite = this.sprite;
    for (let y = 0; y < sprite.height; y++) {
      for (let x = 0; x < sprite.width; x++) {
        const key = sprite.keys[y * sprite.width + x]!;
        if (key !== DOT) this.sPut(x, y, this.color(key));
      }
    }
  }

  /** Colour just above an eye: what an eyelid would be. */
  private lidColor(eye: PetRect): number {
    const spots: [number, number][] = [[eye.x, eye.y - 1], [eye.x - 1, eye.y], [eye.x + eye.w, eye.y]];
    for (const [x, y] of spots) {
      const key = spriteKey(this.sprite, x, y);
      if (key !== DOT && key !== K("o") && key !== K("E")) return this.color(key);
    }
    return this.c("b");
  }

  private drawEyes(): void {
    const eye = this.c("e");
    const shine = this.c("w");
    const heavyLid = this.c("s");
    this.sprite.eyes.forEach((rect, index) => {
      const lid = this.lidColor(rect);
      const isLeft = index === 0;
      for (let dy = 0; dy < rect.h; dy++) {
        for (let dx = 0; dx < rect.w; dx++) {
          const last = dy === rect.h - 1;
          let c = eye;
          switch (this.frame.eyes) {
            case "open":
              if (dx === 0 && dy === 0 && rect.w > 1 && rect.h > 1) c = shine;
              break;
            case "heavy":
              if (dy === 0 && rect.h > 1) c = heavyLid;
              break;
            case "closed":
              if (!last) c = lid;
              break;
            case "happy": {
              // ◠ ◠ : top row plus the outer corner below it.
              const outer = isLeft ? dx === 0 : dx === rect.w - 1;
              if (dy > 0 && !(dy === 1 && outer)) c = lid;
              break;
            }
          }
          this.sPut(rect.x + dx, rect.y + dy, c);
        }
      }
    });
  }

  private drawMouth(): void {
    const m = this.sprite.mouth;
    if (!m) return;
    const ink = this.c("i");
    const tongue = this.c("t");
    let offsets: [number, number, number][];
    switch (this.frame.mouth) {
      case "smile": offsets = [[-1, 0, ink], [1, 0, ink], [0, 1, ink]]; break;
      case "grin": offsets = [[-1, 0, ink], [0, 0, ink], [1, 0, ink], [0, 1, tongue]]; break;
      case "flat": offsets = [[-1, 0, ink], [0, 0, ink], [1, 0, ink]]; break;
      default: offsets = [[0, 0, ink]];
    }
    for (const [dx, dy, c] of offsets) this.sPut(m.x + dx, m.y + dy, c);
  }

  /** Stamps an overlay so its bottom row lands `dy` rows below `anchor`, centred on it. */
  private stamp(overlay: Overlay, anchor: PetPoint, dy: number, dx = 0): void {
    const left = anchor.x + dx - Math.trunc(overlay.width / 2);
    const top = anchor.y + dy - (overlay.height - 1);
    for (let y = 0; y < overlay.height; y++) {
      for (let x = 0; x < overlay.width; x++) {
        const key = overlay.key(x, y);
        if (key !== DOT) this.sPut(left + x, top + y, this.color(key));
      }
    }
  }

  /** First outline cell left and right of `x` on `row`. */
  private silhouette(row: number, x: number): [number, number] {
    const o = K("o");
    const sprite = this.sprite;
    let l = x, r = x;
    if (spriteKey(sprite, x, row) === o) return [x, x];
    while (l > 0 && spriteKey(sprite, l, row) !== o) l -= 1;
    while (r < sprite.width - 1 && spriteKey(sprite, r, row) !== o) r += 1;
    return [l, r];
  }

  private drawAccessory(): void {
    const accessory = this.pet.accessory;
    const sprite = this.sprite;
    if (this.pet.stage === "legend" && PetAccessory.isHat(accessory)) return;
    const ink = this.c("o");
    switch (accessory) {
      case "none":
        return;
      case "specs":
      case "shades":
      case "glasses3D":
        this.drawGlasses(accessory);
        break;
      case "headband": {
        if (sprite.eyes.length === 0) return;
        const top = Math.min(...sprite.eyes.map((e) => e.y));
        const row = top - 2;
        const [l, r] = this.silhouette(row, sprite.head.x);
        const red = this.c("r"), dark = this.c("R");
        for (let x = l; x <= r; x++) this.sPut(x, row, x === l || x === r ? dark : red);
        this.sPut(r + 1, row, red); this.sPut(r + 2, row + 1, red); this.sPut(r + 1, row + 1, dark);
        this.sPut(r + 2, row + 2, dark);
        break;
      }
      case "headphones": {
        if (sprite.eyes.length === 0) return;
        const top = Math.min(...sprite.eyes.map((e) => e.y));
        const [l, r] = this.silhouette(top, sprite.head.x);
        const band = this.c("K"), cup = this.c("r");
        const crownRow = sprite.head.y - 1;
        for (let y = crownRow + 1; y <= top - 1; y++) { this.sPut(l, y, band); this.sPut(r, y, band); }
        for (let x = l + 1; x <= r - 1; x++) this.sPut(x, crownRow, band);
        for (const side of [l - 1, r]) {
          for (let y = top - 1; y <= top + 2; y++) {
            for (let x = side; x <= side + 1; x++) {
              const edge = y === top - 1 || y === top + 2 || (x === side && side < l) || (x === side + 1 && side === r);
              this.sPut(x, y, edge ? ink : cup);
            }
          }
        }
        break;
      }
      case "scarf": {
        const row = sprite.neck;
        const [l, r] = this.silhouette(row, sprite.head.x);
        const red = this.c("r"), dark = this.c("R");
        for (let x = l; x <= r; x++) {
          this.sPut(x, row, x === l || x === r ? ink : red);
          this.sPut(x, row + 1, x === l || x === r ? ink : dark);
        }
        // Hanging end.
        const tx = r - 3;
        for (let y = row + 2; y <= row + 4; y++) {
          this.sPut(tx, y, red); this.sPut(tx + 1, y, dark); this.sPut(tx - 1, y, ink); this.sPut(tx + 2, y, ink);
        }
        this.sPut(tx, row + 5, ink); this.sPut(tx + 1, row + 5, ink);
        break;
      }
      case "bowtie":
        this.stamp(PetArt.bowtie, { x: sprite.head.x, y: sprite.neck }, 1);
        break;
      case "popcorn":
        this.stampLeft(PetArt.popcorn, sprite.hand);
        break;
      case "magnifier":
        this.stampLeft(PetArt.magnifier, sprite.hand);
        break;
      case "bow":
        this.stamp(PetArt.bow, sprite.head, PetArt.bow.dy, sprite.headHalfWidth - 2);
        break;
      case "horns": {
        const spread = Math.max(2, Math.trunc(sprite.headHalfWidth / 2) - 1);
        const horn = PetArt.horn;
        for (const side of [-1, 1]) {
          const baseX = sprite.head.x + side * spread;
          for (let y = 0; y < horn.height; y++) {
            for (let x = 0; x < horn.width; x++) {
              const key = horn.key(x, y);
              if (key === DOT) continue;
              // Authored as the left horn; mirrored for the right one.
              const dx = side < 0 ? x - (horn.width - 1) : horn.width - 1 - x;
              this.sPut(baseX + dx, sprite.head.y + 1 - (horn.height - 1) + y, this.color(key));
            }
          }
        }
        break;
      }
      default: {
        const overlay = PetArt.hats.get(accessory);
        if (!overlay) return;
        this.stamp(overlay, sprite.head, overlay.dy);
        break;
      }
    }
  }

  /** Bottom-left of the overlay at `anchor`. */
  private stampLeft(overlay: Overlay, anchor: PetPoint): void {
    const top = anchor.y - (overlay.height - 1);
    for (let y = 0; y < overlay.height; y++) {
      for (let x = 0; x < overlay.width; x++) {
        const key = overlay.key(x, y);
        if (key !== DOT) this.sPut(anchor.x + x, top + y, this.color(key));
      }
    }
  }

  private drawGlasses(kind: "specs" | "shades" | "glasses3D"): void {
    if (this.sprite.eyes.length !== 2) return;
    const a = this.sprite.eyes[0]!, b = this.sprite.eyes[1]!;
    const ink = this.c("o");
    const fill = kind === "shades" ? [this.c("k"), this.c("k")]
      : kind === "glasses3D" ? [this.c("r"), this.c("q")]
      : [0, 0];
    [a, b].forEach((eye, i) => {
      const x0 = eye.x - 1, x1 = eye.x + eye.w, y0 = eye.y - 1, y1 = eye.y + eye.h;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const border = x === x0 || x === x1 || y === y0 || y === y1;
          const corner = (x === x0 || x === x1) && (y === y0 || y === y1);
          if (border) {
            if (kind === "specs" && corner) continue;
            this.sPut(x, y, ink);
          } else if (fill[i] !== 0) {
            this.sPut(x, y, fill[i]!);
          }
        }
      }
      if (kind === "shades") this.sPut(eye.x, eye.y, this.c("w"));
    });
    // Bridge.
    const bridgeY = a.y - (kind === "specs" ? 0 : 1);
    for (let x = a.x + a.w + 1; x < b.x - 1; x++) this.sPut(x, bridgeY, ink);
  }

  private drawEffect(): void {
    const frame = this.frame;
    if (frame.effect === "none") return;
    // Effects float in the air next to the head; they don't bob with the body.
    const ax = PetArt.centerX + this.sprite.headHalfWidth - 1;
    const ay = PetArt.groundY - (this.sprite.height - 1) + this.sprite.head.y;
    const step = frame.effectStep;
    switch (frame.effect) {
      case "zzz":
        // Small z, then a big Z drifting up and right.
        if (step < 6) this.stampFree(PetArt.zSmall, ax, ay - 3 - Math.trunc(step / 3));
        if (step >= 2 && step < 7) this.stampFree(PetArt.zBig, ax + 3, ay - 8 - Math.trunc((step - 2) / 3));
        break;
      case "heart": {
        if (step >= 6) return;
        const glyph = step === 0 ? PetArt.heartSmall : PetArt.heart;
        this.stampFree(glyph, ax + 1, ay - 4 - step);
        break;
      }
      case "dots": {
        const bubble = PetArt.bubble;
        const bx = Math.min(ax, PetBitmap.size - bubble.width), by = Math.max(ay - 7, 0);
        this.stampFree(bubble, bx, by);
        const dotInk = this.colors[K("K")]!;
        for (let i = 0; i < Math.min(step, 3); i++) this.put(bx + 2 + i * 2, by + 2, dotInk);
        break;
      }
    }
  }

  /** Canvas-space stamp with top-left at (x, y); clipped at the canvas edges. */
  private stampFree(overlay: Overlay, x: number, y: number): void {
    const left = Math.min(x, PetBitmap.size - overlay.width);
    const top = Math.max(y, 0);
    for (let oy = 0; oy < overlay.height; oy++) {
      for (let ox = 0; ox < overlay.width; ox++) {
        const key = overlay.key(ox, oy);
        if (key !== DOT) this.put(left + ox, top + oy, this.color(key));
      }
    }
  }

  private drawSparkles(): void {
    const phase = this.frame.sparkle;
    if (phase === null) return;
    const gold = this.colors[K("y")]!, white = this.colors[K("w")]!;
    const sprite = this.sprite;
    const left = this.ox - 1;
    const right = Math.min(this.ox + sprite.width, PetArt.centerX + sprite.headHalfWidth + 2);
    const top = PetArt.groundY - (sprite.height - 1) + sprite.head.y;
    const spots: [number, number, number][] = [
      [left, top + 3, phase], [right, top + 8, (phase + 3) % 6], [left + 1, PetArt.groundY - 2, (phase + 2) % 6],
    ];
    for (const [x, y, p] of spots) {
      // Swift indexes the table directly (and would trap outside 0..<6); out of range draws nothing here.
      const reach = p >= 0 && p < 6 ? REACH[p]! : -1;
      if (reach < 0) continue;
      this.put(x, y, reach === 0 ? gold : white);
      for (let d = 1; d <= reach; d++) {
        this.put(x - d, y, gold); this.put(x + d, y, gold); this.put(x, y - d, gold); this.put(x, y + d, gold);
      }
    }
  }
}
