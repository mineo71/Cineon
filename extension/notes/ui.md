# Screens (src/ui) and the pages' contract with the background (src/shared/messages.ts)

Ports of the Mac's `Cineon/UI/*.swift` (checked against the Windows port's `windows/Cineon.App/UI/**` and
`windows/notes/screens-*.md`) as Preact pages: the Cineon page (`app.html`), the side panel / Firefox
sidebar (`app.html#panel`) and the toolbar popup (`popup.html`). Sizes, spacing, type and copy are the
Mac's: points are CSS px, Futura is Jost (`.t-title` 500, `.t-bold` 700), SF is the system UI font, and
the palette is `Palette.dark` / `Palette.white` as CSS variables on `:root[data-theme]`.

## Layout

```
src/shared/messages.ts   the contract: requests, answers, signals, send(), listenForUiRequests()
src/ui/app.tsx           entry of app.html (Root, "app" or "panel" from the hash)
src/ui/popup.tsx         entry of popup.html
src/ui/Root.tsx          opens the profile; top bar, page, overlays, toasts, menus (RootView)
src/ui/ui.css            tokens (the Mac's palette) and shared component styles; linked by both pages
src/ui/lib/              page model: session.ts (profile, DB, LibraryStore, settings, metadata, signals),
                         app.ts (AppModel: route, overlays, toasts, actions), live.ts (background data),
                         hooks.ts, format.ts, library.ts and other pure view models, styles.ts, platform.ts
src/ui/components/       Icon (SF Symbols as SVG), controls (Silver/Outline/Hover/Icon buttons, Switch,
                         SettingToggle/Slider, Checkbox, Picker, TextField, SearchCapsule, Spinner),
                         menu (Menu/contextMenu/popover layer), media (LogoMark, RemoteImage, PosterImage,
                         SiteIcon, ProgressLine, FilmStripBody, stars, RatingBadge, PetView, avatars),
                         titles (TitleMenu, PosterCell/Shelf, AdaptivePosterCell, QuickRate, ChecklistRow,
                         StatusPicker), player (PlayerControlsPanel, PlayerHeader)
src/ui/screens/          one file per screen, each with its own .css (imported as text, added once)
test/ui/                 Vitest (Node, and jsdom + @testing-library/preact for components)
```

Screen CSS is bundled as text (esbuild's `.css` loader) and added with `addStyles(css)` when the module
loads, so no build change was needed. macOS is case-insensitive: `App.tsx` would overwrite the `app.tsx`
entry, hence `Root.tsx` / `root.css`.

## Data in pages

- **One session per page** (`lib/session.ts`, the Mac's ProfileSession, the page's parts): `ProfileStore` over
  `chrome.storage.local` (localStorage when a page is opened outside the extension), the profile's
  `Database` + `LibraryStore` (shared IndexedDB with the service worker), its `AppSettings`, a
  `MetadataService` for what the page adds (catalogue search and enrichment run in the page), and
  `statsAndPet()` (ProfileStats + PixelPet, cached per change).
- **Changes between contexts** go over `BroadcastChannel("cineon")` (`SignalChannel`):
  - after its **own** LibraryStore writes a context posts `{type: "library", profileId, keys}`; everyone
    else reloads (debounced 40 ms). A reload's own `changed` (all nine keys) is not re-posted, so there is
    no ping-pong. **The background must do the same** for its LibraryStore: post after writes, `reload()`
    on others' `library` signals for its profile.
  - `settings` after `db.saveSettings` (others call `db.loadSettings()`); `profiles` after ProfileStore
    changes (others `reload()`); `profile` when the person changes (everyone opens that profile; the
    background also gets `session.switchProfile`); `sitePrefs` after a page wrote `site_prefs` itself.
- **What only the background knows** (tabs, players, downloads in flight, shields, Together) comes through
  `lib/live.ts`: each `Live` asks once when the first view subscribes, follows the background's signals,
  and asks again every 1–3 s while anyone looks (a sleeping worker posts nothing). `answered` tells "no
  background" from "nothing to show"; every screen copes with no answer (see Fallbacks).

## The contract

Requests are `chrome.runtime.sendMessage({ kind: "cineon/ui", type, ...payload })`, answered with
`{ ok: true, value }` or `{ ok: false, error }`. `send(type, payload, { timeoutMs = 4000 })` returns the
value or `null` (no background, no handler, timeout or error). The background answers with
`listenForUiRequests(handlers)`; a missing handler leaves the message for other listeners (content
scripts' messages don't carry `kind: "cineon/ui"`). Results that can be "nothing" are wrapped
(`{ tab: null }`) so they're never mistaken for silence.

### Snapshots (all plain data; core/data dates in seconds, Together's in milliseconds)

- `TabSnapshot { tabId, windowId, url, host, title, favIconUrl, parsed: ParsedSnapshot | null,
  linkedTitleId, ref, media: MediaSnapshot | null, canDownload, hasNextEpisode, blocked: ShieldStats,
  sitePrefs: SitePrefs, voiceBoost: VoiceBoostState }` — the Mac's BrowserTab as pages show it. `ref` is
  the tracked episode, else the parsed one, null for a film. `media` is media.js's last report
  `{ position, duration, isPlaying, rate }`. `parsed` is TitleParser's `{ name, altName, year, ref,
  kindHint, posterUrl }`.
- `PlayerCommand`: `play | pause | toggle | {skip, seconds} | {seek, seconds} | {rate, rate} | nextEpisode |
  pictureInPicture | saveMoment | findElsewhere`.
- `DownloadsSnapshot { items: DownloadItem[] (newest first, live bytes), job: SeasonJobSnapshot | null,
  proposal: SeriesProposalSnapshot | null, isBusy }`; `SeasonJobSnapshot { name, label, posterUrl,
  episodes, handled, queued, missed, remaining, current, isFinished, isPaused }`;
  `SeriesProposalSnapshot { name, posterUrl, episodes, seasonCounts: {season, count}[], totalBytes,
  isMeasured, freeBytes, fits }`.
- `TogetherSnapshot { isAvailable, isWorking, personId, myName, party: PartyState | null, isHost,
  partyTabId, challenges: ChallengeSummary[], details: Record<code, ChallengeState>, openedShares:
  ShareInfo[], lastShareCode, recoveryCode, cloud: { lastSync (ms), isSyncing, lastError, cloudCount } }`
  — core/together's TogetherModel and CloudLibrary state.
- `ShieldsSnapshot { catalog: { id, name, summary }[], ruleCounts: Record<id, number>, lastUpdated (ms) |
  null, status: string | null }`.
- `AddFromTabResult`: `{ kind: "done", titleId, message }` (toast the message) or `{ kind: "needsName",
  query }` (open the Add sheet with it).

### Requests (type → payload → result: what the background does)

| Type | Payload | Result | Does |
| --- | --- | --- | --- |
| `ping` | — | `{ version, target }` | Is the background there |
| `tab.state` | `{ tabId }` | `{ tab: TabSnapshot \| null }` | One tab (popup: its own; relink sheet) |
| `player.active` | — | `{ tab: TabSnapshot \| null }` | The tab whose video plays, else the one that played last; null when no tab has a video |
| `player.command` | `{ tabId, command }` | `{ ok }` | Sends the command to media.js in that tab's video frame; `nextEpisode` is Autopilot.skipToNext, `saveMoment` FrameCollector.saveMoment, `findElsewhere` RescueController.findElsewhere |
| `tabs.open` | `{ url, resumeAt, active }` | `{ tabId }` | New tab; with `resumeAt`, seeks there once the video loads (AppModel.resume(url:at:)) |
| `tabs.focus` | `{ tabId }` | `{ ok }` | Selects the tab and focuses its window |
| `search.everywhere` | `{ query, titleId }` | `{ tabs }` | BrowserModel.searchEverywhere: the query on every site with a search template (a tab group is a good fit), linking results to `titleId` |
| `library.addFromTab` | `{ tabId }` | `AddFromTabResult` | AppModel.addCurrentPageToBacklog for that tab |
| `tracker.relink` | `{ tabId, titleId, ref }` | `{ ok }` | WatchTracker.relink |
| `tracker.ignore` | `{ tabId }` | `{ ok }` | WatchTracker.ignore ("This isn't a film") |
| `tracker.stopSite` | `{ tabId }` | `{ ok }` | WatchTracker.stopTrackingSite |
| `shields.state` | — | `ShieldsSnapshot` | FilterEngine's catalogue and rule counts |
| `shields.setSite` | `{ host, prefs, tabId }` | `{ ok }` | Saves `site_prefs` under ShieldState's key (the registrable domain), updates the dynamic rules, reloads `tabId` when shields went on/off |
| `downloads.state` | — | `DownloadsSnapshot` | DownloadCenter + SeasonGrabber |
| `downloads.start` | `{ tabId }` | `{ ok, message }` | DownloadCenter.download(from: tab); `message` is a toast ("Open a film's page first…") |
| `downloads.season` | `{ tabId, fromCurrent }` | `{ ok }` | SeasonGrabber.start(from:fromCurrent:) |
| `downloads.series` | `{ tabId }` | `{ ok }` | SeasonGrabber.startSeries; the proposal arrives in `downloads.state` / the signal |
| `downloads.cancel` / `retry` / `remove` / `show` | `{ id }` | `{ ok }` | Stop; try again; remove the row (a finished file too: `chrome.downloads.removeFile`); `chrome.downloads.show` |
| `downloads.play` | `{ id }` | `{ ok, message }` | Plays a finished download (`chrome.downloads.open` needs the `downloads.open` permission, or an extension player page) |
| `seasons.confirm` / `decline` / `resume` / `cancel` / `dismiss` | — | `{ ok }` | SeasonGrabber's proposal and job buttons |
| `together.state` | — | `TogetherSnapshot` | The model lives in the background so a party outlives the page |
| `together.enter` | `{ code }` | `{ ok }` | TogetherModel.enter |
| `together.startParty` | `{ tabId \| null }` | `{ ok }` | Selects that tab for PartyPlayer, then startParty |
| `together.leaveParty` / `goToParty` | — | `{ ok }` | leaveParty; focus the party's tab (TogetherHost.go("web")) |
| `together.say` / `react` | `{ text }` / `{ emoji }` | `{ ok }` | Chat and reactions |
| `together.shareWatched` / `share` | — / `{ titleId }` | `{ ok }` | Shares |
| `together.createChallenge` / `leaveChallenge` | `{ titleId }` / `{ code }` | `{ ok }` | Challenges |
| `together.forgetShare` / `addToBacklog` / `refreshChallenges` | `{ code }` / `{ card }` / — | `{ ok }` | |
| `together.adopt` | `{ recoveryCode }` | `{ ok }` | adopt, then `cloud.sync()` when it worked |
| `cloud.noteChanges` | `{ titleIds }` | `{ ok }` | Stars or lists changed in a page (its LibraryStore's `onPersonalChange`, batched 300 ms) or a library file imported there: reload, then `CloudLibrary.noteChange` each |
| `session.switchProfile` | `{ profileId }` | `{ ok }` | ProfileStore already says who; close the old ProfileSession, open this one |

### Signals (BroadcastChannel "cineon"; `origin` is the poster's context id, so nobody hears its own)

| Type | Fields | From → to |
| --- | --- | --- |
| `library` | `profileId, keys` | any writer → everyone: `reload()` |
| `settings` | `profileId` | any writer → everyone: `db.loadSettings()` |
| `profiles` | — | any → everyone: `profiles.reload()` |
| `profile` | `profileId` | the page that switched → everyone: open that profile |
| `sitePrefs` | `profileId, host` | a page that wrote `site_prefs` itself (no background) → background |
| `downloads` | `state: DownloadsSnapshot` | background → pages (throttle to a few a second) |
| `player` | `player: TabSnapshot \| null` | background → pages (at most once a second while playing) |
| `together` | `state: TogetherSnapshot` | background → pages |
| `toast` | `text` | background → the Cineon page / panel (TogetherHost.showToast and friends) |
| `navigate` | `route` (a hash like `together` or `library?title=12`) | background → the Cineon page |

### Fallbacks (no answer)

- Top bar: no now-playing pill; Downloads shows rows straight from IndexedDB (`allDownloads`); Together
  says it runs in the background; Settings shows the Mac's five filter lists without counts.
- `tabs.open`, `tabs.focus`, `search.everywhere`: `chrome.tabs` from the page (search opens each site's search
  address in new tabs, or the web search when no site can search); resume without the jump (toast says so).
- Player commands, downloads, tracker, Together actions: a toast "Cineon's background isn't answering…".
- Popup: add to backlog opens `app.html#library?add=<tab title>`; the shields switch writes `site_prefs`
  itself, posts `sitePrefs` and reloads the tab.

## Screens

| Screen | Files | Notes |
| --- | --- | --- |
| Top bar | `screens/TopBar.tsx` | Logo; sections capsule (Home, Library, Timeline, Downloads with the active count, Together with the party dot), the silver light sliding between them; regular ≥ 1200, compact ≥ 1100, icons below; now-playing pill (compact under 1360) with the PlayerControlsPanel popover; search, sites grid popover, rate (gold on Rate); the avatar is the pet at 28, still: click for Profile, hold or right-click for Profile / Who's watching / theme / Settings |
| Home | `screens/Home.tsx` | Hero (backdrop, else a frame you saw, else the poster; Resume/Open, Details) or the welcome hero (search, sites row, import); New episodes (`db.episodeAlerts` + `freshAlerts`), Continue watching, Backlog, Watched |
| Library | `screens/Library.tsx` | Status tabs with counts, kinds, genre/rating/decade menus, Downloaded, Clear, find, sort (remembered per browser), grid/checklist; the adaptive grid (138–190, 18/24) builds only the rows near the screen; watched posters grey until hovered; quick-rate stars on hover |
| Title card | `screens/TitleDetail.tsx` | Hero, Resume/Find, the downloaded copy, status menu, Together menu, overview, moments (copy/save/delete), where you watched it, episodes from Cinemeta (`MetadataService.episodes`), history (`sessionsForTitle`), skip rules (`db.skipRules`, Forget), stars, remove |
| Timeline | `screens/Timeline.tsx`, `lib/timeline.ts` | Days on one film strip, frame reels scrubbed under the pointer, episode stills, browsing toggle (`db.recentHistory`), filter, week/month totals; rows build as they near the screen |
| Downloads | `screens/Downloads.tsx`, `lib/downloads.ts` | Rows, progress, the season job card, the series proposal overlay |
| Together | `screens/Together.tsx`, `lib/together.ts` | Code box, invite or party stage (ticket, members, chat, reactions), challenges with race rows, shares |
| Profile | `screens/Profile.tsx`, `lib/profileText.ts`, `lib/shareCard.ts` | Pet at 168 (animated), tiles, genre bars, star histogram, decades, heatmap, most watched, extras, cloud status, share card PNG |
| Rate | `screens/Rate.tsx` | 1–0 rate and move on after 0.38 s, ←/→ half a star, Delete clears, Return/Space skip, Esc back to Library |
| Settings | `screens/Settings.tsx`, `lib/settings.ts` | Appearance, Ratings in the cloud, Shields, Watching, Downloads and captions, Sites, Profiles, Privacy and data, Updates, Keyboard shortcuts |
| Command bar | `screens/CommandBar.tsx`, `lib/commandBar.ts` | ⌘K / Ctrl+K: continue watching, tabs, sites; when typing: address, all my sites, library, sites, catalogue (add to backlog), history, import, Cineon's commands, web search |
| Sheets | `screens/Sheets.tsx`, `screens/Import.tsx`, `lib/importAnalyzer.ts`, `lib/importApply.ts` | Add/edit site, add title (catalogue search), relink, new challenge, import (this browser's history through `chrome.history` and ImportAnalyzer, or a Cineon library file) |
| Profile picker, splash | `screens/ProfilePicker.tsx`, `screens/Splash.tsx` | "Who's watching?" (asked on launch when on and more than one person); the logo wipe on launch; the reel change turns the logo |
| Side panel | `screens/Panel.tsx`, `screens/PanelRating.tsx` | `app.html#panel` |
| Popup | `popup.tsx`, `screens/Popup.tsx`, `lib/popup.ts` | `popup.html` |

Overlays (`components/overlay.tsx`, `components/menu.tsx`, `components/confirm.tsx`): the title card, sheets and the
series proposal sit on a dimmed backdrop; the command bar near the top; menus, context menus, popovers and
confirmations in one layer at the root (Esc or a click outside closes them). Toasts: one at a time, 3 s (6 s with an
action). Deep links: `app.html#<section>?title=<id>&add=<name>&sheet=import|addSite&relink=<tabId>`.

The theme is put on `:root` before the first paint (the last one used is remembered per browser), then follows the
profile's settings.

**Side panel subset**, and why: what you want beside a playing film without leaving the site. Now playing with the
transport, stars, Save this moment, Find on another site, Download, Go to the tab; Continue watching (8 rows; a row
resumes, its poster opens the title in Cineon); Rate your films one poster at a time with the same keys. The library,
timeline, title card and sheets need the full page's width and overlays, so they open `app.html`.

**Popup**: this tab's film (poster, name, episode, host, progress, −10 s / play-pause / +10 s / next episode), Add to
backlog, Download this video, Fix title…, the site's shields (blocked on this page, on/off for the site), Open Cineon
and the side panel. On the browser's own pages it shows only Open Cineon.

## Tests

`test/ui/`: `format`, `library` (Home/Library/Rate view models, the grid's layout and virtualization, rate keys, title
card helpers), `messages` (send / no answer / timeout / errors, `listenForUiRequests`, the channel's echo rule),
`session` (signals after writes but not reloads, settings, cloud notes, profile switch, overlays, toasts),
`components.test.tsx` (stars; the Library screen counting and filtering, in jsdom with @testing-library/preact),
`timeline`, `downloads`, `profile`, `together`, `settings`, `socialScreens.test.tsx`, `commandBar`, `importAnalyzer`,
`importApply`, `popup`, `panel.test.tsx`.

## TODOs

For the background agent (`listenForUiRequests` in `src/background`):
- Answer every request above; wrap nullable answers as specified (`{ tab: null }`).
- Post `player` (≤ 1/s while playing), `downloads` (throttled), `together`, `toast` and `navigate` signals.
- Post `library` after its own LibraryStore writes and `reload()` on others'; follow `settings`, `profiles` and
  `profile` (or `session.switchProfile`: close and reopen the ProfileSession); on `sitePrefs` rebuild that host's
  dynamic rules.
- On `settings`: `refreshIdentity()` when `sharePet` changes, `cloud.start()` when `cloudBackup` turns on,
  `enabledLists` to the static rulesets, `hibernateMinutes` for discarding idle tabs, voice boost and captions to the
  content scripts.
- `cloud.noteChanges` → `CloudLibrary.noteChange`; `together.adopt` → `cloud.sync()` when it worked.
- `downloads.play` needs the `downloads.open` permission in the manifest (or an extension player page);
  `downloads.remove` deletes finished files with `chrome.downloads.removeFile`.
- The side panel: `chrome.sidePanel.setPanelBehavior` if the toolbar click should open it.

For packaging: there's no `favicon` permission, so sites without a learned `iconUrl` show their initial.

## Not 1:1, and why

- **The browser does what the Mac's window did**: no BrowserBar, tab strip, address pill, web view, find bar, cinema
  mode, traffic lights or sidebar; sites open in the browser's tabs, and "Browse" isn't a section.
- **No native player**: Play/Resume on a download asks the background to open the file; the in-app player, up-next
  card, AirPlay and subtitle drop have no counterpart. The player panel has no sleep timer, second subtitles or cinema
  mode, and gains Go to the tab.
- **Ambient light** belongs to the site's page (content script); the Cineon page has no film behind it.
- **Copy**: "this Mac" → "this computer" / "your browser's downloads folder"; Finder → the downloads folder; ⌘T →
  ⌘K / Ctrl+K (⌘T is the browser's); ⌘D → the popup's Add to backlog; ⇧⌘S → Alt+Shift+S; Bin → Delete file.
- **Settings**: Updates says the browser keeps Cineon up to date (GitHub copies: the releases page); shortcuts list
  `chrome.commands` (Change shortcuts opens the browser's page) plus the page's keys; no "Update lists now" (the lists
  are built in); downloads go to the browser's folder (no Change…); cookies and logins are the browser's; Import a
  library file is new.
- **Import** reads this browser's history through `chrome.history` (about 90 days, one row per address) instead of
  other browsers' files on disk; no bookmarks or Arc tabs; writes aren't one transaction. A Cineon library file can be
  imported too.
- **Command bar** adds Cineon's commands (sections, theme, Who's watching, Add a film/site).
- **Together** lives in the background (a party must outlive the page); pages render snapshots, polled every 3 s
  between signals, with the party clock moving on locally.
- **Images**: `<img>` with the browser's HTTP cache and a 0.25 s fade stand in for the ImagePipeline; frames come from
  IndexedDB as object URLs. The film strip's holes are square-cornered CSS (the Mac rounds them 1.8 pt).
- **Motion**: CSS transitions approximate SwiftUI's springs; no matched geometry on posters when filters change;
  Rate's leaving card has no exit slide; stat numbers don't roll; `minimumScaleFactor` is `clamp()` / container units.
  `prefers-reduced-motion` turns transitions off and keeps pets still.
- **Menus** are the page's own, not native; the avatar menu opens on hold or right-click (the Mac's Menu with a
  primary action opens on press-and-hold). Confirmations are a small card, not an alert sheet.
- **Share card** is drawn with Canvas 2D and downloaded, not rendered from the SwiftUI view into a save panel.
- **Week start** on the timeline follows the browser's locale.
- **Shields popover** (allow pop-ups/redirects, don't track) isn't in the popup, only shields on/off; Don't track this
  site is in the player panel's Tracking menu.
