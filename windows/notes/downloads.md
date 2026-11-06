# Browser import and downloads (Cineon.Core.Import, Cineon.Core.Downloads)

Ports of `Core/BrowserImport.swift`, `Downloads/DownloadCenter.swift`, `Downloads/SeasonGrabber.swift` and
`Downloads/Subtitles.swift`. Tests: `Cineon.Core.Tests/Import` (32) and `/Downloads` (63), all of the Mac's
expectations plus HLS, Range resume, loopback sockets and the job file's shape.

## Import API (`Cineon.Core.Import`)
- `ImportRoots(Local, Roaming)`; `ImportRoots.Default` is `CINEON_IMPORT_ROOT` (both roots) or
  `%LOCALAPPDATA%` + `%APPDATA%`.
- `BrowserImporter`: `PageLimit` (25,000), `Discover()`, `Discover(string root)` (the Mac's `discover(root:)`),
  `Discover(ImportRoots)`, `Scan(ImportSource, ITitleRecognizer, DateTimeOffset? now = null)`,
  `ReadHistory(profileDir)`, `ReadBookmarks(profileDir)`, `ReadArcTabs(arcDir)`, `ChromiumDate(long)`.
- `ImportAnalyzer`: `Analyze(pages, sourceLabel, recognizer, now?)`, `Signal(url, title, recognizer)`,
  `Brand(domain)` (EpisodeLinks and RescueMatcher use this one, don't copy it).
- Records: `ImportSource` (`Label`, `Id`), `BrowsedPage` + `PageOrigin { History, Bookmark, Pinned }`,
  `ImportSiteCandidate`, `ImportVisit`, `ImportTitleCandidate`, `ImportScan`, `ImportSelection`
  (`Titles` is a list of `(Candidate, Status)`), `ImportResult` (`Summary`, `NewTitleIds`).
- `library.ApplyImport(selection)` (extension on `LibraryStore`), `db.ImportHistory(page)`,
  `db.HasSession(titleId, ref, startedAt)`, `progress.IsVisitOnly`, `session.IsVisitOnly`.
- Unknown dates are `DateTimeOffset.MinValue` (Swift's `distantPast`).

### Interface the app implements: `ITitleRecognizer`
The import needs `TitleParser`, which is the Parsing port. Wire it once:
```csharp
sealed class TitleRecognizer : ITitleRecognizer {
    public RecognizedTitle? Parse(string url, string title) =>
        TitleParser.Parse(new PageMeta { Url = url, Title = title }) is { } p
            ? new RecognizedTitle { Name = p.Name, AltName = p.AltName, Year = p.Year, Ref = p.Ref,
                                    KindHint = p.KindHint, Confidence = p.Confidence }
            : null;
    public EpisodeRef? EpisodeRefIn(string text) => TitleParser.EpisodeRef(text);  // Swift episodeRef(in:)
}
```
The tests use `TestTitleParser`, a port of the address-and-title path of `TitleParser.swift`. Once the
Parsing port lands, point the tests at the adapter above and delete it.

## Downloads API (`Cineon.Core.Downloads`)
`DownloadCenter(Database, LibraryStore, Func<AppSettings>, IRequestContext, IDownloadHost, HttpMessageHandler? = null)`
- Reading: `Items` (newest first), `Progress`, `Changed` event, `ActiveCount`, `RunningCount`, `HasFreeSlot`,
  `MaxRunning` (2), `Item(id)`, `Fraction(item)`, `Existing(tab)`, `ItemForFile(path)`, `Folder`,
  `FolderFor(settings)`, `PartialFolderName`.
- Acting: `Download(tab)`, `Enqueue(source, titleId, ref, name, pageUrl, referer, duration, posterUrl, subtitles)`,
  `FetchAsync(url, referer)`, `AddSubtitles(file, id)`, `NextEpisode(item)`, `BinWatched(id)`,
  `LibraryTitle(tab)`, `Retry(id)`, `Cancel(id)`, `Remove(id)`, `ShowInFileExplorer(item)`,
  `NotePlayback(id, position, duration)`, `SuspendAll()`, `RefreshPills(force)`, `Unique(path)`, `SizeOf(path)`.
- Pause and resume are the Mac's Stop and Try again: `Cancel` keeps the partial file, `Retry` carries on
  with `Range: bytes=N-` (an HLS download keeps its finished segments).
- `MediaUrls.Progressive(url)` and `MediaUrls.KindOf(url)` match `media.js`. Use them if C# ever reads
  player requests itself (`WebResourceRequested`): `file.mp4:hls:seg-N.ts` becomes `file.mp4`. `Enqueue`
  and `Existing` apply `Progressive` too.
- `HlsPlaylist` (`ParseMaster`, `ParseMedia`, `Resolve`, `Attributes`), `HlsMaster.Best`, `HlsVariant`,
  `HlsMediaPlaylist`, `HlsSegment`, `HlsKey`, `HlsMap`, `HlsByteRange`.
- `DownloadErrors` (`Explain(status)`, `Describe(exception)`, `Protected`, `SeparateAudio`),
  `DownloadHttpException`, `DownloadFailedException`.
- `SubtitleTrack` (`Load`, `Parse`, `Text(at)`, `Time`, `LabelFor(Uri, index)`, `LabelForFile(path, index)`,
  `DisplayName`), `SubtitleCue`.

`SeasonGrabber(DownloadCenter, IDownloadHost, IEpisodeResolver, profileDirectory)`
- Nested `Scope { Season, Series }`, `Job` (`Seasons`, `Label`, `Handled`, `Remaining`, `Encode()`,
  `static Decode(bytes)`), `Proposal` (`TotalBytes`, `Fits`, `SeasonCounts`).
- State: `CurrentJob` (Swift `job`), `PendingProposal` (Swift `proposal`), `IsLooking`, `IsRunning`,
  `IsBusy`, `Changed`.
- Acting: `Start(tab, fromCurrent)`, `StartSeries(tab)`, `Confirm()`, `Decline()`, `Resume()`, `Cancel()`,
  `Suspend()`, `Dismiss()`, `static FreeSpace(folder)`, `static ShortLabel(ref)`, `EpisodeTimeout`,
  `GuessedBytesPerEpisode`, `JobFileName`.
- `download-job.json` is in the profile folder, in the same shape as the Mac's (`titleID`, `pageURL`,
  `startRef`, `{season, episode}` objects; nils left out). A job saved on a Mac resumes here, and the
  reverse.

### Interfaces the app implements
- `IRequestContext`: `UserAgentAsync()` gives `navigator.userAgent` (or `CoreWebView2Settings.UserAgent`).
  `CookiesAsync(url)` gives `CoreWebView2CookieManager.GetCookiesAsync(url.AbsoluteUri)` mapped to
  `BrowserCookie(Name, Value, Domain, Path, IsSecure)`. Core filters cookies by the Mac's domain, path and
  Secure rule and adds Accept, Referer (the download's frame) and Origin itself. Calls arrive on the UI
  thread.
- `IDownloadHost`: `ShowToast(message, actionTitle?, action?)`, `PlayDownload(item)`,
  `RefreshDownloadPills()`, `EnrichTitle(id, altName)` (metadata), `MoveToRecycleBin(paths)`
  (`FileSystem.DeleteFile(..., RecycleOption.SendToRecycleBin)`), `ShowInFileExplorer(path, select)`
  (`explorer /select,`), `MediaDurationAsync(file)`.
- `IDownloadTab`, the browser tab: `Url`, `DisplayTitle`, `LinkedTitleId`, `TrackRef`, `Parsed` (`PageTitle`),
  `Sources`, `BestSource`, `SourcesFrameUrl`, `MediaDuration`, `EvaluateInPageAsync(script)`, which returns
  JSON as `ExecuteScriptAsync` does (`"true"`, `"[1,2,3]"`, `null` on failure).
- `IEpisodeResolver`: `MakeHelperTab()`; `EpisodeUrl(page, current, target)` =
  `Parsing.EpisodeLinks.Url`; `IsAliveAsync(url)` = `SiteProbe.check` is alive;
  `PublishedEpisodesAsync(title)` = `MetadataService.EpisodesAsync(title)` mapped to
  `PublishedEpisode(Season, Episode, Released)`.
- `IEpisodeHelperTab : IDownloadTab, IDisposable`: `CurrentUrl`, `Load(url)`, `Reload()`, `PausePlayback()`.
  It's a hidden WebView2 that must keep playing: put it in an off-screen window and keep
  `IsVisible = true`, or players pause and never ask for the file. `Dispose` tears it down, and a
  disposed tab must ignore further calls.

## Gotchas
- Create `DownloadCenter` and `SeasonGrabber` on the UI thread. The center captures that
  `SynchronizationContext`; transfers run on the thread pool, while `Changed`, every host call and every
  `IRequestContext` call are posted back to the UI thread. Reading state is safe from any thread.
- Unfinished downloads collect in `<downloads folder>\.cineon-partial\` (hidden):
  `<db hash>-<id>.part` for files, `<db hash>-<id>.hls\` for streams. They're deleted when a download
  finishes or is removed. Changing the folder in Settings leaves them behind in the old folder.
- A stream is saved as `.ts` (MPEG-TS segments) or `.mp4` (fragmented MP4 with `EXT-X-MAP`) and recorded
  with `kind = hls`, so the native player needs a .ts-capable path (MediaPlayerElement plays .ts).
- `SubtitleTrack.Label(for:index:)` is `LabelFor`/`LabelForFile`, because `Label` is the property.
- `Enqueue` no longer takes a web view: the user agent comes from `IRequestContext` for the whole profile.

## What isn't 1:1
- HLS: the Mac saves a `.movpkg` through AVFoundation; here it's one `.ts`/`.mp4` written by
  `HlsDownloader` (highest bandwidth like AVFoundation, 4 segments at once, 4 tries each, AES-128 with an
  explicit or sequence-number IV, byte ranges). Variants whose sound is in a separate playlist come
  after those with their sound in the segments; if every variant has separate sound, the download fails
  with `DownloadErrors.SeparateAudio` (AVFoundation would merge them). SAMPLE-AES and DRM fail with the
  Mac's "may be protected" text. A playlist without `EXT-X-ENDLIST` saves what it lists.
- HLS progress is a fraction of the playlist's duration, as on the Mac. The item's duration comes from
  the playlist, then from `MediaDurationAsync` if the host can read one.
- Resume: the Mac keeps resume data in memory only. Here the partial file is on disk, so Try again carries
  on even after Cineon restarts. If the server ignores Range (200) or answers with the wrong piece, the
  download starts again from the beginning.
- Queue: the Mac counts a starting download twice (running and starting) until its subtitles are saved,
  which can hold the next download back until the first one ends. Here it counts once, and the queue
  is pumped again after every start.
- Subtitle requests carry the cookies for their own address. The Mac sends the film host's cookies.
- Errors: Foundation's network messages are reproduced for timeouts, a dropped connection, an unknown
  host and a refused connection; other .NET errors keep .NET's text. HTTP errors are explained as on the
  Mac, and a stream's HTTP errors get the same explanations.
- Browsers: Windows profile folders; Opera GX is added; Arc for Windows is read from
  `Packages\TheBrowserCompany.Arc_*\LocalCache\Local\Arc` (`User Data` plus `StorableSidebar.json`). The
  Mac's folder layout also works under one root, so the e2e fake browsers work. History is copied through
  a share-everything handle (Chromium locks it on Windows), together with `-journal`. Dia and Yandex use
  guessed Windows paths.
- Strings that name the Mac: "this Mac" is "this PC", "the Bin" is "the Recycle Bin".
- Free space is `DriveInfo.AvailableFreeSpace`. The Mac's "important usage" figure can also count
  purgeable space.
- The job file is written with plain `/` (Swift writes `\/`), which reads the same. Decoding doesn't
  require `queued`, `missed`, `isFinished` or `isPaused`, though Swift does, and this side always writes
  them.
- Not ported here: the `PagePreview` cases of BrowserImportTests (Metadata port). DownloadTests' MediaSource,
  file name and database cases are in `Data/ModelsTests` and `Data/DatabaseTests`; its share code and
  party cases belong to Together. The fixture site (`fixtures/server.js`) isn't used: its HLS and film
  files aren't in the repo, so the HLS tests use an in-process server, and one test uses real sockets
  on 127.0.0.1.
