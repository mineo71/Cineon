# Together and the cloud backup (Cineon.Core.Together)

Ports of `Core/TogetherClient.swift`, `App/TogetherModel.swift` and `App/CloudLibrary.swift`. Same
server calls, arguments, identity file and merge rules as the Mac. A profile folder from a Mac keeps
its identity (`Profiles\<UUID>\together.json`). Tests run against a fake Convex (`FakeConvex.cs`) that
ports `server/convex/*.ts` and checks arguments like Convex's validators. `CINEON_TOGETHER_LIVE=1`
also runs one smoke test against the dev deployment.

## API
- `TogetherClient(Uri, HttpClient?)`. `TogetherClient.Configured(buildUrl)` reads `CINEON_TOGETHER_URL`
  first (set but empty turns Together off), then `buildUrl`. Pass `TogetherClient.DevelopmentUrl` in
  Debug and `ProductionUrl` in Release. `QueryAsync<T>(path, args, decode)`,
  `MutationAsync<T>(...)`, `MutationAsync(path, args)` (null reply), `QueryRawAsync`. Each call has a
  12 s timeout. Every failure, including network, timeout and unreadable replies, is a
  `TogetherError`: `Message` is the sentence for people, plus `Code` (`TogetherErrorCode`: the
  server's `errorData.code`), `RawCode` and `IsTransport`.
- Wire types: `TitleCard` (`From(Title)`, `ToJson()`, `TitleKind`, `PosterUri`), `ShareInfo`,
  `PartyState` (`ExpectedPosition`), `PartyMember`, `PartyReaction`, `PartyMessage`,
  `ChallengeState`, `ChallengeMember`, `ChallengeSummary`, `CodeKind`, `Registered`, `CodeReply`,
  `CloudItem`. Each has `FromJson(JsonElement)`, and `FromJsonOrNull` where the Mac decodes `T?`.
  Server numbers are doubles, as on the Mac.
- `ShareCode.Normalize/Display`, `TogetherIdentity` (`Load(Profile)`, `Save(Guid)`, `FileFor(Guid)`).
- `TogetherModel(profile, library, ITogetherHost, IPartyPlayer, client?, SynchronizationContext?,
  TimeProvider?)`. State: `Party`, `IsHost`, `Challenges`, `Details`, `OpenedShares`,
  `LastShareCode`, `IsWorking`, `PersonId`, `IsAvailable`, `MyName`, `RecoveryCode`. Events:
  `PropertyChanged`, `Changed`. Actions (each returns a Task that never faults; failures become
  toasts): `Enter(code)`, `ShareWatched()`, `Share(title)`, `StartParty()`, `LeaveParty()`, `Say`,
  `React`, `CreateChallenge(title)`, `LeaveChallenge(code)`, `RefreshIdentity()`. Synchronous:
  `Start()`, `Stop()`, `ForgetShare`, `AddToBacklog(card)`, `HasInLibrary(card)`,
  `CopyPartyCode()`, `CopyChallengeCode(code)`, `LocalProgress(card, total)` (returns a
  `ChallengeProgress`). Async: `RefreshChallengesAsync()`, `AdoptAsync(recoveryCode)` (returns bool),
  `AuthorizedAsync()` (returns the client and the secret).
- `CloudLibrary(library, together, () => settings, context?, time?)`: `LastSync`, `IsSyncing`,
  `LastError`, `CloudCount`, `Changed`. Methods: `Start()`, `Stop()`, `SyncNow()`, `SyncAsync()`,
  `NoteChange(title)`, and the static `Key(imdbId, normName, year)` and `Keys(title)`.

## What the app implements
`ITogetherHost` (ProfileSession's side):
- `Settings`: reads `SharePet` and `FinishThreshold`.
- `PetCode`: `session.pet.code`.
- `Route` and `Go(TogetherRoute.Web | Together)`.
- `ShowToast` and `CopyText`.
- `ApplyMetadata(titleId, card)`: `metadata.apply(hit:)` with the card's IMDb id, name, year, kind
  and poster.
- `EnrichMetadata(titleId)`.
- `EpisodeCountAsync(title)`: episodes in seasons above 0, or 0 when unknown.

`IPartyPlayer` (BrowserModel/BrowserTab's side):
- `SelectedTab` and `Tab(id)` return a `PartyTab(Id, Url, Media, LinkedTitleId, Parsed)` snapshot,
  or null once the tab is closed. `Media` is `PartyMedia(Position, Duration, IsPlaying, Rate)` from
  the last media.js report. `Parsed` is TitleParser's guess as a `TitleCard`.
- `OpenTab(url, select)` returns the new tab's id. `Load(tab, url)` loads a page in an open tab.
- `EvaluateInPlayerAsync(tab, script)`: runs the script in the frame that holds the video and
  returns WebView2's JSON result text. The model only sends `TogetherModel.PlayerStateScript` and
  reads `t`, `paused` and `rate`. In WebView2 that's `CoreWebView2Frame.ExecuteScriptAsync` on the
  video's frame, or the top frame when the video is there.
- `PlayerCommand(tab, command)`: runs `window.__cineon && __cineon.<command>;` in the same frame.
  The model sends `play()`, `pause()`, `seek(n)` and `rate(n)`.
- `ShowBanner(tab, id, text, timeout)`: `__cineon.banner({"id","text","actions":[],"timeout"})`,
  like `BrowserTab.showBanner`.

Wiring, as in ProfileSession.swift:
- Build Together, then the cloud backup.
- Start: call `together.Start()`, then `cloud.Start()`. `cloud.Start()` takes
  `library.OnPersonalChange`.
- Close: call `cloud.Stop()`, then `together.Stop()`.
- When `SharePet` changes, call `RefreshIdentity()`.
- When `CloudBackup` is switched on, call `cloud.Start()`.
- After a successful `AdoptAsync`, call `await cloud.SyncAsync()`.

## Gotchas
- Construct both on the UI thread, or pass the dispatcher's `SynchronizationContext`. Every Task
  method moves to that context first, and all state changes and events happen there. Call the
  synchronous members and read properties on the UI thread too. Without a context, work runs on the
  thread pool.
- `Cineon.Core.Profile` is a namespace. Inside `Cineon.Core.*`, write the type as `Data.Profile`.
- Timers use the `TimeProvider`: the party ticks every 1 s, challenges every 5 s, and the backup
  syncs every 10 min, 3 s after start, and 1.5 s after the last change. Tests drive them with a
  manual clock.
- `parties:get` and `library:all` carry a fresh `t`. `challenges:get` doesn't, as on the Mac.
- Mac quirks kept:
  - Shares reopened at start come back in reverse order.
  - Seen reactions and messages are never cleared.
  - `AdoptAsync` renames the adopted person to this profile's name.

## Not 1:1
- `TogetherModel` lives in Core, not `App/`. It has no UI types: toasts, clipboard, navigation,
  settings, pet and metadata go through `ITogetherHost`, and tabs and the player through
  `IPartyPlayer`.
- The Mac's fire-and-forget actions return a `Task`. Swift `async` functions gained `Async`.
- `TogetherError` adds `Code`, `RawCode` and `IsTransport`. Network errors show .NET's message where
  the Mac shows URLError's. A timeout says "The request timed out." and an unreadable reply shows
  Swift's DecodingError sentence, both as on the Mac.
- `together.json` without `openedShares` loads; the Mac would replace the identity. Slashes aren't
  escaped when written. Either way, both apps read the file.
- `PartyMessage.Id` uses the text, not Swift's per-launch `hashValue`. Command numbers are invariant
  shortest form (`seek(601)` where Swift writes `seek(601.0)`).
- `Start()` called twice replaces its timer; the Mac would add a second one. CloudLibrary's unused
  `lastPull` is gone.
- Properties notify only when a value changes. `@Observable` notified on every assignment.
- `ShareCode.Normalize` upper-cases with .NET rules, so `ß` stays `ß` where Swift makes `SS`.
