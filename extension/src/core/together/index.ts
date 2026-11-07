// Together and the cloud backup: ports of Core/TogetherClient.swift, App/TogetherModel.swift and
// App/CloudLibrary.swift. See extension/notes/together.md.

export {
  TogetherClient,
  TogetherError,
  ShareCode,
  TOGETHER_ERROR_CODES,
  errorCodeFromRaw,
  serializeArgs,
  type TogetherErrorCode,
  type TogetherErrorOptions,
  type TogetherClientOptions,
  type Fetch,
  type ConvexArgs,
} from "./client";
export {
  TitleCard,
  ShareInfo,
  PartyMember,
  PartyReaction,
  PartyMessage,
  PartyState,
  ChallengeMember,
  ChallengeState,
  ChallengeSummary,
  CodeKind,
  Registered,
  CodeReply,
  CloudItem,
} from "./types";
export { DecodeError } from "./json";
export { TogetherIdentity, memoryIdentityStore, type IdentityStore } from "./identity";
export { systemClock, delay, Emitter, type Clock } from "./clock";
export {
  playerCommandText,
  type TogetherHost,
  type TogetherRoute,
  type TogetherSettings,
  type PartyPlayer,
  type PartyTab,
  type PartyTabId,
  type PartyMedia,
  type PlayerCommand,
} from "./host";
export {
  TITLE_KINDS,
  TITLE_STATUSES,
  titleKindFromRaw,
  titleStatusFromRaw,
  titleStatusLabel,
  progressFraction,
  isEpisode,
  type TitleKind,
  type TitleStatus,
  type TogetherTitle,
  type TogetherProgress,
  type TogetherLibrary,
  type CloudLibrarySource,
  type AddTitleOptions,
  type RestoreValues,
} from "./library";
export {
  TogetherModel,
  simpleUrlKey,
  type TogetherModelOptions,
  type TogetherProfile,
  type TogetherProperty,
  type ChallengeProgress,
  type PlayerState,
} from "./model";
export {
  CloudLibrary,
  type CloudLibraryOptions,
  type CloudSettings,
  type CloudAuthority,
  type CloudProperty,
} from "./cloud";
