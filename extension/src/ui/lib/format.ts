// Text the screens share: Theme.swift's DateText, EpisodeRef labels, ByteCountFormatter's `.file`
// style, and small helpers. Pure, so they're tested on Node (test/ui/format.test.ts).
//
// Dates: the data layer keeps seconds since 1970 (`UnixTime`); these take seconds too unless named
// otherwise (`fromMs`).

import type { EpisodeRef, WatchProgress, WatchSession } from "../../core/data";

const DAY = 86_400;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Days between two local calendar days (b − a). */
function dayDifference(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / (DAY * 1000));
}

export const DateText = {
  /** "Today", "Yesterday", "Thursday 6 November", or with the year when it isn't this year. */
  day(seconds: number, now: Date = new Date(), locale?: string): string {
    const date = new Date(seconds * 1000);
    const diff = dayDifference(date, now);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    const sameYear = date.getFullYear() === now.getFullYear();
    return new Intl.DateTimeFormat(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(date);
  },

  /** The time, short: "21:40" or "9:40 PM", as the browser's locale writes it. */
  time(seconds: number, locale?: string): string {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(seconds * 1000));
  },

  /** RelativeDateTimeFormatter, `.full`: "3 hours ago", "in 2 days", "2 weeks ago". */
  relative(seconds: number, now: Date = new Date(), locale?: string): string {
    return relativeText(seconds - now.getTime() / 1000, locale, "always");
  },

  /** `.relative(presentation: .named)`: "yesterday", "now", "5 minutes ago". */
  relativeNamed(seconds: number, now: Date = new Date(), locale?: string): string {
    return relativeText(seconds - now.getTime() / 1000, locale, "auto");
  },

  fromMs(ms: number): number {
    return ms / 1000;
  },
};

function relativeText(delta: number, locale: string | undefined, numeric: "always" | "auto"): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric, style: "long" });
  const abs = Math.abs(delta);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * DAY],
    ["month", 30 * DAY],
    ["week", 7 * DAY],
    ["day", DAY],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (abs >= size) return format.format(Math.trunc(delta / size), unit);
  }
  return format.format(Math.trunc(delta), "second");
}

/** Swift's `EpisodeRef.shortLabel` / `longLabel`. */
export const RefText = {
  short(ref: EpisodeRef): string {
    return `S${ref.season} E${ref.episode}`;
  },
  long(ref: EpisodeRef): string {
    return `Season ${ref.season}, episode ${ref.episode}`;
  },
};

/** From an imported history: the page was opened, how far you got isn't known. */
export function isVisitOnly(item: Pick<WatchProgress, "duration"> | Pick<WatchSession, "duration">): boolean {
  return item.duration === 0;
}

/**
 * ByteCountFormatter with `.file`: decimal units, "Zero KB", whole numbers for bytes and KB,
 * one decimal from MB up ("1.2 GB", "345 KB", "12 bytes").
 */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Zero KB";
  if (bytes < 1000) return `${Math.round(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} KB`;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} ${units[unit]}`;
}

/** `count.formatted()`: grouped digits in the browser's locale. */
export function grouped(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

/** "1 film" / "3 films". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `String(format: "%.1f", x)`. */
export function oneDecimal(x: number): string {
  return x.toFixed(1);
}

/** StatTiles.hours: whole hours. */
export function hoursText(value: number): string {
  return String(Math.round(value));
}

/** `Int(fraction * 100)`. */
export function percent(fraction: number): number {
  return Math.trunc(fraction * 100);
}

/** The text after the scheme and `www.`, as the Mac shows a host. */
export function bareHost(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** A URL's host, or null when it has none. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/** `CommandBar.directURL(from:)`: addresses typed without a scheme, like "site.to/film". */
export function directUrl(text: string): string | null {
  if (text.includes(" ")) return null;
  if (text.startsWith("http://") || text.startsWith("https://")) return validUrl(text);
  if (text.startsWith("localhost") || text.startsWith("127.0.0.1")) return validUrl(`http://${text}`);
  const hostPart = text.split("/").find((part) => part.length > 0) ?? text;
  const labels = hostPart.split(".").filter((label) => label.length > 0);
  const last = labels[labels.length - 1];
  if (labels.length < 2 || last == null || [...last].length < 2 || !/^\p{L}+$/u.test(last)) return null;
  return validUrl(`https://${text}`);
}

function validUrl(text: string): string | null {
  try {
    new URL(text);
    return text;
  } catch {
    return null;
  }
}

/** "1:02:03" or "42:10" (Timecode.string), re-exported for screens that only need text. */
export { Timecode } from "../../core/data";
