// Profile: the pixel pet and the stats it grows from. See notes/profile.md.

export {
  PetAccessory, PetEffect, PetEyes, PetGenre, PetMood, PetMouth, PetSpecies, PetStage, PetTone, genreKey,
  type PetFraming,
} from "./petTypes";
export { PetBitmap, PetCrop, PetFrame, type PetPoint, type PetRect } from "./petBitmap";
export { PetArt, Overlay, K, spriteKey, makePalette, type Sprite, type SpriteSet, type Patch } from "./petArt";
export { renderPet, type RenderablePet } from "./petRenderer";
export { PixelPet, PetTraits, type GenreWeight, type PetGrowth, type PixelPetInit } from "./pixelPet";
export {
  PetCanvas, type PetCanvasContext, type PetCanvasElement, type PetDeviceRect, type PetFill, type PetFrameOptions,
  type PetImage,
} from "./petCanvas";
export {
  ProfileStats, type BingeDay, type CalendarDay, type DecadeCount, type StatsComputeOptions, type StatsProgress,
  type StatsSession, type StatsStatus, type StatsTitle, type TopTitle,
} from "./profileStats";
export { Fnv64, stableHash } from "./fnv";
