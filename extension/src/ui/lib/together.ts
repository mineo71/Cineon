// What the Together page says, worked out from the background's snapshot: pure, tested in
// test/ui/together.test.ts.

import { type Title, findTitle } from "../../core/data";
import { type ChallengeState, type ChallengeSummary, PartyState, ShareCode, type TitleCard } from "../../core/together";
import { Timecode } from "./format";

/** TogetherModel.MINIMUM_DURATION: shorter videos (trailers, clips) can't start a party. */
export const PARTY_MINIMUM_DURATION = 240;

/** The six reactions on the pad. */
export const REACTIONS = ["😂", "😮", "😭", "❤️", "👏", "🍿"] as const;

/** A code typed in is complete: six letters or digits once dashes and spaces are gone. */
export function isCompleteCode(raw: string): boolean {
  return [...ShareCode.normalize(raw)].length === 6;
}

/**
 * Where the party is now: the host's last position, moved on by the time since the server said
 * so, plus the time since this page heard it (snapshots come every second or so).
 */
export function partyPosition(party: PartyState, receivedAt: number, now: number = Date.now()): number {
  const base = PartyState.expectedPosition(party);
  if (!party.playing) return base;
  return base + (Math.max(0, now - receivedAt) / 1000) * party.rate;
}

/** PartyStage.syncLine. */
export function partySyncLine(party: PartyState, isHost: boolean, position: number): string {
  if (isHost) return "You're the host. Everyone's player follows yours.";
  return `Following ${party.hostName}, ${party.playing ? "playing" : "paused"} at ${Timecode.string(position)}`;
}

/** PartyInvite's sentence, with or without something playing. */
export function inviteText(name: string | null): string {
  return name != null
    ? `Invite friends to ${name}. They open the same page and their player follows yours: play, pause, every jump. You can talk in the chat while you watch.`
    : "Start a film on one of your sites, then come back here to invite people to it.";
}

/** ChallengeCard.subtitle. */
export function challengeSubtitle(summary: ChallengeSummary, state: ChallengeState | null | undefined, personId: string | null): string {
  const winner = state?.winnerName ?? summary.winnerName;
  if (winner != null) {
    return state?.winnerId != null && state.winnerId === personId ? "You won. First to the end." : `${winner} got there first`;
  }
  const total = Math.trunc(summary.totalEpisodes);
  const goal = total > 1 ? `First to finish all ${total} episodes` : "First to finish it";
  return `${goal} · ${Math.trunc(summary.memberCount)} in`;
}

/** TogetherModel.hasInLibrary: in a list already, by IMDb ID or by name and year. */
export function hasInLibrary(card: TitleCard, titles: ReadonlyMap<number, Title>): boolean {
  if (card.imdbId != null) {
    for (const title of titles.values()) {
      if (title.imdbId === card.imdbId && title.status !== "none") return true;
    }
  }
  const title = findTitle(titles.values(), card.name, null, card.year);
  return title != null && title.status !== "none";
}

/** "From Anna · 12 titles". */
export function shareByline(ownerName: string, count: number): string {
  return `From ${ownerName} · ${count} ${count === 1 ? "title" : "titles"}`;
}

/** The note under Share my Watched list. */
export function shareNote(watched: number): string {
  if (watched === 0) return "Films you mark as watched can go in a list for friends: posters and your ratings, nothing else.";
  return `${watched} ${watched === 1 ? "film goes" : "films go"} in, with their posters, your ratings and nothing else. A friend types the code and can add any of them to their backlog.`;
}
