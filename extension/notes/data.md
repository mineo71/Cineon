# Data layer (src/core/data)

Port of Core/Data (C# `windows/Cineon.Core/Data`, checked against Swift `Models.swift`,
`Database.swift`, `LibraryStore.swift`, `LibraryQuery.swift`, `ProfileStore.swift` and
`LibraryExport` in `SettingsView.swift`). Import everything from `src/core/data` (index.ts).
Tests: `test/data/*` (Vitest + fake-indexeddb), ported from `Cineon.Core.Tests/Data`.

## Conventions
- **Dates are numbers: seconds since 1970** (`UnixTime`), as the apps' databases keep them. Not
  milliseconds, not `Date`. `StoredDate.now()`, `toReference/fromReference` (Swift JSON, seconds
  since 2001), `iso8601` (JSONEncoder's: whole seconds cut, `Z`), `parseIso8601`.
  Exception kept from the apps: `MediaSource.foundAt` is milliseconds.
- **Addresses are strings**, exactly as written (Swift's `absoluteString`, C#'s `OriginalString`).
- **Optionals are `| null`**, never `undefined`, so records survive JSON and messaging.
- **Models are readonly interfaces**; change with spread (`{ ...title, name }`). Each has a
  same-named value with `make(partial)` (the C# record defaults) and the Swift computed
  properties as functions: `Title.rating(t)`, `WatchProgress.fraction(p)`, `DownloadItem.fileBaseName(d)`.
- **Enums are unions of the apps' raw strings** (`"film" | "series" | ...`), with a same-named
  value: `allCases`, `fromRaw(raw) → T | null`, and `label`/`note`/`css` where the apps have them.
- Field names are the C# names in camelCase: `titleId`, `imdbId`, `posterUrl`, `ref: EpisodeRef`.
- UUIDs are upper-case strings, as the apps write them.

## API
Models (`models.ts`): `Title`, `TitleKind`, `TitleStatus`, `Rating` (`maxHalves`, `text`, `clamp`),
`EpisodeRef` (`none`, `make`, `isEpisode`, `equals`), `EpisodeAlert`, `WatchProgress`,
`WatchSession`, `SkipRule`, `SkipRuleKind`, `FilmFrame`, `MediaSource` (`qualityIn`, `quality`,
`qualityRank`, `best`), `MediaSourceKind`, `VoiceBoostState`, `DownloadStatus` (`isActive`),
`DownloadItem` (`fraction`, `watchedFraction`, `episodeBadge`, `fileBaseName`), `CaptionStyle`
(`label`, `css`, `nativeSize`), `LibraryEventKind`, `LibraryEvent`, `Site` (`searchUrl`),
`HistoryEntry`, `SitePrefs`, `ShieldStats` (`total`), `AppTheme`, `SearchEngine` (`url`), `Timecode`
(`string`, `spoken`), `UrlKey.make(url)`, `DomainName` (`registrable`, `isSameSite`, `isIPAddress`,
`displayName`), `Urls.parse`. `LibraryText.normalize` / `canonicalGenre` (the parsing and profile
ports should call these, not copy them).

`AppSettings` (`appSettings.ts`): the interface has the Mac's 33 JSON keys. `defaults()`,
`make(partial)`, `decode(text | bytes) → AppSettings | null` (lenient per key, null when not an
object), `fromObject(value)`, `encode(s) → string`, `toObject(s)`, `equals(a, b)`, `keys`.

`Database` (`database.ts`), all async:
- `Database.open(name, factory?)`, `openProfile(profileId)`, `nameFor(profileId)` →
  `cineon-<UUID>`, `Database.delete(name)`, `close()`, `idb` (the raw connection), `name`.
- Episode alerts: `episodeAlerts()`, `saveEpisodeAlert(a)`.
- Titles: `allTitles()`, `insertTitle(t) → id`, `updateTitle(t)`, `deleteTitle(id)`, `mergeTitle(from, into)`.
- Progress: `allProgress()` (latest first), `progress(urlKey)`, `progress(titleId, ref)`,
  `upsertProgress(p)`, `clearProgress(titleId, ref)`.
- Sessions: `sessions(limit = 300, before = null)`, `sessionsForTitle(titleId)`,
  `latestSession(titleId, ref, after)`, `latestSession(url)`, `insertSession(s) → id`,
  `updateSession(s)`, `deleteSession(id)`, `secondsPerDay(since) → {day, seconds}[]`, `totalSeconds(since)`.
- Skip rules: `skipRules(titleId, site?)`, `saveSkipRule(rule)`, `deleteSkipRule(id)`.
- Frames: `allFrames()`, `insertFrame(f) → id`, `deleteFrame(id)`, `deleteAllFrames()`; frame
  images: `readFrameFile(file)`, `writeFrameFile(file, data)`, `deleteFrameFiles(prefix, exact?)`,
  `frameFileSizes()`.
- `knownHosts()`.
- Downloads: `allDownloads()`, `insertDownload(d) → id`, `updateDownload(d)`, `deleteDownload(id)`.
- Events: `addEvent(kind, titleId, at?)`, `events(limit = 300)`.
- Links: `link(urlKey) → {titleId, ref} | null`, `setLink(urlKey, titleId, ref)`, `isIgnored(urlKey)`, `ignore(urlKey)`.
- Sites: `allSites()`, `insertSite(s) → id`, `updateSite(s)`, `deleteSite(id)`.
- History: `addHistory(url, host, title)`, `updateHistoryTitle(url, title)`,
  `searchHistory(query, limit = 8)`, `recentHistory(limit = 300)`, `clearHistory()`.
- `sitePrefs() → Map<host, SitePrefs>`, `saveSitePrefs(p)`; `addStats(delta, day)`, `totalStats()`.
- `loadSettings()`, `saveSettings(s)` (errors swallowed, as on the Mac).

`LibraryStore` (`libraryStore.ts`): `LibraryStore.open(db, frameFiles?)`. Synchronous reads from
memory: `titles: ReadonlyMap<id, Title>`, `progress`, `sessions` (latest 600), `events` (latest
300), `sites`, `framesBySession`, `momentsByTitle`, `bestFrameByTitle`, `revision`, `backlog`,
`watching`, `watched`, `count(status)`, `continueWatching → {title, progress}[]`,
`latestProgress(titleId)`, `progressList(titleId)`, `search(query, limit = 8)`,
`find(name, altName?, year?)`, `currentId(id)`, `frames(sessionId)`, `moments(titleId)`,
`bestFrame(titleId)`, `siteForHost(host)`. Writes return promises: `reload()`,
`addTitle(name, {year, kind, status, imdbId, posterUrl, backdropUrl, overview}) → Title | null`,
`update(title)`, `setStatus(id, status)`, `setRating(id, halves | null)`,
`restore(id, {halves?, ratedAt?, status?, statusAt?, finishedAt?})`, `delete(id)`,
`merge(from, into)`, `recordWatchStart(titleId)`, `saveProgress(p)`, `clearProgress(titleId, ref)`,
`saveSession(s) → WatchSession`, `deleteSession(id)`, `sessionsForTitle(titleId)`,
`addFrame(frame, data?) → FilmFrame | null`, `readFrame(frame)`, `deleteFrame(frame)`,
`deleteAllFrames()`, `framesSize()`, `pruneFrames(limit = 800 MiB)`, `addSite(url, name?)`,
`updateSite(site)`, `removeSite(id)`, `moveSite(offsets, destination)`,
`seedDefaultSitesIfNeeded()`. `onPersonalChange: ((title) => void) | null` (setStatus/setRating
only). `changed.on(keys => …)` returns an unsubscribe function; keys are `LibraryStoreKey`s
(`"titles"`, `"progress"`, `"sessions"`, `"events"`, `"sites"`, the three frame maps, `"revision"`).
`findTitle(titles, name, altName?, year?)` is `find` over any titles.

`FrameFiles` (`frameFiles.ts`): where frame images live. `IdbFrameFiles(db)` (default: the
profile database's `frame_files` store) and `MemoryFrameFiles`. Image data: `Blob | ArrayBuffer | Uint8Array`.

`LibraryQuery` (`libraryQuery.ts`): a plain object `{list, kind, genres, rating, decade, onThisMac,
text, sort}`; `LibraryQuery.make(partial)`, `apply(q, titles, downloadedIds?)`, `hasFilters(q)`,
`equals(a, b)`, `compareNames(a, b)`, `genresIn(titles) → {name, count}[]`, `decadesIn(titles)`.
`LibraryList`, `LibraryKind`, `LibrarySort` (raw strings + `label`, `matches`), `RatingFilter`
(`any`, `unrated`, `atLeast(n)`, `below(n)`, `label`, `matches`, `choices`, `equals`).

`ProfileStore` (`profileStore.ts`): `ProfileStore.open({storage, defaultName?, deleteProfileData?})`;
`profiles`, `lastUsedId`, `askOnLaunch`, `lastUsed`, `databaseName(id)`; async `markUsed(id)`,
`add(name) → Profile`, `rename(id, name)`, `setPoster(id, url | null)`, `delete(id)`,
`setAskOnLaunch(value)`, `reload()`; `changed`; static `storageKey` (`"profiles.json"`),
`encode`, `encodeJson`, `decode`. Storage: `chromeStorage(area?)` (chrome.storage.local by
default), `MemoryStorage` for tests, or anything with `get(key)` / `set(key, value)`.

`LibraryExport` (`libraryExport.ts`): `payload(library, now?)`, `make(library, now?) → string`
(the Mac's file, byte for byte), `parse(text) → ImportedLibrary | null`,
`apply(library, imported) → ImportResult`, `importText(library, text)`. `swiftPrettyJson(value)`
writes any value as Swift's pretty, sorted JSONEncoder does.

## Storage
One IndexedDB database per profile, `cineon-<PROFILE-UUID>`, version 4 (the apps' `user_version`).
Each SQLite table is an object store with the same name, and each row has the SQLite column names
and value types: snake_case, dates as seconds, booleans 0/1, `genres` joined with `|`, `subtitles`
with `\n`, null for NULL. A Mac/Windows row can be copied in as is. Indexes keep the SQLite names
(`titles_norm`, `titles_imdb` unique, `progress_url`, `sessions_time`, `sessions_title`,
`events_time`, `sites_host` unique, `history_time`, `frames_session`, `frames_title`,
`downloads_time`); extra ones stand in for SQLite's scans and foreign keys (`progress_title`,
`sessions_url`, `events_title`, `url_links_title`, `history_url`, `skip_rules_key` unique,
`skip_rules_title`, `downloads_title`, `frame_files_size`). Keys: auto-increment `id` where SQLite
has `INTEGER PRIMARY KEY`, `[title_id, season, episode]` for progress, `url_key`, `host`, `day`,
`key`, `title_id` for episode alerts.

Done by hand, each call in one transaction (all or nothing, like SQLite's):
- Foreign keys: inserting a session, progress, event, link, skip rule, frame (and its session),
  download or episode alert for a missing title rejects with `ConstraintError`.
- `deleteTitle` cascades to progress, sessions, events, links, skip rules, frames, episode alerts;
  downloads keep the row with `titleId: null`. `deleteSession` leaves its frames with no session.
- `mergeTitle`: UPDATE OR IGNORE for progress and skip rules (the target's own copy wins, the
  source's is dropped), everything else moves; the source's episode alert goes.
- Unique IMDb ID and site host reject with `ConstraintError`, like SQLite's unique indexes.
- `upsertProgress` keeps `finished` once true; `saveSkipRule` upserts on (title, site, kind)
  keeping the rule's ID; `searchHistory` is SQLite's LIKE (`_` matches any one character, only
  ASCII letters ignore case; `%` is dropped from the query).

## Gotchas
- **LibraryStore writes change memory synchronously**, then the promise settles once the database
  has the change, and `changed` fires then. Calls made back to back compose (`setStatus` then
  `setRating` without awaiting both land). Inserts (`addTitle`, `addSite`, `addFrame`, a new
  `saveSession`) need the database's ID first, so memory changes after the insert.
- **Collections are replaced, never mutated**: a new `titles` Map / `sessions` array identity
  means something changed (handy for Preact).
- **One LibraryStore sees only its own writes.** A store in the service worker and one in a page
  over the same database don't see each other's changes; call `reload()` when told (a message or
  BroadcastChannel). `reload()` replaces memory with what the database holds at that moment.
- `library.sessions` is the latest 600 with the newest *saved* first (as the Mac): a session saved
  later goes to the front even if it started earlier, until the next `reload()`.
- Database errors (`isDatabaseError`: IndexedDB's DOMException names) are swallowed in
  LibraryStore, as Swift's `try?`; other errors (bugs) still throw. Database itself rejects.
- Never await anything but IndexedDB requests inside `transact` (idb.ts): the transaction commits
  at the first other await.
- The database connection closes itself when another context deletes or upgrades it
  (`versionchange`), so `ProfileStore.delete` doesn't hang on an open connection.

## Not 1:1, and why
- **Async everywhere** IndexedDB is involved (Database, LibraryStore writes, ProfileStore writes);
  the apps are synchronous. `ProfileStore.askOnLaunch` is read-only; set it with `setAskOnLaunch`.
- **No tabs table / `PersistedTab`**: the browser keeps tabs.
- **Frames folder → `frame_files` store** (`FrameFiles` interface). `framePath`/`frameURL` become
  `readFrame(frame)` (the image) and `bestFrame(titleId)` (the frame); C#'s
  `FramesSizeAsync`/`PruneFramesAsync` are `framesSize`/`pruneFrames`. `DownloadItem.fileURL` is gone
  (the browser owns download paths); `file` is whatever path the downloads code records.
- **IDs**: IndexedDB's key generator never reuses an ID; SQLite reuses the highest one after it's
  deleted. Nothing relies on either.
- **Settings value** is kept as JSON text (bytes are read too); the apps keep a UTF-8 BLOB.
  `downloadsFolder` is kept for round trips, but the extension saves into the browser's downloads.
- **`enabledLists` and `LibraryQuery.genres` are arrays used as sets** (JSON-friendly); compare with
  `AppSettings.equals` / `LibraryQuery.equals`.
- **ProfileStore** lives in `chrome.storage.local` under `"profiles.json"` as an object of that
  file's shape. The first person's name comes from `defaultName` (the extension can't read the
  account's name), else "Me". Deleting a person deletes their IndexedDB database (cookies stay with
  the browser profile). Mac-written `createdAt` values are written back unchanged (a JS number in
  seconds since 1970 can't hold every 2001-based value exactly, so the original is remembered).
- **Export**: the Mac only writes it; reading it back (`parse`/`apply`) is new. Merge rules: match
  by IMDb ID, else `find(name, year)`; fill only what's missing (IMDb ID, year, kind, rating, list,
  finish date) and never overwrite your own rating or list; sessions attach to the title of that
  name (the first, if two share it; a missing title is added), skipping any already there for the
  same title and episode starting in the same second; a session's start position is taken as
  `stoppedAt - watchedSeconds`; titles get `lastWatchedAt` from their latest imported session.
  `apply` returns the titles it added or changed for the cloud backup to send; it doesn't call
  `onPersonalChange`. `parse` skips unreadable entries instead of refusing the file.
- `LibraryText.normalize` matches the C# port exactly (all the Windows cases pass, plus final sigma
  and a few half-width and Greek cases checked against Foundation). Known Foundation difference
  inherited from the C#: a lone U+0345 folds to "ι" on the Mac and to "" here.
- `LibraryQuery.compareNames` uses `Intl.Collator` (numeric, case-insensitive, accent-sensitive) in
  the browser's locale, with an ordinal tie-break, for Finder's `localizedStandardCompare`.
- `CaptionStyle.css` names the browser's UI font (`system-ui`) instead of SF Pro / Segoe UI.
- `addSite` reads hosts with WHATWG `URL` (IDN hosts come back as punycode; Swift keeps Unicode).
- Overloads keep the Swift/C# names where TypeScript can tell them apart (`progress(urlKey)` /
  `progress(titleId, ref)`, `latestSession`, `skipRules(titleId, site?)`); C#'s renames stay
  elsewhere (`sessionsForTitle`, `siteForHost`).
