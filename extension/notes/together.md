# Together and the cloud backup (`src/core/together`)

Ports of `Core/TogetherClient.swift`, `App/TogetherModel.swift` and `App/CloudLibrary.swift`, translated
from the Windows port (`windows/Cineon.Core/Together`). Same server calls, arguments, identity JSON and
merge rules as the apps, so a person keeps one identity, one set of challenges and one cloud library
across the Mac, Windows and the browser. No browser APIs: the runtime supplies fetch (the global one by
default), storage, timers, tabs and the player through the interfaces below.

Tests run against a fake Convex (`test/together/fakeConvex.ts`, a port of `FakeConvex.cs`, itself a port
of `server/convex/*.ts` that checks arguments like Convex's validators) behind a fake `fetch`, with a
manual clock. Nothing in the suite reaches the network: `blockNetwork()` replaces the global fetch with
one that throws. `CINEON_TOGETHER_LIVE=1 npx vitest run test/together/live.test.ts` runs one smoke test
against the **dev** deployment (never production); it leaves a throwaway person, share and ended party
there.

## API

### Client (`client.ts`, `types.ts`)
- `new TogetherClient(baseUrl, { fetch?, timeoutMs? })`. `TogetherClient.configured(override, buildUrl =
  PRODUCTION_URL, options?)`: `override` wins when it's set, even to `""`, which turns Together off (the
  apps' `CINEON_TOGETHER_URL`); otherwise `buildUrl`. Null unless it's an http(s) address.
  `PRODUCTION_URL` is `https://admired-mouse-481.eu-west-1.convex.cloud` (what people install),
  `DEVELOPMENT_URL` the dev deployment. Use dev for development builds and e2e.
- `query(path, args, decode, signal?)`, `mutation(path, args)` (answer ignored, Swift's `NullReply`),
  `mutation(path, args, decode, signal?)`, `queryRaw(path, args, signal?)`, `endpoint(kind)`,
  `TogetherClient.clean(message)`. POST `/api/query|mutation` with `{"path","args","format":"json"}`,
  12 s timeout. The status line is ignored; the body says what happened.
- Every failure is a `TogetherError`: `message` is the sentence for people; `code` is the server's
  `errorData.code` (`"INVALID_ARGUMENT" | "UNKNOWN_DEVICE" | "NOT_FOUND" | "NOT_MEMBER" | "NOT_HOST" |
  "PARTY_ENDED"`, or null), `rawCode` as sent, `isTransport` for no answer (network, timeout). A
  timeout says "The request timed out.", an unreadable reply "The Together server sent something
  unexpected", a value of the wrong shape Swift's "The data couldn't be read because it isn't in the
  correct format." (`cause` is the `DecodeError`). Cancelling through `signal` rejects with the abort
  reason, not a TogetherError. Non-finite numbers in arguments are refused before sending.
- Wire types are interfaces plus a companion object of the same name with `fromJson` (and `fromJsonOrNull`
  where the Mac decodes `T?`): `TitleCard` (`make`, `from(title)`, `toJson`, `titleKind`, `posterUri`),
  `ShareInfo`, `PartyState` (`expectedPosition`), `PartyMember`, `PartyReaction`, `PartyMessage` (`id`),
  `ChallengeState`, `ChallengeMember`, `ChallengeSummary` (`listFromJson`), `CodeKind`, `Registered`,
  `CodeReply`, `CloudItem` (`make`, `newest`). Server numbers are float64 and times are milliseconds
  since 1970, as the server sends them. Optional fields are `null`, never missing.
- `ShareCode.normalize(raw)` / `ShareCode.display(code)` (`K7Q-2MX`).

### Identity (`identity.ts`)
- `TogetherIdentity` (`secret`, `name`, `personId`, `openedShares`, `partyCode`, `pet`), `load(store,
  name)`, `save(store)`, `encode()`, `decode(text)`, `newSecret()` (32 random bytes, base64),
  `isStrictBase64(text)`.
- `IdentityStore { read(): string | null | Promise<…>; write(text): void | Promise<void> }` holds the
  text of the apps' `together.json`, byte-compatible both ways, so a profile's identity can be imported
  from or exported to the apps as that file. `memoryIdentityStore(initial?)` for tests.
- The runtime's store: `chrome.storage.local` under a per-profile key, e.g. `together:<profile UUID>`,
  holding the JSON text. A missing or unreadable identity is replaced by a new one, as on the Mac.

### Model (`model.ts`)
`await TogetherModel.create({ profile, library, host, player, client, identityStore, clock?, urlKey? })`
(async because it loads the identity).
- State (read-only): `party`, `isHost`, `challenges`, `details` (a `ReadonlyMap`, replaced on change),
  `openedShares` (replaced on change), `lastShareCode`, `isWorking`, `personId`, `isAvailable`,
  `myName`, `recoveryCode`, `clock`.
- `subscribe(listener)` → unsubscribe. The listener hears the name of what changed (`TogetherProperty`).
- Actions, each a promise that never rejects (failures become toasts, as on the Mac): `enter(code)`,
  `shareWatched()`, `share(title)`, `startParty()`, `leaveParty()`, `say(text)`, `react(emoji)`,
  `createChallenge(title)`, `leaveChallenge(code)`, `refreshIdentity()`, `addToBacklog(card)`.
- Synchronous: `start()`, `stop()`, `forgetShare(code)`, `hasInLibrary(card)`, `copyPartyCode()`,
  `copyChallengeCode(code)`, `localProgress(card, total)` → `ChallengeProgress { fraction, watched,
  label, finished }`.
- Other async: `refreshChallenges()`, `adopt(recoveryCode)` → boolean, `authorized()` → `{ client,
  secret }` (throws TogetherError; for the backup), `whenSaved()` (identity writes so far are done),
  `partyTick()` (what the party loop runs every second).
- `TogetherModel.parsePlayerState(value)` reads media.js's `state()` (object or JSON text).
  `TogetherModel.MINIMUM_DURATION` is 240 s.
- `simpleUrlKey(url)` is the stand-in page key used when `urlKey` isn't given.

### Cloud backup (`cloud.ts`)
`new CloudLibrary({ library, together, settings: () => ({ cloudBackup }), clock? })` (the clock defaults to
the model's).
- State: `lastSync` (milliseconds since 1970, or null), `isSyncing`, `lastError`, `cloudCount`;
  `subscribe(listener)`.
- `start()`, `stop()`, `syncNow()`, `sync()`, `noteChange(title)`, `flush()`, `merge(remote)` → the
  titles to send; static `key(imdbId, normName, year)`, `keys(title)`, `item(title)`, `ms(seconds)`,
  `BATCH_SIZE` (200).

## What the runtime implements
`TogetherLibrary<Title>` and `CloudLibrarySource<Title>` (`library.ts`) are the parts of core/data's
`LibraryStore` used here, and its store fits them as is: `titles` (a `ReadonlyMap`), `watched`,
`find(name, altName?, year?)`, `progressList(titleId)` (rows with `ref: { season, episode }`),
`setStatus`, `addTitle(name, { year, kind, status, imdbId, posterUrl })`, `restore(id, { halves?,
ratedAt?, status?, statusAt?, finishedAt? })` (a key left out is left alone; `halves: null` clears) and
the settable `onPersonalChange`. Dates are seconds since 1970 (the data layer's), converted to the
server's milliseconds here. Mutations may answer with a promise; reads are synchronous.

`TogetherHost<Title>` (the profile session's side):
- `settings` (`sharePet`, `finishThreshold`, read each time), `petCode` (core/profile's `pet.code`),
  `route` (`"web"` when a web page is in front, `"together"` on the Together page, else `"other"`).
- `go("web" | "together")`: focus the party's tab / open the Together page.
- `showToast(text)`: a toast on the Cineon page, or a notification when none is open. `copyText(text)`.
- `applyMetadata(titleId, card)`: `metadata.apply(hit)` with the card's IMDb id, name, year, kind and
  poster. `enrichMetadata(titleId)`. `episodeCount(title)`: episodes in seasons above 0, or 0.

`PartyPlayer` (the background's tabs and the content scripts' media.js); every member may answer with a
promise, and every call is about a tab that may have closed (do nothing then):
- `selectedTab()` and `tab(id)` return a `PartyTab { id, url, media, linkedTitleId?, parsed? }` snapshot
  (null once closed). `media` is `{ position, duration, isPlaying, rate }` from the last media.js report;
  `parsed` is TitleParser's guess as `TitleCard.make(name, year, kindHint)`.
- `openTab(url, select)` → the new tab's id (`chrome.tabs.create`). `load(tab, url)` (`chrome.tabs.update`).
- `playerState(tab)`: media.js's `__cineon.state()` from the frame with the video (a message to that
  frame's content script; MV3 can't run a script string). Only `t`, `paused` and `rate` are read.
- `playerCommand(tab, command)`: `{ kind: "play" | "pause" } | { kind: "seek", seconds } | { kind:
  "rate", rate }`, sent to the same frame to call `__cineon.play()` etc. `playerCommandText(command)` gives
  the apps' text (`seek(601)`).
- `showBanner(tab, id, text, timeout)`: media.js's `__cineon.banner({id, text, actions: [], timeout})`.

Wiring, as in ProfileSession.swift: build Together, then the backup. Start: `together.start()`, then
`cloud.start()`. Close: `cloud.stop()`, then `together.stop()`. When `sharePet` changes, call
`refreshIdentity()`; when `cloudBackup` is switched on, `cloud.start()`; after a successful `adopt`,
`await cloud.sync()`.

## Gotchas
- Timers come from the `Clock` (`systemClock` by default): the party ticks every 1 s, challenges every
  5 s, the backup syncs every 10 min, 3 s after start and 1.5 s after the last change. An MV3 service
  worker is stopped after ~30 s without extension events, which would stop a party's 1 s loop and the
  10-minute sync: keep the model where it lives (the Cineon page or an offscreen document while a party
  is on), or keep the worker awake with `chrome.alarms` and messages while it matters.
- `parties:get` and `library:all` carry a fresh `t`; `challenges:get` doesn't, as on the Mac.
- Mac quirks kept: shares reopened at start come back in reverse order; seen reactions and messages are
  never cleared; `adopt` renames the adopted person to this profile's name.

## Not 1:1
- `TogetherModel` has no UI types: toasts, clipboard, navigation, settings, pet and metadata go through
  `TogetherHost`, tabs and the player through `PartyPlayer`, the library through `TogetherLibrary`, and the
  identity file through an `IdentityStore`. The model is made with `await TogetherModel.create(...)`.
- No SynchronizationContext: JavaScript is single-threaded. `subscribe` replaces `PropertyChanged` and
  `Changed`, and only fires when a value changes (`details` and `openedShares` are new objects each time).
- `TogetherErrorCode` is the server's string (`"NOT_FOUND"`), null for none. Network errors carry the
  browser's message ("Failed to fetch") where the Mac shows URLError's.
- The player is asked for media.js's state and sent structured commands instead of script strings
  (MV3 forbids evaluating strings); command numbers are shortest form (`seek(601)` where Swift writes
  `seek(601.0)`), as on Windows.
- `PartyMessage.id` uses the text, not Swift's per-launch `hashValue` (as on Windows).
- `addToBacklog` returns a promise (the library's writes are async here).
- `urlKey` is injected (core/data's `UrlKey.make`); without it a smaller stand-in is used that drops the
  scheme, `www.`, tracking parameters and fragments other than `s:1-e:2`.
- `ShareCode.normalize` upper-cases with JavaScript's full mapping, so `ß` becomes `SS` as in Swift
  (Windows keeps `ß`). Characters are grapheme clusters via `Intl.Segmenter`.
- `lastSync` is milliseconds since 1970 rather than a date. CloudLibrary's unused `lastPull` is gone.
- `start()` called twice replaces its timer (as on Windows); the Mac would add a second one.
