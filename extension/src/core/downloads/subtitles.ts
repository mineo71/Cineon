// Port of windows/Cineon.Core/Downloads/Subtitles.cs (Cineon/Downloads/Subtitles.swift).
// A subtitle file saved next to a download, WebVTT or SubRip.

export interface SubtitleCue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface SubtitleTrack {
  /** The file's path (or any name the caller keeps it by). */
  readonly id: string;
  readonly label: string;
  readonly cues: readonly SubtitleCue[];
}

const LANGUAGES: Readonly<Record<string, string>> = {
  en: "en", eng: "en", english: "en",
  uk: "uk", ua: "uk", ukr: "uk", ukrainian: "uk", "украинский": "uk", "українська": "uk",
  ru: "ru", rus: "ru", russian: "ru", "русский": "ru",
  de: "de", ger: "de", deu: "de", fr: "fr", fre: "fr", fra: "fr", es: "es", spa: "es",
  it: "it", ita: "it", pl: "pl", pol: "pl", pt: "pt", por: "pt", ja: "ja", jpn: "ja",
};

export const SubtitleTrack = {
  /**
   * A track from a file's bytes (the Mac's `load(path:)`: the extension can't read the disk, so the
   * caller hands the bytes). Null when there are no cues. "Film [1080p].en.vtt" is labelled by the
   * part before the extension.
   */
  fromData(path: string, data: Uint8Array | ArrayBuffer): SubtitleTrack | null {
    const cues = SubtitleTrack.parse(SubtitleTrack.decode(data));
    if (cues.length === 0) return null;
    const file = path.split(/[/\\]/).pop() ?? path;
    const dotExt = file.lastIndexOf(".");
    const stem = dotExt > 0 ? file.slice(0, dotExt) : file;
    const dot = stem.lastIndexOf(".");
    const code = dot > 0 && dot < stem.length - 1 ? stem.slice(dot + 1) : "";
    return { id: path, label: SubtitleTrack.displayName(code), cues };
  },

  /** UTF-8, or Windows-1251 when the bytes aren't valid UTF-8, like the Mac. */
  decode(data: Uint8Array | ArrayBuffer): string {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
    } catch {
      // Not UTF-8.
    }
    try {
      return new TextDecoder("windows-1251").decode(data);
    } catch {
      return "";
    }
  },

  parse(raw: string): SubtitleCue[] {
    const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const cues: SubtitleCue[] = [];
    for (const block of text.split("\n\n")) {
      const lines = block.split("\n");
      const timing = lines.findIndex((l) => l.includes("-->"));
      if (timing < 0) continue;
      const parts = lines[timing]!.split("-->");
      if (parts.length !== 2) continue;
      const start = SubtitleTrack.time(parts[0]!);
      const end = SubtitleTrack.time(trimSpaces(parts[1]!).split(" ")[0]!);
      if (start == null || end == null) continue;
      const body = lines
        .slice(timing + 1)
        .map(clean)
        .filter((l) => l.length > 0)
        .join("\n");
      if (body.length === 0 || end <= start) continue;
      cues.push({ start, end, text: body });
    }
    // A stable sort, as LINQ's OrderBy.
    return cues.map((cue, index) => ({ cue, index })).sort((a, b) => a.cue.start - b.cue.start || a.index - b.index).map((c) => c.cue);
  },

  /** What should be on screen at this moment, if anything. */
  text(track: SubtitleTrack, time: number): string | null {
    const cues = track.cues;
    let low = 0;
    let high = cues.length - 1;
    let found: number | null = null;
    // The last cue starting at or before now.
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid]!.start <= time) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found == null) return null;
    // Cues can overlap. Show every one that covers now, oldest first.
    const lines: string[] = [];
    for (let index = found; index >= 0 && index >= found - 4; index--) {
      const cue = cues[index]!;
      if (cue.start <= time && time < cue.end) lines.unshift(cue.text);
    }
    return lines.length === 0 ? null : lines.join("\n");
  },

  /** `00:01:02.345`, `01:02.345` or SubRip's `00:01:02,345`. */
  time(raw: string): number | null {
    const parts = trimSpaces(raw)
      .replaceAll(",", ".")
      .split(":")
      .filter((p) => p.length > 0);
    if (parts.length < 2 || parts.length > 3) return null;
    let seconds = 0;
    for (const part of parts) {
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(part)) return null;
      seconds = seconds * 60 + Number(part);
    }
    return seconds;
  },

  /** A short language code from a subtitle address, or "sub<n>" when there's none. */
  labelFor(url: string, index: number): string {
    let path: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "file:") return SubtitleTrack.labelForFile(decodePath(parsed.pathname), index);
      path = decodePath(parsed.pathname);
    } catch {
      path = url;
    }
    return labelFromComponents(path.split("/").filter((c) => c.length > 0), index);
  },

  /** `labelFor` for a file's name or path, such as one someone picked. */
  labelForFile(path: string, index: number): string {
    return labelFromComponents(path.split(/[/\\]/).filter((c) => c.length > 0), index);
  },

  /** "Subtitles 3" for a numbered track, otherwise the language's name: "English", "Ukrainian". */
  displayName(code: string, locale: string = defaultLocale()): string {
    if (code.startsWith("sub")) return "Subtitles " + code.slice(3);
    try {
      const name = new Intl.DisplayNames([locale], { type: "language", fallback: "code" }).of(code);
      if (name != null && name.length > 0 && name.toLowerCase() !== code.toLowerCase()) return titleCase(name, locale);
    } catch {
      // Not a language tag.
    }
    return code.toUpperCase();
  },
};

function labelFromComponents(components: string[], index: number): string {
  if (components.length > 0) {
    // The last two components, without the file's extension.
    const last = components[components.length - 1]!;
    const dot = last.lastIndexOf(".");
    if (dot > 0) components[components.length - 1] = last.slice(0, dot);
  }
  const words = components
    .slice(-2)
    .flatMap((component) => component.toLowerCase().split(/[^\p{L}\p{M}\p{N}]/u))
    .reverse();
  for (const word of words) {
    const code = Object.hasOwn(LANGUAGES, word) ? LANGUAGES[word] : undefined;
    if (code !== undefined) return code;
  }
  return `sub${index + 1}`;
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function trimSpaces(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

function clean(line: string): string {
  return trimSpaces(
    line
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]*\}/g, "")
      .replaceAll("&nbsp;", " ")
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">"),
  );
}

function titleCase(text: string, locale: string): string {
  return text.replace(/\p{L}[\p{L}\p{M}']*/gu, (word) => word.charAt(0).toLocaleUpperCase(locale) + word.slice(1));
}

function defaultLocale(): string {
  return (globalThis as { navigator?: { language?: string } }).navigator?.language ?? "en";
}
