# Cineon for Windows

The goal is a 1:1 copy of the Mac app: the same screens, features and behaviour, and the same data
formats, so a profile folder copied from a Mac opens on Windows. The Mac app in `../Cineon` is the
spec. When the two disagree, the Mac app is right.

## Stack

| Mac | Windows |
| --- | --- |
| Swift 6, SwiftUI, AppKit | C# 14 on .NET 10, WinUI 3 (Windows App SDK 2.6), **no XAML files**: UI is built in C# |
| WKWebView | WebView2 (Chromium) |
| SQLite through the C API | Microsoft.Data.Sqlite, same schema and migrations |
| Sparkle | Velopack, from the same GitHub releases |
| AVFoundation player | MediaPlayerElement (Windows.Media.Playback) |
| Media keys / Now Playing | SystemMediaTransportControls |
| UserNotifications | AppNotificationManager |
| Futura / SF | Jost (bundled, OFL) / Segoe UI Variable |
| SF Symbols | Segoe Fluent Icons |
| `~/Library/Application Support/Cineon` | `%LOCALAPPDATA%\Cineon` (override: `CINEON_DATA_DIR`) |
| `~/Movies/Cineon` | `%USERPROFILE%\Videos\Cineon` |

## Projects

- `Cineon.Core` (`net10.0`): everything that isn't Windows UI: models, database, library store and
  queries, title parsing, metadata, rescue matching, episode links, filter conversion and matching,
  profile stats, the pixel pet (as pixel data), Together client, cloud backup, browser import,
  downloads (HTTP and HLS), season and series jobs, subtitles, settings. **Builds and tests on any OS.**
- `Cineon.Core.Tests`: xUnit v3. Port each Mac test in `../CineonTests` that covers Core code.
- `Cineon.App` (`net10.0-windows10.0.19041.0`): the WinUI app: window, pages, WebView2 tabs and the
  page-script bridge, playback, native player, notifications, media keys, debug commands.

Shared with the Mac app and linked from `../Cineon/Resources`, never copied:
`Scripts/*.js` (injected into every page) and `Filters/*.txt`.

## Checking on a Mac

```
make win-test    # dotnet test Cineon.Core.Tests
make win-check   # type-checks Cineon.App with MacCheck=true (skips the Windows-only PRI step)
```

Real builds, the app's first run and the end-to-end tests happen on GitHub's Windows runners
(`.github/workflows/windows.yml`), which upload screenshots as artifacts.

## Conventions

- Keep the Mac names: `TitleParser`, `RescueMatcher`, `LibraryStore`, `SeasonGrabber`. Types and
  methods are PascalCase, so `TitleParser.parse(...)` becomes `TitleParser.Parse(...)`. Swift enums
  with raw values become C# enums, with a `ToRaw()`/`FromRaw()` pair that keeps the same strings in
  the database and JSON.
- Namespaces: `Cineon.Core.Data`, `.Parsing`, `.Metadata`, `.Shields`, `.Profile`, `.Together`,
  `.Downloads`, `.Import`, `.Settings`; `Cineon.App.UI`, `.Browser`, `.Playback`, `.Services`.
- Same SQLite tables, columns, indexes and migration steps as `Database.swift`, and the same JSON
  shapes as the Mac app for `profiles.json`, settings, `download-job.json` and everything sent to the
  server. Dates are stored the way the Mac stores them.
- Async work uses `Task`. The UI thread is reached through `DispatcherQueue`. Core has no UI types.
- User-facing text is copied from the Mac app word for word, except where it names Mac things (⌘
  becomes Ctrl, Finder becomes File Explorer, "this Mac" becomes "this PC").
- Shortcuts: ⌘ becomes Ctrl, ⌥ becomes Alt, ⇧ stays Shift.
- Page scripts call `window.webkit.messageHandlers.<name>.postMessage(body)`. On Windows a small
  shim, injected first, sends `{handler, body}` through `chrome.webview.postMessage`, so the shared
  scripts don't change.
- No secrets in the repo.

## Port map

Status: `todo`, `wip`, `done` (ported and tested), `n/a` (no Windows equivalent).

### Core
| Mac | Windows | Status |
| --- | --- | --- |
| Core/Models.swift | Core/Data/Models.cs | done |
| Core/SQLite.swift, Core/Database.swift | Core/Data/Database.cs | done |
| Core/LibraryStore.swift | Core/Data/LibraryStore.cs | done |
| Core/LibraryQuery.swift | Core/Data/LibraryQuery.cs | done |
| App/ProfileStore.swift (+ AppPaths) | Core/Data/ProfileStore.cs, AppPaths.cs | done |
| Core/TitleParser.swift | Core/Parsing/TitleParser.cs | done |
| Core/RescueMatcher.swift | Core/Parsing/RescueMatcher.cs | done |
| Core/EpisodeLinks.swift | Core/Parsing/EpisodeLinks.cs | done |
| Core/Metadata.swift | Core/Metadata/MetadataService.cs | done |
| Core/Images.swift | Core/Metadata/ImageCache.cs | done |
| Shields/FilterConverter.swift, FilterEngine.swift, ShieldState.swift | Core/Shields/* (request matcher + cosmetic CSS) | done |
| Profile/ProfileStats.swift | Core/Profile/ProfileStats.cs | done |
| Profile/PixelPet.swift | Core/Profile/PixelPet.cs | done |
| Core/TogetherClient.swift | Core/Together/TogetherClient.cs | done |
| App/CloudLibrary.swift | Core/Together/CloudLibrary.cs | done |
| Core/BrowserImport.swift | Core/Import/BrowserImport.cs (Chrome, Edge, Brave, Arc, Opera, Vivaldi on Windows) | done |
| Downloads/DownloadCenter.swift | Core/Downloads/DownloadCenter.cs | done |
| Downloads/SeasonGrabber.swift | Core/Downloads/SeasonGrabber.cs (job model + planning) | done |
| Downloads/Subtitles.swift | Core/Downloads/Subtitles.cs | done |

### App
| Mac | Windows | Status |
| --- | --- | --- |
| App/CineonApp.swift | App/Program.cs, App.cs, menus become keyboard accelerators | done |
| App/AppModel.swift, ProfileSession.swift | App/AppModel.cs, ProfileSession.cs | done |
| UI/Theme.swift | App/UI/Theme.cs (Palette, Typeface, button styles) | done |
| UI/RootView.swift, TopBar.swift, Sidebar.swift | App/UI/MainWindow.cs, TopBar.cs, BrowserBar.cs | done |
| Browser/* | App/Browser/* (WebView2 tabs, script bridge, tracking, rescue, autopilot, frames) | done |
| App/Playback.swift, StayAwake.swift | App/Playback/* (SMTC, sleep timer, SetThreadExecutionState) | done |
| Downloads/LocalPlayback.swift | App/Playback/LocalPlayer.cs | done |
| App/EpisodeAlerts.swift | App/Services/EpisodeAlerts.cs (app notifications) | done |
| App/TogetherModel.swift | App/TogetherModel.cs | done |
| UI/HomeView, LibraryView, TitleDetailView, WatchTimelineView | App/UI/Pages/* | done |
| UI/DownloadsView, PlayerControls, Sheets, CommandBar | App/UI/* | done |
| UI/TogetherView, ProfileView, ProfilePicker, RateModeView, Rating | App/UI/* | done |
| UI/SettingsView, ImportSheet, RescueView, Splash | App/UI/* | done |
| App/DebugCommands.swift | App/DebugCommands.cs (local HTTP port in Debug builds on scratch data) | done |
| App/Updater.swift | App/Updater.cs (Velopack) | done |
| App/Intents.swift (Siri, Shortcuts) | Jump List tasks | done |
| AirPlay | n/a | n/a |

## Notes from the ports

`windows/notes/*.md` hold each port's API summary and what isn't 1:1. Read them before building on a
piece. Shared text keys (`LibraryText.Normalize`, `LibraryText.CanonicalGenre`) live in Core.Data;
other ports call those instead of keeping copies.

## Releases

Velopack installs the app into `%LOCALAPPDATA%\Cineon.App` (pack id `Cineon.App`). Data lives in
`%LOCALAPPDATA%\Cineon`, a different folder, because Velopack's uninstaller deletes its own folder.
Never change the pack id after the first Windows release: installed copies would stop updating.

One version number for both platforms. `make release` publishes the Mac build and pushes the tag.
The Windows workflow runs on the tag, builds win-x64 and win-arm64, packs them with Velopack and adds
`CineonSetup.exe`, the portable zip and Velopack's feed files to the same GitHub release.
