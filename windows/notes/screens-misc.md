# Downloads, the native player, sheets, import and the command bar (Cineon.App)

Ports of `UI/DownloadsView.swift`, `Downloads/LocalPlayback.swift`, `UI/Sheets.swift`, `UI/ImportSheet.swift`
and `UI/CommandBar.swift`, plus the AppModel, ProfileSession and EpisodeAlerts call sites for downloads,
seasons and metadata. Type-checked on a Mac only (`make win-check`); nothing here has run on Windows yet.

## Where things are
- `UI/DownloadsView.cs`: `DownloadsPage` (`Route.Downloads`), `DownloadRow`, `SeasonJobCard` (running, paused
  with Carry on, finished; "N of M"), `MiscGlyph` (Segoe glyphs these screens use that `Glyph` lacks).
- `UI/LocalPlayerView.cs`: `LocalPlayerView` (`Route.Player`), `CaptionOverlay`, `UpNextCard`.
- `Playback/LocalPlayer.cs`: `LocalPlayback` on a `MediaPlayer` (`CommandManager.IsEnabled = false`). Beyond the
  stand-in's members: `Player`, `Caption`, `SecondCaption`, `CaptionStyle`, `CaptionChanged` (captions only, up
  to 4/s), `SubtitleTracks`, `SelectedSubtitleId`, `SecondSubtitleId`, `DidEnd`, `IsFading`, `IsStopped`,
  `AddSubtitles(path)`, `Host` ("This PC"). `Changed` fires for play state, tracks and selection, not position.
  Resume at the saved place (`MediaPlaybackItem(source, start)`), progress, sessions, watched status and
  `Downloads.NotePlayback` are saved exactly as the Mac does (every 5 s while playing, and on end and stop).
- `UI/Sheets.cs`: `Sheets.For` (SheetHost), `Sheets.Frame` (SheetFrame), `Sheets.FieldLabel`, `AddSiteSheet`,
  `EditSiteSheet`, `AddTitleSheet`, `RelinkSheet`, `NewChallengeSheet`, `MetadataResults`, `SeriesDownloadSheet`,
  and `DebouncedSearch` (220 ms, the Mac's `debouncedSearch`; the command bar uses it too).
- `UI/ImportSheet.cs`: `ImportSheet` over `BrowserImporter.Discover/Scan(source, ParserRecognizer.Shared)` and
  `LibraryStore.ApplyImport`, then `Metadata.Enrich(..., inBackground: true)` for new titles.
- `UI/CommandBar.cs`: `CommandBarView` and `CommandBarView.DirectUrl(text)` (the Mac's `CommandBar.directURL`).
- Registered in `Pages.For` and `Overlays.Sheet/CommandBar`. `Overlays.SeriesDownload` is a new layer in
  `OverlayHost` between the sheet and the command bar: it follows the session's `Seasons.Changed`, and its
  dimmed backdrop (and Esc, and Not now) calls `Seasons.Decline()`.

## Kit additions (use these rather than writing new ones)
- `Inputs`: `Field(placeholder, text, changed, submit, size, focus)` (the Mac's InputField; lightweight-styled
  TextBox with no accent underline), `Paint(box, plain)` (again after a theme change), `FocusWhenLoaded`,
  `Checkbox(isOn, changed, content)` (silver tint), `Picker(options, selected, changed, enabled)` (small pop-up
  button), `Spinner(size)`, `MenuButton(content, fill, help)`, `ShowMenu(anchor, fill, at)`, `Item`, `Choice`
  (ticked), `Header` (greyed section title), `Separator`.
- `ProgressLine` (a progress line whose `Fraction` changes in place), `ByteCount.File` (ByteCountFormatter
  `.file`), `DateText.Relative` (in a `partial class DateText`; Day/Time are the library port's).
- `Ui.Detached()`: takes a kept element out of its old parent before a render places it again.
- `Component.WatchHandler(subscribe, unsubscribe, onChange?)` for `EventHandler` events (Core's `Changed`).
- `Buttons.Silver(title, glyph, ...)`, `Buttons.Outline(title, glyph, ...)`; `palette:` on Silver, Hover and Icon
  draws a button in another palette (the player's bar and up-next card are always dark, like the Mac's).

## Patterns worth copying
- Never rebuild an element that's being clicked or typed in on a frequent update. Downloads raise `Changed`
  about 5 times a second: rows update progress in place and rebuild only when what they show changes. Sheets
  build their fields once; what changes while typing is a separate `Live` that rebuilds alone.
- Elements kept across renders (fields, the scroll view, the MediaPlayerElement) go through `Detached()` before
  being placed again; a component that returns the same root keeps it (`ReferenceEquals(Content, root)`).
- MediaPlayer events arrive on other threads; `LocalPlayback` queues them onto the UI thread and polls
  position on a 250 ms DispatcherQueueTimer, the Mac's periodic time observer.

## Temporary, to resolve at merge
- `PortStandIns.cs`: extension members for what other ports add: `ProfileSession.Downloads`, `.Seasons`,
  `.Metadata` (they throw until port-browser's real properties exist), `.Tracker` (`Relink`, `Ignore`; no-op),
  `BrowserTab.Parsed` and `.FaviconUrl` (null), and `TogetherModel.CreateChallenge` (the Together port deletes
  the app's TogetherModel stub, so that block stops compiling then). Instance members win over extensions, so
  once the real ones are merged the file is dead: delete it. `ProfileSession.cs` calls `this.Downloads` and
  `this.Metadata` so the stand-ins resolve; the `this.` can go after.

## Left for others
- port-browser: the TODO(after core merge) sites it owns (AddCurrentPageToBacklog, ActivePlayer.Ref, the Now
  Playing name, DownloadCurrentVideo, Seasons.Start/StartSeries, RefreshPills, Seasons.Suspend), the three
  session properties, `IDownloadHost`, `IRequestContext`, `IEpisodeResolver`, `WatchTracker.Relink/Ignore`,
  `BrowserTab.Parsed/FaviconUrl`.
- port-together / social: `Cloud.Start/Stop` sites; `CreateChallenge` lands with Core's TogetherModel.
- RootView (MainCard) port: the player draws its own screen frame (inset 10/12/12/12, radius 12, hairline),
  because PageHost has none. If PageHost gains MainCard's frame and ambient light, drop `PaintFrame`'s inset.
- Images: `AmbientModel.SetFromImage` (`ImagePipeline.ZonesAsync`) is still a TODO elsewhere.
- Check on Windows: the transport controls (no full-window button in WinUI 3's MTC; a full-window request is
  turned into the app's full screen), MediaComposition thumbnails of `.ts` downloads, the FullScreen presenter
  round trip, the TextBox/CheckBox resource keys, dropping `.srt` from File Explorer onto the film.

## Not 1:1
- Text names Windows things: Show in File Explorer, Move to Recycle Bin, Ctrl+Shift+S, Ctrl+T, "this PC". The
  timeline's host for films watched from a download is "This PC" (Mac rows say "This Mac").
- The Downloads header shows the full folder path; the Mac shortens the home folder to `~`.
- Player controls are MediaPlayerElement's transport controls, not AVKit's floating ones: no picture in
  picture, no AirPlay. Full screen is a button in AirPlay's place, a double click on the film or F11; it puts
  the window in the FullScreen presenter and hides the app's bars through Cinema mode, so Esc and Ctrl+Shift+C
  leave it. With the player focused, Space plays or pauses and Left/Right skip 10 s.
- The up-next card sits 88 px higher than the Mac's, above the transport controls that span the bottom.
- `ApplyCaptionStyle` sizes the subtitle files Cineon draws; a file's own text tracks use the Windows caption
  settings (the Mac sets AVTextStyleRules on them). The site style's text shadow is a composition DropShadow.
- Ambient light reads a 48 x 27 MediaComposition thumbnail at the nearest key frame, one at a time when ambient
  light asks (1.5 s), instead of AVPlayerItemVideoOutput frames. After three failures it stops trying.
- A file that can't play shows a toast ("Couldn't play ..."); AVPlayerView shows its own error symbol.
- `Rate` is MediaPlayer's rate, which a paused player keeps (the Mac reports 1 while paused either way).
- Menus: the subtitles menu's inline pickers are ticked items under a greyed title. The sleep and subtitle
  icons have no filled Segoe variant; they brighten when on. The paused job card shows a plain pause glyph.
- Text fields show Windows' clear button; checkboxes and the pop-up picker are Fluent controls in silver.
- The series sheet's adaptive grid is worked out once for the sheet's fixed width (4 columns).
- The catalogue's poster row scrolls sideways with Shift+wheel or a touchpad, as WinUI's horizontal
  ScrollViewer does.
- `DateText.Relative` writes English only; `ByteCount.File` uses English units with the locale's decimal mark.
- Overlays animate with PopupThemeTransition (the host's), not the Mac's 0.96 scale and fade.
