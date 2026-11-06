# Library screens (Cineon.App/UI/Pages)

Ports of `UI/HomeView.swift`, `LibraryView.swift`, `TitleDetailView.swift`, `WatchTimelineView.swift`,
`RateModeView.swift`, `Splash.swift` (SplashView) and RootView's `AmbientLight`. Registered in `Pages.For`
(Home, Library, Timeline, Rate), `Overlays.TitleDetail`, `Overlays.Splash`, and `AmbientLight` is the first
child of MainWindow's root, under the pages.

## Types
- `HomePage`, `PosterShelf.Make(app, name, titles, showProgress, destination, badges)`, `PosterCell` (Home's
  poster with name; lifts 1.025 on hover; right-click is the title menu).
- `LibraryPage`; `AdaptiveGridLayout` (VirtualizingLayout: SwiftUI's adaptive 138-190 columns, 18/24 spacing;
  row heights known up front, so only rows near the screen exist); `LibraryGridCell`, `ChecklistRow`, `QuickRate`.
- `TitleDetailCard` (the overlay), `MomentCell`.
- `TimelinePage` (ItemsRepeater + StackLayout of `TimelineRow`s), `TimelineSessionRow`, `FrameReel` (scrubs
  frames under the pointer, preloads them on first hover).
- `RatePage` (keys: 1-0 rate and move on after 0.38 s, Left/Right half a star, Backspace/Delete clear,
  Enter/Space skip, Esc back to the library; it keeps keyboard focus on itself after clicks).
- `SplashView`; `Easing.EaseInOut` / `Easing.Bezier` for frame-driven animation.
- `AmbientLight`.
- Shared by these screens (`Pages/LibraryKit.cs`): `LibraryWatch` (rebuild on library changes and follow profile
  switches; pass to `Watch(watch.Subscribe, watch.Unsubscribe)`), `PageButtons` (Silver/Outline with an icon,
  icon-only versions, Plain, mini `Switch`), `SearchField` (a text box that survives rebuilds), `TitleMenu`
  (Build/Add/Item/Toggle/Show), `FilterMenu.Make`, `PressableComponent` (a click/Enter/Space/right-click/hover
  base for cells; clicks on inner buttons stay theirs), `AdaptiveColumns` (non-virtual adaptive grid),
  `FrameFiles` (frame paths as file URIs), `EpisodeSource`, `LocalCopies`, `UiDefaults`, `RepeaterCells.Template()`,
  `PageGlyph` (circle, half circle, checklist, half star), `TitleText.Empty`.

## How they're built (for whoever touches them)
- Pages are `Component`s whose `Render()` returns the same root every time and refreshes parts inside it. The
  scrollers, text boxes and repeaters are made once, so a library change (a progress save every few seconds while
  something plays) doesn't lose the scroll position or the text box's focus. Hosts (`Border.Child`) get fresh
  children; nothing built in one render is put in a second parent.
- Repeaters' templates are empty Borders; `ElementPrepared` puts (or reuses) a cell in it. Same ids in the same
  order update the cells on screen in place (`SetTitle`), so hover state survives a rating; anything else resets
  `ItemsSource`. The custom layout relies on ItemsRepeater's auto-recycling of elements not asked for in a measure
  pass, and never calls `RecycleElement`.

## Kit additions (Shared.cs, Ui.cs)
- `RemoteImage`: `maxPixel` (decode size), `blur`, `FadeSeconds` (0.25 s ease-out fade-in), settable `Url` (keeps
  the old picture until the new one is ready, then swaps without a fade), placeholder kept under filled images like the Mac's ZStack.
  `ImageSurfaces`: one decoded `LoadedImageSurface` per address and size, shared, LRU up to 256 MB of pixels,
  one load at a time per key, `Preload`. A cached image shows at once with no fade. Effect factories are cached.
- `Posters.Image` without a width is an `AspectRatioPanel` (2:3 known at measure time) instead of setting Height in
  SizeChanged. `Stars.Star` and `StarRatingControl` take an optional `Palette` (QuickRate is always dark).
- `DateText.Day`, `DateText.Time` (`partial`; `Relative` comes from the misc port's Formats.cs).
- `Ui.AspectRatio`, `AspectRatioPanel`, `ViewThatFits` (first child whose ideal width fits; the others are laid
  out at no size, hidden, disabled and out of the accessibility tree), `FitRow` (two groups on one line, or the second under the first),
  `Ui.ShrinkToFit` (minimumScaleFactor, sized in one go by measuring copies of the text), `Ui.Detach` (false
  when it can't take the element from its parent), `Motion` (`Enabled` = Windows "Animation effects", `Scale` spring
  around the centre, `Fade`, `Reveal` (fade in, or fade out then collapse), `Period(response)`, `EaseInOut`, `EaseOut`).
- `PageButtons.Silver` brightens on hover like the Mac's `.brightness`; the kit's `Buttons.Silver` shows a border
  instead. Worth moving the kit to the brightening when someone owns Buttons.cs (and folding in the misc port's
  icon overload).

## Left for other ports
- `TODO(port-together)`: the title card's Together menu (Challenge friends to finish it, Share it as a code) once
  the app's TogetherModel has `IsAvailable`, `CreateChallenge(title)`, `Share(title)`.
- `TODO(port-screens-social)`: Rate mode's finished screen shows the logo where the Mac shows
  `PixelPetView(pet, 120)`; swap in `new PixelPetView(app.Session.Pet, 120, animated: true)`.
- `TODO(port-screens-misc)`: `RelativeDate.Text` stands in for `DateText.Relative`; delete it once Formats.cs merges.
- `TODO(after core merge)`: `EpisodeSource` makes one MetadataService per session until `Session.Metadata` exists;
  `LocalCopies` reads the downloads table until `Session.Downloads.Items` exists (On this PC, Play the copy).
- port-browser: Find on my sites, Open page, Resume and Continue call BrowserModel stubs, so they do nothing yet.
- AmbientModel.SetFromImage still has its TODO (no zones from a poster), so Home's faint hero light stays dark;
  AmbientLight shows whatever zones the model has.

## Not 1:1
- Mac menus become MenuFlyouts; text: "On this PC", "Show in File Explorer", "Ctrl+T", "Ctrl+D", "on this PC".
- No layout animation when filters or tabs change the grid (SwiftUI moves posters with Motion.quick); it swaps.
- `.firstTextBaseline` rows are bottom-aligned with margins worked out from Jost's and Segoe's metrics.
- The Library sort is kept in `%LOCALAPPDATA%\Cineon\ui-defaults.json` (`library.sort`), not UserDefaults.
- Switches are drawn (26×15, white knob); Timeline's is tinted like the Mac's, Rate's uses the Windows accent
  colour as the untinted Mac switch uses the system's.
- Text boxes show WinUI's clear button while focused.
- `minimumScaleFactor` picks the largest size that fits (binary search on measured copies), not SwiftUI's exact scale.
- Shadows are ThemeShadow; the title card's close button sits on in-app acrylic instead of ultraThinMaterial.
- Rate's backdrop: Gaussian blur 60 and opacity 0.42 as on the Mac, but no 1.3 saturation boost, and a new backdrop
  fades in over the last (0.5 s) rather than SwiftUI's implicit cross-fade.
- Timeline's roll end fades to the page colour instead of being masked (the same on a solid page).
- Splash: the reveal is a growing pie clip from -38° clockwise, with a hard edge where the Mac's mask has a 4%
  soft one. The glint is left out: overlay-blending a strip over a mark in one flat colour changes nothing, on the
  Mac too. Timing (0.42 s sweep, 0.54 s hold, 0.22 s fade) is the Mac's.
- AmbientLight: the 3×3 mesh is blended with cubic Hermite curves into a 96×60 bitmap stretched over the window
  (MeshGradient's smoothed colours are close to this). Over white the Mac multiplies at 0.55; over the white canvas
  normal blending at 0.55 gives the same.
- DateText.Day follows Windows' culture patterns ("Thursday, November 6" in en-US; en-GB gets a comma the Mac's
  template doesn't have). Relative times are English, numeric ("1 day ago").
- Hover lifts and card slides are Composition springs with Period = response / 2π; with animation effects off they
  jump. Fades and the ambient light still ease.
