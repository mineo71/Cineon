# Data layer (Cineon.Core.Data)

Same schema as the Mac (sqlite_master identical; a Mac-made DB opens with no migration, and the Mac
reads Windows-written DBs). Fixture: `Cineon.Core.Tests/Fixtures/mac-profile.sqlite` (fake data).

## Gotchas
- Addresses are `Uri`: use `.OriginalString` for the exact text, never `.ToString()` (strips
  percent-encoding). `Uri` equality ignores `#fragment`; compare `OriginalString` when it matters.
- Dates are `DateTimeOffset`. `StoredDate.ToUnix/FromUnix` (DB) and `ToReference/FromReference`
  (Swift JSON, seconds since 2001).
- `LibraryStore` belongs to the UI thread; raises `INotifyPropertyChanged` and a coarse `Changed`.
- Upper-case UUID strings everywhere (`Database.UuidString(Guid)`), as the Mac writes them.
- Text keys: `LibraryText.Normalize` (Swift `TitleParser.normalize`) and `LibraryText.CanonicalGenre`.

## Renames from Swift
Nested enums become `SkipRuleKind`, `MediaSourceKind`, `LibraryList`, `LibraryKind`, `RatingFilter`,
`LibrarySort`; `URLKey` becomes `UrlKey`. Overloads split by label: `SessionsForTitle`, `SiteForHost`,
`QualityIn`, `GenresIn`, `DecadesIn`, `FramePath`/`BestFramePath`, `FramesSizeAsync`/`PruneFramesAsync`.
`restore(halves: Int??)` becomes `Restore(id, restoreRating, halves, ...)`; `moveSite(IndexSet, Int)`
becomes `MoveSite(IEnumerable<int>, int)`.

## Main types
`Title`, `EpisodeRef`, `WatchProgress`, `WatchSession`, `SkipRule`, `FilmFrame`, `LibraryEvent`,
`HistoryEntry`, `PersistedTab` (WebKit state from a Mac is unusable here), `Site`, `DownloadItem`,
`MediaSource`, `SitePrefs`, `ShieldStats`, `Profile`, `LibraryQuery`, `AppSettings` (33 Mac keys,
`Decode/Encode`), `Database(path)` (every Swift method in PascalCase), `LibraryStore(Database)`,
`ProfileStore`, `AppPaths` (`Root`, `IsScratch`, `IsTestRun`, `Profile(Guid)`,
`DefaultDownloadsFolder`, `DownloadsFolder(settings)`), `SqliteDb`, `DomainName`, `Rating`,
`Timecode`, `UrlKey`, `Urls.Parse`.
