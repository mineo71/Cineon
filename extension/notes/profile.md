# Pixel pet and profile stats (`src/core/profile`)

Ports of `Cineon/Profile/PixelPet.swift` and `ProfileStats.swift`, translated from the Windows port
(`windows/Cineon.Core/Profile`). Pixel-identical to the Mac for every look (13,680 combinations × 10
frames), the same codes byte for byte, and the same device pixels as SwiftUI's `PixelPetView` at 1× and
2×. `test/profile/macParity.test.ts` checks this with the FNV-1a hashes the Swift dump programs printed
(`windows/Cineon.Core.Tests/Profile/MacParity/*.swift`); the TypeScript dumps are in
`test/profile/macParity/`. Set `CINEON_PET_DUMP` to a folder to get the dump text for a diff.

## Showing a pet in the UI
- Your own: `PixelPet.make(stats.petTraits(PetTraits.seedFor(profile.id)))`. The seed is the profile UUID
  in upper case, like the Mac, or the name and tone differ.
- A friend's: `PixelPet.fromCode(code)`; null means show their initial.
- Every `PetCanvas.frameInterval` (100 ms) while the pet is visible and animated:
  `PetCanvas.frameFor(pet, size, { framing, animated, reduceMotion })`, and redraw only when
  `!PetFrame.equals(frame, last)`. Still avatars (top bar 28, Together lists 44 × 0.86 and 24 × 0.86, the
  share card 150) and `prefers-reduced-motion` draw the resting frame once. Rate mode is 120, the profile
  hero 168.
- Draw: `PetCanvas.draw(canvas, pet, frame, size, devicePixelRatio, framing)`. It sizes the canvas to
  `ceil(size × scale)` device pixels, sets its CSS size to `pixelWidth / scale` px, turns
  `imageSmoothingEnabled` off and puts the pixels, so one canvas pixel is one device pixel. Redraw when
  `devicePixelRatio` changes (a `matchMedia("(resolution: …dppx)")` listener). Anything else that scales
  a pet (`bitmap.toRgba()` is 24×24) must use nearest-neighbour (`image-rendering: pixelated`).
- Accessibility: `role="img"`, `aria-label={pet.accessibilityDescription}`.
- `JSON.stringify(pet)` is the code, as the Mac's `Codable`.

## API
- Enumerations are string unions of the Swift case names (`"fox"`, `"glasses3D"`, `"sciFi"`), each with
  a companion object of the same name: `all` (in code order), `ordinal`, `fromRaw`, `label`, and the C#
  extension members: `PetStage.minimumExperience/next/fromExperience`, `PetMood.fromDaysSinceLastWatch`,
  `PetAccessory.isHat`, `PetGenre.species/accessory/tone/fromName`. `PetSpecies`, `PetStage`,
  `PetMood`, `PetAccessory`, `PetTone`, `PetGenre`, `PetEyes`, `PetMouth`, `PetEffect`, `PetFraming`.
- `PixelPet`: `new PixelPet({ species, stage, accessory?, tone?, mood?, level?, nameIndex? })`;
  fields `species stage accessory tone mood level nameIndex`; `code`, `name`, `blurb`, `speciesLabel`,
  `stageLabel`, `moodLabel`, `accessoryLabel`, `accessibilityDescription`, `restingFrame`, `frameAt(t)`,
  `bitmap(frame?)`, `contentBounds`, `equals`, `toJSON`. Static: `make(traits)`, `fromCode(code)`,
  `experience(hours, titles)`, `levelForExperience(xp)`, `rankedGenres(genres)`, `growth(traits)`,
  `nameIndexFor(seed, species)`, `stableHash(text)` (bigint), `tightCrop(bounds, devicePixels)`,
  `maxLevel`, `nameCount`, `codePrefix`, `nameHeads`, `nameTails`.
- `PetTraits { genres, hoursWatched, titlesFinished, daysSinceLastWatch, seed }`, `PetTraits.seedFor(id)`;
  `GenreWeight { name, weight }`; `PetGrowth`.
- `PetFrame` (plain object; `PetFrame.make()`, `PetFrame.equals`), `PetCrop` (`PetCrop.canvas`),
  `PetBitmap` (`pixels: Uint32Array` of 0xAARRGGBB, `get`, `set`, `toRgba(crop?)`, `equals`).
- `PetCanvas`: `frameInterval`, `now()` (seconds since 2001, the Mac's clock), `timeSinceReferenceDate`,
  `isTight`, `adjusted`, `frameFor`, `cropFor`, `deviceRects`, `layout` (rectangles in CSS px for an SVG
  or a 2D context's `fillRect`), `renderBitmap`, `render` (a `PetImage { pixelWidth, pixelHeight, rgba }`,
  usable as `new ImageData(rgba, pixelWidth, pixelHeight)`), `draw`. `draw` takes a `PetCanvasElement`
  (an `HTMLCanvasElement` or `OffscreenCanvas` fits); the core touches no DOM globals.
- `PetArt` (sprites, palettes, overlays, `spriteFor`, `palette`, `allOverlays()`), `renderPet`,
  `Fnv64`/`stableHash`.
- `ProfileStats.compute(titles, sessions, progress, { moments, adsBlocked, downloads, now, timeZone })`
  with `StatsTitle { id, name, posterUrl?, year?, isSeries?, status?, genres?, runtimeMinutes?,
  ratingHalves?, lastWatchedAt? }`, `StatsSession { titleId, startedAt, endedAt, watchedSeconds }`,
  `StatsProgress { titleId, isEpisode, finished }`; map the library's titles, sessions and progress into
  them (`isEpisode`: `ref.season` or `ref.episode` above 0; core/data's dates are seconds since 1970, so
  pass `new Date(seconds * 1000)`). Results are fields (`trackedHours`, `estimatedHours`,
  `genres`, `heatmap`, `binge`…) and getters (`favouriteGenre`, `favouriteDecade`, `titlesFinished`,
  `busiestWeekday`, `busiestHour`), plus `daysSinceLastWatch(now?, timeZone?)`,
  `petTraits(seed, now?, timeZone?)`, `equals`, and `ProfileStats.canonicalGenre(raw)`.

## Not 1:1
- Enums are string unions, not numbered enums; the code uses each value's position in `all`, so the
  order is the format, as before. Raw values (`toRaw` on Windows) are the strings themselves.
- The renderer writes RGBA (canvas order, straight alpha) where Windows writes premultiplied BGRA. Pet
  colours are opaque or transparent, so the bytes are the same up to channel order; the parity dump swaps
  to BGRA before hashing. `PetBitmap.toBgra` is `toRgba`.
- `PetCanvas.frameInterval` is 100 (ms), not a `TimeSpan`. `draw` is new (Windows draws with a
  WriteableBitmap or Win2D).
- Dates are `Date`; time zones are IANA names worked out with `Intl.DateTimeFormat` (default: the
  system's zone, like `Calendar.current`). A fixed offset is `Etc/GMT±n`. `BingeDay.day` is
  `{ year, month, day }` where Windows has a `DateOnly`.
- `canonicalGenre` upper-cases the first grapheme with JavaScript's full mapping, which is what Swift
  does (`ß` becomes `SS`); the Windows port keeps `ß`. Lower-casing goes one code point at a time, as
  Swift, so a final sigma doesn't turn into `ς`.
- `PixelPet` construction truncates fractional levels and name indexes (and treats non-finite ones as
  the minimum); Swift and C# take integers.
- `contentBounds` is cached per pet (pets are immutable).
- `PetTraits.seedFor` takes the UUID as a string and upper-cases it; it doesn't reformat other spellings.
- Kept from Windows: the Legend twinkle phase is capped at 5 (the Mac traps at 6), ties in the biggest
  day go to the earliest day, ties elsewhere go by input order.
