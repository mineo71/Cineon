// The data layer: models, the per-profile IndexedDB database, the library store and queries,
// settings, profiles and the library export. See notes/data.md.

export { StoredDate, type UnixTime } from "./dates";
export { LibraryText } from "./libraryText";
export {
  AppTheme,
  CaptionStyle,
  DomainName,
  DownloadItem,
  DownloadStatus,
  EpisodeAlert,
  EpisodeRef,
  FilmFrame,
  type HistoryEntry,
  type LibraryEvent,
  LibraryEventKind,
  MediaSource,
  MediaSourceKind,
  Rating,
  SearchEngine,
  ShieldStats,
  Site,
  SitePrefs,
  SkipRule,
  SkipRuleKind,
  Timecode,
  Title,
  TitleKind,
  TitleStatus,
  UrlKey,
  Urls,
  VoiceBoostState,
  WatchProgress,
  WatchSession,
} from "./models";
export { AppSettings } from "./appSettings";
export { Database, SCHEMA_VERSION, Stores, type FrameData } from "./database";
export { type FrameFiles, IdbFrameFiles, MemoryFrameFiles } from "./frameFiles";
export { Emitter } from "./emitter";
export { findTitle, LibraryStore, type LibraryStoreKey, type NewTitle, type Restored } from "./libraryStore";
export { LibraryKind, LibraryList, LibraryQuery, LibrarySort, RatingFilter } from "./libraryQuery";
export {
  chromeStorage,
  type KeyValueStorage,
  MemoryStorage,
  type Profile,
  ProfileStore,
  type ProfileStoreKey,
  type ProfileStoreOptions,
  type StoredProfiles,
} from "./profileStore";
export {
  type ExportItem,
  type ExportPayload,
  type ExportSession,
  type ImportedLibrary,
  type ImportedSession,
  type ImportedTitle,
  type ImportResult,
  LibraryExport,
} from "./libraryExport";
export { swiftPrettyJson } from "./swiftJson";
export { isDatabaseError } from "./idb";
