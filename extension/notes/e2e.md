# End-to-end test (e2e/, playwright.config.ts) and releases

The port of `fixtures/e2e.py`: a real Chromium with the unpacked development build, driven through the
debug hooks (`self.cineonDebug.run(type, query)`, notes/runtime.md) against the fake streaming site
(`fixtures/server.js`). Same sections, same check names where the check is the same, the same
`N of M passed` at the end.

## Running it

```
cd extension
npm ci --legacy-peer-deps
npx playwright install chromium            # once (CI: --with-deps)
make -C .. fixtures/film.mp4 fixtures/hls/index.m3u8   # needs ffmpeg
npm run e2e                                # node scripts/build.mjs --dev && playwright test
CINEON_E2E_ONLY=autopilot,rescue npx playwright test   # some sections (as e2e.py)
```

| Variable | Does |
| --- | --- |
| `CINEON_E2E_ONLY` | comma-separated sections: `main ui autopilot rescue frame awake tools downloads season series alerts together cloud profile chrome memory` (the `[section]` in each test's title; `--grep` works too) |
| `CINEON_E2E_HEADLESS=1` | Chrome's new headless mode instead of a window (CI runs a window under `xvfb-run`) |
| `CINEON_E2E_SLOW` | stretches every wait (default 1.5 when `CI` is set, else 1) |
| `CINEON_E2E_REAL_AUTOPLAY=1` | keeps Chrome's autoplay rule (see "Not 1:1") |
| `CINEON_E2E_METADATA=1` | keeps metadata lookups on (off by default: nothing asks the real catalogue) |
| `CINEON_TOGETHER_URL` | another Together deployment (default: the dev one; the production one is refused) |
| `CINEON_E2E_CHROME` | another browser binary (default: Playwright's Chrome for Testing) |
| `CINEON_E2E_REUSE_SERVER=1` | use a fixture server already on the port (it remembers the hosts rescue killed: restart it between runs) |
| `CINEON_E2E_KEEP=1` | keeps each section's browser profile and downloads (the folder is printed) |
| `CINEON_E2E_PORT` | the fixture site's port (8765) |

Output: `playwright-report/` (HTML, with every attachment), `test-results/<test>/` (screenshots of
every screen in `screens/`, `chrome-N.log`, and for failures `state-*.txt`, `screen-*.png`,
`console-*.txt`), `test-results/e2e-summary.txt` and `e2e-checks.json` (every check), and on GitHub
the step summary.

## How it works

- **One browser per section.** Each test is one e2e.py section (the main walk-through is split into
  its parts) with a fresh browser profile, so a failed or hung section can't spoil the next. Checks
  are soft: a failing check is recorded, printed (`  FAIL  name   [detail]`), marked in the report,
  and the section carries on, as in e2e.py. A section that throws counts as one more failure
  ("section '…' finished without an error", as e2e_windows.py). `e2e/reporter.ts` prints the total.
- **On every failure** the test attaches the `state` and `tabs` dumps; for the first eight, a
  screenshot of the selected tab and the console of the pages and of the service worker (captured by
  wrapping `console` in the worker). Every section attaches its final `state`.
- **The browser is started by hand and Playwright connects over CDP** (`e2e/cineon.ts`), not with
  `launchPersistentContext`, so the series section can kill the browser (`SIGKILL`) and start it again
  on the same profile, as e2e.py kills and restarts the app, and pages keep the window's size.
  Playwright takes over every download even then (random names in its own temporary folder), so after
  connecting the harness gives them back (`Browser.setDownloadBehavior` `default`): `chrome.downloads`
  names and places files as for a person, in this run's folder (the profile's preferences set it and
  turn the save dialog off), under `Cineon/`.
- **If Playwright loses the worker** (it happened once locally, mid-section), the harness waits for it,
  wakes it with an extension page, then connects over CDP again; the error names the workers the
  browser lists.
- **The extension's id** is computed from the folder (SHA-256 of the path, as Chrome does for unpacked
  extensions); the worker is `chrome-extension://<id>/background.js`. A browser's own component
  extensions have workers called `background.js` too, so it isn't enough to take the first one.
- **e2e.py's SQL** reads the same stores in IndexedDB (`rows("sessions")` etc., the SQLite column
  names), through `self.cineonDebug.runtime.ready()` in the worker. Frame images are read from the
  `frame_files` store and judged in the worker (8×4 pixels, max − min of the bytes, e2e.py's
  `is_real_picture`); proportions from the decoded image.
- **Clicks are real**: `page.mouse.click` on the Playwright page showing the selected tab (CDP input
  events are trusted). media.js's banner has a closed shadow root, so its buttons are found through
  DevTools' DOM (`DOM.getDocument` with `pierce`) and clicked in the middle; e2e.py's "card's right
  edge less 75" is the fallback.
- **Requests the pages send** (`search.everywhere`, `shields.state`) go from a popup page opened in a
  background tab, through `chrome.runtime.sendMessage`, as the UI sends them.
- **The popup** is opened as a page (the toolbar's popup can't be opened by Playwright) with
  `chrome.tabs.query` told which tab is active, so it shows that film's tab.
- Chrome flags: `--use-mock-keychain` and `--password-store=basic` (on a Mac, without them Chrome
  waits on the keychain and pages never load — that is what kept an earlier probe "off the
  network"), `--disable-backgrounding-occluded-windows` (a covered window still counts as visible, for
  frames and ambient), `--autoplay-policy=no-user-gesture-required` (below), and the component
  extensions off. On Linux CI also `--no-sandbox --test-type`, as Playwright's own launch does
  (Ubuntu 24.04 can refuse Chrome's sandbox); `CINEON_E2E_SANDBOX=1` keeps the sandbox.

## Checks against e2e.py

e2e.py has 220 checks (counting each of the route loop's four, and leaving out "a film to rate", which
only appears when adding a title fails). Ported: 192. Skipped with a printed reason: 28. New: 24.

Skipped (the reason is printed with each):

| Section | Checks | Why |
| --- | --- | --- |
| main | fake download blocked | the download shield isn't ported (notes/runtime.md) |
| main | a clicked-through search result survives as a tab; untouched search results are cleaned up | search results are ordinary (grouped) browser tabs; Cineon never closes them |
| main | cookies don't leak between profiles | Cineon's people share the browser profile's cookies |
| main | the 8 import checks | the extension imports this browser's history from the Import sheet; no other browsers' files, no debug command |
| tools | Siri's play or pause plays it again | no Siri/App Intents (`remote cmd=play` resumes instead) |
| downloads | the native player starts; the screen stays on in the native player too; downloaded subtitles show in the player; ambient light follows the downloaded film; leaving the player lets the Mac sleep; its place is kept; watching it goes on the timeline | no player of Cineon's own (`chrome.downloads.open`) |
| season | the next downloaded episode is offered at the end; and plays; the watched episode goes to the Bin | the same |
| chrome | the 4 traffic-light checks | the Mac's own window chrome |
| memory | app process stays light | no app process of its own |

Ported, but checked another way (same name unless said):

- Startup: "all five rule lists compile on first launch" is the five static rulesets enabled
  (`getEnabledRulesets`); "over 100,000 blocking rules active" sums the apps' rule counts of the
  enabled lists as Settings shows them (`shields.state`).
- "pop-up was blocked, no new tab", "closing the tab leaves none open": web tabs in `tablist`, since
  the browser keeps a blank tab of its own.
- "a new tab has nothing to go back to": `history.length` in the page (the browser's back button).
- Hostile navigation adds the fixture site as one of the person's sites first: the extension shields
  redirects only on pages it has a stake in.
- Rescue, another address of the same site: the film plays for a moment on the other address first
  (e2e.py only opens it). The Mac's history has every page; the extension remembers hosts only where
  something was watched, so an address merely opened isn't a known mirror.
- "a video that errors starts looking elsewhere" / "a video that hangs is noticed": the extension asks
  inside the player (`rescue|This video stopped.` / `…is stuck.`) instead of searching by itself (it
  can't tell fullscreen from outside); the first presses the banner's "Find another source" and
  checks a search started.
- Awake: `stayAwake` in the state (what Cineon asked `chrome.power` for); macOS's `pmset` is the Mac's.
- "a subtitle file shows as a second line over the film": the page's player loads the subtitle file
  (an extension can't open one from disk), then `subs2 index=0`.
- "Control Center shows what's playing": `nowplaying`, the tab whose media the browser's controls show.
- "the sleep timer fades the sound out": the film is first made to play again (the media key, then the
  video itself; e2e.py uses Siri) and its clock must move a second, so the check can't pass or fail on a
  film that isn't playing; the fade counts if `sleepstate` says `fading=true` or `faded=true` (the
  latest timer started its fade, kept after it ends, since a fade with no sound to fade can be over
  between two looks). On the first Linux CI run the film had stalled with no sound card, the timer
  simply ran out, and the check read as a missing fade.
- Frames: "the frame is a file on disk" counts `frame_files` entries.
- Downloads: "it's in the downloads folder" is `<browser downloads>/Cineon/`. "the stream saves as a
  package" (.movpkg) is **"the stream saves as one file"** here (.ts or .mp4, over 1 MB).
- Series: "after a crash it's still there, paused" kills the browser, not the app.
- Cloud: the secret is read from `chrome.storage.local` (`together:<profile id>`), the apps' together.json.
- "the {route} page opens": the Cineon page's `main.route-<route>` after `route to=…`; the share card
  is the Profile page's "Save a share card" button and the PNG it downloads.
- Every section starts in its own browser, so sections e2e.py runs on top of earlier ones set up what
  they need (the profile section seeds the demo library, hibernation opens a second tab, profiles
  adds a title first).

New (not in e2e.py): "the browser accepts every converted rule" (startup), and the `[ui]` section:
every route of the Cineon page in both themes (16, each with a screenshot), the side panel in both
themes, no uncaught errors in the Cineon page, the popup on a browser page and on a film's tab in
both themes (screenshots too).

## Not 1:1

- **Autoplay.** The Mac's web views may start a film with sound by themselves; Chrome only lets a page
  that someone clicked (or navigated to from a clicked page of the same site) do that. The test runs
  Chrome with `--autoplay-policy=no-user-gesture-required` so Cineon's own logic is what's tested;
  `CINEON_E2E_REAL_AUTOPLAY=1` shows what a person who never clicked gets ("and with its sound on"
  and "a film to try them on plays with sound" then depend on Chrome's media engagement).
- **The worker never idles.** Playwright is attached to the service worker through DevTools, and an
  attached worker isn't stopped after 30 s. The keep-alive under a real idle stop is still untested.
- **Metadata** lookups are off in every profile (e2e.py's first profile has them on) so nothing
  depends on the real catalogue; `CINEON_E2E_METADATA=1` turns them back on.
- **Firefox** is checked by `web-ext lint --self-hosted` only (0 errors; warnings: no
  `data_collection_permissions` in the manifest, which AMO will need, two `innerHTML` assignments in
  the bundled UI, and a coin-miner false positive from EasyPrivacy's host list); the end-to-end test is
  Chromium.

## Runs (macOS, Chrome for Testing 156.0.8078.4, headed, 2026-11-08)

**Now: 216 of 216 passed (28 skipped)**, every section, in 10 minutes.

The first local run gave 205 of 210 and the first Linux CI run (42430935758) 204 of 210. The failures
were four bugs in the extension, each reproduced on its own and fixed there (with a unit test), and one
Linux-only observation:

1. **Redirect shield missed dead targets** ("scripted redirect blocked", "redirect counted"). The
   fixture redirects to `ads.example.test`, which doesn't resolve: Chrome fires `onBeforeNavigate` then
   `onErrorOccurred` and never commits, and the shield only acted on commits (`didCommit` →
   `checkRedirect`), so the tab was left on the error page. Fixed by stopping the redirect in the page
   before it leaves, as the Mac does: the Navigation API's `navigate` event, in the isolated world, with
   the background saying which pages are shielded (notes/runtime.md; `content/redirectShield.ts`).
2. **Protected direct downloads got 403** ("the file downloads with the page's cookie and address").
   Measured with a logging server: the download carried the cookie but no Referer. No
   declarativeNetRequest rule, whatever its condition, reaches a `chrome.downloads` request, and the
   API refuses a `Referer` header. Fixed by fetching direct files in Chrome through the stream worker
   (byte ranges into OPFS, joined, handed over as a blob), where the rules apply (notes/downloads.md).
3. **The HLS stream was saved as `Only Film.txt`** ("the stream saves as one file"). Chrome reads an
   untyped blob as `text/plain` and replaces `.ts` with `.txt` (checked: a `video/mp2t` blob keeps `.ts`).
   The OPFS file has no type; the hand-off now uses a typed slice of it.
4. **Rescue skipped the sibling address** ("a dead address moves to another address of the site"). The
   live rescue's `knownHosts()` held only the dead host: the film watched on the other address had its
   session carried on under the new host (the tracker's merge window), and the page itself was never in
   the history, because the history rule ("pages that had a film") was checked before tracking began.
   Fixed by recording a film page when tracking starts (`Browser.noteWatched`).
5. **Linux: "the sleep timer fades the sound out"** (CI only). At the check the film sat at 40.86 s
   since the section began at 40 s, `track=-1`, and the toast was "Sleep timer paused the film": with
   no sound card (Chrome's ALSA output fails on the runner) the film playing with sound had stalled, so
   the timer had nothing playing to fade and simply ran out, which is what it should do. The check now
   makes sure the film plays and moves before setting the timer, accepts `faded=true` (a fade remembered
   after the timer ends, so a quick one can't slip between looks), and CI gets a PulseAudio null sink.
   Not verified on Linux from here.

Also seen once: Playwright lost the service worker mid-section (the frames section, after a quiet
32 s); it didn't happen again, and the harness now recovers (above).

## CI and releases

- `.github/workflows/extension.yml`: on pushes touching `extension/**`, `fixtures/**`,
  `Cineon/Resources/Scripts/**` or the workflow, and by hand (`e2e_only`: sections, empty for all,
  `none` to skip the end-to-end test). Ubuntu, Node 22: `npm ci --legacy-peer-deps`, Vitest, `tsc`
  (the extension and `e2e/`), the release build with `--package` (checked for `cineonDebug` and
  `__DEV__`), `web-ext lint` on `dist/firefox`, the zips as an artifact; then `--dev`, Playwright's
  Chromium with its system libraries, ffmpeg, the fixture media, a sound card (a PulseAudio null
  sink: the runner has none, Chrome's ALSA output fails and a film playing with sound stalls), and
  the test in a window under `xvfb-run`. The report and `test-results/` (screenshots, logs) are
  artifacts.
- `.github/workflows/extension-release.yml`: on `v*` tags (and by hand with `tag` and `dry_run`, as
  windows-release.yml): checks `extension/package.json` has the tag's version, runs Vitest, builds
  `--package`, lints, waits for the release the Mac script makes, and uploads
  `Cineon-extension-<version>-chrome.zip` and `-firefox.zip`. A dry run keeps them as an artifact.
- `scripts/release.sh` sets the extension's version with `npm version <v> --no-git-tag-version`
  (package.json and package-lock.json) and commits them with the release.
