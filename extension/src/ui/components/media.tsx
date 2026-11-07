// The film pieces from Theme.swift and Rating.swift: the logo, remote images, posters (watched
// ones fade to grey, and back on hover), site icons, the progress line, the film strip, stars and
// the rating badge. Plus the pixel pet (core/profile's PetCanvas) and people's avatars.

import type { CSSProperties, ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type FilmFrame, Rating, type Title, TitleKind } from "../../core/data";
import { PetCanvas, PetFrame, type PetFraming, PixelPet } from "../../core/profile";
import { useReducedMotion, useSession } from "../lib/hooks";
import { Icon } from "./Icon";

// MARK: Logo

export function LogoMark({ size = 28, color, style }: { size?: number; color?: string; style?: CSSProperties }) {
  return (
    <span
      class="logo-mark"
      role="img"
      aria-label="Cineon"
      style={{ width: `${size}px`, height: `${size}px`, color: color ?? "var(--ink)", ...style }}
    />
  );
}

// MARK: Images

const loaded = new Set<string>();

/**
 * RemoteImage: the placeholder until the picture arrives, then a 0.25 s fade. An address already
 * shown in this page appears at once. The browser's HTTP cache stands in for the ImagePipeline.
 */
export function RemoteImage({
  url,
  placeholder,
  fit = "cover",
  class: className,
  style,
  alt = "",
}: {
  url: string | null | undefined;
  placeholder?: ComponentChildren;
  fit?: "cover" | "contain";
  class?: string;
  style?: CSSProperties;
  alt?: string;
}) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">(url && loaded.has(url) ? "loaded" : "loading");
  const instant = useRef(url != null && loaded.has(url));
  useEffect(() => {
    instant.current = url != null && loaded.has(url);
    setState(url && loaded.has(url) ? "loaded" : "loading");
  }, [url]);
  const showImage = url && state !== "failed";
  return (
    <div class={`remote-image${fit === "contain" ? " fit" : ""}${className ? ` ${className}` : ""}`} style={style}>
      {state !== "loaded" && <div class="placeholder">{placeholder}</div>}
      {showImage && (
        <img
          src={url}
          alt={alt}
          decoding="async"
          loading="lazy"
          draggable={false}
          referrerpolicy="no-referrer"
          class={`${state === "loaded" ? "loaded" : ""}${instant.current ? " instant" : ""}`}
          onLoad={() => {
            loaded.add(url);
            setState("loaded");
          }}
          onError={() => setState("failed")}
        />
      )}
    </div>
  );
}

const frameUrls = new Map<string, string>();
const frameLoads = new Map<string, Promise<string | null>>();

/** An object URL for a saved frame's image (the profile's frame files). */
export function useFrameUrl(frame: FilmFrame | null | undefined): string | null {
  const session = useSession();
  const key = frame ? `${session.profile.id}|${frame.file}` : null;
  const [url, setUrl] = useState<string | null>(key ? frameUrls.get(key) ?? null : null);
  useEffect(() => {
    if (!frame || !key) {
      setUrl(null);
      return;
    }
    const known = frameUrls.get(key);
    if (known) {
      setUrl(known);
      return;
    }
    let cancelled = false;
    let load = frameLoads.get(key);
    if (!load) {
      load = session.library.readFrame(frame).then((data) => {
        if (!data) return null;
        const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: "image/jpeg" });
        const objectUrl = URL.createObjectURL(blob);
        frameUrls.set(key, objectUrl);
        // Keep a few hundred; the oldest go.
        if (frameUrls.size > 400) {
          const oldest = frameUrls.keys().next().value as string;
          URL.revokeObjectURL(frameUrls.get(oldest)!);
          frameUrls.delete(oldest);
        }
        return objectUrl;
      });
      frameLoads.set(key, load);
      void load.finally(() => frameLoads.delete(key));
    }
    void load.then((value) => {
      if (!cancelled) setUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return url;
}

/** The title's poster, or, with none anywhere, a frame you actually saw. */
export function useTitleArt(title: Title | null | undefined, prefer: "poster" | "backdrop" = "poster"): string | null {
  const session = useSession();
  const frame = title ? session.library.bestFrame(title.id) : null;
  const primary = title ? (prefer === "backdrop" ? title.backdropUrl : title.posterUrl) : null;
  const frameUrl = useFrameUrl(primary ? null : frame);
  return primary ?? frameUrl;
}

// MARK: Posters

/** With no poster, the name becomes the poster: a title card. */
export function PosterPlaceholder({ name }: { name: string }) {
  return <div class="poster-placeholder">{name}</div>;
}

/**
 * PosterImage: 2:3, cropped, 6 pt corners. Watched titles are black and white, like a memory,
 * until hovered (or `keepsColour`).
 */
export function PosterImage({
  title,
  width,
  radius = 6,
  keepsColour = false,
  children,
  class: className,
}: {
  title: Title;
  width?: number;
  radius?: number;
  keepsColour?: boolean;
  children?: ComponentChildren;
  class?: string;
}) {
  const url = useTitleArt(title);
  const mono = title.status === "watched" && !keepsColour;
  return (
    <div
      class={`poster${mono ? " mono" : ""}${className ? ` ${className}` : ""}`}
      style={{ width: width != null ? `${width}px` : "100%", borderRadius: `${radius}px` }}
    >
      <RemoteImage url={url} placeholder={<PosterPlaceholder name={title.name} />} style={{ position: "absolute", inset: "0" }} />
      {children}
    </div>
  );
}

/** A poster for something that isn't in the library (a share, a search hit, a challenge). */
export function CardPoster({
  url,
  name,
  width,
  height,
  radius = 6,
}: {
  url: string | null | undefined;
  name: string;
  width: number;
  height: number;
  radius?: number;
}) {
  return (
    <RemoteImage
      url={url}
      placeholder={<PosterPlaceholder name={name} />}
      style={{ width: `${width}px`, height: `${height}px`, borderRadius: `${radius}px`, flex: "none" }}
    />
  );
}

/** SiteIcon: the site's icon, or its initial in Futura Bold. */
export function SiteIcon({ name, url, size = 20 }: { name: string; url: string | null | undefined; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const initial = [...name][0]?.toUpperCase() ?? "";
  return (
    <span
      class="site-icon"
      style={{ width: `${size}px`, height: `${size}px`, borderRadius: `${size * 0.22}px`, fontSize: `${size * 0.62}px` }}
      aria-hidden="true"
    >
      {url && !failed ? (
        <img src={url} alt="" referrerpolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        initial
      )}
    </span>
  );
}

// MARK: Progress and film

/** A thin progress line, ink on raised2. */
export function ProgressLine({ fraction, height = 3, width, style }: { fraction: number; height?: number; width?: number | string; style?: CSSProperties }) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return (
    <div
      class="progress-line"
      role="progressbar"
      aria-valuenow={Math.trunc(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ height: `${height}px`, width: typeof width === "number" ? `${width}px` : width ?? "100%", ...style }}
    >
      <i style={{ width: `max(${height}px, ${clamped * 100}%)` }} />
    </div>
  );
}

/** Perforation pitch: everything on the timeline is a multiple of it, so the holes line up. */
export const FILM_PITCH = 16;

/** A length of film: body and 7×9 perforations, 4 pt in, every 16 pt down both edges (CSS: .film-strip). */
export function FilmStripBody({ width, height, style, children }: { width: number; height: number; style?: CSSProperties; children?: ComponentChildren }) {
  return (
    <div class="film-strip" aria-hidden={children ? undefined : "true"} style={{ width: `${width}px`, height: `${height}px`, position: "relative", ...style }}>
      {children}
    </div>
  );
}

// MARK: Stars

const starPath = "M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z";

let gradientIds = 0;

/** One star, filled from the left by `fill` (0, 0.5 or 1). */
export function RatingStar({ fill, size, emptyOpacity = 1, lift }: { fill: number; size: number; emptyOpacity?: number; lift?: boolean }) {
  const id = useMemo(() => `gold${++gradientIds}`, []);
  const box = size * 1.1;
  return (
    <span
      class={`star${lift ? " lift" : ""}`}
      style={{ width: `${box}px`, height: `${box}px`, "--fill": String(fill), "--size": `${size}px` } as CSSProperties}
    >
      <svg viewBox="0 0 24 24" class="empty" style={{ opacity: emptyOpacity }} aria-hidden="true">
        <path d={starPath} fill="currentColor" />
      </svg>
      {fill > 0 && (
        <svg viewBox="0 0 24 24" class="full" aria-hidden="true">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="var(--gold-top)" />
              <stop offset="1" stop-color="var(--gold-bottom)" />
            </linearGradient>
          </defs>
          <path d={starPath} fill={`url(#${id})`} />
        </svg>
      )}
    </span>
  );
}

/** StarRow.fill: how much of star `star` (1–10) a rating of `halves` fills. */
export function starFill(star: number, halves: number): number {
  const full = Math.trunc(halves / 2);
  if (star <= full) return 1;
  if (star === full + 1 && halves % 2 === 1) return 0.5;
  return 0;
}

/** Ten stars, read only. */
export function StarRow({ halves, size = 11, spacing = 1.5 }: { halves: number | null; size?: number; spacing?: number }) {
  return (
    <span class="stars" style={{ gap: `${spacing}px` }} role="img" aria-label={halves != null ? `Rated ${Rating.text(halves)} out of 10` : "Not rated"}>
      {Array.from({ length: 10 }, (_, i) => (
        <RatingStar key={i} fill={starFill(i + 1, halves ?? 0)} size={size} />
      ))}
    </span>
  );
}

/** StarRatingControl.halves(at:starWidth:): left half of a star is a half, right half the whole star. */
export function halvesAt(x: number, starWidth: number): number {
  return Rating.clamp(Math.ceil((x / starWidth) * 2));
}

/**
 * Ten stars to rate with. Hovering shows what a click would give, down to half a star; clicking
 * the rating it already has clears it. Arrows move by half a star and Delete clears when focused.
 */
export function StarRatingControl({
  halves,
  size = 17,
  spacing = 3,
  showsValue = true,
  onChange,
  label = "Rating",
}: {
  halves: number | null;
  size?: number;
  spacing?: number;
  showsValue?: boolean;
  onChange: (halves: number | null) => void;
  label?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? halves ?? 0;
  const starWidth = size * 1.1 + spacing;
  const pick = (event: MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return halvesAt(event.clientX - rect.left, starWidth);
  };
  return (
    <span
      class="star-control"
      tabIndex={0}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={10}
      aria-valuenow={halves != null ? halves / 2 : 0}
      aria-valuetext={halves != null ? `${Rating.text(halves)} out of 10` : "Not rated"}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onChange(Math.max(1, (halves ?? 1) - 1));
        else if (event.key === "ArrowRight") onChange(Math.min(Rating.maxHalves, (halves ?? 0) + 1));
        else if (event.key === "Backspace" || event.key === "Delete") onChange(null);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <span
        class="stars"
        style={{ gap: `${spacing}px` }}
        onMouseMove={(event) => setHover(pick(event))}
        onMouseLeave={() => setHover(null)}
        onClick={(event) => {
          event.stopPropagation();
          const picked = pick(event);
          onChange(picked === halves ? null : picked);
        }}
      >
        {Array.from({ length: 10 }, (_, i) => (
          <RatingStar
            key={i}
            fill={starFill(i + 1, shown)}
            size={size}
            emptyOpacity={hover == null ? 1 : 0.8}
            lift={hover != null && Math.trunc((shown + 1) / 2) === i + 1}
          />
        ))}
      </span>
      {showsValue && (
        <span
          class={`value${shown > 0 ? " gold-text" : ""}`}
          style={{ fontSize: `${size * 0.95}px`, minWidth: `${size * 1.9}px`, color: shown > 0 ? undefined : "var(--ink3)" }}
        >
          {shown > 0 ? Rating.text(shown) : "–"}
        </span>
      )}
    </span>
  );
}

/** A small gold badge with the rating, for poster corners and rows. */
export function RatingBadge({ halves, compact = false }: { halves: number; compact?: boolean }) {
  return (
    <span class={`rating-badge${compact ? " compact" : ""}`} aria-label={`Rated ${Rating.text(halves)} out of 10`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id="badge-gold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="rgb(255,219,128)" />
            <stop offset="1" stop-color="rgb(237,168,56)" />
          </linearGradient>
        </defs>
        <path d={starPath} fill="url(#badge-gold)" />
      </svg>
      {Rating.text(halves)}
    </span>
  );
}

// MARK: Pixel pet

function devicePixelRatioNow(): number {
  return typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
}

/**
 * PixelPetView: core/profile's PetCanvas at device pixels, redrawn every 100 ms only when the pose
 * changes; still (the resting frame) when not animated or with reduced motion.
 */
export function PetView({
  pet,
  size,
  animated = true,
  framing = "automatic",
}: {
  pet: PixelPet;
  size: number;
  animated?: boolean;
  framing?: PetFraming;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduceMotion = useReducedMotion();
  const [scale, setScale] = useState(devicePixelRatioNow);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(`(resolution: ${scale}dppx)`);
    const listener = () => setScale(devicePixelRatioNow());
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, [scale]);

  useEffect(() => {
    const element = canvas.current;
    if (!element || !element.getContext) return;
    let last: PetFrame | null = null;
    const draw = () => {
      const frame = PetCanvas.frameFor(pet, size, { framing, animated, reduceMotion });
      if (last && PetFrame.equals(frame, last)) return;
      last = frame;
      try {
        PetCanvas.draw(element, pet, frame, size, scale, framing);
      } catch {
        // A canvas without a 2D context (tests) draws nothing.
      }
    };
    draw();
    if (!animated || reduceMotion) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") draw();
    }, PetCanvas.frameInterval);
    return () => clearInterval(timer);
  }, [pet.code, size, animated, framing, reduceMotion, scale]);

  return (
    <canvas
      ref={canvas}
      class="pet-canvas"
      role="img"
      aria-label={pet.accessibilityDescription}
      style={{ width: `${size}px`, height: `${size}px` }}
    />
  );
}

// MARK: People

/** Someone as their initial, in silver when it's you (Avatar). */
export function Avatar({ name, isMe = false, size = 26 }: { name: string; isMe?: boolean; size?: number }) {
  const initial = [...name][0]?.toUpperCase() ?? "?";
  return (
    <span
      class="avatar"
      aria-label={name}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${size * 0.46}px`,
        color: isMe ? "var(--on-silver)" : "var(--ink)",
        background: isMe ? "var(--silver)" : "var(--raised2)",
        boxShadow: "inset 0 0 0 2px var(--card)",
      }}
    >
      {initial}
    </span>
  );
}

/** Someone as their pixel pet when they share one, otherwise their initial (PersonAvatar). */
export function PersonAvatar({ name, petCode, isMe = false, size = 26 }: { name: string; petCode: string | null | undefined; isMe?: boolean; size?: number }) {
  const pet = useMemo(() => (petCode ? PixelPet.fromCode(petCode) : null), [petCode]);
  if (!pet) return <Avatar name={name} isMe={isMe} size={size} />;
  return (
    <span
      class="avatar"
      aria-label={name}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        background: isMe ? "color-mix(in srgb, var(--silver-top) 35%, transparent)" : "var(--raised2)",
        boxShadow: isMe ? "inset 0 0 0 1.5px var(--silver-bottom)" : "inset 0 0 0 1px var(--line)",
      }}
    >
      <PetView pet={pet} size={size * 0.86} animated={false} />
    </span>
  );
}

/** A profile's initial on silver (ProfileAvatar). */
export function ProfileAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const initial = [...name][0]?.toUpperCase() ?? "?";
  return (
    <span
      class="avatar"
      aria-hidden="true"
      style={{ width: `${size}px`, height: `${size}px`, background: "var(--silver)", color: "var(--on-silver)", fontSize: `${size * 0.48}px` }}
    >
      {initial}
    </span>
  );
}

/** "Film", "Series"… */
export function kindLabel(title: Pick<Title, "kind">): string {
  return TitleKind.label(title.kind);
}

export { Icon };
