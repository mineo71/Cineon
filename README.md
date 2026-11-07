# Cineon

A very fast, personal browser for watching films, series and cartoons across many sites. It
remembers what you watched, where, and how far you got, saves films to your computer with one click,
and lets you watch with friends. Native on macOS (Swift, WebKit) and on Windows (C#, WinUI 3,
WebView2), with no accounts. The Mac app updates with [Sparkle](https://sparkle-project.org), the
Windows app with [Velopack](https://velopack.io).

## Install on a Mac

Cineon needs macOS 26 or later, on Apple silicon or Intel.

1. Download `Cineon-x.y.z.dmg` from the [latest release](https://github.com/mineo71/Cineon/releases/latest)
   and drag Cineon to Applications.
2. Open it. The first time, macOS refuses, because the app isn't notarized by Apple. Open **System
   Settings → Privacy & Security**, scroll down and click **Open Anyway** next to the line about
   Cineon. This is needed only once; updates open straight away.

Or with Homebrew, which skips step 2:

```
brew tap mineo71/cineon https://github.com/mineo71/Cineon
brew trust mineo71/cineon
brew install --cask cineon
```

### Updates

Cineon checks for a new version once a day. When there is one, it shows what changed and installs
it with one click. **Settings → Updates** can install updates quietly the next time you quit
instead, or stop the daily check; **Cineon → Check for Updates…** looks right away. Updates replace
only the app: profiles, the library and downloads stay where they are.

## Install on Windows

Cineon needs Windows 10 (1809) or later, on x64 or ARM.

1. Download `Cineon.App-win-x64-Setup.exe` (or `-win-arm64-` for ARM PCs) from the
   [latest release](https://github.com/mineo71/Cineon/releases/latest) and run it. It installs for
   your account only, with no administrator prompt, and opens Cineon.
2. The first time, Windows SmartScreen may say it protected your PC, because the installer isn't
   signed with a paid certificate. Click **More info**, then **Run anyway**. Updates don't ask again.

A portable zip is there too, for running without installing (it doesn't update itself).

Updates work as on the Mac: a daily check, one click to install, or quietly on quit (**Settings →
Updates**), and **More → Check for Updates…**. Your data lives in `%LOCALAPPDATA%\Cineon`, apart from
the app, so updating or uninstalling never touches it.

The Windows app is a 1:1 port of the Mac app: same screens and features, and the same data formats,
so a profile folder copied from a Mac opens on Windows. What differs is listed in
`windows/notes/*.md`; how it's built is in `windows/PLAN.md`.

## Build

Requires Xcode and XcodeGen (`brew install xcodegen`).

```
make            # Release build, universal, at dist/Cineon.app
make install    # copies it to /Applications
make run        # builds and launches
make test       # unit tests
make e2e        # drives a real Debug build against a fake streaming site (about 15 minutes)
make filters    # refreshes the bundled filter lists
make assets     # regenerates the icon and logo from design/logo-source.png
make win-test   # the Windows app's shared code: tests (needs the .NET 10 SDK)
make win-check  # type-checks the Windows app on a Mac
```

The Windows app builds, launches on every screen and runs its end-to-end test on GitHub's Windows
runners (`.github/workflows/windows.yml`); on Windows, `dotnet build windows/Cineon.App -r win-x64`.

## Releasing

1. Add a `## [1.2.0] - 2026-12-01` section to `CHANGELOG.md` and commit it on `main`.
2. Run `make release VERSION=1.2.0`.

The script raises the version and build number in `project.yml`, builds a universal Release, packs a
DMG and a zip, signs the zip with the update key, writes `appcast.xml`, updates the Homebrew cask,
commits, tags `v1.2.0`, pushes and publishes the GitHub release with the changelog section as its
notes. Installed copies find it through `releases/latest/download/appcast.xml`.
`scripts/release.sh 1.2.0 --dry-run` builds and packs into `dist/release` without publishing.

The update key's private half is in `~/.config/cineon/sparkle-private-key`, outside the repo; the
public half is `SUPublicEDKey` in `project.yml`. Keep a copy of the private key somewhere safe:
without it, installed copies can't accept another update.

The app is signed ad hoc, not with a Developer ID, so Gatekeeper asks once on first launch (see
Install). Sparkle checks every update against the EdDSA key instead.

## Where things are

| Path | What's there |
| --- | --- |
| `Cineon/Core` | Database, library, title recognition, metadata, browser import |
| `Cineon/Browser` | Tabs, web views, playback tracking, rescue, series autopilot, frame capture |
| `Cineon/Downloads` | Saving what players stream, whole seasons and series, subtitles, the native player for saved films |
| `Cineon/Profile` | Profile statistics and the pixel pet |
| `Cineon/Shields` | Filter list converter and compiled rule lists |
| `Cineon/Resources/Scripts` | JavaScript injected into pages |
| `Cineon/UI` | All screens |
| `fixtures` | Fake streaming site and end-to-end test |
| `server` | The Together backend (Convex): share codes, watch parties, challenges |
| `docs/PLAN.md` | Design system and data model |

Your data is in `~/Library/Application Support/Cineon`, with one SQLite database and one folder of
saved frames per profile. Downloads go to `~/Movies/Cineon`, which Settings can change.

## Downloads

Cineon notices the files a player streams, the way you'd find them in the Network tab, and a
Download button appears in the player's corner (or press ⇧⌘S). Whole files are saved as they are.
HDRezka-style `file.mp4:hls:seg-N.ts` requests are traced back to the whole `file.mp4`. Sites that
only stream HLS playlists are saved as `.movpkg` packages through AVFoundation. Subtitles the player
loaded are saved next to the film. Saved films play in the native player on the Downloads page,
keep their place, go on the timeline, and light the room with real frames.

From an episode, the download button's menu (press and hold it) gets the rest of the season, the
whole season, or the whole series. For a series Cineon finds every season (from the page's own
season list, the published episode list, or by trying addresses) and asks first, with the number of
episodes, a rough size and the free space. The job is saved after every episode, so if Cineon closes
or crashes partway, Downloads offers to carry on, and episodes that stopped with it are fetched again.

## Watching

- **Top bar**: Home, Library, Timeline, Downloads and Together in one capsule in the middle, with
  what's playing, search, sites, rating mode and your pet on the right. A site opens as a framed
  screen with its own toolbar and tabs, so the film's light can spill around it.
- **Media keys and Control Center**: play/pause, ±10 s, scrubbing and next episode, from the
  keyboard, AirPods or Control Center, for a site's player or a downloaded film.
- **Sleep timer**: 15 to 90 minutes, or the end of this episode. The sound fades over 20 s, then it
  pauses and nothing starts after it. In the player panel, the Watch menu and the native player.
- **Voice boost** (⇧⌘B): dialogue louder, explosions softer, for players whose sound the page may
  process (media-source players such as HDRezka's, and same-site files). Others are left alone,
  since processing their sound would silence them.
- **Second subtitles**: any subtitle file the player loaded, or one from disk, as a second line above
  the picture. The native player shows two tracks, and takes `.srt`/`.vtt` files dropped on it.
- **AirPlay** from the native player. The screen stays awake while anything plays.
- **New episode alerts**: series you're watching are checked every 6 hours. New episodes notify and
  appear on Home.
- **Siri and Shortcuts**: Continue Watching, Play or Pause, Next Episode, Set a Sleep Timer, Rate My
  Films, Open My Profile.

## Ratings, library and profile

- Ratings are out of ten in half stars, shown in gold on every poster. Hover a poster to rate it.
- **Rate mode** (⇧⌘R) goes through everything you've watched one poster at a time: click a star or
  press 1 to 0, arrows for halves.
- The Library filters by list, kind, genre, rating, decade and what's on this Mac, and sorts by
  watched, added, rating, name, year or length.
- Ratings and lists are backed up to the Together server and come back after the library is cleared
  or imported again. Settings shows a recovery code that brings them to another Mac or profile.
- **Profile**: hours (timed, plus runtimes for what was finished before Cineon), films, episodes,
  streaks, favourite genres and decades, your stars, when you watch, most watched, and a share card.
- **Pixel pet**: grown from your taste. Species from your favourite genre, accessory and colours from
  the next ones, stage from how much you've watched, mood from how recently. It's your avatar in
  parties and challenges.

## Together

Optional, and nothing leaves the Mac until you start or join something. Each profile gets a random
key, and the server stores only its hash. Everything works with six-letter codes:

- **Share** your Watched list or one title. A friend types the code, sees the posters, and adds
  what they like to their backlog.
- **Watch party**: start one from the film playing. Friends open the same page and their player
  follows yours: play, pause and every jump. Chat and reactions show over the film.
- **Challenges**: first to finish a series or film. Everyone's progress bar comes from what they
  actually watch.

The server address is the `CINEON_TOGETHER_URL` build setting in `project.yml`, one for Debug and one
for Release. See `server/README.md` to deploy your own.

## Limits worth knowing

- macOS 26 or later. Windows and Linux would need a separate shell.
- Chrome extensions can't run. uBlock's filter lists do, except for its scriptlet rules, which have
  no WebKit equivalent, so some sites that fight ad blockers will leak more than in Chrome.
- DRM services such as Netflix may refuse to play.
- Posters come from IMDb's and Cinemeta's public, unofficial endpoints. They can change without
  notice. If they do, Cineon falls back to each page's own title and image. Lookups send film names
  to those services, and can be turned off in Settings.
- Four things use private WebKit APIs: per-site shields, the blocked-request counter,
  picture-in-picture and starting the next episode with its sound on. All are checked before use.
  This rules out the Mac App Store, so Cineon is published on GitHub instead.
- Rescue can only look on sites you've added, and reads their search pages the way a browser would.
  A site that hides its results behind a login or a bot check won't turn anything up. For a series it
  opens the series' page, since few sites let an episode be linked from search.
- Learned intro skips use fixed times, so an episode with a longer cold open can skip the wrong part.
  Undo twice and the rule is dropped. Rules are listed on each title's page.
- Frames can't be captured from video protected by DRM. Those sessions keep the catalogue's still.
- Season and series downloads open each episode in a hidden tab and wait for its player to ask for the
  file, one at a time, two downloads running. A site whose player needs a real click to load won't
  give up its files this way; those episodes are listed so you can download them by hand.
- Voice boost doesn't work in the native player yet, and not in players that stream from another
  site without permission to read the sound.
- Online subtitle search isn't built in: OpenSubtitles needs an API key. Files from disk work.
- Downloads can't save DRM-protected or encrypted streams, and won't try. Some sites sign their file
  links for a short time: if a retry fails with "refused", open the page and download again.
- Together sends your profile's name, your pet's code, and the titles, positions and page addresses
  you choose to share, to the Together server. The cloud backup sends each rated or listed title's
  name, year, IMDb id, rating and list. It can be turned off in Settings. A watch party only works when friends can open the same page.
  Only the host controls a party.
- Ambient light and frames photograph Cineon's own window when a site won't let its video be read.
  That needs macOS 14.4 or later, and no permission.
- Importing reads pages, bookmarks and saved tabs from Chromium browsers and Arc. Passwords and
  cookies are never read. History doesn't record whether a film was finished, so the review screen
  suggests a list for each title and lets you change it.
