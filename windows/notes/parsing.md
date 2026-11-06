# Parsing and metadata (Cineon.Core.Parsing, Cineon.Core.Metadata)

Ported 1:1 from `Core/TitleParser.swift`, `RescueMatcher.swift`, `EpisodeLinks.swift`, `Metadata.swift` and
`Images.swift`. Checked against the Mac by `Parsing/MacParity/ParsingDump.swift` (compiled with the real Swift
sources): 4,342 committed cases (page titles in English, Ukrainian and Russian, addresses, link texts, IMDb and
Cinemeta bodies, dates, HTML heads) plus two 30-38k fuzz runs give identical output. To rerun bigger:
`make_corpus.py <seed> <scale> <out>`, run the Swift dump on it, point `CINEON_PARSING_CORPUS`/`_EXPECTED` at both.

## API
- `TitleParser.Parse(PageMeta) -> ParsedTitle?`, `Clean(text, siteTokens)`, `EpisodeRefIn(text)` (Swift
  `episodeRef(in:)`), `KindHint(text)`, `Normalize` (forwards to `LibraryText.Normalize`).
- `PageMeta` (+ `LinkedData`) and `PageMeta.FromJson(string|JsonElement)`: what `meta.js` posts, decoded as strictly
  as `JSONDecoder` (url, title, ld required; a wrong type fails it all; null on failure).
- `RescueMatcher.Best(links, names, year, pageUrl)`, `Score`, `NameScore`, `Tokens`, `Years`, `IsVideoSharing`,
  `Mirrors(url, hosts)`; `RescueLink(Url, Text, Context)`, `RescueMatch(Link, Score, YearConfirmed).IsStrong`.
- `SiteBrand.Of(domain)`: the Mac's `ImportAnalyzer.brand`. The browser import port should call it, not copy it.
- `EpisodeLinks.Url(url, current, target) -> Uri?`; `NextEpisode.Candidates(after, episodes, now?)`;
  `SkipLearner.Jump(From, To, LastAt).Extended(...)`, `MergeWindow`, `IsIntro`, `IsCredits`, `Agree`, `SiteKey`.
- `MetadataClient(handler?)` / `.Shared`: `SearchAsync`, `DetailAsync(imdbId, kind)`, static `BestMatch`,
  `ResizedPoster`, `SearchUrl`, `DetailUrls`, `ParseSearch`, `ParseDetail`. `PagePreview(handler?)` / `.Shared`:
  `FetchAsync(url)`, static `Parse(html, base)`. Records `MetadataHit`, `EpisodeInfo` (`Id` = "2x4"), `MetadataDetail`.
- `MetadataService(library, enabled, client?, preview?)`: `Enrich(id, altName, inBackground)`,
  `ApplyAsync(hit, id)` (Swift `apply(hit:to:)`), `EpisodesAsync(title, fresh)`, `TestEpisodes`. Like the
  LibraryStore it writes to, call it on the UI thread; its awaits come back there.
- `ImageCache(directory, handler?, diskCapacity, memoryCapacity)` / `.Shared` (`<data>\ImageCache`):
  `DataAsync(url)` (memory, disk, network; one fetch per address at a time), `Cached(url)` (memory only),
  `DiskSize`. `ImagePipeline<TImage>(cache, decode, cost, costLimit)`: `ImageAsync(url, maxPixel)`,
  `Cached(url, maxPixel)`, `Key`. `Rgb(R, G, B)`: `Brightness`, `Boosted(1.5)`, `Black`.

## What the UI must do with images
- One `ImagePipeline<SoftwareBitmap>` (or `BitmapSource`) over `ImageCache.Shared`. `decode`: `BitmapDecoder` on a
  thread-pool thread, `BitmapTransform` scaled so the longest side is at most `maxPixel` (never up), Fant
  interpolation, `ExifOrientationMode.RespectExifOrientation` (the Mac applies the EXIF transform); `cost` =
  `PixelWidth * PixelHeight * 4`. Return null when decoding fails.
- `RemoteImage`: draw the placeholder, then `pipeline.Cached(url, maxPixel)` at once if there (no flash), else load
  and fade in over 0.25 s ease-out; ignore a result whose url has changed. Default `maxPixel` 600, fill.
- `ColorZones.sample` and `ImagePipeline.zones(of:)` are drawing: decode at 256, scale to 3x2 in sRGB (Fant is close
  to CoreGraphics' medium interpolation), read the six pixels left-to-right, top row first, as `Rgb` / 255.

## Not 1:1
- ICU's case-insensitive matching folds ligatures and ß ("ﬁlm online" is noise on the Mac); .NET's doesn't.
- Text Foundation would keep as a relative URL ("/p.jpg" in `og:image`, `ld.image`, Cinemeta posters) becomes null:
  there's no relative `Uri` that survives the database here anyway.
- The disk cache is SHA-256-named files in `ImageCache`, not URLCache's `Cache.db` (a copied Mac folder is ignored
  and left alone). 2xx-only, no `no-store`, entries up to 5% of capacity, least recently used out first down to 90%.
- `HttpClient.Timeout` (8 s metadata, 15 s images) is a total time; URLSession's is an idle time.
- User agents are the Mac's word for word ("(Macintosh) Cineon/1.0", Safari for page previews) so servers answer alike.
- Matching, not a difference: CJK numerals as numbers, full upper-casing, CharacterSet tables, grapheme-aware `contains`/`components`/`replacing` and
  Foundation's per-part URL fix-up are copied from Swift's behaviour in `SwiftText`/`SwiftUrl` (internal).

## Left for other ports
- `Browser/EpisodeAutopilot.swift` has no pure logic the Mac tests exercise (they test `EpisodeLinks`,
  `NextEpisode`, `SkipLearner` and `RescueMatcher`, all here). Everything in it stays with the browser port:
  `AutopilotState`, `NextEpisodeTarget`, `EpisodeExit`, rule loading and `setSkips`, `tick`, jump settling and the
  intro banner, credits learning, undo, `findNext` (`__cineon.hasEpisode`, `SiteProbe`), `skipToNext`, `playNext`.
- `FrameGradingTests` (CoreGraphics) belong to the frame collector; `SkipRuleStorageTests` to the data layer.
- Found while checking, in Data (not changed here): `UrlText.EncodeInvalid` keeps valid `%XX` in a part that also
  has invalid characters, where Foundation re-encodes the whole part ("a%20b c" is "a%2520b%20c"), so `UrlKey` can
  differ for such addresses; `SwiftUrl.FixUp` has the Foundation rule. `LibraryText.Normalize` drops accents that
  open a string with no letter before them, which Foundation keeps (`RescueMatcher.Tokens` handles it).
