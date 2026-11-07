// Downloads: the queue, direct files through chrome.downloads, HLS streams through OPFS, season and
// series jobs, subtitles. See notes/downloads.md.

export { DownloadCenter, type DownloadCenterOptions, type NewDownload, type PickedFile } from "./downloadCenter";
export {
  SeasonGrabber,
  type SeasonGrabberOptions,
  SeasonJob,
  SeasonProposal,
  type SeasonScope,
} from "./seasonGrabber";
export {
  type DownloadHost,
  type DownloadTab,
  type EpisodeHelperTab,
  type EpisodeResolver,
  type PageMethod,
  type PageTitle,
  type PublishedEpisode,
} from "./types";
export {
  type BrowserDownloadDelta,
  type BrowserDownloadItem,
  type BrowserDownloadOptions,
  type BrowserDownloadQuery,
  type BrowserDownloads,
  type BrowserDownloadState,
  chromeDownloads,
  type DnrApi,
  DnrHeaderRules,
  type DnrRule,
  type HeaderRules,
  type HeaderTarget,
  hostOf,
  ObjectUrls,
  type PageHeaders,
  pageHeaders,
} from "./browser";
export {
  type StreamEvent,
  type StreamHandler,
  StreamHost,
  type StreamHostOptions,
  type StreamJob,
  type StreamJobState,
  type StreamWorker,
} from "./stream";
export { type OpfsDirectory, type OpfsFile, type OpfsWritable, PartFolder, PartStore } from "./partStore";
export { HlsDownloader, type HlsDownloadOptions, type HlsOutcome, sleep } from "./hlsDownloader";
export {
  type HlsByteRange,
  HlsKey,
  HlsMap,
  HlsMaster,
  HlsMediaPlaylist,
  HlsPlaylist,
  type HlsSegment,
  HlsVariant,
} from "./hlsPlaylist";
export { DownloadHttp, type FetchLike } from "./http";
export {
  DownloadErrors,
  DownloadFailedError,
  DownloadHttpError,
  DownloadNetworkError,
  DownloadStoppedError,
  DownloadTimeoutError,
} from "./errors";
export { MediaUrls } from "./mediaUrls";
export { type SubtitleCue, SubtitleTrack } from "./subtitles";
export { DownloadText } from "./text";
