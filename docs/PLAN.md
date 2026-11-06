# Cineon plan

A very fast, personal browser for watching films, series and cartoons across many
sites, which never loses your place. macOS first.

## Why it exists

Films get lost: you watch across several sites, without accounts, and nothing remembers
what you saw, where, or how far you got. Cineon makes the *title* the primary object
rather than the URL. Everything else (tabs, history, ad blocking) serves that.

## Stack (and why)

| Decision | Choice | Reason |
| --- | --- | --- |
| Engine | `WKWebView` | Native, hardware video decode, shares the system WebKit, lowest memory and battery use on a Mac |
| UI | SwiftUI + AppKit | Instant launch, real window chrome, native Liquid Glass |
| Storage | SQLite (system library) | No dependency, sub-millisecond reads, crash-safe |
| Ad blocking | `WKContentRuleList` | Compiled to bytecode inside WebKit, the fastest available way to block |
| Dependencies | none | Nothing to install, nothing to update |

Known limits of this stack:

- macOS only. Windows and Linux would need their own shell around the same ideas.
- Chrome extensions (uBlock Origin itself) cannot run. Filter lists can.
- DRM services (Netflix, Disney+) may refuse to play in a non-Safari WebKit app.

## Features

### Core
1. Browser: tabs, sites grid, command bar, back/forward, zoom, find, session restore, tab hibernation.
2. Playback tracking: detect `<video>` in any frame, recognise title and season/episode (EN/UK/RU), record position.
3. Auto-resume across sites, with the option to start over.
4. Library: Backlog (checklist), Watching, Watched. Films, series, cartoons.
5. Timeline: every session (what, where, when, how far) and library actions.
6. Search everywhere: one query across all sites. Dead site? Find the same film on another.
7. Shields, four layers: network rules, cosmetic rules, pop-up/redirect shield, overlay sweeper.
8. Profiles: separate cookies, library, timeline and settings per person.
9. Import from Arc, Chrome and other Chromium browsers: finds film sites, films and the episode
   you ended on in history, bookmarks and saved tabs, with a review screen before anything is saved.
10. Rescue: when a site or video dies, try the site's other addresses, then search the person's other
    sites, and carry on from the same second. A certain match opens after a short countdown.
11. Autopilot for series: learns intros and credits from what you skip, per series and site, and moves
    on to the next episode by rewriting the address or using the page's own episode list.
12. Real frames: a few small images from each session, kept on this Mac, make up the timeline's film
    strip. Move across one to scrub, click to carry on from that second. Moments are saved on purpose.
13. Downloads: the files a player streams are noticed as the Network tab would list them, and saved
    with one click from a button on the player. Whole files, HDRezka's `:hls:` files, HLS playlists
    and subtitles. A Downloads page plays them in the native player, on the timeline like any other.
14. Watch modes: ambient light follows the film even where the page won't let it be read, by
    photographing Cineon's own window; Cinema mode turns it up; caption styles for web players and
    downloads.
15. Together (Convex, optional): share codes for lists and titles, watch parties that follow the
    host, and challenges with everyone's progress. See `docs/superpowers/specs/`.

### Delight
- Ambient light from the playing film, Cinema mode, watched titles fade to black and white,
  film-strip timeline, launch logo animation, reel-change profile transition.

## Design system

**Concept:** a projection room. The chrome is silver and black, like the logo. Colour only
ever comes from the films.

| Token | Dark | White |
| --- | --- | --- |
| Canvas | `#000000` | `#FFFFFF` |
| Ink | `#FFFFFF` | `#000000` |
| Ink secondary | white 62% | black 62% |
| Ink tertiary | white 38% | black 42% |
| Raised | white 7% | black 4.5% |
| Hairline | white 11% | black 11% |
| Silver | `#F5F5F5` to `#8E8E8E` | `#3A3A3A` to `#000000` |
| Gold (ratings and the pet only) | `#FFDB80` to `#EDA838` | `#EDB033` to `#BD8014` |

**Type:** Futura for titles and headings (the film-title face). SF Pro for interface text,
tabular digits for timecodes.

**Boldness goes to one place:** ambient light. Everything around it stays quiet. No cards
with shadows, no decorative gradients. The one hue of Cineon's own is gold, for ratings and the
pet, like an award statuette.

**Layout:** a 56 pt bar across the top. The window's own buttons are moved down to its middle
(`TrafficLights`, redone after every resize; full screen keeps AppKit's place). The logo is on the
left, the sections sit in one capsule in the middle like a TV app's with the current one lit
silver, and what's playing, search, sites, rating mode and your pet are on the right. Over a hero
the bar is a fade in the page's colour and the capsules are smoked glass; elsewhere it's the
page's black or white. Narrow windows drop the playing title first, then tighten the sections,
then fold them into a menu. Cineon's own pages run edge to edge under it. Sites and the native
player sit in a framed screen with the film's light spilling around it, and only then does a
44 pt browser bar appear: back, forward and the tabs on the left, the address centred under the
sections, downloading on the right.

**Motion:** one launch moment and one reel change. Everything else answers an action.
Reduced Motion is respected.

## Data model (one SQLite file per profile)

`titles`, `progress` (last position per title + episode), `sessions` (timeline),
`events` (library actions on the timeline), `url_links` (manual corrections), `ignored`,
`sites`, `history`, `tabs`, `site_prefs`, `stats`, `settings`, `skip_rules` (learned intros and
credits), `frames` (saved images, stored as files in the profile's `Frames` folder), `downloads`
(saved films, stored in `~/Movies/Cineon`), `episode_alerts` (each watched series' newest aired
episode and what's new since).

Schema v4 moved ratings from five stars to ten in half steps: `titles.rating` holds half steps
(15 is 7.5), with `rated_at` and `status_at` for merging with the cloud backup, newest wins.

Sessions are written continuously, so a crash loses at most ten seconds.

## Metadata (no signup)

Posters and details come from public, keyless sources: IMDb suggestions for search,
Cinemeta for descriptions, genres and episode lists. Lookups send the film title to those
services and can be turned off in Settings. Without them the page's own image and title
are used.

## Build

```
make            # build Release, write dist/Cineon.app
make run        # build and launch
make test       # unit tests
make install    # copy to /Applications
make filters    # refresh the bundled filter list snapshot
```

## Later

- Windows/Linux shell.
- PIN-locked profiles.
- iCloud sync of library and timeline between Macs.
- Import from Safari (needs Full Disk Access) and Firefox.
