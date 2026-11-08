# Cineon as a browser extension

The same Cineon, inside Chrome, Edge and Firefox (Safari later), built from the same specs as the
apps: the Mac app in `../Cineon` is the reference and the Windows port in `../windows` shows how each
piece was translated (its `notes/*.md` list every API and every deliberate difference). It syncs
with the apps through the same Together/cloud server (`../server`).

What the browser already does (tabs, address bar, window, profiles, history) the extension uses
instead of rebuilding. Everything else — tracking and resume, the library and ratings, next
episode, learned intro and credits skips, rescue, shields, downloads (direct and HLS), Together,
the cloud backup, timeline frames, ambient light, the profile with the pixel pet, rate mode — is a
1:1 port.

## Stack

| Apps | Extension |
| --- | --- |
| Swift / C# core | TypeScript (`src/core`), no browser APIs, tested with Vitest on Node |
| SQLite | IndexedDB, same tables and fields (`src/core/data`); export/import in the apps' formats |
| Page scripts via WKUserScript / WebView2 | the same files as content scripts, bundled from `../Cineon/Resources/Scripts` with the handler lookup pointed at a shim (`window.webkit…` → extension messaging). Isolated world, like the Mac's private script world; `shield.js` runs in the main world, as on the Mac. |
| WatchTracker, autopilot, rescue | background service worker (`src/background`) |
| WKContentRuleList / WebView2 request filter | `declarativeNetRequest` static rulesets built from the same lists (`scripts/filters.mjs`), cosmetic CSS from a per-host map, per-site toggles as dynamic rules |
| Download center, HLS | `chrome.downloads` for files; HLS segments fetched in an offscreen document, written to OPFS, saved with `chrome.downloads` |
| SwiftUI / WinUI screens | Preact pages (`src/ui`): the Cineon page (Home, Library, Timeline, Downloads, Together, Profile, Rate, Settings), the side panel, the toolbar popup |
| Futura / Jost | Jost (bundled) |
| Media keys, notifications, stay awake | Media Session in the page, `chrome.notifications`, `chrome.power` |

## Layout

```
extension/
  src/core/        TypeScript port of Core (data, parsing, metadata, shields, stats, pet, together, downloads logic)
  src/background/  service worker: tracker, autopilot, rescue, shields wiring, downloads, together, alerts
  src/content/     content scripts: the shared page scripts + the messaging shim + cosmetic CSS
  src/offscreen/   HLS downloading and frame work that needs a document
  src/ui/          Preact pages and the design system
  scripts/         build, filter conversion, packaging
  test/            Vitest; parity tests reuse the corpora in ../windows/Cineon.Core.Tests/**/MacParity
  e2e/             Playwright with the unpacked extension in Chromium, against ../fixtures/server.js
```

## Commands

```
npm install
npm run build      # dist/chrome and dist/firefox
npm test           # Vitest
npm run typecheck
npm run e2e        # Playwright end-to-end against the fixture site
npm run package    # zips for GitHub releases and the stores
```

## Conventions

- Port from the C# where it exists (closest to TypeScript), checking behaviour against the Swift.
  Keep names: `TitleParser.parse`, `RescueMatcher.best`, `LibraryStore`, `SeasonGrabber`.
- Same JSON shapes for everything sent to the server and for export/import.
- User-facing text is the Mac's, with Mac words swapped for browser ones.
- No `eval`/remote code (MV3). All lists and fonts are bundled.
- Each port writes `notes/<area>.md`: API, what isn't 1:1, and why.

## Port map

| Area | Source | Status |
| --- | --- | --- |
| Data model, IndexedDB store, library queries, settings | Core/Data | done (notes/data.md) |
| Title parser, rescue matcher, episode links, metadata, image cache | Core/Parsing, Core/Metadata | done, 4,342/4,342 parity (notes/parsing.md) |
| Shields: lists → DNR rulesets, cosmetic CSS, site toggles | Core/Shields | done, 13,575 rules (notes/shields.md) |
| Profile stats, pixel pet (renderer) | Core/Profile | done, hashes match (notes/profile.md) |
| Together client and model, cloud backup | Core/Together | done (notes/together.md) |
| Downloads: queue, HLS, season and series jobs, subtitles | Core/Downloads | done (notes/downloads.md) |
| Content scripts and messaging | App/Browser/ScriptBridge | done (notes/runtime.md) |
| Tracker, autopilot, rescue, frames, ambient | App/Browser | done; ambient computed, not drawn (notes/runtime.md) |
| Screens | App/UI | done (notes/ui.md) |
| End-to-end test | fixtures/e2e.py | done: 216/216 on Linux CI, 28 skipped (notes/e2e.md) |
| Packaging and releases | | done: extension.yml, extension-release.yml, release.sh sets the version |

## Distribution

Zips for Chrome/Edge and Firefox are attached to each GitHub release. Store listings (Chrome Web
Store, Edge Add-ons, Firefox Add-ons) need the owner's developer accounts; downloading from
streaming sites may not pass the Chrome Web Store's review, so the GitHub zip (load unpacked) stays
the reference build.
