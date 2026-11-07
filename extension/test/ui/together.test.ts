import { describe, expect, it } from "vitest";
import { Title } from "../../src/core/data";
import type { ChallengeState, ChallengeSummary, PartyState, TitleCard } from "../../src/core/together";
import {
  challengeSubtitle,
  hasInLibrary,
  inviteText,
  isCompleteCode,
  partyPosition,
  partySyncLine,
  shareByline,
  shareNote,
} from "../../src/ui/lib/together";
import { ticketPath } from "../../src/ui/screens/Together";

const card = (name: string, extra: Partial<TitleCard> = {}): TitleCard => ({
  name,
  year: null,
  kind: "film",
  imdbId: null,
  posterUrl: null,
  status: null,
  rating: null,
  ...extra,
});

function party(fields: Partial<PartyState> = {}): PartyState {
  return {
    code: "K7Q2MX",
    ended: false,
    hostId: "host",
    hostName: "Anna",
    title: card("Dune"),
    pageUrl: "https://example.com/dune",
    playing: true,
    position: 600,
    rate: 1,
    updatedAt: 1_000_000,
    now: 1_005_000,
    members: [],
    reactions: [],
    messages: [],
    hostPet: null,
    ...fields,
  } as PartyState;
}

function summary(fields: Partial<ChallengeSummary> = {}): ChallengeSummary {
  return {
    code: "ABC123",
    title: card("Severance", { kind: "series" }),
    totalEpisodes: 9,
    winnerName: null,
    memberCount: 3,
    myFraction: 0.2,
    leaderName: null,
    leaderFraction: 0.5,
    ...fields,
  };
}

describe("Together page", () => {
  it("accepts six-letter codes typed any way", () => {
    expect(isCompleteCode("k7q-2mx")).toBe(true);
    expect(isCompleteCode(" K7Q 2MX ")).toBe(true);
    expect(isCompleteCode("K7Q-2M")).toBe(false);
    expect(isCompleteCode("K7Q-2MXX")).toBe(false);
  });

  it("moves the party clock on between snapshots while it plays", () => {
    const p = party();
    // 5 s since the host's update, as the server said, then 2 s since this page heard it.
    expect(partyPosition(p, 10_000, 12_000)).toBeCloseTo(607);
    expect(partyPosition(party({ playing: false }), 10_000, 12_000)).toBe(600);
    expect(partyPosition(party({ rate: 2 }), 10_000, 10_000)).toBeCloseTo(610);
  });

  it("says who the player follows", () => {
    expect(partySyncLine(party(), true, 600)).toBe("You're the host. Everyone's player follows yours.");
    expect(partySyncLine(party(), false, 605)).toBe("Following Anna, playing at 10:05");
    expect(partySyncLine(party({ playing: false }), false, 3725)).toBe("Following Anna, paused at 1:02:05");
  });

  it("invites to what's playing, or says how to start", () => {
    expect(inviteText("Dune")).toMatch(/^Invite friends to Dune\. They open the same page/);
    expect(inviteText(null)).toBe("Start a film on one of your sites, then come back here to invite people to it.");
  });

  it("describes a challenge: the goal, then the winner", () => {
    expect(challengeSubtitle(summary(), null, "me")).toBe("First to finish all 9 episodes · 3 in");
    expect(challengeSubtitle(summary({ totalEpisodes: 1, memberCount: 1 }), null, "me")).toBe("First to finish it · 1 in");
    expect(challengeSubtitle(summary({ winnerName: "Bo" }), null, "me")).toBe("Bo got there first");
    const won = { winnerId: "me", winnerName: "Me" } as ChallengeState;
    expect(challengeSubtitle(summary(), won, "me")).toBe("You won. First to the end.");
  });

  it("knows what's already in the library", () => {
    const titles = new Map([
      [1, Title.make({ id: 1, name: "Dune", normName: "dune", year: 2021, status: "watched", imdbId: "tt1160419" })],
      [2, Title.make({ id: 2, name: "Alien", normName: "alien", year: 1979, status: "none" })],
    ]);
    expect(hasInLibrary(card("Whatever", { imdbId: "tt1160419" }), titles)).toBe(true);
    expect(hasInLibrary(card("Dune", { year: 2021 }), titles)).toBe(true);
    expect(hasInLibrary(card("Dune", { year: 1984 }), titles)).toBe(false);
    // In the library but in no list: not "have it".
    expect(hasInLibrary(card("Alien", { year: 1979 }), titles)).toBe(false);
  });

  it("writes share lines", () => {
    expect(shareByline("Anna", 1)).toBe("From Anna · 1 title");
    expect(shareByline("Anna", 12)).toBe("From Anna · 12 titles");
    expect(shareNote(0)).toMatch(/^Films you mark as watched/);
    expect(shareNote(1)).toMatch(/^1 film goes in/);
    expect(shareNote(4)).toMatch(/^4 films go in/);
  });

  it("punches a notch into each short side of the ticket", () => {
    const d = ticketPath(120, 60);
    expect(d).toContain("V 24 A 6 6 0 0 0 120 36");
    expect(d).toContain("V 36 A 6 6 0 0 0 0 24");
    expect(d.startsWith("M 8 0")).toBe(true);
  });
});
