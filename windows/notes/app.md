# App state and services (Cineon.App)

Ported from `App/AppModel.swift`, `ProfileSession.swift`, `Playback.swift`, `StayAwake.swift`,
`EpisodeAlerts.swift`, `CineonApp.swift` (menus, DeepLink) and `Intents.swift`, plus the Overlays and
ToastHost parts of `UI/RootView.swift`. Everything here lives on the UI thread; anything arriving on
another thread (SMTC buttons, notification clicks, second launches, the updater) is queued onto it.

## AppModel (`App.Model`, also `AppModel.Shared`)
Made in `App.OnLaunched` before the window. Observable: views `Watch(app)` and rebuild on `Changed`
(not raised every tick; playback state raises it only when it changes).
- State: `Route` (+ `PreviousRoute`), `DetailTitleId`, `Sheet` (`AppSheet` records, `.Id` like the
  Mac), `IsCommandBarVisible`/`CommandBarSeed`, `IsProfilePickerVisible`, `IsFindVisible`, `IsCinema`,
  `IsSidebarPeeking`, `IsChangingReel`, `SplashVisible`, `Settings` (get/set saves), `IsDark`,
  `Palette`, `Session`, `Browser`, `Library`, `HasTabs`, `Profiles`, `Filters`, `Toasts`, `Ambient`,
  `NowPlaying`, `Window` (MainWindow).
- Playing: `ActivePlayer` (`ActivePlayer.Local(LocalPlayback)` / `.Web(BrowserTab)` with IsPlaying,
  Position, Duration, Rate, TitleId, Ref, Identity, Toggle/Play/Pause/Skip/Seek/FadeOut/CancelFade),
  `TogglePlayback`, `PlayNextEpisode`, `LocalPlayback`, `PlayDownload`, `ClosePlayer`, `UpNext`,
  `PlayUpNext`, `CancelUpNext`.
- Sleep timer: `SleepTimer` (`SleepTimerState`), `StartSleepTimer(SleepTimerMode)`,
  `StartSleepTimer(double seconds)`, `CancelSleepTimer`, `SleepTimerRemaining`. `SleepTimerMode.Choices`,
  `.Label`, `.IsEndOfItem`. The fade starts 20 s (`SleepTimerState.FadeSeconds`) before the end.
- Commands: `Go`, `OpenTitle`, `OpenCommandBar(seed)`, `CloseCommandBar`, `ToggleSidebar`,
  `ToggleTheme`, `ToggleCinema`/`ExitCinema`, `Resume(Title)`, `Resume(Uri, position)`,
  `ContinueWatching(titleId?)`, `OpenSite`, `AddCurrentPageToBacklog`, `SaveMoment`, `FindElsewhere`,
  `DownloadCurrentVideo`, `DownloadRestOfSeason`, `DownloadWholeSeries`, `SwitchProfile`,
  `HandleEscape` (closes the top overlay, then Cinema, then Find), `PrepareToQuit` (idempotent).
- `AmbientModel`: `Zones` (6 × `AmbientModel.Rgb`), `Level`; views ease Level over 1.2 s and Zones
  over 1.4 s. The AmbientLight view (RootView) isn't ported yet.
- Unlike the old stub, `Go` no longer closes the title card: the Mac's doesn't.

## ProfileSession
`Profile`, `Db` (Profiles\<UUID>\cineon.sqlite), `Library`, `Shields` (ShieldState over
`Services.DatabaseShieldStore`), `Settings` (setter saves and applies: scripts, rules, voice boost,
captions, pet identity), `Rules` (`FilterEngine.RulesFor(...)`, re-applied on `Filters.Changed`),
`Web` (WebEnvironment), `Autopilot`, `Rescue`, `Frames`, `Browser`, `Together`, `Alerts`, `Stats`
(cached like the Mac), `Pet`, `LatestPosterUrl`, `Start()`, `ApplyRules()`, `Close()`.

## Contracts later ports fill
Stand-ins hold exactly the members the app uses, each marked with the Swift signature it mirrors.
- `TODO(port-browser)`: `Browser/BrowserModel.cs` (Tabs, SelectedId, Selected, ListedTabs,
  PlayingTab, Start, Shutdown, OpenTab, Open, Select, Close, ReopenClosed, SelectTab, SelectAdjacent,
  SearchEverywhere, EndSearch; add `Search`), `Browser/BrowserTab.cs` (Id, Url, Title, Media,
  LinkedTitleId, SearchGroup, Track, LastPlaybackReport, Autopilot, AmbientFramesBlocked, HasWebView,
  DisplayTitle, EnsureWebView, GoBack/GoForward/Reload/Zoom/ResetZoom, media commands, SetAmbient,
  SetTheater, ApplyVoiceBoost, ApplyCaptions, CaptureWindowZonesAsync, SnapshotZonesAsync),
  `Browser/WebEnvironment.cs` (the Mac's WebKitEnvironment: create the CoreWebView2Environment with
  `UserDataFolder` and `--disable-features=HardwareMediaKeyHandling,MediaSessionService`, so media keys
  reach NowPlayingCenter; InstallScripts, ApplyRules/RulesChanged, Teardown), `Browser/WatchTracker.cs`
  (MediaState, LiveTrack; add WatchTracker as `ProfileSession.Tracker`), `Browser/EpisodeAutopilot.cs`
  (AutopilotState.IsHeldForSleep, SkipToNext), `Browser/Rescue.cs` (FindElsewhere, Stop),
  `Browser/FrameCollector.cs` (SaveMoment). No ScriptRouter: ScriptBridge delivers to its own tab.
- `TODO(port-player)`: `Playback/LocalPlayer.cs` (`LocalPlayback.Create` null when the file is gone,
  position/duration/IsPlaying/Rate, OnEnded, Play/Pause/Toggle/Seek/Skip/FadeOut/CancelFade/Stop,
  ApplyCaptionStyle, SampleZones). Set `CommandManager.IsEnabled = false` on its MediaPlayer.
- `TODO(port-together)`: `TogetherModel.cs` (Start, Stop, RefreshIdentity).
- `TODO(port-debug)`: `cineon://debug/...` in `Services/DeepLink.cs` (DEBUG_COMMANDS, scratch only).
  `NowPlaying.Handlers` and `EpisodeAlerts.LastNotificationForTests` exist for it.
- `TODO(after core merge)`: Downloads (`Item(forFile:)` in Resume, `NextEpisode(after:)` twice,
  `BinWatched`, `Item(id)` in PlayDownload, `Download(from: tab)`, `RefreshPills`, `SuspendAll`,
  `Items` for Stats), Seasons (`Start`, `StartSeries`, `Suspend`, the proposal overlay), Cloud
  (`Start`/`Stop`), Metadata (`Enrich` in RetryMissingMetadata and AddCurrentPageToBacklog, `Apply`
  in the commented `AddToBacklog(MetadataHit)`, `EpisodesAsync` in EpisodeAlerts), Parsing
  (`BrowserTab.Parsed` for AddCurrentPageToBacklog, ActivePlayer.Ref, NowPlaying's name), Images
  (`ImagePipeline.ZonesAsync` in AmbientModel.SetFromImage).

## Overlays and toasts
`UI/Overlays.cs`: ports register in `Overlays` like `Pages`: `TitleDetail(app, title)`,
`Sheet(app, sheet)`, `CommandBar(app)`, `ProfilePicker(app)`, `Splash(app)` (it clears
`SplashVisible`; none registered skips it). Null shows a placeholder (a plain picker for profiles).
`OverlayHost` stacks them in the Mac's order with the dimmed backdrop (click closes), builds each once
per open and keeps it. `ToastHost` is the Mac's toast; `GlassPanel(radius)` is `glassPanel`.
`ReelChange` is ported.

## Shortcuts (UI/Commands.cs; one table feeds keys and the menu)
| Command | Keys | Command | Keys |
| --- | --- | --- | --- |
| Settings… | Ctrl+, | Play or Pause | Ctrl+Shift+P |
| New Tab | Ctrl+T | Back 10 Seconds | Ctrl+Shift+Left |
| Open Location… | Ctrl+L | Forward 10 Seconds | Ctrl+Shift+Right |
| Reopen Closed Tab | Ctrl+Shift+T | Next Episode | Ctrl+Shift+N |
| Close Tab | Ctrl+W | Picture in Picture | Ctrl+Shift+I |
| Find in Page | Ctrl+F | Voice Boost | Ctrl+Shift+B |
| Hide Toolbars on Sites | Ctrl+S | Save This Moment | Ctrl+Shift+M |
| Cinema Mode | Ctrl+Shift+C | Download This Video | Ctrl+Shift+S |
| Reload Page | Ctrl+R | Downloads | Ctrl+Shift+J |
| Actual Size / Zoom In / Out | Ctrl+0 / Ctrl+= / Ctrl+- | Find This on Another Site | Ctrl+Shift+E |
| Switch Theme | Ctrl+Shift+D | Who's Watching… | Ctrl+Shift+U |
| Home | Ctrl+Shift+H | Back / Forward | Ctrl+[ / Ctrl+] |
| Library | Ctrl+Shift+L | Next / Previous Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Timeline | Ctrl+Y | Tab 1…9 | Ctrl+1…9 |
| Rate My Films | Ctrl+Shift+R | Search (Windows) | Ctrl+K |
| Add to Backlog | Ctrl+D | App menu (Windows) | Alt, F10 |
| Search All Sites | Ctrl+Shift+F | Close the top overlay / Cinema | Esc |

No keys: Check for Updates…, Import from Another Browser…, Together, My Profile, Sleep Timer ▸,
Download the Rest of This Season, Download the Whole Series…. Keys are read in the root's KeyDown, so a
text box keeps the keys it uses (Ctrl+Y, Ctrl+Shift+arrows). **Browser port:** keys typed while a page
has focus never reach XAML; forward them with `Shortcuts.Handle(app, key, ctrl, shift, alt)` (Esc too).

The More button (end of the top bar's tools) and Alt/F10 open a MenuFlyout: Watch ▸, Tabs ▸, View ▸,
the File and Edit commands, Import from Another Browser…, Settings…, Check for Updates….

## Launch, links, notifications, updates
- `Program.Main`: Velopack hooks register/unregister `cineon://` (HKCU\Software\Classes\cineon);
  then `SingleInstance` (AppInstance key per data folder, so scratch runs stay separate) redirects a
  second launch to the running copy, which comes to the front and handles its links.
- `DeepLink`: `open?url=`, `search?q=`, and the Jump List's `continue[?title=id]`, `playpause`, `next`,
  `sleep?minutes=` (0 = end of this), `downloads`, `profile`, `rate`.
- `JumpList`: tasks Continue Watching, Play or Pause, Next Episode, Sleep Timer (30 min), Rate Films,
  My Profile, Open Downloads, via the shell's ICustomDestinationList (WinRT's JumpList needs package
  identity). Not in scratch runs.
- `Notifications` (AppNotificationManager, registered on launch, unregistered on quit, not in scratch
  runs). A click opens the title, also when it launched Cineon.
- `UpdatePrompt`: Updater.Offer as a ContentDialog with plain-text release notes (Install and Relaunch /
  Skip This Version / Remind Me Later, Esc = later); `Updater.Said` as toasts.
- Media keys and the media flyout: `NowPlayingCenter` on the window's SystemMediaTransportControls.
- `StayAwake`: SetThreadExecutionState (display + system) while something plays.

## Not 1:1
- Siri phrases and the Continue Watching title picker have no Windows equivalent; the Jump List has
  the same actions and `cineon://continue?title=<id>` takes a title.
- No menu bar: menus live in the More flyout. Ctrl+K is bound (the Mac's tooltip says ⌘K, unbound).
- Play/pause key: SMTC sends Play or Pause, not toggle; Play with nothing on resumes like the Mac's
  toggle. With nothing playing the session is Closed, so Windows may route the key elsewhere.
- Rewind/fast-forward buttons skip 10 s. The flyout shows the poster from its URL (no 600 px resize).
- StayAwake has no reason string (SetThreadExecutionState takes none).
- Cinema hides the caption buttons with `SetBorderAndTitleBar(true, false)`.
- Esc is handled once by the window instead of by each view.
- Overlays over the top bar: its drag strip still takes clicks there (the backdrop can't be clicked
  in the top 56 px).
- Notifications need no permission prompt; the Windows Settings switch decides.
- Velopack installs into `%LOCALAPPDATA%\Cineon` (packId Cineon), the same folder as the data
  root. Check Velopack's uninstall doesn't delete profiles before shipping.
