# Downloads (src/core/downloads, src/offscreen)

Port of Core/Downloads (C# `windows/Cineon.Core/Downloads`: DownloadCenter, DownloadHttp, HlsPlaylist,
HlsDownloader, MediaUrls, SeasonGrabber, Subtitles), checked against Swift `Cineon/Downloads`.
Import everything from `src/core/downloads` (index.ts); the Chrome offscreen pieces from
`src/offscreen/client.ts`. Tests: `test/downloads/*` (78), ported from `Cineon.Core.Tests/Downloads`
(DownloadCenter, Hls, SeasonGrabber, SeriesDownload, Subtitle) over fakes of fetch, chrome.downloads,
declarativeNetRequest, OPFS, object URLs and runtime messaging (`test/downloads/fakes.ts`).

## How it fits together
```
DownloadCenter (service worker / Firefox event page)
 ├─ direct file ─► DnrHeaderRules.add(Referer/Origin for the file's URL and site, tab-less requests only)
 │                 chrome.downloads.download({url, filename: "Cineon/<name>.<ext>", conflictAction: "uniquify"})
 │                 progress: downloads.search({id}) every pollInterval + onChanged; Stop = pause, Try again = resume
 ├─ HLS ─────────► StreamWorker.start({key, url})
 │                   Chrome: OffscreenStreamWorker ⇄ runtime messages ⇄ offscreen.html (StreamHost)
 │                   Firefox: StreamHost in the background page itself
 │                 StreamHost: HlsDownloader → OPFS cineon-partial/<key>.hls/ → joined output.part
 │                   asks the center for headers on every host first ("hosts"), reports progress
 │                   → "done" with an object URL → center: chrome.downloads.download(blob URL) → release
 └─ subtitles ──► fetch with a header rule → Blob → object/data URL → chrome.downloads into Cineon/
SeasonGrabber ──► EpisodeResolver.makeHelperTab() (a tab nobody looks at) → enqueue each episode's file
```

## Wiring (what the background writes)
```ts
// Top level of the service worker / event page, before any await:
const browserDownloads = chromeDownloads();            // holds onChanged deltas until the center listens
const streams = createStreamWorker();                  // Chrome: OffscreenStreamWorker; Firefox: StreamHost
const headers = new DnrHeaderRules(chrome.declarativeNetRequest, { storage: chromeStorage(chrome.storage.session) });

// Per profile, once its Database and LibraryStore are open:
const downloads = await DownloadCenter.open({
  db, library, host, downloads: browserDownloads, headers, streams,
  storage: chromeStorage(),                             // chrome.storage.local
  session: chromeStorage(chrome.storage.session),      // tells a worker restart from a browser restart
});
const grabber = await SeasonGrabber.open({ downloads, host, resolver, storage: chromeStorage() });
// Profile closes: grabber.suspend(); downloads.suspendAll().
```
`chromeStorage` is the data layer's (`src/core/data`). The Chrome build needs `offscreen.html`
(scripts/build.mjs makes it from `src/offscreen/index.ts`) and the `offscreen`, `downloads`,
`declarativeNetRequest`, `storage`, `unlimitedStorage` permissions and `<all_urls>` host access, which
the manifest already has.

## API
`DownloadCenter` — `static open(options) → Promise<DownloadCenter>`; `static maxRunning` (2),
`static folderName` (`"Cineon"`), `static compare(a, b)`, `static unique(name, taken) → name`
("Arrival 2.mkv", "Name.en 2.vtt"), `static extension(suggested, sourceUrl)`.
- Reading (synchronous, from memory): `items` (newest first; a new array on every change),
  `progress: ReadonlyMap<id, 0…1>` (new Map on change), `activeCount`, `runningCount`, `hasFreeSlot`,
  `databaseName`, `folder`, `item(id)`, `fraction(item)`, `browserDownloadId(id)` (for
  `chrome.downloads.open/show`), `existing(tab)`, `itemForFile(path)`, `nextEpisode(item)`.
  `changed: Emitter<void>`; `pollInterval` (ms, default 1000).
- Acting: `download(tab) → Promise<boolean>`, `enqueue(NewDownload) → Promise<DownloadItem | null>`
  (`{source, titleId, ref, name, pageUrl, referer, duration, posterUrl, subtitles}`),
  `fetch(url, referer) → Promise<Uint8Array | null>`, `addSubtitles({name, data}, id) → Promise<path | null>`,
  `libraryTitle(tab) → Promise<Title | null>`, `retry(id)`, `cancel(id)`, `remove(id) → Promise`,
  `binWatched(id) → Promise`, `showInFolder(item) → Promise`, `notePlayback(id, position, duration)`,
  `refreshPills(force?)`, `suspendAll()`, `detach()`, `idle()`.
  `remove`/`binWatched` take the item out of `items` at once; the promise settles when the files are gone.
- Records: `file` and `subtitles` are the absolute paths chrome.downloads reports (`DownloadItem.filename`);
  `kind` is `"hls"` for streams, saved as `.ts` (MPEG-TS) or `.mp4` (fMP4 with EXT-X-MAP).
- Which browser download holds each item is kept in `storage` under `<db name>/downloads.json`
  (`{ "<item id>": <chrome download id> }`).

`SeasonGrabber` — `static open({downloads, host, resolver, storage, storageKey?, estimate?})`;
`job` (Swift `job`), `proposal`, `isLooking`, `isRunning`, `isBusy`, `changed`; `start(tab, fromCurrent)`,
`startSeries(tab)`, `confirm()`, `decline()`, `resume()`, `cancel()`, `suspend()`, `dismiss()`, `idle()`;
`static freeSpace(estimate?)`, `static shortLabel(ref)` ("S1 E2"), `static numbers(value)`,
`static episodeTimeout` (45 s), `static guessedBytesPerEpisode`, `static jobFileName`
(`"download-job.json"`). Waits (ms, public for tests): `pollInterval`, `slotInterval`, `nudgeInterval`,
`firstLoadTimeout`, `episodeWait`. The job is stored as the JSON text under
`<db name>/download-job.json` (null once finished or dismissed).
`SeasonJob` (`make`, `seasons`, `label`, `handled`, `remaining`, `encode → string`, `decode(string | bytes)`),
`SeasonProposal` (`totalBytes`, `fits`, `seasonCounts`), `SeasonScope` (`"season" | "series"`).

HLS: `HlsPlaylist` (`isPlaylist`, `isMaster`, `parseMaster`, `parseMedia`, `attributes`, `resolve`),
`HlsMaster.best/needsSeparateAudio`, `HlsVariant.height`, `HlsKey.isAes128`, `HlsMap.identity`,
`HlsMediaPlaylist.totalDuration/isFragmentedMp4`; `HlsDownloader(http, subtle?)` with `parallel` (4),
`attempts` (4), `retryDelay` (ms), `download(url, PartFolder, {progress, signal, prepare}) → HlsOutcome`,
`static sequenceIv(n)`. `StreamHost({parts, fetch, objectUrls, subtle?, progressInterval?})` implements
`StreamWorker` (`setHandler`, `start`, `stop`, `discard`, `release`, `jobs`) plus `idle()`, `hls`, `http`.
`PartStore` (`open(storage?)`, `folder`, `remove`, `names`, `folderName = "cineon-partial"`), `PartFolder`.

Other: `DownloadErrors` (`explain(status)`, `describe(error)`, `interruption(reason)`, `isTransient`,
`couldNotSave`, `protected`, `separateAudio`, …), `DownloadHttpError`, `DownloadFailedError`,
`DownloadTimeoutError`, `DownloadNetworkError`, `DownloadStoppedError`; `DownloadHttp(fetch)`
(`getBytes`, `getText`, `status`, `idleTimeout`); `MediaUrls.progressive/kindOf`; `SubtitleTrack`
(`fromData(path, bytes)`, `decode`, `parse`, `text(track, time)`, `time`, `labelFor(url, i)`,
`labelForFile(path, i)`, `displayName(code, locale?)`); `DownloadText` (every user-facing string);
`pageHeaders(referer, sourceUrl)`, `hostOf(url)`; `ObjectUrls.browser()/data()`; `chromeDownloads(api?)`.

## Interfaces the runtime implements (src/core/downloads/types.ts)
- **`DownloadHost`**: `showToast(message, actionTitle?, action?)`; `playDownload(item)` (opens the saved
  file in Cineon's player; `downloads.browserDownloadId(item.id)` + `chrome.downloads.open` is the
  fallback, since an extension page can't read `file://` without the user allowing file access);
  `refreshDownloadPills()` (each tab's download button); `enrichTitle(titleId, altName)` (metadata
  port); optional `mediaDuration(item) → seconds | null`.
- **`DownloadTab`** (the tab the person is on): `url`, `displayTitle`, `linkedTitleId`, `trackRef`
  (tracker's episode), `parsed: PageTitle | null` (title parser → `{name, altName, year, ref, kindHint,
  posterUrl, overview}`), `sources` (the tab's `media.js` `sources` messages as `MediaSource`s),
  `bestSource` (`MediaSource.best(sources, playingSrc)`), `sourcesFrameUrl` (the URL of the frame those
  messages came from), `mediaDuration`, and
  `callPage(method, ...args) → Promise<unknown>` for `seasonsOnPage`, `episodesOnPage(season)`,
  `openEpisode(season, episode, false)`, `playQuietly()`. MV3 can't evaluate script strings, so:
  ```ts
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, world: "ISOLATED",
    func: (m, a) => { const c = (window as any).__cineon; return c && typeof c[m] === "function" ? c[m](...a) : null; },
    args: [method, args],
  }).catch(() => [null]);
  return r?.result ?? null;
  ```
  (media.js runs in the isolated world, which `executeScript`'s ISOLATED world shares.)
- **`EpisodeResolver`**: `makeHelperTab() → Promise<EpisodeHelperTab>`; `episodeUrl(pageUrl, current,
  target)` = parsing port's `EpisodeLinks.url`; `isAlive(url, signal)` = SiteProbe says alive;
  `publishedEpisodes(title, signal)` = metadata's episode list as `{season, episode, released}`
  (`released` in seconds since 1970, null = already out).
- **`EpisodeHelperTab`** (`DownloadTab` + `currentUrl`, `load(url)`, `reload()`, `pausePlayback()`,
  `close()`): a tab the person doesn't look at. Recommended: `chrome.tabs.create({url: "about:blank",
  active: false})` in the current window, then `chrome.tabs.update(id, {muted: true, autoDiscardable:
  false})`; `load` = `chrome.tabs.update(id, {url})`, `reload` = `chrome.tabs.reload(id)`, `currentUrl`
  from `tabs.onUpdated`, `pausePlayback` = `__cineon.pause()` in the frame holding the video (the
  Mac's `mediaCommand("pause()")`), `close` = `chrome.tabs.remove(id)`; calls after close do nothing.
  `sources`/`bestSource` must update live from that tab's media.js messages (all frames), with
  `isCurrent` as media.js reports it. A background tab is hidden (`visibilityState` "hidden"), and some
  players only ask for their file once they play: SeasonGrabber nudges `playQuietly()` every 4 s; if a
  site still refuses in a hidden tab, use an unfocused small window (`chrome.windows.create({focused:
  false, width: 480, height: 270, type: "popup"})`) instead — the Mac uses an off-screen window. Keep
  the helper out of history/tracking (the runtime's tracker should skip it).

### Interfaces it uses that the runtime only constructs
`BrowserDownloads` (`chromeDownloads()`), `HeaderRules` (`DnrHeaderRules`), `StreamWorker`
(`createStreamWorker()`), `ObjectUrls` (`ObjectUrls.browser()` is the default), `KeyValueStorage`
(`chromeStorage()`), `FetchLike` (global fetch by default).

## Browser differences
- **Chrome/Edge**: background is a service worker: no `URL.createObjectURL`, stopped when idle. So
  streams run in the offscreen document (reasons BLOBS + WORKERS, one per extension, opened by
  `ensureOffscreenDocument()` on the first stream and left open). `OffscreenStreamWorker` must be made
  at the top level (it registers `runtime.onMessage` at once; events that arrive before the center is
  open wait). The document keeps going while the worker sleeps; its messages wake the worker, and
  `DownloadCenter.open` with `session` takes running work back (`jobs()`, `downloads.search`). Subtitle
  bytes are saved through `data:` URLs (no object URLs in the worker). Progress polling stops while
  the worker sleeps; `onChanged` (held by `chromeDownloads()`) wakes it when a download ends.
- **Firefox**: background is an event page with a DOM: `createStreamWorker("firefox")` is a StreamHost
  in the page, object URLs are real blob URLs (Firefox refuses `data:` URLs in downloads.download).
  An event page also unloads when idle; an unloaded page loses a running stream's fetches, which then
  resumes from its OPFS parts on Try again. Keep the page alive while a stream runs (e.g. an open
  `runtime.Port` from the Downloads page, or periodic extension API calls).
- **Headers**: `DnrHeaderRules` uses session rules with `tabIds: [-1]` (requests from no tab: the
  worker, the offscreen document, chrome.downloads) in IDs 1,000,000–1,009,999 (no other code may use
  that range). Each download gets a priority-2 rule for its exact URL and a priority-1 rule for its
  sites (registrable domains, so redirects and segment hosts on the same site are covered); Referer is
  set or removed, Origin set (cross-site, as the apps) or removed (so the extension's own
  `chrome-extension://` Origin never reaches the site). Rules go when the download ends. Verify in
  the e2e run that Firefox's DNR applies to the extension's own requests; if it doesn't, implement
  `HeaderRules` with blocking `webRequest.onBeforeSendHeaders` (needs `webRequestBlocking` in the
  Firefox manifest).
- **Cookies and browser name**: chrome.downloads and `fetch(..., {credentials: "include"})` send the
  browser's own cookies and User-Agent, so the C# `IRequestContext` (cookie filtering, UA) is gone.
- **OPFS**: `navigator.storage.getDirectory()` in the offscreen document (Chrome) and the background
  page (Firefox 111+). Partial streams live in `cineon-partial/<fnv32(db name)>-<item id>.hls/`.

## What isn't 1:1, and why
- **Where files go**: always `Cineon/` inside the browser's downloads folder (`downloadsFolder` in
  settings is kept for round trips but unused). The browser owns the path; `file` is its absolute path.
- **Names**: the apps' names and " 2", " 3" numbering, checked against what the browser downloaded
  itself into `Cineon/` (`downloads.search({filenameRegex})`) and names reserved by running downloads;
  `conflictAction: "uniquify"` still guards files the browser doesn't know (it would add " (1)").
- **Extension of a direct file**: decided before the response arrives (chrome.downloads takes the name
  up front), so it comes from the address (mp4, m4v, mov, webm, mkv; else mp4). The apps also read
  Content-Disposition and Content-Type.
- **Stop / Try again**: Stop pauses the browser's download; Try again resumes it (the browser sends
  Range and starts over if the site ignores it); a download that can't resume (cancelled in the
  browser's list, a server error) starts afresh. After a browser restart Chrome's own interrupted
  downloads resume the same way. Streams keep their segments in OPFS, so Try again carries on even
  after a browser restart (the Windows behaviour), and a joined stream whose hand-off failed (disk
  full) is handed over again without the network.
- **Deleting**: there is no Bin: `remove`/`binWatched` delete with `chrome.downloads.removeFile` and
  erase the entry from the browser's list. The copy says so (`DownloadText.deleteFile`,
  `confirmDelete`, `deletedWatched`, `binSettingTitle/Detail`); asking first (`confirmDelete`) is new.
- **Error messages**: HTTP errors of streams and subtitles are the apps' (`explain(status)`). For direct
  files the browser reports `InterruptReason`s, mapped in `DownloadErrors.interruption`; for
  `SERVER_FAILED` the center asks the site once more (GET `Range: bytes=0-0` with the page's headers) to
  word it "(503)" as the apps do. fetch can't tell an unknown host from a refused connection: both are
  "Could not connect to the server."; a body that breaks off is "The network connection was lost.".
- **"Stopped when Cineon closed"** means the browser closed. A service worker restart is not a close:
  with `session` storage, queued items stay queued and running ones are taken back.
- **Free space**: `SeasonProposal.freeBytes` is `navigator.storage.estimate()` quota − usage, the room
  the browser gives the extension on this computer (where streams wait). The downloads folder can't be
  measured from an extension; the UI shows `DownloadText.freeSpaceNote`.
- **Async**: anything touching IndexedDB, the browser or the network returns a promise (`download`,
  `enqueue`, `remove`, `start`, …). Memory changes are synchronous, as in the data layer.
- **Page scripts**: `callPage(method, ...args)` instead of evaluating script strings (MV3 has no eval).
- **Subtitles**: `SubtitleTrack.load(path)` is `fromData(path, bytes)` (an extension can't read the
  disk); `displayName` uses `Intl.DisplayNames` in the browser's language.
- **Job file**: the same JSON as the Mac/Windows `download-job.json` (written with plain `/`; Swift's
  `\/` reads the same), kept as text in chrome.storage instead of a file, so it can be copied to and
  from the apps unchanged. Decoding is as lenient as the Windows port.
- **Not ported**: the cookie rule (`CookiesFollowTheMacsRule`) and User-Agent checks (the browser sends
  its own), `LoopbackTests` (the real network stack is the browser's), `ShowInFileExplorer` (it's
  `showInFolder` → `chrome.downloads.show`/`showDefaultFolder`), `SizeOf`/`FolderFor`/partial-folder
  paths (the browser and OPFS own them). `Import/BrowserImportTests` has no download cases.
