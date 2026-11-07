# Parsing and metadata (src/core/parsing, src/core/metadata)

Ported 1:1 from `Core/TitleParser.swift`, `RescueMatcher.swift`, `EpisodeLinks.swift`, `Metadata.swift` and
`Images.swift`, by way of the Windows port (`windows/Cineon.Core/Parsing`, `Metadata`) and its Swift-compat
helpers. Checked against the Mac by `test/parsing/parity.test.ts`, which prints the same line per case as
`windows/Cineon.Core.Tests/Parsing/MacParity/ParsingDump.swift` and compares with its committed `expected.txt`:
**all 4,342 cases are identical, with nothing skipped or replaced** (the Windows port skips the ligature case
and replaces two relative addresses). Also identical: two fresh fuzz runs of 30,742 cases each
(`make_corpus.py 7 12` and `make_corpus.py 20261107 12`) and 121 hand-written edge cases (ligatures, ſ, the
Kelvin sign, final sigma, Arabic-Indic and full-width digits, U+0085 and U+2028), all run through the Swift dump
compiled from the Mac sources.

To rerun bigger, on a Mac, from the repo root: build the dump as the header of `ParsingDump.swift` says, then
`python3 windows/Cineon.Core.Tests/Parsing/MacParity/make_corpus.py <seed> <scale> /tmp/c.jsonl`,
`/tmp/parsingdump/dump /tmp/c.jsonl > /tmp/c.expected`, and in `extension/`:
`CINEON_PARSING_CORPUS=/tmp/c.jsonl CINEON_PARSING_EXPECTED=/tmp/c.expected npx vitest run test/parsing/parity.test.ts`.
`CINEON_PARSING_DUMP=<path>` writes this side's lines for a diff.

## API

Addresses are strings holding what Foundation's `URL.absoluteString` would (`SwiftUrl.string(text)` turns any
text into that), dates are milliseconds since 1970, and absent values are `null`, so everything survives
extension messaging and IndexedDB.

`src/core/parsing` (`index.ts`):
- `TitleParser.parse(meta: PageMeta): ParsedTitle | null`, `.clean(text, siteTokens: ReadonlySet<string>)`,
  `.episodeRefIn(text): EpisodeRef | null` (Swift `episodeRef(in:)`), `.kindHint(text): TitleKind`,
  `.normalize(text)` (forwards to `LibraryText.normalize`).
- `PageMeta` (`{ url, title, ogTitle?, ogType?, ogSite?, ogImage?, ogDescription?, twitterTitle?, h1?, ld: LinkedData[],
  icon?, search? }`), `PageMeta.from(value: unknown)` for what `meta.js` posts and `PageMeta.fromJson(text)`: as strict
  as `JSONDecoder` (url, title and ld required, a wrong type fails it all, null on failure).
- `ParsedTitle { name, altName, year, ref, episodeName, kindHint, posterUrl, overview, confidence }`.
- `RescueMatcher.best(links, names, year, pageUrl): RescueMatch | null`, `.score(link, names, year)`,
  `.isStrong(match)`, `.nameScore(text, name)`, `.tokens(text)`, `.years(text)`, `.isVideoSharing(url)`,
  `.mirrors(url, hosts): string[]`, `.strongScore` 0.9, `.possibleScore` 0.6; `RescueLink { url, text, context }`,
  `RescueMatch { link, score, yearConfirmed }`.
- `SiteBrand.of(domain)`: the Mac's `ImportAnalyzer.brand`. The browser import port should call it, not copy it.
- `EpisodeLinks.url(url, current, target): string | null`.
- `NextEpisode.candidates(after, episodes, now = Date.now()): EpisodeRef[]` (episodes need `season`, `episode`, `released`).
- `SkipLearner.Jump` (= `SkipJump`): `new SkipJump(from, to, lastAt)` (seconds of video, `lastAt` in ms since 1970),
  `.extended(from, to, at): SkipJump | null`; `SkipLearner.mergeWindow` (4, seconds), `.isIntro(from, to, duration)`,
  `.isCredits(remaining, duration)`, `.agree(a, b)`, `.siteKey(host)`.
- `SwiftUrl.parse(text)` / `.from(url)` / `.string(text)` / `.fixUp(text)`, with `absoluteString`, `scheme`, `host`,
  `path`, `query`, `lastPathComponentWithoutExtension`, `withHost(host)`, `resolve(reference)`: Foundation's reading of
  an address, for code that needs to agree with the Mac about one.
- `TitleKind` (`"film" | "series" | "cartoon" | "unknown"`, the Mac's raw values), `TITLE_KINDS`, `titleKindFromRaw`,
  `EpisodeRef { season, episode }` with `EpisodeRef.none`, `.of`, `.isEpisode`, `.equals`.

`src/core/metadata` (`index.ts`):
- `new MetadataClient({ fetch?, timeoutMs? = 8000, userAgent? })` / `MetadataClient.shared`:
  `search(query, signal?): Promise<MetadataHit[]>`, `detail(imdbId, kind, signal?): Promise<MetadataDetail | null>`;
  static `searchUrl`, `parseSearch(json)`, `bestMatch(hits, name, year, kind)`, `resizedPoster(raw, width)`,
  `detailUrls(imdbId, kind)`, `parseDetail(json)`, `parseDate(text)` (ms), `userAgent`.
  Same endpoints (`v3.sg.media-imdb.com/suggestion/x/…json`, `v3-cinemeta.strem.io/meta/{movie|series}/…json`), same
  decoding and the same film-then-series fallback for unknown kinds and cartoons.
- `new PagePreview({ fetch?, timeoutMs?, userAgent? })` / `.shared`: `fetch(url, signal?): Promise<{ poster, overview }>`
  (first 300,000 bytes), static `parse(html, base)`, `userAgent` (Safari's, as on the Mac).
- `MetadataHit { id, name, year, kind, posterUrl, subtitle, rank }` (`metadataHit(...)` builds one),
  `EpisodeInfo { id ("2x4"), season, episode, name, overview, thumbnailUrl, released }` (`episodeInfo(...)` fills the id),
  `MetadataDetail { overview, genres, runtimeMinutes, posterUrl, backdropUrl, year, episodes }`.
- `new MetadataService({ library, enabled, client?, preview?, pauseMs? = 120 })`: `enrich(titleId, altName?, inBackground?)`,
  `apply(hit, titleId)` (Swift `apply(hit:to:)`), `episodes(title, fresh?)`, `testEpisodes: Map<titleId, EpisodeInfo[]>`,
  `idle` (settles when the queue is empty).
- `new ImageCache({ fetch?, caches?, cacheName? = "cineon-images", diskCapacity? = 400 MB, memoryCapacity? = 8 MB,
  timeoutMs? = 15000, now? })` / `.shared`: `data(url): Promise<Uint8Array | null>` (memory, Cache Storage, network;
  one fetch per address at a time), `cached(url)` (memory only), `diskSize()`, static `entryUrl(url)`.
  `new ImagePipeline<TImage>(cache, decode(bytes, maxPixel), cost(image), costLimit = 200 MB)`: `image(url, maxPixel)`,
  `cached(url, maxPixel)`, static `key` ("600|https://…"). `CostCache<K, V>`. `Rgb { r, g, b }` with `Rgb.black`,
  `.of`, `.brightness`, `.boosted(c, 1.5)`.

## What the data layer must provide

- `src/core/parsing/data-copy/` holds copies of the data layer's `LibraryText.normalize` (`libraryText.ts`),
  `DomainName` (`domainName.ts`), `UrlKey.make` (`urlKey.ts`), `UrlText` (`urlText.ts`) and the `TitleKind` and
  `EpisodeRef` types (`models.ts`), because `src/core/data` was being written at the same time. Once it lands, each
  file should become a re-export of the data layer's, so the library's keys and the parser's are one copy (as
  `windows/notes/data.md` asks). They were checked by the parity run above: `normalize` is the C# `LibraryText.Normalize`;
  `DomainName` follows the Swift (full lower-casing, Swift's `Int`), which agrees with the C# on real host names.
- `MetadataLibrary<T extends MetadataTitle>`, for `MetadataService`: `title(id)` and `titles()` read synchronously
  (the apps keep titles in memory, and `enrich` checks `metadataChecked` before it queues); `update(title)` and
  `merge(fromId, intoId)` may return promises, which are awaited; `latestProgressUrl(titleId)` is
  `latestProgress(titleID)?.url`. `MetadataTitle` is the fields metadata reads and writes: `id`, `name`, `normName`,
  `year`, `kind`, `imdbId`, `posterUrl`, `backdropUrl`, `overview`, `genres`, `runtimeMinutes`, `metadataChecked`.
  Updates are made with object spread (`{ ...title, posterUrl }`), so titles should be plain objects.

## What the UI must do with images

- One `ImagePipeline<ImageBitmap>` over `ImageCache.shared`, in an extension page or the service worker (Cache Storage
  there is the extension's; in a content script `caches` would be the site's). `decode`:
  `createImageBitmap(new Blob([bytes]), { resizeWidth/Height so the longest side is at most maxPixel (never up),
  resizeQuality: "high", imageOrientation: "from-image" })` (the Mac applies the EXIF transform); `cost` =
  `width * height * 4`. Return null when decoding fails.
- `RemoteImage`: draw the placeholder, then `pipeline.cached(url, maxPixel)` at once if there (no flash), else load and
  fade in over 0.25 s ease-out; ignore a result whose url has changed. Default `maxPixel` 600, cover.
- `ColorZones.sample` and `ImagePipeline.zones(of:)` are drawing: decode at 256, draw into a 3x2 canvas
  (`imageSmoothingQuality: "medium"`), read the six pixels left to right, top row first, as `Rgb` / 255.

## Not 1:1

- Nothing in the parity corpus. ICU's case-insensitive matching folds ligatures and ß inside literal strings
  ("ﬁlm online" is noise on the Mac), which JavaScript's `i` doesn't; the ICU-to-JavaScript translation
  (`swiftText.ts`, `icuSource`) expands literal runs with those characters as alternatives, so it matches here.
- A page's relative poster ("/p.jpg" in `og:image`, `ld.image`, Cinemeta) stays relative, as Foundation keeps it (the
  Windows port makes it null). `ImageCache` only fetches absolute http(s) addresses, so it loads nothing, as on the Mac.
- The disk cache is Cache Storage, not URLCache's `Cache.db`: entries at `https://cineon-images.invalid/<SHA-256 of
  the address>` (the Windows file names), with sizes and last use in `index.json` beside them. Same rules: 200
  responses without `no-store`, entries up to 5% of capacity, least recently used out first down to 90%. Last use is
  saved with every write and 2 s after reads, so a worker stopped in between loses only a little ordering.
- `User-Agent` is sent as on the Mac, but Chrome drops it from `fetch` (a forbidden header there); Firefox sends it. If
  a service ever answers differently, set it with a `declarativeNetRequest` `modifyHeaders` rule for those hosts.
  Requests use `credentials: "omit"` (the Mac's sessions are ephemeral). Images go without a custom agent.
- Timeouts (8 s metadata, 15 s images) are for the whole request, as on Windows; URLSession's is an idle time.
- Swift's `Int` from JSON is checked against 64 bits, but values past 2^53 come back rounded. `parseDate` returns
  null for a zone offset past ±14 h, where the C# would throw.
- `enrich` starts its queue on a microtask, like Swift's `Task` from the main actor: several calls made in one turn
  all queue before the first lookup, so what's being watched still goes first.
- Unicode tables are the browser's (Node 20 here: Unicode 16), as the Windows port's are .NET's. The letter ranges
  Foundation's `CharacterSet` lacks are excluded as on Windows.
- Needs `Intl.Segmenter` (Chrome 87, Firefox 125), RegExp lookbehind, `\p{…}` and the `d` flag.

## Left for other ports

- As on Windows, everything in `Browser/EpisodeAutopilot.swift` (state, `tick`, settling, banners, credits learning,
  `findNext`, `skipToNext`, `playNext`) belongs to the background tracker, which calls `EpisodeLinks`, `NextEpisode`,
  `SkipLearner` and `RescueMatcher` from here. `FrameGradingTests` belong to the frame collector and
  `SkipRuleStorageTests` to the data layer.
- The browser import port should use `SiteBrand.of`, and the data layer's `Timecode` tests stay with it.
