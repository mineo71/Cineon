# Pixel pet and profile stats (Cineon.Core.Profile)

Pixel-identical to the Mac for every look (13,680 combinations x 10 frames), and the same as
SwiftUI's `PixelPetView` at 1x and 2x. Parity programs: `Cineon.Core.Tests/Profile/MacParity/*.swift`.

## Showing a pet in WinUI
- Your own: `PixelPet.Make(stats.PetTraits(PetTraits.SeedFor(profile.Id)))`. The seed is the profile
  UUID in upper case, like the Mac, or the name and tone differ.
- A friend's: `PixelPet.FromCode(code)`; null means show their initial.
- Every 100 ms (`PetCanvas.FrameInterval`): `PetCanvas.FrameFor(...)`, redraw only when it changes.
  When it isn't animated, or animations are off in Windows settings, draw the resting frame once.
- Draw: `PetCanvas.Render(pet, frame, size, XamlRoot.RasterizationScale, framing)` into a
  WriteableBitmap shown at `PixelWidth / scale` DIPs (no resampling). Or Win2D with
  `PetCanvas.Layout(...)`, antialiasing off. Anything that scales it must use nearest-neighbour.

## Renames
`PetSpecies`, `PetStage`, `PetMood`, `PetAccessory`, `PetTone`, `PetGenre`, `PetFrame`, `PetEyes`,
`PetMouth`, `PetEffect`, `PetCrop`, `PetGrowth`; `FromCode`, `LevelForExperience`, `NameIndexFor`.

## Stats
`ProfileStats.Compute(StatsTitle[], StatsSession[], StatsProgress[], moments, adsBlocked,
downloads, now?, timeZone?)`; map library models into the Stats* records. Ties are broken by input
order (the Mac's dictionary order varies by launch).
