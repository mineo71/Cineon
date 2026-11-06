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
| Core/Models.swift | Core/Data/Models.cs | todo |
| Core/SQLite.swift, Core/Database.swift | Core/Data/Database.cs | todo |
| Core/LibraryStore.swift | Core/Data/LibraryStore.cs | todo |
| Core/LibraryQuery.swift | Core/Data/LibraryQuery.cs | todo |
| App/ProfileStore.swift (+ AppPaths) | Core/Data/ProfileStore.cs, AppPaths.cs | todo |
| Core/TitleParser.swift | Core/Parsing/TitleParser.cs | todo |
| Core/RescueMatcher.swift | Core/Parsing/RescueMatcher.cs | todo |
| Core/EpisodeLinks.swift | Core/Parsing/EpisodeLinks.cs | todo |
| Core/Metadata.swift | Core/Metadata/MetadataService.cs | todo |
| Core/Images.swift | Core/Metadata/ImageCache.cs | todo |
| Shields/FilterConverter.swift, FilterEngine.swift | Core/Shields/* (request matcher + cosmetic CSS) | todo |
| Profile/ProfileStats.swift | Core/Profile/ProfileStats.cs | todo |
| Profile/PixelPet.swift | Core/Profile/PixelPet.cs | todo |
| Core/TogetherClient.swift | Core/Together/TogetherClient.cs | todo |
| App/CloudLibrary.swift | Core/Together/CloudLibrary.cs | todo |
| Core/BrowserImport.swift | Core/Import/BrowserImport.cs (Chrome, Edge, Brave, Arc, Opera, Vivaldi on Windows) | todo |
| Downloads/DownloadCenter.swift | Core/Downloads/DownloadCenter.cs | todo |
| Downloads/SeasonGrabber.swift | Core/Downloads/SeasonGrabber.cs (job model + planning) | todo |
| Downloads/Subtitles.swift | Core/Downloads/Subtitles.cs | todo |

### App
| Mac | Windows | Status |
| --- | --- | --- |
| App/CineonApp.swift | App/Program.cs, App.cs, menus become keyboard accelerators | todo |
| App/AppModel.swift, ProfileSession.swift | App/AppModel.cs, ProfileSession.cs | todo |
| UI/Theme.swift | App/UI/Theme.cs (Palette, Typeface, button styles) | todo |
| UI/RootView.swift, TopBar.swift, Sidebar.swift | App/UI/MainWindow.cs, TopBar.cs, BrowserBar.cs | todo |
| Browser/* | App/Browser/* (WebView2 tabs, script bridge, tracking, rescue, autopilot, frames) | todo |
| App/Playback.swift, StayAwake.swift | App/Playback/* (SMTC, sleep timer, SetThreadExecutionState) | todo |
| Downloads/LocalPlayback.swift | App/Playback/LocalPlayer.cs | todo |
| App/EpisodeAlerts.swift | App/Services/EpisodeAlerts.cs (app notifications) | todo |
| App/TogetherModel.swift | App/TogetherModel.cs | todo |
| UI/HomeView, LibraryView, TitleDetailView, WatchTimelineView | App/UI/Pages/* | todo |
| UI/DownloadsView, PlayerControls, Sheets, CommandBar | App/UI/* | todo |
| UI/TogetherView, ProfileView, ProfilePicker, RateModeView, Rating | App/UI/* | todo |
| UI/SettingsView, ImportSheet, RescueView, Splash | App/UI/* | todo |
| App/DebugCommands.swift | App/DebugCommands.cs (local HTTP port in Debug builds on scratch data) | todo |
| App/Updater.swift | App/Updater.cs (Velopack) | todo |
| App/Intents.swift (Siri, Shortcuts) | Jump List tasks | todo |
| AirPlay | n/a | n/a |

## Releases

One version number for both platforms. `make release` publishes the Mac build and pushes the tag.
The Windows workflow runs on the tag, builds win-x64 and win-arm64, packs them with Velopack and adds
`CineonSetup.exe`, the portable zip and Velopack's feed files to the same GitHub release.
