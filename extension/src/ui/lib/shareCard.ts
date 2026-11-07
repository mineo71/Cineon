// ProfileView.swift's ShareCardView, drawn on a canvas at 2×: logo, your pet, top numbers and
// taste, on the dark gradient. `shareCardData` is pure (tested); `drawShareCard` paints it.

import type { GenreWeight, PixelPet, ProfileStats } from "../../core/profile";
import { PetCanvas } from "../../core/profile";
import { averageText, genreDetail, genrePercent, hours } from "./profileText";

export interface ShareCardData {
  /** "November 2026". */
  date: string;
  name: string;
  petLine: string;
  genreLine: string | null;
  numbers: { value: string; label: string }[];
  average: string;
  genres: GenreWeight[];
  genreDetail: string | null;
}

export function shareCardData(stats: ProfileStats, pet: PixelPet, name: string, now: Date = new Date(), locale?: string): ShareCardData {
  return {
    date: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(now),
    name,
    petLine: `${pet.name}, ${pet.stageLabel.toLowerCase()} ${pet.speciesLabel.toLowerCase()}`,
    genreLine: stats.favouriteGenre ? `Mostly ${stats.favouriteGenre.toLowerCase()}` : null,
    numbers: [
      { value: hours(stats.estimatedHours), label: "hours" },
      { value: String(stats.filmsWatched), label: "films" },
      { value: String(stats.episodesFinished), label: "episodes" },
    ],
    average: averageText(stats.averageRating),
    genres: stats.genres.slice(0, 5),
    genreDetail: genreDetail(stats.genres),
  };
}

/** "Ana on Cineon.png", safe for any file system. */
export function shareCardFileName(name: string): string {
  const cleaned = name.replace(/[/\\:?%*|"<>\n\r\t]/g, " ").replace(/\s+/g, " ").trim();
  return `${cleaned.length > 0 ? cleaned : "Me"} on Cineon.png`;
}

export const SHARE_CARD_WIDTH = 720;
const PAD = 36;
const SPACING = 22;
const TITLE = '"Jost", "Futura", "Century Gothic", sans-serif';
const UI = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const STAR = "M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z";

function genreBlockHeight(count: number): number {
  const rows = count === 0 ? 16 : count * 16 + (count - 1) * 9;
  return 28 + 16 + rows;
}

/** The card's height in points. */
export function shareCardHeight(data: ShareCardData): number {
  return PAD + 22 + SPACING + 150 + SPACING + 53 + SPACING + genreBlockHeight(data.genres.length) + PAD;
}

function white(alpha: number): string {
  return `rgba(255,255,255,${alpha})`;
}

function goldGradient(ctx: CanvasRenderingContext2D, top: number, bottom: number): CanvasGradient {
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, "rgb(255,219,128)");
  g.addColorStop(1, "rgb(237,168,56)");
  return g;
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = goldGradient(ctx, 2.6, 20.1);
  ctx.fill(new Path2D(STAR));
  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/** The logo in white, as a small canvas (the PNG is a mask). */
async function whiteLogo(size: number, scale: number): Promise<HTMLCanvasElement | null> {
  const image = await loadImage("logo-mark.png");
  if (!image) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.round(size * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const fit = Math.min(canvas.width / image.width, canvas.height / image.height);
  const w = image.width * fit;
  const h = image.height * fit;
  ctx.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Paints the card on `canvas` at `scale` (2 for the saved picture). */
export async function drawShareCard(canvas: HTMLCanvasElement, data: ShareCardData, pet: PixelPet, scale = 2): Promise<void> {
  const height = shareCardHeight(data);
  canvas.width = SHARE_CARD_WIDTH * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  try {
    await Promise.all([
      document.fonts?.load(`500 40px ${TITLE}`),
      document.fonts?.load(`700 30px ${TITLE}`),
    ]);
  } catch {
    // The system's fonts will do.
  }
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";

  // Background: white 0.1 to black.
  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, "rgb(26,26,26)");
  background.addColorStop(1, "#000");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, height);

  const right = SHARE_CARD_WIDTH - PAD;
  let y = PAD;

  // Header: logo, Cineon, the month.
  const logo = await whiteLogo(20, scale);
  if (logo) ctx.drawImage(logo, PAD, y + 1, 20, 20);
  ctx.fillStyle = "#fff";
  ctx.font = `700 17px ${TITLE}`;
  ctx.fillText("Cineon", PAD + 28, y + 2);
  ctx.font = `13px ${UI}`;
  ctx.fillStyle = white(0.5);
  ctx.textAlign = "right";
  ctx.fillText(data.date, right, y + 4);
  ctx.textAlign = "left";
  y += 22 + SPACING;

  // The pet and who you are.
  const frame = PetCanvas.frameFor(pet, 150, { animated: false });
  const image = PetCanvas.render(pet, frame, 150, scale);
  const pixels = document.createElement("canvas");
  pixels.width = image.pixelWidth;
  pixels.height = image.pixelHeight;
  const pixelContext = pixels.getContext("2d");
  if (pixelContext) {
    pixelContext.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.pixelWidth, image.pixelHeight), 0, 0);
    const w = image.pixelWidth / scale;
    const h = image.pixelHeight / scale;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pixels, PAD + (150 - w) / 2, y + (150 - h) / 2, w, h);
    ctx.imageSmoothingEnabled = true;
  }
  const textX = PAD + 150 + 26;
  const lines = 48 + 6 + 19 + (data.genreLine ? 6 + 19 : 0);
  let ty = y + (150 - lines) / 2;
  ctx.fillStyle = "#fff";
  ctx.font = `500 40px ${TITLE}`;
  ctx.fillText(data.name, textX, ty, right - textX);
  ty += 48 + 6;
  ctx.fillStyle = white(0.7);
  ctx.font = `15px ${UI}`;
  ctx.fillText(data.petLine, textX, ty, right - textX);
  if (data.genreLine) {
    ty += 19 + 6;
    ctx.fillText(data.genreLine, textX, ty, right - textX);
  }
  y += 150 + SPACING;

  // The numbers.
  let x = PAD;
  for (const number of data.numbers) {
    ctx.fillStyle = "#fff";
    ctx.font = `700 30px ${TITLE}`;
    ctx.fillText(number.value, x, y);
    const valueWidth = ctx.measureText(number.value).width;
    ctx.fillStyle = white(0.55);
    ctx.font = `12px ${UI}`;
    ctx.fillText(number.label, x, y + 38);
    x += Math.max(valueWidth, ctx.measureText(number.label).width) + 34;
  }
  star(ctx, x, y + 7, 20);
  ctx.fillStyle = "#fff";
  ctx.font = `700 30px ${TITLE}`;
  ctx.fillText(data.average, x + 25, y);
  ctx.fillStyle = white(0.55);
  ctx.font = `12px ${UI}`;
  ctx.fillText("average", x, y + 38);
  y += 53 + SPACING;

  // Your taste.
  ctx.fillStyle = "#fff";
  ctx.font = `500 22px ${TITLE}`;
  ctx.fillText("Your taste", PAD, y);
  if (data.genreDetail) {
    const titleWidth = ctx.measureText("Your taste").width;
    ctx.fillStyle = white(0.38);
    ctx.font = `12.5px ${UI}`;
    ctx.fillText(data.genreDetail, PAD + titleWidth + 10, y + 7);
  }
  y += 28 + 16;
  if (data.genres.length === 0) {
    ctx.fillStyle = white(0.38);
    ctx.font = `12.5px ${UI}`;
    ctx.fillText("Genres appear once Cineon has found your films' details.", PAD, y);
    return;
  }
  const most = data.genres[0]!.weight || 1;
  const barX = PAD + 92 + 12;
  const barWidth = right - 34 - 12 - barX;
  for (const [index, genre] of data.genres.entries()) {
    ctx.fillStyle = white(0.62);
    ctx.font = `12.5px ${UI}`;
    ctx.fillText(genre.name, PAD, y, 92);
    const width = Math.max(3, (barWidth * genre.weight) / most);
    if (index === 0) {
      const silver = ctx.createLinearGradient(0, y + 3, 0, y + 13);
      silver.addColorStop(0, "#f5f5f5");
      silver.addColorStop(1, "#9e9e9e");
      ctx.fillStyle = silver;
    } else {
      ctx.fillStyle = white(0.32);
    }
    ctx.beginPath();
    ctx.roundRect(barX, y + 3, width, 10, [0, 4, 4, 0]);
    ctx.fill();
    ctx.fillStyle = white(0.38);
    ctx.font = `11.5px ${UI}`;
    ctx.textAlign = "right";
    ctx.fillText(`${genrePercent(genre.weight)}%`, right, y + 1);
    ctx.textAlign = "left";
    y += 16 + 9;
  }
}

/** Renders the card and hands it to the browser as a download. */
export async function saveShareCard(stats: ProfileStats, pet: PixelPet, name: string): Promise<void> {
  const data = shareCardData(stats, pet, name);
  const canvas = document.createElement("canvas");
  await drawShareCard(canvas, data, pet, 2);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The picture couldn't be made");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = shareCardFileName(name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
