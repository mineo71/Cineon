// Port of windows/Cineon.Core/Downloads/HlsPlaylist.cs. The Mac hands playlists to AVFoundation,
// which saves .movpkg packages; the browser has nothing like it, so Cineon reads the playlists
// itself (RFC 8216) and writes one file, as the Windows port does.

import { Urls } from "../data";

/** One quality of a stream, from a master playlist's `#EXT-X-STREAM-INF`. */
export interface HlsVariant {
  readonly url: string;
  readonly bandwidth: number;
  /** "1920x1080", when the playlist says. */
  readonly resolution: string | null;
  readonly codecs: string | null;
  /** The `AUDIO` group whose renditions carry its sound, when that's kept apart. */
  readonly audioGroup: string | null;
}

export const HlsVariant = {
  /** The picture's height, 1080 for "1920x1080", or 0. */
  height(variant: HlsVariant): number {
    const parts = variant.resolution?.split("x");
    if (parts?.length !== 2 || !/^\d+$/.test(parts[1]!)) return 0;
    const height = Number(parts[1]);
    return height <= 2_147_483_647 ? height : 0;
  },
};

/** A master playlist: the qualities on offer. */
export interface HlsMaster {
  readonly variants: readonly HlsVariant[];
  /** Audio groups that have at least one rendition in its own playlist. */
  readonly separateAudioGroups: readonly string[];
}

export const HlsMaster = {
  /**
   * The quality the Mac would save. AVFoundation's download task takes the highest bitrate when
   * it isn't told otherwise, so this does too. Variants with their sound in the same segments come
   * first, because sound kept apart would need merging into the file.
   */
  best(master: HlsMaster): HlsVariant | null {
    const muxed = master.variants.filter((v) => !HlsMaster.needsSeparateAudio(master, v));
    const pool = muxed.length > 0 ? muxed : master.variants;
    let best: HlsVariant | null = null;
    for (const variant of pool) {
      if (
        best == null ||
        variant.bandwidth > best.bandwidth ||
        (variant.bandwidth === best.bandwidth && HlsVariant.height(variant) > HlsVariant.height(best))
      ) {
        best = variant;
      }
    }
    return best;
  },

  needsSeparateAudio(master: HlsMaster, variant: HlsVariant): boolean {
    return variant.audioGroup != null && master.separateAudioGroups.includes(variant.audioGroup);
  },
};

/** How a run of segments is encrypted. */
export interface HlsKey {
  /** `AES-128`, `SAMPLE-AES`… (never `NONE`: that's no key). */
  readonly method: string;
  readonly url: string | null;
  /** 16 bytes, or null to use the segment's sequence number. */
  readonly iv: Uint8Array | null;
  readonly keyFormat: string | null;
}

export const HlsKey = {
  isAes128(key: HlsKey): boolean {
    return key.method === "AES-128";
  },
};

/** A byte range within a resource: `#EXT-X-BYTERANGE:length@offset`. */
export interface HlsByteRange {
  readonly length: number;
  /** -1 while parsing means "straight after the previous range"; resolved in segments. */
  readonly offset: number;
}

/** The initialisation section fragmented-MP4 segments need: `#EXT-X-MAP`. */
export interface HlsMap {
  readonly url: string;
  readonly range: HlsByteRange | null;
  readonly key: HlsKey | null;
}

export const HlsMap = {
  /** Value identity, as C#'s record equality: the same section written twice is one section. */
  identity(map: HlsMap): string {
    const range = map.range ? `@${map.range.offset}+${map.range.length}` : "";
    const key = map.key ? `|${map.key.method}|${map.key.url ?? ""}|${map.key.iv ? hex(map.key.iv) : ""}` : "";
    return map.url + range + key;
  },
};

export interface HlsSegment {
  readonly url: string;
  readonly duration: number;
  readonly sequence: number;
  readonly key: HlsKey | null;
  readonly range: HlsByteRange | null;
  readonly map: HlsMap | null;
}

/** A media playlist: the segments of one quality, in order. */
export interface HlsMediaPlaylist {
  readonly segments: readonly HlsSegment[];
  readonly endList: boolean;
  readonly targetDuration: number;
}

export const HlsMediaPlaylist = {
  totalDuration(playlist: HlsMediaPlaylist): number {
    return playlist.segments.reduce((sum, s) => sum + s.duration, 0);
  },

  /** Fragmented MP4 rather than MPEG-TS: the segments share an initialisation section. */
  isFragmentedMp4(playlist: HlsMediaPlaylist): boolean {
    return playlist.segments.some((s) => s.map != null);
  },
};

const STREAM_INF = "#EXT-X-STREAM-INF:";
const MEDIA = "#EXT-X-MEDIA:";
const MEDIA_SEQUENCE = "#EXT-X-MEDIA-SEQUENCE:";
const TARGET_DURATION = "#EXT-X-TARGETDURATION:";
const EXTINF = "#EXTINF:";
const BYTERANGE = "#EXT-X-BYTERANGE:";
const KEY = "#EXT-X-KEY:";
const MAP = "#EXT-X-MAP:";

export const HlsPlaylist = {
  isPlaylist(text: string): boolean {
    return text.replace(/^[﻿ \t\r\n]+/, "").startsWith("#EXTM3U");
  },

  isMaster(text: string): boolean {
    return text.includes("#EXT-X-STREAM-INF");
  },

  parseMaster(text: string, baseUrl: string): HlsMaster {
    const variants: HlsVariant[] = [];
    const separateAudio = new Set<string>();
    let pending: Record<string, string | undefined> | null = null;
    for (const line of lines(text)) {
      if (line.startsWith(STREAM_INF)) {
        pending = HlsPlaylist.attributes(line.slice(STREAM_INF.length));
      } else if (line.startsWith(MEDIA)) {
        const media = HlsPlaylist.attributes(line.slice(MEDIA.length));
        const group = media["GROUP-ID"];
        if (media.TYPE === "AUDIO" && media.URI !== undefined && group !== undefined) separateAudio.add(group);
      } else if (line.startsWith("#")) {
        continue;
      } else if (pending != null) {
        const url = HlsPlaylist.resolve(baseUrl, line);
        if (url != null) {
          variants.push({
            url,
            bandwidth: digits(pending.BANDWIDTH) ?? 0,
            resolution: pending.RESOLUTION ?? null,
            codecs: pending.CODECS ?? null,
            audioGroup: pending.AUDIO ?? null,
          });
        }
        pending = null;
      }
    }
    return { variants, separateAudioGroups: [...separateAudio] };
  },

  parseMedia(text: string, baseUrl: string): HlsMediaPlaylist {
    const segments: HlsSegment[] = [];
    let sequence = 0;
    let targetDuration = 0;
    let endList = false;
    let duration: number | null = null;
    let range: HlsByteRange | null = null;
    let key: HlsKey | null = null;
    let map: HlsMap | null = null;
    // Where the last ranged segment of each resource ended, for ranges with no offset.
    const rangeEnds = new Map<string, number>();

    for (const line of lines(text)) {
      if (line.startsWith(MEDIA_SEQUENCE)) {
        sequence = digits(line.slice(MEDIA_SEQUENCE.length)) ?? 0;
      } else if (line.startsWith(TARGET_DURATION)) {
        targetDuration = float(line.slice(TARGET_DURATION.length)) ?? 0;
      } else if (line.startsWith(EXTINF)) {
        let value = line.slice(EXTINF.length);
        const comma = value.indexOf(",");
        if (comma >= 0) value = value.slice(0, comma);
        duration = float(value) ?? 0;
      } else if (line.startsWith(BYTERANGE)) {
        range = parseRange(line.slice(BYTERANGE.length));
      } else if (line.startsWith(KEY)) {
        const attributes = HlsPlaylist.attributes(line.slice(KEY.length));
        const format = attributes.KEYFORMAT ?? null;
        // Several keys can stand side by side for different DRM systems. Only the plain one counts.
        if (format != null && format !== "identity" && key != null) continue;
        const method = attributes.METHOD ?? "NONE";
        key =
          method === "NONE"
            ? null
            : {
                method,
                url: attributes.URI !== undefined ? HlsPlaylist.resolve(baseUrl, attributes.URI) : null,
                iv: attributes.IV !== undefined ? parseIv(attributes.IV) : null,
                keyFormat: format,
              };
      } else if (line.startsWith(MAP)) {
        const attributes = HlsPlaylist.attributes(line.slice(MAP.length));
        const url = attributes.URI !== undefined ? HlsPlaylist.resolve(baseUrl, attributes.URI) : null;
        map =
          url != null
            ? { url, range: attributes.BYTERANGE !== undefined ? parseRange(attributes.BYTERANGE) : null, key }
            : null;
      } else if (line.startsWith("#EXT-X-ENDLIST")) {
        endList = true;
      } else if (line.startsWith("#")) {
        continue;
      } else {
        const url = HlsPlaylist.resolve(baseUrl, line);
        if (url != null) {
          let segmentRange: HlsByteRange | null = null;
          if (range != null) {
            const offset = range.offset >= 0 ? range.offset : (rangeEnds.get(url) ?? 0);
            segmentRange = { length: range.length, offset };
            rangeEnds.set(url, offset + range.length);
          }
          segments.push({ url, duration: duration ?? 0, sequence, key, range: segmentRange, map });
        }
        sequence++;
        duration = null;
        range = null;
      }
    }
    return { segments, endList, targetDuration };
  },

  /** An attribute list: `KEY=VALUE,KEY="quoted, value"`. */
  attributes(text: string): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = Object.create(null);
    let i = 0;
    while (i < text.length) {
      while (i < text.length && (text[i] === "," || text[i] === " ")) i++;
      const eq = text.indexOf("=", i);
      if (eq < 0) break;
      const name = text.slice(i, eq).trim();
      i = eq + 1;
      let value: string;
      if (i < text.length && text[i] === '"') {
        let close = text.indexOf('"', i + 1);
        if (close < 0) close = text.length;
        value = text.slice(i + 1, close);
        i = close + 1;
      } else {
        let comma = text.indexOf(",", i);
        if (comma < 0) comma = text.length;
        value = text.slice(i, comma).trim();
        i = comma;
      }
      result[name] = value;
    }
    return result;
  },

  /**
   * A playlist line made into an address. Relative paths whose first part holds a colon, like
   * HDRezka's `1080.mp4:hls:seg-1.ts`, are paths, not schemes.
   */
  resolve(baseUrl: string, reference: string): string | null {
    if (/^https?:\/\//i.test(reference)) return Urls.parse(reference);
    if (reference.startsWith("//")) {
      const scheme = schemeOf(baseUrl);
      return scheme == null ? null : Urls.parse(scheme + ":" + reference);
    }
    if (/^(?:data|skd):/i.test(reference)) return Urls.parse(reference);
    const firstSlash = reference.search(/[/?#]/);
    const first = firstSlash < 0 ? reference : reference.slice(0, firstSlash);
    if (first.includes(":")) reference = "./" + reference;
    try {
      return new URL(reference, baseUrl).href;
    } catch {
      return null;
    }
  },
};

function lines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol.slice(0, -1);
  } catch {
    return null;
  }
}

/** C#'s `long.TryParse(text, NumberStyles.None)`: digits only. */
function digits(text: string | undefined): number | null {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
}

/** C#'s `double.TryParse(text, NumberStyles.Float, InvariantCulture)`. */
function float(text: string): number | null {
  const t = text.trim();
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(t) ? Number(t) : null;
}

/** `length[@offset]`. An offset of -1 means "straight after the previous range". */
function parseRange(text: string): HlsByteRange | null {
  const parts = text.replace(/^"+|"+$/g, "").split("@");
  const length = digits(parts[0]);
  if (length == null) return null;
  const offset = parts.length > 1 ? (digits(parts[1]) ?? -1) : -1;
  return { length, offset };
}

function parseIv(text: string): Uint8Array | null {
  const raw = /^0x/i.test(text) ? text.slice(2) : text;
  if (raw.length === 0 || raw.length > 32 || !/^[0-9a-f]+$/i.test(raw)) return null;
  const padded = raw.padStart(32, "0");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
