# End-to-end test on Windows (DebugCommands.cs, fixtures/e2e_windows.py)

The Mac's `fixtures/e2e.py` drives a Debug build through `cineon://debug/...` links and reads replies
from `debug-output.txt`. Windows runs the same sections and checks against the same fake streaming
site (`fixtures/server.js`), but talks to the app over a local test port, and clicks with real Windows
input.

## Running it

On GitHub: `.github/workflows/windows.yml` runs it after the screenshots (which are uploaded first, so
the test can't hold them back). It installs ffmpeg (choco), tries to add Windows Server's Media
Foundation feature, makes `fixtures/film.mp4`, `short.mp4` and `hls/` with the Makefile's commands,
points `flix-alive.localhost`, `flix-dying.localhost`, `gone.localhost` and `nothing.localhost` at
127.0.0.1 in the hosts file, runs the test, and uploads `windows-e2e`: the log
(`e2e-windows.log`), `crash.log`, the app's last `/state`, the fixture server's log and a screenshot of
each section that failed.

On a Windows PC:
```
dotnet build windows/Cineon.App -c Debug -r win-x64
# fixtures: the three ffmpeg commands from the Makefile (film.mp4, short.mp4, hls/index.m3u8)
python fixtures/e2e_windows.py
```
It needs node, ffmpeg and ffprobe on PATH, takes 15 to 30 minutes, moves the mouse (real clicks)
and wants the window left alone while it clicks. Without the hosts entries above, the rescue checks
that probe `*.localhost` sites from the app (not the web view) may fail. From an administrator shell
staying awake is read from `powercfg /requests`; otherwise from the app's own report.

Settings: `CINEON_E2E_ONLY=autopilot,rescue` (section names: main, autopilot, rescue, frame, awake,
tools, downloads, season, series, alerts, together, cloud, profile, chrome, memory),
`CINEON_E2E_EXE`, `CINEON_DEBUG_PORT` (8790), `CINEON_E2E_SLOW` (1.5: every wait_until timeout is
stretched by this), `CINEON_E2E_BUDGET` (70 minutes, then the remaining sections are skipped and
counted as failures), `CINEON_E2E_ARTIFACTS`, `CINEON_E2E_DATA`, `CINEON_E2E_BROWSERS`,
`CINEON_E2E_KEEP=1`. `make e2e` on the Mac is unchanged.

## The test port
`DebugCommands.Start` (from `App.OnLaunched`) listens on `127.0.0.1:$CINEON_DEBUG_PORT` with a
`TcpListener` (no URL ACL needed), only when compiled with `DEBUG_COMMANDS` (the Debug configuration),
on scratch data (`AppPaths.IsScratch`, so `CINEON_DATA_DIR` is set) and with the variable set.

`GET /<command>?<query>` with the header `X-Cineon-Debug: 1` runs the Mac's command of that name on the
UI thread and answers with its reply as text. Requests without the header, with an `Origin`, or for
another Host get a 403, so a page in the test browser can't drive the app. Commands that wait for
something (a page script, the server, an import) answer when it's done; `debug()` in the Python waits
for the answer, where the Mac's only sends the link.

`cineon://debug/...` (DeepLink) runs the same commands and writes the reply to `debug-output.txt` in
the data folder, as the Mac does.

Windows additions: `/ping` (`pong`, once the UI thread answers), `/link?url=cineon://...` (what a second
launch would hand over), `/quit` (saves and exits, like closing the window).

## Commands
Every Mac command is ported with its parameters and reply format. Numbers print as Swift prints a
Double (`300.0`), Booleans as `true`/`false`, `/eval` results as WebKit's `"\(value)"` would (strings
bare, Booleans `1`/`0`, whole numbers without a point, `<null>` for nothing). Commands the Mac answers
with nothing answer `ok`.

| Command | On Windows |
| --- | --- |
| `/eval` | Top frame. `world=cineon` is ignored: WebView2 has no content worlds. |
| `/mediaeval` | The frame with the video (`BrowserTab.EvaluateInPlayerAsync`). |
| `/click?x=&y=` | Page coordinates from the web view's top left, through `SendInput` (move, press, release) at the screen point, after bringing the window forward. Pages get a trusted click with a user gesture, like the Mac's NSEvents. |
| `/windowclick?x=&y=` | The same at window coordinates (view pixels from the top left of the client area, which includes the bar). |
| `/fullscreen`, `/windowsize` | AppWindow's FullScreen/Overlapped presenter; `Resize` in view pixels. `animate` is ignored. |
| `/intent?name=` | Siri and Shortcuts don't exist here: runs the Jump List's link for the same action (`cineon://playpause`, `continue`, `next`, `sleep?minutes=`, `profile`). Unknown names answer `n/a`. |
| `/sharecard` | `ShareCard.RenderAsync` (Win2D) written to `share-card.png` in the data folder. |
| `/importreport` | `BrowserImporter.Discover(ImportRoots.Default)`, which reads `CINEON_IMPORT_ROOT`. |
| `/together`, `/cloud`, `/adopt`, `/checknew`, `/filterupdate` | Awaited, so the reply reflects the result. |
| `/seed` | Ported (`MetadataClient.Shared.SearchAsync` + `Metadata.ApplyAsync`). |

Nothing the Mac's DebugCommands does is AirPlay-only, so no command is `n/a` apart from unknown intents.

`/state` has the Mac's keys in the Mac's order, then Windows extras before `memory` (which the tests
read as the last line): `hibernated`, `ready`, `zoom`, `boost`, `best`, `sourcesFrame`, `selected`,
`pageFullscreen`, `awake` (StayAwake holds the display), `scale`. Keys whose meaning differs:
- `lights`: the caption buttons instead of the traffic lights: `<width>,<height>` in view pixels
  (`AppWindow.TitleBar.RightInset` and `Height`), or `fullscreen`.
- `window`: the HWND. `appActive`: the window is the foreground window. `windowVisible`: shown and
  not minimised (`MainWindow.IsShowing`; Windows can't tell when another window covers it).
- `memory`: the process's working set. WebView2 runs in its own processes, as WebKit's content does.
- `blocked`, `media`, `ambient` are formatted like Swift's descriptions (`ShieldStats(ads: 3, ...)`,
  `RGB(r: ...)`), because the checks look for those strings.

## Hooks added outside DebugCommands.cs
- `App.cs`: starts the port after launch (`#if DEBUG_COMMANDS`).
- `AppModel.Playback.cs`: `IsKeepingAwakeForTests` (`#if DEBUG_COMMANDS`), for `/state`'s `awake`.
- `Services/DeepLink.cs`: the `debug` host calls `DebugCommands.RunFromLink`.

## Checks: covered and skipped
The Mac has 218 `check` calls (221 at run time; the profile section checks four routes). Windows runs
all of them (the four window checks and the stream's file type as Windows versions), plus three of
its own (224 at run time when nothing crashes).

Run straight from `e2e.py` with the transport swapped (`debug`, `state`, `evaluate`, `media_eval`,
`read_debug`, `db`, `query`, `fetch`, `restart_app`, `keeps_awake`, `convex`, `check` and `wait_until`
are replaced in its module): autopilot, rescue, awake, tools, season, series, alerts, together,
cloud, profile. A change to those sections in `e2e.py` reaches Windows too; keep them free of
Mac-only calls (anything beyond the helpers above).

Windows versions in `e2e_windows.py`:
- main (the Mac's `run_tests` body): the search link is a real second launch of `Cineon.exe
  cineon://search?...` (new check: it hands the link over and quits; if it doesn't, `/link` stands
  in so the next checks still have a search); the import reads `/importreport`'s reply; the fake
  download is looked for in `%USERPROFILE%\Downloads`. New check: Chrome and Edge in their Windows
  folders (`Google\Chrome\User Data`, `Microsoft\Edge\User Data`) are found alongside the Mac-layout Arc.
- frame: `sips` becomes `ffprobe` for the picture's size.
- downloads: a stream saves as one `.ts` or `.mp4`, not a `.movpkg`; the timeline host is `This PC`.
- chrome: the traffic-light checks are skipped with a printed reason. In their place: the caption
  buttons fit in the bar, stay after a resize, come back after full screen, and a real click on the
  logo in the bar (a title-bar passthrough region) reaches the app.
- startup: also checks the data folder appears.
Check names that mention the Mac are renamed when printed ("the PC", "The media flyout", "The Jump
List's Play or Pause"); the conditions are the same. Staying awake reads `powercfg /requests`
(DISPLAY section, this exe) where the Mac reads `pmset -g assertions`; if powercfg can't be read, or
never lists the request while the app says it holds one, it falls back to `/state`'s `awake`.

Robustness the Mac's doesn't need: each section runs in its own try, so an exception fails that
section and the rest go on; a dead app is a failure (with the tail of crash.log) and is started again
on the same data; a failed check prints the main `/state` keys; a section with failures leaves a
screenshot; the summary lists every failure with its section.

## Likely trouble on the first runs
- Video: Edge decodes H.264/AAC through Media Foundation, an optional feature on Windows Server. If
  it isn't there (see the "Media Foundation" step's output), nothing plays: tracking, autopilot,
  rescue, frames, tools, the native player and the season downloads fail together.
- HLS: Chromium doesn't play `.m3u8` in a `<video>` by itself. The playlist check depends on media.js
  or the network sniffer still seeing the playlist when the video won't load.
- Clicks: `SendInput` needs the interactive desktop and the window in front. `/click` replies with
  `key=` (foreground or not) and `sent=` (events Windows took): look there first.
- Sound: the "next episode starts with its sound on" and keep-watching checks rely on WebView2 letting
  a page start sound without a gesture.
- Helper tabs (season and series downloads) are parked WebView2s; if players pause there, the
  season checks time out.
- `powercfg /requests` may not list SetThreadExecutionState; the fallback covers it but says so.
- The 400 MB memory check is the Mac's number for a working set.
