# Browser (Cineon.App.Browser and the site UI)

Ports of `Browser/BrowserModel.swift`, `BrowserTab.swift`, `WebKitEnvironment.swift`, `WatchTracker.swift`,
`EpisodeAutopilot.swift`, `Rescue.swift`, `FrameCollector.swift`, `WindowCapture.swift`, and the UI in
`UI/TopBar.swift` (BrowserBar, TabStrip, TabChip, DownloadMenuButton, NowPlayingPill), `UI/Sidebar.swift`
(AddressPill, ShieldButton, ShieldPopover, PlayingIndicator), `UI/RescueView.swift`, `UI/PlayerControls.swift` and
`UI/RootView.swift` (WorkspaceLayout, MainCard, AmbientLight, LoadingSweep, BlankTabView, LoadFailureView,
FindBar, SearchDeckBar). Everything here lives on the UI thread; every WebView2 handler goes through
`Safe.On`, so an exception lands in crash.log instead of ending the app.

## Files
- `Browser/WebEnvironment.cs`: one `CoreWebView2Environment` per profile, user data in
  `Profiles\<UUID>\WebView2`, args `--disable-features=HardwareMediaKeyHandling,MediaSessionService,CalculateNativeWinOcclusion`.
  `EnvironmentAsync()`, `WarmUp()`, `InstallScripts(sweeper)` (raises `ScriptsChanged`; open tabs reinstall),
  `ApplyRules(engine)`/`Rules`/`RulesChanged`, `Teardown()`, `IsTornDown`, static `Configure(core)`.
- `Browser/ScriptBridge.cs` (extended): the shim also offers `cineonKey`, `cineonLink` and `cineonCss` (with
  reply); `InstallAsync(sweeper, extra)`; handlers are guarded.
- `Browser/PageExtras.cs`: the Windows-only page scripts: `Keys(shortcuts)` (forwards the menu shortcuts, Esc
  and F10 from a focused page), `Links` (which link or form was pressed, for the redirect shield), `Css` (asks
  for the ad rules' hiding CSS in every frame), `Zoom(factor)`.
- `Browser/BrowserModel.cs`: `BrowserModel`, `SearchSession`, `WebViewHost` (the Grid holding the tabs' WebView2s).
- `Browser/BrowserTab*.cs`: the tab (`BrowserTab.cs` state and page messages, `.WebView.cs` lifecycle,
  navigation and shields, `.Media.cs` playback, downloads, captions, voice boost, subtitles, capture, find).
- `Browser/WatchTracker.cs`, `EpisodeAutopilot.cs`, `Rescue.cs` (also `SiteProbe`, `RescueSession`,
  `RescueProbe`), `FrameCollector.cs` (also `FrameImage`, `ColorZones`, `DecodedImage`, `FrameState`),
  `WindowCapture.cs`, `HeadlessWebView.cs`, `DownloadBridge.cs` (`RequestContext`, `EpisodeResolver`,
  `HelperTab`), `PartyPlayer.cs` (Core Together's `IPartyPlayer` over the browser), `Safe.cs`.
- `Services/DownloadHost.cs`: `IDownloadHost` (toasts, `AppModel.PlayDownload`, Recycle Bin through
  SHFileOperation, `explorer /select,`, video duration from Windows.Storage).
- UI: `UI/Workspace.cs` (Workspace, AmbientLight), `UI/BrowserBar.cs` (BrowserBar, DownloadMenu, TabStrip,
  PlayingIndicator, AddressPill, ShieldButton, ShieldPanel, Popovers), `UI/WebPage.cs` (WebOverlays, the page
  for `Route.Web`: SearchDeckBar, LoadingSweep, LoadFailureView, FindBar, the blank tab), `UI/RescueView.cs`,
  `UI/NowPlayingPill.cs` (NowPlayingPill, PlayerControlsPanel, SecondSubtitlesRow, SubtitleFilePicker).

## API the screens can use
- `app.Browser` (`BrowserModel`): `Tabs`, `ListedTabs`, `SelectedId`, `Selected`, `Search`, `PlayingTab`,
  `RecentlyClosed`, `IsPageFullscreen`, `Changed` (list, selection, search) and `TabChanged` (anything a tab
  shows). `OpenTab(url, select, resumeAt, siteId, keepWatching)`, `Open(url, …)` (reuses a tab on that page),
  `Select`, `Close`, `ReopenClosed`, `Move(from, to)`, `SelectTab(i)`, `SelectAdjacent(±1)`,
  `SearchEverywhere(query)`, `EndSearch(keeping)`, `PauseOthers`, `LearnFromPage`, `ScheduleSave`/`SaveNow`.
- `BrowserTab`: `Id`, `Url`, `Title`, `DisplayTitle`, `FaviconUrl`, `IsLoading`, `Progress`
  (`ProgressSignal`), `CanGoBack/Forward`, `Failure` (`LoadFailure(Host, Message, Url)`), `Media`
  (`MediaState`; `Ticks` fires with every report, `Changed` only when it starts, stops or goes), `Parsed`
  (`ParsedTitle`), `PageMeta`, `LinkedTitleId`, `Track` (`LiveTrack`), `Blocked` (`BlockedSignal`),
  `IsTheaterOn`, `Rescue`, `Sources`, `BestSource`, `SourcesFrameUrl`, `BoostState`, `SecondSubtitles`,
  `SubtitleChoices`, `IsHibernated`, `IsFullscreen`, `ZoomFactor`, `HasWebView`, `Control` (the WebView2),
  `Core` (ready CoreWebView2 or null), `IsHelper`.
  Commands: `EnsureWebView`, `Load(url[, resumingAt])`, `LoadToKeepWatching`, `GoBack/GoForward/Reload/Stop`,
  `Zoom(Δ)`, `ResetZoom`, `Hibernate`, `TearDownWebView`, `Play/PausePlayback/TogglePlayback/Seek/Skip/SetRate/
  FadeOut/CancelFade/TogglePictureInPicture`, `PlayerCommand(js)`, `EvaluateInPlayerAsync`/`EvaluateInPageAsync`
  (JSON text like `ExecuteScriptAsync`), `ShowBanner`, `SetAmbient`, `SetTheater`, `ApplyVoiceBoost`,
  `ApplyCaptions`, `RefreshDownloadPill`, `ShowSecondSubtitlesAsync(url)`, `ShowSecondSubtitles(track)`,
  `ClearSecondSubtitles`, `FindAsync(text, backwards)`, `StopFind`, `CaptureAsync()` (JPEG of the page),
  `CaptureWindowZonesAsync`, `SnapshotZonesAsync`. It is the downloads' `IDownloadTab`.
- `session.Tracker` (`Relink(tab, titleId, ref)`, `Ignore(tab)`, `StopTrackingSite(tab)`, `ResumePosition`,
  `TabNavigated`), `session.Autopilot` (`SkipToNext`, `HandleBanner`), `session.Rescue` (`FindElsewhere`,
  `TryFailedPageSearch`, `CanSearch`, `Take`, `Dismiss`, `StopCountdown`, `Stop`), `session.Frames`
  (`SaveMoment`, `PictureRectAsync`), `session.Metadata`, `session.Downloads`, `session.Seasons`,
  `session.RequestContext`.
- `AppModel.Browser.cs` (new partial): `IsScreen`, `ShowsBars`, `ContentTop`, `BrowserLayoutChanged()`.
- The Relink sheet (Sheets port) calls `session.Tracker.Relink(app.Browser.Selected, id, ref)`.
- The player route sits in the same framed screen: the workspace frames `Route.Player` too, so the
  LocalPlayer page just fills what it's given.
- `new PartyPlayer(session.Browser)` is the `IPartyPlayer` for Core's TogetherModel.

## Wiring done outside Browser/ (small, additive)
- `ProfileSession`: `Tracker`, `Metadata`, `Downloads`, `Seasons`, `RequestContext`, created in the Mac's
  order; `ShowDownloadButton` refreshes the pills; `Seasons.Suspend()` and `RequestContext.Close()` on close.
- `AppModel`: `AddCurrentPageToBacklog` uses `tab.Parsed`; `DownloadCurrentVideo`, `DownloadRestOfSeason`,
  `DownloadWholeSeries` call the downloads. `ActivePlayer.Ref` and Now Playing's name use `Parsed`.
- `MainWindow`: hosts `Workspace` (which holds `PageHost`; PageHost's own inset is now 0), the top bar follows
  `app.ShowsBars`, and keys whose source is a WebView2 are left to the page's forwarder (no double handling).
- `TopBar`: the NowPlayingPill before the tools; Browse with nothing selected opens the first tab.
- `Pages`: `Route.Web` is `WebOverlays`.

## Debug hooks (for the debug port; nothing is served)
- `app.Browser.DebugState()`: the Mac's `/state` browser lines: `url`, `title`, `parsed`, `media`, `track`,
  `blocked`, `framesBlocked`, `fullscreen`, `hasSuperview`, `hibernated`, `ready`, `banner`, `failure`,
  `theater`, `canGoBack`, `zoom`, `boost`, `best`, `sourcesFrame`, `rescue` (`RescueSession.DebugText`, the
  Mac's `reason|stage|site:path:strong;…|countdown`), plus `tabs`, `tablist` (`url[h|a]`), `search`,
  `selected`, `pageFullscreen`.
- `tab.DebugSources()` (`source kind current=… url`, plus `sniffed …` lines), `tab.EvaluateForDebugAsync(js)`
  (the Mac's `/eval`, in the video's frame), `tab.LastBannerForTests`, `tab.Hibernate()`,
  `autopilot.HandleBanner(banner, action, tab)` (the Mac's `/banner`), `rescue.Take(tab.Rescue.Options[0], tab)`.

## Not 1:1, and why
- No content worlds: WebView2 injects into the page's own world, so `window.__cineon` is visible to pages
  (ScriptBridge's choice). The CSS for ad rules is a constructed stylesheet added at document start, not a
  WebKit user stylesheet. A consequence: a page could post `cineonKey` (run an app shortcut, such as close
  tab) or a made-up `cineonLink` (get its own cross-site redirect past the shield). Nothing a page can do
  through them goes beyond what the person could press; worth closing if WebView2 ever offers isolated worlds
  for injected scripts.
- A form a page submits by script (`form.submit()`, `requestSubmit()`) is reported by `PageExtras.Links` and
  allowed, as WebKit's `.formSubmitted` is.
- No WebKit navigation types. WebView2 says only whether a navigation had a gesture, so `PageExtras.Links`
  reports the link (or form) pressed and the redirect shield treats a gesture without one as a script
  navigation, like WebKit's `.other`. The iframe-link hijack check uses that report's frame.
- Pop-ups: "a real click" is WebView2's `IsUserInitiated` (a script's `window.open` inside a click counts).
  Helper tabs never open pop-ups (the Mac's would ask the browser).
- Downloads a site starts itself: WebView2 doesn't say whether one came from the main frame or a
  `download` link, so with the download shield on every one is blocked with the toast, and with it off every
  one is saved to Downloads.
- No interaction state: WebView2 can't save or restore history and scroll, so a woken or restored tab
  loads its address again (no Back history). A Mac's saved state is kept in the `tabs` table until the tab
  wakes here, so the profile still restores on a Mac.
- Zoom is CSS zoom on the page, reapplied to every new document (WinUI's WebView2 hides the controller's
  `ZoomFactor`). Ctrl+wheel and pinch zoom are WebView2's own.
- Load progress steps through started (0.1), committed (0.5), DOM ready (0.8) and finished; WebView2 has no
  estimated progress.
- An HTTP error page (404 and so on) counts as a finished load, as on the Mac; WebView2 calls it a failure.
  Error texts say "Your PC is offline", and unknown errors read "The page couldn't be loaded."
- The user agent is WebView2's own (Edge). The Mac adds Safari's name because WebKit is turned away.
- A video's fullscreen puts the whole window in fullscreen with only the page (the Mac gives the video a
  window of its own).
- Frames and ambient light: WebView2's `CapturePreviewAsync` (which includes the video picture) stands in
  for WKWebView's snapshot, and a GDI copy of the screen under the web view stands in for ScreenCaptureKit
  (it sees anything covering the window). The window capture path and the snapshot path both use the
  page capture first.
- Ambient light is nine soft radial glows at the Mac's mesh points (WinUI has no mesh gradient); on white
  it's a lower opacity instead of a multiply blend.
- Media sniffing: media.js still reports the player's files; `WebResourceResponseReceived` adds files only
  the network saw (by URL, or an HLS content type), kept only when their Referer is the reporting frame.
- Helper tabs and rescue probes are plain WebView2 controllers parked outside the main window's client
  area (the Mac's windowless web views), so they need the main window to exist.
- If WebView2's browser process dies, every tab of the profile loses its page; the environment is made again
  once the old process has exited (at most 10 s) and the selected tab reloads. WebKit restarts only the
  web content process.
- A pop-up opened from a search result tab gets its window before the search closes (WebView2 needs the
  opener alive until then); the Mac closes the search first.
- Tab dragging reorders on drop (the Mac moves tabs live while dragging). The download button's menu opens
  on right-click or press-and-hold (the Mac's long press), and its tooltip says so.
- Shield "off" icon is Fluent's blocked glyph; there's no shield-slash.
- The native player's speed row isn't in the controls popover yet: LocalPlayback has no rate setter
  (TODO(port-player) in `NowPlayingPill.cs`).

## Risks to check first on Windows
1. WebView2 under `Opacity = 0` and in a composition-clipped card: if WinUI's WebView2 ignores ancestor
   opacity or clips, sites would show through native pages or with square corners. Fallback: collapse the
   web slot off-route (players may then pause like a background tab).
2. `EnsureCoreWebView2Async` on a WebView2 that is `Collapsed` (background tabs, search preloads) or not yet
   in the tree (a link opened at launch). Both should wait for Loaded; if they hang, show it at 1×1 instead.
3. Parked controllers (`HeadlessWebView`) as children of the WinUI window: that players load and play there
   (season grabber) and that nothing of them is visible or takes input.
4. `WebResourceRequested` for every request: the UI thread answers each one. Watch page load times on
   heavy sites; the matcher is microseconds, the hop isn't.
5. Keys from a focused page: Ctrl shortcuts, Esc and F10 should work once each (the window ignores keys
   whose source is a WebView2 in case WinUI also routes them).
6. The redirect shield's link report racing the navigation it describes (it's sent on pointer down).
7. `CapturePreviewAsync` with hardware video, and the GDI fallback with MPO video planes (may be black).
