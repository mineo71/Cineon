// Port of windows/Cineon.Core/Downloads/MediaUrls.cs: how media.js reads the files a player asks
// for, for code that sees those requests itself (webRequest in the background). The shared page
// script does the same, so both agree.

import { type MediaSourceKind } from "../data";

const HLS_SUFFIX = /\.mp4:hls:/i;
const SEGMENT = /(?:^|[/_.-])(?:seg|segment|chunk|frag|fragment|part)[-_]?\d+\.(?:mp4|m4s)(?=[?#]|$)/i;
const SUBTITLE = /\.(?:vtt|srt)(?=[?#]|$)/i;
const PLAYLIST = /\.m3u8(?=[?#]|$)/i;
const VIDEO = /\.(?:mp4|m4v|webm|mov)(?=[?#]|$)/i;

export const MediaUrls = {
  /**
   * HDRezka's player asks for `file.mp4:hls:seg-1-v1-a1.ts`. Cutting `:hls:…` leaves the whole
   * film, `file.mp4`, with any query kept.
   */
  progressive(url: string): string {
    const at = url.search(HLS_SUFFIX);
    if (at === -1) return url;
    const rest = url.slice(at + 4);
    const query = rest.search(/[?#]/);
    return url.slice(0, at + 4) + (query === -1 ? "" : rest.slice(query));
  },

  /** What kind of file an address is, or null for anything that isn't a film, playlist or subtitles. */
  kindOf(url: string): MediaSourceKind | null {
    if (SUBTITLE.test(url)) return "subtitle";
    if (PLAYLIST.test(url)) return "hls";
    if (VIDEO.test(url) && !SEGMENT.test(url)) return "file";
    return null;
  },
};
