# Runtime (src/background, src/content)

The background and the content scripts that tie the ported pieces together: ports of the Mac's
`Browser/*` (BrowserTab, BrowserModel, WatchTracker, EpisodeAutopilot, Rescue, FrameCollector,
WindowCapture, WebKitEnvironment) and `App/*` (ProfileSession, AppModel's playback and stay-awake,
Playback's sleep timer, EpisodeAlerts, the TogetherModel host), checked against the Windows port
(`windows/Cineon.App/Browser/*`, `windows/notes/browser.md`, `windows/notes/app.md`). The browser owns
tabs, windows and web views; Cineon remembers what it knows about each tab and drives its pages through
the page scripts.

## Files

```
src/background/
  index.ts          every listener, registered synchronously at the top level; the debug hooks behind `if (__DEV__)`
  runtime.ts        Runtime: opens the ProfileSession on the first event after a wake, routes browser events and content messages
  session.ts        ProfileSession (SessionContext): db, library, settings, shields, metadata, downloads + seasons,
                    Together + cloud, alerts, playback, toasts; signals in and out; ToastCenter
  context.ts        SessionContext, Toasts, Notifier, SiteProber: what every piece sees (the Mac's `session`)
  tabState.ts       TabState (BrowserTab's state as plain data), MediaEvent, MediaState, LiveTrack, AutopilotState,
                    FrameState, RescueState, EpisodeExit
  tabs.ts           TabRegistry: every tab's state, saved to chrome.storage.session, read back and reconciled on wake
  browser.ts        Browser: BrowserModel + BrowserTab's commands, page messages, navigation, pop-up/redirect shields
  tracker.ts        WatchTracker
  autopilot.ts      EpisodeAutopilot (with the "no" guard: an automatic move never follows a "no")
  rescue.ts         SiteProbe (FetchSiteProbe), RescueEngine, the HTML link reader, probe tabs
  frames.ts         FrameCollector, FrameImage grading, ImageOps (createImageBitmap + OffscreenCanvas), ambient zones
  playback.ts       active player, sleep timer with fade, stay awake (chrome.power), the 1-second tick
  alerts.ts         EpisodeAlerts
  togetherBridge.ts TogetherHost + PartyPlayer over tabs, the identity store (chrome.storage.local `together:<profile>`)
  downloadsBridge.ts DownloadTab adapter, EpisodeResolver, the helper tab
  shieldsBridge.ts  ShieldState over the profile DB, ShieldRules, ShieldCounter, cosmetic CSS, `shields.state`
  snapshots.ts      TabSnapshot, DownloadsSnapshot, TogetherSnapshot for the pages
  uiHandlers.ts     answers every request in shared/messages.ts
  commands.ts       chrome.commands and the context menu
  keepAlive.ts      KeepAlive (see Lifetime)
  chromeApi.ts      the real browser behind Platform/Notifier/PageHub; clipboard
  platform.ts       Platform = TabsApi + PageCalls (the seam tests fake)
  debug.ts          the debug/* hooks (development builds only)
  env.ts            build target/version/dev, Clock, small helpers
src/content/
  isolated.ts       every frame, ISOLATED world, document_start: startIsolated(media.js, meta.js, theater.js)
  bridge.ts         startIsolated: the shim, the shield relay, hello/config, link gestures, keep-alive port, __cineonContent
  main.ts           every frame, MAIN world, document_start: shield.js with the relay as its `cineonShield`
  shieldRelay.ts    the MAIN ⇄ ISOLATED relay
  helpers.ts        __cineonContent: theater(on), viewport(), links() (the Mac's rescue harvest script)
  shim.ts           (from before) `globalThis.__cineonHandlers`: cineonMedia, cineonMeta, cineonMediaReply (Promise), cineonShield
  pageScripts.d.ts  `@page-run/*` modules
```

## Content scripts

- **No eval.** `scripts/build.mjs` gained an `@page-run/<file>.js` import that wraps the Mac's script, its
  handler lookup swapped for `globalThis.__cineonHandlers` as before, in `export default function run() { … }`.
  The scripts run inside the content script bundle; `@page/<file>.js` (the source as a string) still works.
- **Isolated world** (all frames, `match_about_blank`): media.js in every frame, meta.js in the top frame (it waits
  for DOMContentLoaded itself, as the Mac's document-end injection did). theater.js runs on demand through
  `__cineonContent.theater(on)` (the Mac runs it in the page world; it only touches classes and a style element).
- **Main world** (all frames): shield.js. Its only handler, `cineonShield`, goes through `shieldRelay.ts`: both
  worlds agree on a nonce before any page script exists (hello/ask/ack events on `document`, whichever starts
  first), then reports travel as events named `cineon-shield-<nonce>`, dispatched with the original
  `dispatchEvent` captured at document_start. A page can't listen for a name it doesn't know; `window.postMessage`
  (the first idea) would hand the nonce to every page listener with the first report.
- **Hello**: each frame sends `{cineon: "hello", top, url}`; the answer is `{noShield}` (the overlay sweeper off in
  settings, or shields off for the top page's site) applied as `data-cineon-noshield`, which shield.js reads on
  every click. The background inserts the frame's element-hiding CSS (`ShieldRules.cssFor(top page)`, a USER
  stylesheet, as the Mac) for the frame that said hello. Settings changes are pushed as `{cineon: "config"}`.
- **Gestures**: a trusted click with a modifier or the middle button on a link reports `{cineon: "gesture", link}`;
  the pop-up shield lets that new tab stay (the person asked for it).
- **Page calls** (`PageCalls.call`): `chrome.scripting.executeScript({world: "ISOLATED", injectImmediately: true})`
  calling `window[target][method](...args)` with target `__cineon` (media.js), `__cineonMeta` (meta.js) or
  `__cineonContent`. The content scripts share that world. 8 s timeout (a frame that never commits never answers).
  This is also the downloads port's `callPage`.

## Messages

- Content → background: the shim's `{cineon: 1, h, b, frame}` (`cineonMediaReply` is answered: `{seekTo, skips,
  play}` or null), `hello`, `gesture`. Messages from documents whose `documentLifecycle` isn't `active` (back/forward
  cache, prerender, a page being replaced) are dropped. A main-frame message from a `documentId` the tab hasn't seen
  commits that document first (the page can speak before `webNavigation.onCommitted` arrives).
- Pages → background: every request in `shared/messages.ts` (uiHandlers.ts). Signals out: `library` (after the
  background's own writes; a reload isn't re-posted, the same rule as the pages'), `settings` (after background
  writes: menus, debug), `profiles` (debug addprofile), `player` (≤ 1/s with a trailing post), `downloads` (≤ 4/s),
  `together`, `toast`, `navigate`. Signals in: `library` → reload (40 ms debounce), `settings` → reload and apply
  (ProfileSession.settings didSet), `profiles`, `profile` → switch, `sitePrefs` → reload ShieldState and the rules.
- Toasts (`ToastCenter`): a toast about a tab shows over its player as media.js's banner `toast` (with its button
  as action `action`, closures kept in memory), unless a more important banner is up (next episode, intro,
  rescue); otherwise a `toast` signal for the Cineon page and side panel, and a notification when none is open.

## Lifetime (MV3)

- **Listeners**: all registered synchronously in `index.ts` before any await; `chromeDownloads()`,
  `createStreamWorker()` and `DnrHeaderRules` are made there too (notes/downloads.md).
- **State**: tabs (TabRegistry, everything in TabState, debounced 400 ms) in `chrome.storage.session` key
  `cineon.tabs`; the sleep timer (`cineon.sleepTimer`); the shield counter checkpoint (`cineon.counterCheckpoint`);
  when the cloud last synced (`cineon.cloudSyncedAt:<profile>`); which profiles started this browser session
  (`cineon.started`); download header rules (DnrHeaderRules). The library and everything else is IndexedDB. On wake
  the first event opens the session (`Runtime.ready`), restores the tabs, drops tabs that closed meanwhile, treats a
  tab whose address changed meanwhile as navigated, and marks a rescue search that was running as finished.
- **Once per browser session, not per wake**: retrying missing metadata, pruning frames, Together's shares and
  challenges. The cloud backup's 3-second first sync runs only when the last sync is over 10 minutes old.
- **Alarms**: `cineon-alerts` (first after 1 min, then every 6 h; each check skips series checked in the last 6 h,
  as the Mac's 30-minute timer does), `cineon-cloud` (10 min), `cineon-hibernate` (5 min), `cineon-shields` (1 min,
  only in store builds where blocked requests are counted by polling).
- **Staying awake**: `KeepAlive` holds reasons (`playback` while a video plays or a sleep timer runs, `party` while
  a watch party is on, `downloads` while downloads or a season job are active). While any is held it calls
  `chrome.runtime.getPlatformInfo()` every 20 s (an extension API call resets Chrome's idle timer, Chrome 110+);
  in Firefox the playing tab's content script also holds a `cineon-keepalive` port and pings through it. Nothing is
  held otherwise: a paused film lets the worker sleep, and its next report wakes it.
- **Together**: the model lives in the background. Its challenge loop runs while a page asks about Together (each
  `together.*` request starts it; it stops 2 minutes after the last one unless a party is on). A party's 1-second
  loop is kept alive by the `party` reason.
- **Firefox**: the background is an event page (DOM, no offscreen API): streams run in it (StreamHost), object URLs
  are real, the clipboard is written directly, `getViews()` stands in for `runtime.getContexts()`.

## Debug hooks (development builds)

`node scripts/build.mjs --dev` (or `--watch`) defines `__DEV__`; `index.ts` installs `debug.ts` behind
`if (__DEV__)`, so release builds contain none of it (checked: no `cineonDebug`, no `eval` in the release bundle).
Two ways in:
- from the worker (Playwright `serviceWorker.evaluate` / CDP): `await self.cineonDebug.run("state", {...})`;
- from an extension page: `chrome.runtime.sendMessage({kind: "cineon/debug", type: "state", ...query})` →
  `{ok: true, value: "<text>"}` (content scripts are refused).

The answer is the Mac's debug-output text: `key=value` lines with the Mac's keys where they apply, `end=1` where the
Mac writes it. Query values may be strings or numbers. Commands:

| Command | Query | Does / answers |
| --- | --- | --- |
| `state` | | `profile`, `profileid`, `url`, `title`, `parsed` (`name\|year\|S1E2\|kind\|confidence`), `media` (`pos/dur playing=`), `track`, `linked`, `blocked` (`ShieldStats(...)`), `framesBlocked`, `ambientOn`, `ambient`, `tabs`, `tablist`, `helpers`, `toast`, `banner` (`id\|text\|offer\|countdown`), `rescue` (`reason\|stage\|site:path:strong;…\|countdown\|resume=`), `failure`, `frames`, `sites`, `theater`, `boost`, `best`, `sourcesFrame`, `sources`, `downloads`, `autopilot`, `sleep`, `awake`, `stayAwake`, `party`, `version` |
| `idle` | | waits for queued page reports, captures, rescue searches, metadata, downloads; saves the tabs |
| `tabs` | | one line per known tab (helpers and probes too) |
| `open` | `url`, `select` | new tab → `tab=<id>` |
| `resume` | `url`, `at`, `expected` | new tab resuming at `at`, expecting that length |
| `keepwatching` | `url`, `at` | AppModel.resume(url:at:) |
| `addsite` | `url`, `name`, `search` | adds a site with that search template |
| `eval` | `js` (page world) or `world=cineon&method&args&target` | the page's own world via `executeScript` MAIN (eval: development builds only); or a call in the isolated world |
| `mediaeval` | `js`, or `method` + `args` (JSON) | the same in the video's frame |
| `banner` | `banner`, `action` | as if media.js's banner button was pressed |
| `settings` | `minimumSeconds`, `finishThreshold`, `hibernateMinutes`, `captions`, and 0/1: `ambient metadata frames downloadButton voiceBoost binWatched playNext alerts cloud sharePet autoNext learnSkips autoRescue autoResume pauseOthers popupShield redirectShield sweeper blocking history` | saves, posts `settings` |
| `sitepref` | `host`, 0/1 `trackingOff shieldsOff allowPopups allowRedirects` | |
| `hibernate` | | discards every tab but the selected one |
| `selecttab` / `closetab` | `i` / | |
| `removesites`, `deletesession`, `deletetitle`, `addtitle`, `rate` | `id` / `name year kind status` / `id halves` | `addtitle` → `id=` |
| `download`, `downloads`, `playdownload` | / / `id` | `downloads`: `best=`, `folder=`, `source …`, `sniffed …`, `download\t…` rows, `end=1` |
| `season`, `seasoncancel`, `seasonconfirm`, `seasonresume`, `seasonstate` | `from=current\|series` | `seasonstate` as the Mac, plus `helper=` |
| `sleep`, `sleepstate` | `mode=end\|cancel\|seconds&s=\|m=` | |
| `nowplaying`, `remote` | `cmd=toggle\|play\|pause\|next\|forward\|back\|seek&to=` | |
| `voiceboost`, `subs2`, `subs2state` | `index` / `clear=1` | |
| `fakeepisodes`, `checknew` | `title`, `list=1x1:2024-01-01,…` | |
| `cloud`, `adopt`, `stats`, `together` | `do=sync` / `code` / / `code party=start\|leave react say challenge sharewatched addshared refresh dump=1` | as the Mac (+ `partyTab=` in the dump) |
| `moment`, `frames`, `findelsewhere`, `rescuetake`, `stallseconds`, `cinema` | / / / / `s` / | `frames`: per-session counts and moments; `cinema` toggles theater.js |
| `route`, `detail` | `to` / `id` | opens the Cineon page there |
| `seed` | | the Mac's demo library, without the catalogue |
| `addprofile`, `switchprofile` | `name`, `switch=1` / `name` | |

Not ported: `/click`, `/windowclick`, `/windowsize`, `/fullscreen` (Playwright drives the browser itself),
`/route` to a native route, `/theme`, `/commandbar`, `/sheet`, `/profiles` (UI), `/searchselect` (no search
session), `/importreport`, `/filterupdate`, `/updatecheck`, `/intent`, `/sharecard`, `/upnext`, `/player`,
`/playerseek`, `/localsubs` (no native player).

## Not 1:1, and why

- **The page being left is saved under its own address.** The Mac sets the new URL before saving the old page's
  progress (`urlChanged`, `load`), so the old episode's progress could point at the new address; here
  `tabNavigated` runs before the address changes.
- **Pop-up and redirect shields apply only to pages Cineon has a stake in**: the person's sites, pages with a long
  video, and pages that say they're a film or an episode (parsed with a year, an episode or a kind, or `og:type`
  video). The Mac app only ever shows films; the browser around the extension also shows the person's mail, bank and
  sign-ins, whose pop-ups and redirects must keep working. Pop-ups are closed after the browser opened them
  (`webNavigation.onCreatedNavigationTarget`); a link opened in a new tab on purpose stays. A redirect can't be
  cancelled in MV3, so a script sending a shielded page to another site (`client_redirect`, not trusted) is sent
  back (`tabs.goBack`), and the toast with Allow shows once the page is back. The download shield isn't ported: the
  browser's downloads are the person's for everything, and nothing ties one to a tab.
- **No rescue panel**: banners over the player (`rescue-search` with Open/Leave buttons, a countdown button for a
  strong match on a dead page), or a notification when the page itself failed to load (the browser's error page runs
  no content script). Video trouble always shows the Mac's in-page offer (`rescue`/`find`): the background can't
  tell whether the video is fullscreen. Search results are fetched first and read with a small HTML link reader (no
  DOMParser in the worker); a hidden probe tab in one small unfocused window is the fallback for script-drawn results.
  A running search doesn't survive the worker stopping.
- **Frames and ambient light**: the photograph is `tabs.captureVisibleTab` cropped to the picture (it includes
  hardware-decoded video, so there's no second window-capture step), so the tab must be the selected one. Ambient
  zones are kept on the tab (`ambient`, 0–255) and shown in the debug state; nothing in the extension draws the glow.
- **Toasts** about a tab are banners in its page; toasts from elsewhere are the pages' or a notification. An action's
  closure is lost if the worker stops before it's pressed.
- **Browsing history** is recorded (when the setting is on) only on the person's sites and pages that had a film:
  the extension sees all browsing, the Mac app only what's opened in it.
- **Hibernation** is the browser's discard, and only for tabs on the person's sites or with a film.
- **Playing a download** opens the file with the computer's player (`downloads.open`, permission added) or shows it in
  the folder; there's no player of Cineon's own.
- **Clipboard** (party and share codes): Chrome's worker has none, so the active web page writes it (works when that
  page has focus); the codes are in the Together snapshot either way.
- **Together's route** is "web" when a site is in front, else "other" (the background can't see a page's section).
- **Tabs open before the extension was installed or updated** have no content scripts until reloaded.
- **Captions, voice boost, second subtitles, the sleep timer** reach media.js the same way; the sleep timer is
  set from the context menu (and debug), as the pages have no control for it.

## Browser differences

| | Chrome / Edge | Firefox |
| --- | --- | --- |
| Background | service worker; `KeepAlive` pings an API | event page; also a content-script port |
| Streams | offscreen document | StreamHost in the event page |
| Subtitles' object URLs | `data:` URLs | blob URLs |
| Stay awake | `chrome.power` | none |
| Open pages | `runtime.getContexts` | `extension.getViews` |
| Notification buttons | yes | no (a click is the first button) |
| Tab groups (search everywhere) | yes | ignored where missing |
| Stale documents | `documentLifecycle`, `documentId` | not given (onCommitted order only) |
| Blocked-request counting | see notes/shields.md | see notes/shields.md |

## Tests

`test/background/` (Vitest, Node): `tracker`, `autopilot`, `runtime` (content routing, the shields, worker
restarts, page requests, signals), `playback`, `debug`, `tabState`, `rescue`, `frames` — a real ProfileSession over
fake-indexeddb with every browser seam faked (`fakes.ts`, `rescueFakes.ts`: manual clock, tabs, page calls, pages,
notifications, probe). `test/content/` (jsdom): the shield relay in both orders, the isolated world's start, config,
keep-alive port, link reports, the harvest script, theater.

## Checked in a real browser, and not

Checked in Chrome for Testing 1248 (headless, scratch profile, the dev build loaded through CDP's
`Extensions.loadUnpacked`): the worker starts without errors or warnings, the debug hooks answer, settings save,
`open` makes a tab, `idle` settles. Nothing that needs a page to load could be checked here: this machine's command
sandbox keeps the browser off the network, the fixture site on 127.0.0.1 included. So none of these has run in a
real browser yet, and the e2e test should start with them: content scripts in frames (media.js, meta.js, the shield
relay, hello and cosmetic CSS), `executeScript` page calls into a cross-origin player frame, playback reports into
tracking and resume, banners and their buttons, `captureVisibleTab` frames, webRequest sniffing, the pop-up and
redirect shields, notifications, downloads through the center, the helper and probe tabs, the keep-alive under a
real 30-second idle stop, Firefox at all.
