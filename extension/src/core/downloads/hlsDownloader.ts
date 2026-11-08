// Port of windows/Cineon.Core/Downloads/HlsDownloader.cs.
//
// Saves an HLS stream as one file: the quality the Mac would pick, its segments fetched a few at a
// time, AES-128 decrypted with WebCrypto, and joined in order. MPEG-TS segments make a `.ts` file,
// fragmented-MP4 segments an `.mp4`. Segments already saved in the staging folder (OPFS) are kept,
// so a download that failed, was stopped, or was cut off by the browser closing carries on where
// it was. Once joined, the segments go and `output.json` marks the output as whole, so handing it
// to the browser's downloads can be tried again without the network.

import { DownloadErrors, DownloadFailedError, DownloadStoppedError } from "./errors";
import { type DownloadHttp } from "./http";
import {
  HlsKey,
  HlsMap,
  HlsMaster,
  HlsMediaPlaylist,
  HlsPlaylist,
  type HlsSegment,
} from "./hlsPlaylist";
import { type PartFolder } from "./partStore";

/** What a finished stream download left behind in its staging folder. */
export interface HlsOutcome {
  /** The joined file's name in the staging folder. */
  readonly file: string;
  /** `ts` or `mp4` for a stream; a plain file's own (mp4, m4v, mov, webm, mkv). */
  readonly extension: string;
  /** Seconds, from the playlist (0 for a plain file). */
  readonly duration: number;
  readonly size: number;
}

export interface HlsDownloadOptions {
  /** 0 to 1, in order, as segments arrive (weighted by their duration). */
  progress?: (fraction: number) => void;
  signal?: AbortSignal;
  /**
   * Called with the addresses about to be fetched (the variant, then every segment, key and map),
   * before any request goes to them, so the page's Referer and Origin can be set up for their hosts.
   */
  prepare?: (urls: string[]) => Promise<void>;
}

const FINGERPRINT_FILE = "segments.txt";
const OUTPUT_FILE = "output.part";
const DONE_FILE = "output.json";

const segmentFile = (index: number) => `seg-${String(index).padStart(6, "0")}`;
const mapFile = (index: number) => `map-${String(index).padStart(3, "0")}`;

export class HlsDownloader {
  /** Segments fetched at the same time. */
  parallel = 4;
  /** Tries per segment before the download fails. */
  attempts = 4;
  /** Milliseconds before the first retry, doubled for each one after. */
  retryDelay = 1000;
  /** Bytes per request for a plain file. */
  fileChunk = 8 * 1024 * 1024;

  static readonly outputFile = OUTPUT_FILE;

  constructor(
    private readonly http: DownloadHttp,
    private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
  ) {}

  async download(url: string, staging: PartFolder, options: HlsDownloadOptions = {}): Promise<HlsOutcome> {
    const { progress, signal, prepare } = options;

    // Joined last time, and only the hand-off failed: nothing to fetch.
    const finished = await readDone(staging);
    if (finished != null) {
      progress?.(1);
      return finished;
    }

    await prepare?.([url]);
    let text = await this.getText(url, signal);
    if (!HlsPlaylist.isPlaylist(text)) throw new DownloadFailedError(DownloadErrors.protected);
    let mediaUrl = url;
    if (HlsPlaylist.isMaster(text)) {
      const master = HlsPlaylist.parseMaster(text, url);
      const variant = HlsMaster.best(master);
      if (variant == null) throw new DownloadFailedError(DownloadErrors.protected);
      if (HlsMaster.needsSeparateAudio(master, variant)) throw new DownloadFailedError(DownloadErrors.separateAudio);
      mediaUrl = variant.url;
      await prepare?.([mediaUrl]);
      text = await this.getText(mediaUrl, signal);
      if (!HlsPlaylist.isPlaylist(text) || HlsPlaylist.isMaster(text)) {
        throw new DownloadFailedError(DownloadErrors.protected);
      }
    }
    const playlist = HlsPlaylist.parseMedia(text, mediaUrl);
    const segments = playlist.segments;
    if (segments.length === 0) throw new DownloadFailedError(DownloadErrors.protected);
    // SAMPLE-AES and the DRM systems need a licence; only plain AES-128 can be undone here.
    if (segments.some((s) => (s.key != null && !HlsKey.isAes128(s.key)) || (s.map?.key != null && !HlsKey.isAes128(s.map.key)))) {
      throw new DownloadFailedError(DownloadErrors.protected);
    }
    await prepare?.(addressesOf(segments));
    const extension = HlsMediaPlaylist.isFragmentedMp4(playlist) ? "mp4" : "ts";
    return this.fetchAndJoin(segments, staging, options, extension, HlsMediaPlaylist.totalDuration(playlist));
  }

  /**
   * A plain file (a progressive MP4, WebM…), fetched by the extension the way a stream is: in byte
   * ranges a few at a time, kept in the staging folder so a retry carries on, then joined. Chrome's own
   * downloads can't carry the page's Referer, which some sites insist on. A server that ignores Range
   * gets one request for the whole file.
   */
  async downloadFile(url: string, extension: string, staging: PartFolder, options: HlsDownloadOptions = {}): Promise<HlsOutcome> {
    const { progress, signal, prepare } = options;
    const finished = await readDone(staging);
    if (finished != null) {
      progress?.(1);
      return finished;
    }
    await prepare?.([url]);
    const { size, ranges } = await this.withRetries(() => this.http.probe(url, signal), signal);
    const segments: HlsSegment[] = [];
    if (ranges && size != null && size > 0) {
      for (let offset = 0, i = 0; offset < size; offset += this.fileChunk, i++) {
        segments.push({ url, duration: 0, sequence: i, key: null, map: null, range: { offset, length: Math.min(this.fileChunk, size - offset) } });
      }
    } else {
      segments.push({ url, duration: 0, sequence: 0, key: null, map: null, range: null });
    }
    return this.fetchAndJoin(segments, staging, options, extension, 0);
  }

  /** Fetches what isn't in the staging folder yet, joins it all in order, and marks it whole. */
  private async fetchAndJoin(
    segments: readonly HlsSegment[],
    staging: PartFolder,
    options: HlsDownloadOptions,
    extension: string,
    total: number,
  ): Promise<HlsOutcome> {
    const { progress, signal } = options;
    await keepOnlyIfSameStream(staging, segments);

    const keys = new Map<string, Promise<CryptoKey>>();
    const keyFor = (key: HlsKey): Promise<CryptoKey> => {
      const id = key.url ?? "";
      let task = keys.get(id);
      if (task == null) {
        task = this.fetchKey(key, signal);
        // A failed key is asked for again by the next segment that needs it.
        task.catch(() => keys.delete(id));
        keys.set(id, task);
      }
      return task;
    };

    const weight = (s: HlsSegment) => (total > 0 ? s.duration : 1);
    const whole = total > 0 ? total : segments.length;
    let done = 0;
    const have = new Set<number>();
    for (let i = 0; i < segments.length; i++) {
      if (await staging.has(segmentFile(i))) {
        have.add(i);
        done += weight(segments[i]!);
      }
    }
    progress?.(Math.min(1, done / whole));

    // Initialisation sections, one file per distinct section, in the order they're first used.
    const maps: HlsMap[] = [];
    const mapIndex = new Map<string, number>();
    for (const segment of segments) {
      if (segment.map == null) continue;
      const id = HlsMap.identity(segment.map);
      if (!mapIndex.has(id)) {
        mapIndex.set(id, maps.length);
        maps.push(segment.map);
      }
    }
    for (let m = 0; m < maps.length; m++) {
      const map = maps[m]!;
      if (await staging.has(mapFile(m))) continue;
      let bytes = await this.withRetries(() => this.http.getBytes(map.url, map.range, signal), signal);
      if (map.key != null) {
        bytes = await this.decrypt(bytes, await keyFor(map.key), map.key.iv ?? HlsDownloader.sequenceIv(segments[0]!.sequence));
      }
      await staging.write(mapFile(m), bytes);
    }

    // A few at a time. When a segment fails for good, no new ones start, but the ones already on
    // their way finish and are kept (only the person stopping it cuts them off), so a retry asks
    // only for what's missing.
    let next = 0;
    let failure: { error: unknown } | null = null;
    const worker = async () => {
      while (failure == null && !signal?.aborted) {
        const index = next++;
        if (index >= segments.length) return;
        if (have.has(index)) continue;
        const segment = segments[index]!;
        try {
          let bytes = await this.withRetries(() => this.http.getBytes(segment.url, segment.range, signal), signal);
          if (segment.key != null) {
            bytes = await this.decrypt(bytes, await keyFor(segment.key), segment.key.iv ?? HlsDownloader.sequenceIv(segment.sequence));
          }
          await staging.write(segmentFile(index), bytes);
        } catch (error) {
          failure ??= { error };
          return;
        }
        done += weight(segment);
        progress?.(Math.min(1, done / whole));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.parallel, segments.length)) }, worker));
    if (signal?.aborted) throw new DownloadStoppedError();
    if (failure != null) throw (failure as { error: unknown }).error;

    // One file, in order. A changed initialisation section goes in where it changes.
    const order: string[] = [];
    let current: string | null = null;
    for (let i = 0; i < segments.length; i++) {
      const map = segments[i]!.map;
      if (map != null && HlsMap.identity(map) !== current) {
        current = HlsMap.identity(map);
        order.push(mapFile(mapIndex.get(current)!));
      }
      order.push(segmentFile(i));
    }
    const size = await staging.join(OUTPUT_FILE, order, signal);
    const outcome: HlsOutcome = {
      file: OUTPUT_FILE,
      extension,
      duration: total,
      size,
    };
    await staging.write(DONE_FILE, JSON.stringify(outcome));
    for (const name of order) await staging.remove(name).catch(() => {});
    return outcome;
  }

  private async getText(url: string, signal?: AbortSignal): Promise<string> {
    const bytes = await this.withRetries(() => this.http.getBytes(url, null, signal), signal);
    return new TextDecoder().decode(bytes);
  }

  private async fetchKey(key: HlsKey, signal?: AbortSignal): Promise<CryptoKey> {
    const url = key.url;
    if (url == null) throw new DownloadFailedError(DownloadErrors.protected);
    const bytes = await this.withRetries(() => this.http.getBytes(url, null, signal), signal);
    if (bytes.length !== 16) throw new DownloadFailedError(DownloadErrors.protected);
    return this.subtle.importKey("raw", bytes as Uint8Array<ArrayBuffer>, { name: "AES-CBC" }, false, ["decrypt"]);
  }

  private async decrypt(data: Uint8Array, key: CryptoKey, iv: Uint8Array): Promise<Uint8Array> {
    try {
      const plain = await this.subtle.decrypt(
        { name: "AES-CBC", iv: iv as Uint8Array<ArrayBuffer> },
        key,
        data as Uint8Array<ArrayBuffer>,
      );
      return new Uint8Array(plain);
    } catch {
      throw new DownloadFailedError(DownloadErrors.protected);
    }
  }

  private async withRetries<T>(body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let delay = this.retryDelay;
    for (let attempt = 1; ; attempt++) {
      try {
        return await body();
      } catch (error) {
        if (attempt >= this.attempts || signal?.aborted || !DownloadErrors.isTransient(error)) throw error;
        await sleep(delay, signal);
        delay *= 2;
      }
    }
  }

  /** Without its own IV, a segment's IV is its sequence number, big-endian in 16 bytes. */
  static sequenceIv(sequence: number): Uint8Array {
    const iv = new Uint8Array(16);
    let rest = sequence;
    for (let i = 15; i >= 8; i--) {
      iv[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
    return iv;
  }
}

/** Segments saved earlier only count if they're from the same stream, cut the same way. */
async function keepOnlyIfSameStream(staging: PartFolder, segments: readonly HlsSegment[]): Promise<void> {
  let text = `${segments.length}\n`;
  for (const segment of segments) {
    // Query strings carry tokens that change each time the page is opened.
    const query = segment.url.search(/[?#]/);
    text += query < 0 ? segment.url : segment.url.slice(0, query);
    if (segment.range != null) text += `@${segment.range.offset}+${segment.range.length}`;
    text += "\n";
  }
  if ((await staging.readText(FINGERPRINT_FILE)) === text) return;
  for (const name of await staging.names()) await staging.remove(name);
  await staging.write(FINGERPRINT_FILE, text);
}

async function readDone(staging: PartFolder): Promise<HlsOutcome | null> {
  const text = await staging.readText(DONE_FILE);
  if (text == null) return null;
  try {
    const done = JSON.parse(text) as HlsOutcome;
    if (typeof done.extension !== "string" || !/^[a-z0-9]{1,5}$/.test(done.extension) || typeof done.size !== "number") return null;
    return (await staging.size(OUTPUT_FILE)) === done.size ? done : null;
  } catch {
    return null;
  }
}

/** Every distinct address the segments need, in order. */
function addressesOf(segments: readonly HlsSegment[]): string[] {
  const seen = new Set<string>();
  for (const s of segments) {
    seen.add(s.url);
    if (s.key?.url != null) seen.add(s.key.url);
    if (s.map != null) {
      seen.add(s.map.url);
      if (s.map.key?.url != null) seen.add(s.map.key.url);
    }
  }
  return [...seen];
}

/** Waits, or rejects with DownloadStoppedError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DownloadStoppedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DownloadStoppedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
