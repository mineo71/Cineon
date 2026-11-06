# Together, Profile, profile picker and Settings (Cineon.App/UI/Pages)

Ports of `UI/TogetherView.swift`, `UI/ProfileView.swift`, `UI/ProfilePicker.swift` and `UI/SettingsView.swift`,
the pet on the top bar's avatar (`TopBar.swift`'s AvatarButton), and the Together wiring in ProfileSession.

## Files
- `TogetherPage.cs`: `TogetherPage` (Route.Together): header with the code box, `PartySection` (invite or
  `PartyStage`: poster, sync line, ticket, members, chat, reactions), `ChallengesSection`, `SharesSection`,
  `BlurredImage` (the stage's blurred poster light).
- `ProfilePage.cs`: `ProfilePage` (Route.Profile): hero with the animated pet, stat tiles, genre bars, 1-10
  histogram, decades, weekday x hour heatmap, most watched, extras; `CloudStatusLine` (also in Settings);
  `ProfileCharts`. `ShareCard.cs`: the share card, drawn with Win2D at 2x (see below).
- `ProfilePickerView.cs`: "Who's watching?" (`Overlays.ProfilePicker`; the placeholder is gone).
- `SettingsPage.cs`: `SettingsPage` (Route.Settings), every section; `SettingsSection`/`SectionContent`
  (the Mac's Section, SettingToggle, SettingSlider, Picker), `LibraryExport`.
- `PixelPetView.cs`: **public** `PixelPetView(pet, size, animated = true, framing = Automatic)`, per
  notes/profile.md: WriteableBitmap at device pixels shown at `PixelWidth / scale` DIPs, 100 ms frames, only
  redrawn when the pose changes, resting pose when not animated or when Windows' animation effects are off,
  redrawn when the window moves to a screen with another scale. Use it for any pet.
- `People.cs`: `People.PersonAvatar` (pet or initial), `InitialAvatar` (the Mac's Avatar), `ProfileAvatar`,
  `CodeBadge`, `Crown` (crown.fill drawn as a path), `SectionHeading`.
- `SocialKit.cs`: helpers these screens share (below), `Changes`, `KeyedComponent`/`KeyedView`, `PageScroll`,
  `MaxWidthColumn`, `Identity`.
- `App/TogetherHost.cs`: `TogetherHost : ITogetherHost` (settings, pet code, route, toasts, clipboard) and
  `PartyPlayer : IPartyPlayer` over BrowserModel (selected tab, tab snapshots, OpenTab; the rest TODO). The
  app's stub `TogetherModel.cs` is deleted: `ProfileSession.Together` is Core's `TogetherModel`, and
  `ProfileSession.Cloud` is Core's `CloudLibrary`, wired as notes/together.md says (Debug talks to
  `DevelopmentUrl`, Release to `ProductionUrl`; `CINEON_TOGETHER_URL` overrides).

## How these views rebuild
Party state changes every second and challenges every five, so a whole-page rebuild would reload posters
(RemoteImage loads asynchronously, so they flash) and steal focus from text boxes. Instead:
- `PageScroll` is built once per page: the ScrollViewer and its column stay while sections rebuild, so the place
  is kept (the Mac's `.frame(maxWidth:alignment:)` is `MaxWidthColumn`; `.scrollIndicators(.never)` is a hidden
  scroll bar).
- Sections are `KeyedComponent`s: after every change they hear about they compute `Key()` (a tuple or a string of
  what they show) and rebuild only when it differs; otherwise `OnSame()` updates parts in place. The party stage
  is built once per party and updates its texts, members and chat in place every second (new messages are
  appended), so the chat box keeps its text and focus.
- Settings sections rebuild only when a row appears or goes (`key`); switches, sliders and pickers follow the
  settings through refreshers, so a switch keeps its slide and a slider isn't replaced under the pointer.
- Text boxes that must survive a rebuild (code, recovery code, names) are kept and taken out of their old parent
  with `SocialKit.Detach` before joining the new tree; a theme change makes a new box with the same text.

## Kit pieces (stand-ins until the other ports merge)
`SocialKit.Field` (plain TextBox, no accent underline), `Spinner`, `WithIcon` (Silver/Outline with an icon),
`Relative` (RelativeDateTimeFormatter, `.named` too) and `Bytes` (ByteCountFormatter `.file`) stand in for the
misc-screens port's `Inputs.Field`, `Inputs.Spinner`, `Buttons.Silver/Outline(title, glyph, ...)`,
`DateText.Relative` and `ByteCount.File`; each call site says `TODO(after merge)`. Others, worth moving into the
kit: `ClipRounded` (composition clip, children included; a Border's corner radius rounds only its own fill),
`Tracking` (SwiftUI `.tracking` as CharacterSpacing), `OnBaseline` (first-baseline rows via
`TextLineBounds.TrimToBaseline`), `Hair` (one device pixel, the Mac's 0.5 pt lines), `ConfirmAsync` (the Mac's
confirmationDialog as a ContentDialog with no default button, so no accent colour), `AnimationsEnabled`,
`CopyText`. Settings switches are ToggleSwitch with lightweight-styling resources: on = white 0.78 (dark) or
black (white theme) like the Mac's tint, knob in the canvas colour; sliders likewise; ComboBox pill in ink.

## Left for other ports
- `TODO(port-browser)`: `PartyPlayer.Load`, `EvaluateInPlayerAsync`, `PlayerCommand`, `ShowBanner` (watch parties
  don't drive the player until then), and Settings' "Clear cookies and logins" (needs the profile's
  CoreWebView2Profile.ClearBrowsingDataAsync; it confirms and does nothing yet). BrowserModel should raise
  `Changed` when a tab's media changes; the party invite also re-checks every second.
- `TODO(after core merge)`: `TogetherHost.ApplyMetadata`, `EnrichMetadata` and `EpisodeCountAsync` need
  `ProfileSession.Metadata` (a series challenge counts as one episode until then); `PartyTab.Parsed` and the
  invite's `tab.Parsed?.Name` need `BrowserTab.Parsed`; the downloads folder line reads
  `AppPaths.DownloadsFolder(settings)` where the Mac reads `downloads.folder`.
- NewChallengeSheet (the "New challenge" button sets `AppSheet.NewChallenge`) belongs to the misc-screens port.

## Not 1:1
- Share card: Win2D draws the Mac's layout (720 wide, at 2x, dark) instead of rendering the SwiftUI view, so
  the pet stays pixel-exact. Jost is loaded from `ms-appx:///Assets/Fonts/Jost.ttf#Jost`; the star is a drawn
  polygon. Saved through Windows App SDK's FileSavePicker, then shown in File Explorer (`/select`).
- Settings shortcuts list the Windows keys and add Ctrl+K (search) and Alt/F10 (menu); "Hide or show sidebar"
  is "Hide or show toolbars on sites", the Windows command's name.
- Copy swaps: "this Mac" → "this PC", "another Mac" → "another PC", "the Bin" → "the Recycle Bin" (detail; the
  label keeps "Bin episodes once watched"), "Use Movies" → "Use Videos", ⇧⌘S → Ctrl+Shift+S, Info.plist's
  CineonTogetherURL → the CINEON_TOGETHER_URL environment variable. The downloads folder shows the full path
  (Windows has no `~`).
- Windows switches are 40 x 20 (the Mac's are `.controlSize(.small)`); the on knob is the canvas colour, not
  white, so it reads on the light-grey track in the dark theme.
- The recovery code is cut at the end, not in the middle (TextBlock has no middle truncation).
- Segoe has no cloud with a slash, tick or mark: the cloud status uses the plain cloud, and a warning sign for
  errors. Crown is a drawn path. play.rectangle.on.rectangle is Segoe's Video glyph.
- The pet's floor shadow is a radial gradient (XAML can't blur a shape); the stage's poster light is a real
  composition Gaussian blur (50) with a 1.4 saturation colour matrix.
- The profile card hover is a composition spring (period 0.3 s / 2π, damping 0.72); "Edit profiles" and theme
  changes switch without the Mac's spring/crossfade. Stat numbers don't roll (`.numericText()`).
- The avatar's menu opens on right-click (the Mac's Menu with primaryAction opens on press and hold).
- Chat scroll-to-bottom uses ScrollViewer.ChangeView's own animation, not 0.2 s ease-out.
- Library export: same keys, sorted, ISO 8601 dates and omitted nulls as JSONEncoder, but System.Text.Json's
  spacing (`"key": value`) and unescaped slashes.
