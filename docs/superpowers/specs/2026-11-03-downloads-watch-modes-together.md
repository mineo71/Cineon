# Downloads, watch modes and Together

Three additions to Cineon, built in this order. Each one stands on its own.

## 1. Downloads (Leopoldo, rebuilt inside Cineon)

### Why

Leopoldo (`../hdrezka`, a Chrome extension) exists because in-page players lag, and site developers
themselves tell people to dig the `.mp4` out of the Network tab. Cineon is a WebKit app, so the
extension can't run in it, and WebKit has no `webRequest`. The same job is done natively.

### How Leopoldo works (what carries over)

- Watches every `*.mp4*` request in the main frame only (ads live in iframes).
- HDRezka's player requests `file.mp4:hls:manifest.m3u8` and `file.mp4:hls:seg-N-v1-a1.ts`.
  Cutting the `:hls:...` suffix gives the bare progressive `file.mp4`, one row per episode.
- Title from `.b-post__title`, `h1`, `og:title`. `3 сезон 1 серия` / `S03E01` parsed for the name.
- Filename `{show} S{season}E{episode} [{quality}]` or `{title} [{quality}]`.

### Capture

`media.js` already runs in every frame in Cineon's private world. It gains a source collector:

- `PerformanceObserver` on resource entries (buffered), which sees the player's fetch/XHR traffic
  from any world, plus `video.currentSrc`, `<source>` and `<track>`.
- Kept: `.mp4 .m4v .webm .mov .m3u8` and subtitles `.vtt .srt`. Dropped: `blob:`, `data:`, segments.
- HDRezka's `:hls:` suffix is cut, as in Leopoldo.
- Only frames holding a long video (240 s or more) report. That replaces Leopoldo's main-frame
  filter and also works for players inside cross-origin iframes.

### Download

- `DownloadCenter` per profile. Progressive files go through `URLSession` with the profile's cookies
  for that host, the player frame as `Referer`, and the web view's user agent.
- HLS-only sources go through `AVAssetDownloadURLSession` (Apple's own offline HLS), producing a
  `.movpkg` that the native player opens. Encrypted streams are refused, not decrypted.
- Subtitles the player loaded are saved next to the video.
- Files go to `~/Movies/Cineon` (changeable in Settings). Interrupted downloads can be retried.
- New table `downloads` (schema v3).

### Where you see it

- A small pill on the player itself, "Download · 1080p", which turns into the progress and then
  "Saved". It lives in the page so it shows in fullscreen too, like the resume card. It can be
  switched off in Settings.
- Watch menu: Download This Video (⇧⌘S).
- A **Downloads** page in the sidebar: poster, name, episode, size, progress, Play, Show in Finder,
  Move to Trash, Retry.
- Playing opens a native player (AVKit) inside the main card. Position is saved, the session goes
  on the timeline and into the title's progress, so Home's "Continue" resumes the local copy.
- Local playback gives real frames, so ambient light follows the film there.

## 2. Watch modes

- **Live ambient light everywhere.** Today most streaming CDNs block frame reads, and window
  snapshots come back black for hardware video, so the light falls back to poster colours.
  ScreenCaptureKit can photograph Cineon's own window without any permission prompt (macOS 14.4+);
  that becomes the fallback, so the light follows the film on those sites too.
- **Cinema mode aura.** Cinema mode leaves a dark frame around the player; the light there gets
  stronger and wider.
- **Captions.** A caption style (size and backing) applied to native text tracks in web players
  (`::cue`), and to the native player. Downloaded subtitles show in the native player.

## 3. Together (Convex)

Optional. Nothing leaves the Mac until someone starts or joins something. No accounts: each
profile gets a random device key, kept in its profile folder; the server only stores its SHA-256.

- **Share codes.** Share your Watched list or one title as a code like `K7Q-2MX`. A friend types
  the code and sees the posters, and can add any of them to their backlog.
- **Watch party.** Start one from the film playing. Friends join with the code; Cineon opens the
  same page and follows the host: play, pause and seeks, within about two seconds. Members see who's
  in. The host is in control.
- **Challenges.** "First to finish Severance." Create from a title, share the code, everyone who
  joins shows with their progress bar (episodes finished out of the total, or how far into a film),
  and the first to finish wins.

### Backend contract (Convex, `server/convex`)

All functions are called through Convex's HTTP API (`POST <url>/api/query|mutation`, body
`{path, args, format: "json"}`), so the app needs no SDK. Every write takes `deviceSecret`
(base64 string, 32 random bytes). Strings are trimmed and capped (names 40, titles 200, URLs 2000).

`TitleCard = { name: string, year?: number, kind: "film"|"series"|"cartoon"|"unknown", imdbId?: string, posterUrl?: string, status?: string, rating?: number }`
(`rating` is half-star steps 1–20, 15 = 7.5/10; the server passes it through without a range check.)

`LibraryItem = { key: string, name: string, year?: number|null, kind?: string|null, rating?: number|null, ratedAt?: number|null, status?: "none"|"backlog"|"watching"|"watched"|null, statusAt?: number|null, finishedAt?: number|null }`

Codes: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, unique across all kinds, sent without
the dash, case-insensitive on input.

| Function | Kind | Args | Returns |
| --- | --- | --- | --- |
| `people:register` | mutation | `deviceSecret, name, pet?: string \| null` | `{ personId, name, pet: string \| null }` (creates or updates; `pet` left out or `null` keeps the stored one, `""` removes it) |
| `codes:resolve` | query | `code` | `{ kind: "share"\|"party"\|"challenge" } \| null` |
| `shares:create` | mutation | `deviceSecret, label, titles: TitleCard[] (≤ 500)` | `{ code }` |
| `shares:get` | query | `code` | `{ code, label, ownerName, titles, createdAt } \| null` |
| `parties:create` | mutation | `deviceSecret, title?: TitleCard, pageUrl, position, playing, rate` | `{ code }` |
| `parties:join` | mutation | `deviceSecret, code` | party (as `get`) |
| `parties:leave` | mutation | `deviceSecret, code` | `null` (host leaving ends the party) |
| `parties:update` | mutation | `deviceSecret, code, position, playing, rate, pageUrl?` | `null`, host only |
| `parties:heartbeat` | mutation | `deviceSecret, code` | `null` |
| `parties:react` | mutation | `deviceSecret, code, emoji` | `null` |
| `parties:say` | mutation | `deviceSecret, code, text` | `null`; members and the host only; counts as a heartbeat |
| `parties:get` | query | `code, t?` | `{ code, ended, hostId, hostName, hostPet, title, pageUrl, playing, position, rate, updatedAt, now, members: [{ personId, name, lastSeen, pet }], reactions: [{ name, emoji, at, pet }], messages: [{ personId, name, pet, text, at }] } \| null` |
| `challenges:create` | mutation | `deviceSecret, title: TitleCard, totalEpisodes` | `{ code }` (creator joins) |
| `challenges:join` | mutation | `deviceSecret, code` | challenge (as `get`) |
| `challenges:leave` | mutation | `deviceSecret, code` | `null` |
| `challenges:report` | mutation | `deviceSecret, code, fraction, watchedEpisodes, label, finished` | `null`; first `finished` sets the winner |
| `challenges:get` | query | `code, t?` | `{ code, title, totalEpisodes, createdAt, creatorId, winnerId, winnerName, now, members: [{ personId, name, fraction, watchedEpisodes, label, finishedAt, updatedAt, pet }] } \| null` |
| `challenges:mine` | query | `deviceSecret` | `[{ code, title, totalEpisodes, winnerName, memberCount, myFraction, leaderName, leaderFraction }]` |
| `library:put` | mutation | `deviceSecret, items: LibraryItem[] (≤ 200)` | `{ saved }` (upsert by `key`; `saved` = items accepted) |
| `library:all` | query | `deviceSecret, t?` | `[{ key, name, year, kind, rating, ratedAt, status, statusAt, finishedAt, updatedAt }]` (absent fields are `null`, sorted by key) |

Times are milliseconds since 1970. `now` is the server clock, so clients can correct for drift.
Members are sorted by progress, then by who got there first. Party members not seen for 30 s drop
out of `members`. Reactions older than 10 s aren't returned.

`pet` is a short code the app turns into a pixel-pet avatar, like `p1-Ab3_x9`: 1 to 48 characters
of `[A-Za-z0-9_-]`; `""` removes it, anything else is `INVALID_ARGUMENT`. Every `pet` in a response (`hostPet`, party
members, reactions and messages, challenge members) is read from the person as they are now, so a
changed pet shows everywhere; it is `null` until set.

Party chat: `parties:say` trims the text, turns control characters (newlines too) into spaces and
cuts it to 280 characters. Empty text is `INVALID_ARGUMENT`, and so is a sixth message from the same
person within 5 s ("Slow down…"). A caller who isn't a member or the host gets `NOT_MEMBER`.
`parties:get` returns the latest 50 messages, oldest first; a message's `name` is the sender's name
when they said it. `t` on `parties:get`, `challenges:get` and `library:all` is ignored (see the
server README): send the current time so `now` isn't served from Convex's query cache.

Library backup: the same device secret is the identity, so moving a profile means reusing its secret
(a "recovery code"); registering it on another device returns the same `personId`. In `library:put`,
`key` is an IMDb id (`tt0903747`) or `n:<normalised name>|<year or empty>`, 1–160 characters; `name`
is required (capped at 200); `kind` is at most 16 characters; `rating` is a whole number 1–20; times
are ms. For each optional field, leaving it out keeps what's stored, `null` clears it and a value
sets it. `rating` and `status` are last-write-wins on `ratedAt` / `statusAt`: an incoming value
whose time is older than the stored one is ignored, a missing time counts as older than any time,
and a tie goes to the incoming value. Clearing keeps the time, so an older value from another device
can't come back. `ratedAt` and `statusAt` later than the server clock are clamped to it. `ratedAt`
without `rating` (or `statusAt` without `status`) is ignored. One bad item fails the whole call with
`INVALID_ARGUMENT` naming it (`items[3].rating …`). `library:all` returns every row in one response:
fine for a few thousand (3,000 rows ≈ 770 KB); Convex's per-query limit of 32,000 documents read
caps it at about 30,000.

### Client

- `TogetherClient`: plain `URLSession` JSON calls. Deployment URL from `Info.plist`
  (`CineonTogetherURL`).
- A **Together** page in the sidebar: enter a code, the party card, challenges with progress bars,
  share buttons, and codes opened before.
- Party sync polls once a second while in a party; challenge progress is reported when it changes
  and polled every few seconds while the page is open, otherwise once a minute (a toast says when
  someone wins).

## Not in this round

- Decrypting encrypted HLS or any DRM.
- Everyone controlling a party (only the host does).
- Accounts, sign-in, push notifications.
