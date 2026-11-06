# Player utilities, profile and pixel pet

Date: 2026-11-05. The user asked for all ten ideas from the last list, a better party page, and a
profile page with statistics and a pixel pet that represents them. They opted out of a question
round, so everything below marked *my call* is a guess to check.

## Player utilities

1. **Media keys and Now Playing.** `MPRemoteCommandCenter` and `MPNowPlayingInfoCenter`, fed from
   the native player when it's open, otherwise from the tab that's playing. Play, pause, toggle,
   ±10 s, scrubbing, next episode. Artwork is the title's poster.
2. **Sleep timer.** 15, 30, 45, 60 or 90 minutes, or the end of this episode or film. The sound
   fades out over the last 20 s, playback pauses and volume goes back to where it was. "End of
   episode" also stops the autopilot from moving on. Shown in the Playback menu, the sidebar's
   now-playing card and the native player.
3. **Voice boost.** Web Audio in the page: low shelf cut, presence peak around 2.5 kHz, compressor,
   make-up gain. Only for players whose audio the page may read (MediaSource `blob:` video or
   same-origin files). Elsewhere it says it can't and leaves the sound alone, because routing a
   cross-origin video through Web Audio silences it. The audio graph is only connected once its
   context is running, so turning it on can never leave a film silent. *My call:* not in the
   native player yet.
4. **Two subtitles at once.** Web: the subtitle files the player fetched (seen by the source
   collector) can be shown as a second line above the picture, drawn by Cineon and synced to the
   video. Swift fetches the file with the page's cookies. Native: a second track under the first,
   and "Add Subtitles from File…" for `.srt`/`.vtt`. *My call:* no online subtitle search, because
   OpenSubtitles needs an API key.
5. **AirPlay.** A route picker in the native player.

## Library utilities

6. **New episode alerts.** Every 6 hours, and a minute after launch, each series you're watching
   gets its episode list checked. The first check only records what's out. Later ones post a
   notification for newly aired episodes and add them to Home. Stored in a new `episode_alerts`
   table (schema v4).
7. **Download a whole season.** From a series tab: a hidden helper tab opens each episode in turn
   (the page's own episode list, or the address rewritten), waits for the player's file and hands
   it to the download queue. At most 2 downloads at a time, the rest queued; links are fetched just
   before each download so they don't expire while waiting. Settings: bin watched episode
   downloads (default on; files go to the Bin, so it can be undone). The native player moves on
   to the next downloaded episode.
8. **Siri and Shortcuts.** App Intents: Continue Watching (optionally a title), Play or Pause,
   Sleep Timer, Open Downloads, Open Profile. App Shortcuts phrases for Siri.

## Together

9. **Party chat.** `parties:say`, plus `messages` in `parties:get`. Messages show in the party
   panel and briefly over the film, like reactions.
10. **Party page redesign.** A hero with what's playing and the sync state, members with their
    pets and presence, chat, reactions, an invite code with copy buttons. When no party is on, a
    clear start card for what's playing now.

## Profile

- A **Profile** page in the sidebar. Counts: time watched (tracked, plus an estimate from
  runtimes for titles finished before Cineon tracked them, labelled as an estimate), films and
  episodes finished, series completed, current and longest streak, longest binge, favourite genre
  with a breakdown, favourite decade, top titles, a weekday × hour heatmap, moments saved, ads
  blocked, downloads.
- **Pixel pet.** Generated from the profile: species from the favourite genre, accessory from the
  second, palette from the third, stage from experience (hours plus finished titles), mood from
  how recently you watched. Shown on the profile, in the sidebar and as your avatar in parties and
  challenges. The pet travels as a short code in `people.pet`.
- **Share card.** The profile summary and pet rendered to a PNG to save or share.

## Added during the build

The user asked for these while the work above was underway.

- **Less Arc, more film app.** The sidebar (address bar, site tiles, vertical tabs) is gone. A top
  bar carries the sections in Futura, a now-playing pill, search, sites, rating mode and the pet.
  Cineon's own pages are full-bleed. Sites and the native player are a framed screen, which keeps
  the ambient light visible, and get a slim browser toolbar with tabs as chips. *My call:* "Hide
  Toolbars on Sites" (⌘S) hides both bars on sites, and they come back at the top edge.
- **Ratings out of ten with halves**, saved locally as half steps (schema v4 multiplies old
  five-star ratings by four). They show as gold badges on posters and can be set by hovering a
  poster, in a title's page, in the player panel, or in **rate mode**.
- **Cloud backup** of ratings and lists in Convex (`library:put`, `library:all`), keyed by IMDb id
  or normalised name and year, newest wins per field. After a library is cleared or imported again,
  the next sync puts the stars back. A recovery code (the profile's device secret) restores them
  on another Mac or profile. *My call:* the backup is on by default, since the user asked for it,
  and can be turned off in Settings.
- **Library filters**: list, kind, genre (several), rating, decade, on this Mac, text; sorted by
  watched, added, rating either way, name, year either way, length.
