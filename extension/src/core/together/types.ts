// The types at the top of Cineon/Core/TogetherClient.swift (C#: TogetherTypes.cs). Each `fromJson`
// reads a value the way Swift's JSONDecoder does for that type and throws a DecodeError on a wrong
// shape. Numbers come back as floats (2022.0), so whole numbers are read as doubles and truncated where
// the Mac makes them Ints. Times are milliseconds since 1970, as the server keeps them.

import * as J from "./json";
import { parseUrl, numberText } from "./text";
import { titleKindFromRaw, type TitleKind, type TogetherTitle } from "./library";

/** A film as it travels between friends: enough to show a poster and find it again. */
export interface TitleCard {
  name: string;
  year: number | null;
  /** A TitleKind raw value: film, series, cartoon or unknown. */
  kind: string;
  imdbId: string | null;
  posterUrl: string | null;
  /** A TitleStatus raw value, null for titles in no list. */
  status: string | null;
  /** Half-star steps, 1 to 20. */
  rating: number | null;
}

export const TitleCard = {
  make(name: string, year: number | null = null, kind = "unknown", imdbId: string | null = null, posterUrl: string | null = null): TitleCard {
    return { name, year, kind, imdbId, posterUrl, status: null, rating: null };
  },

  /** Swift's `TitleCard(title)`. */
  from(title: TogetherTitle): TitleCard {
    return {
      name: title.name,
      year: title.year,
      kind: title.kind,
      imdbId: title.imdbId,
      posterUrl: title.posterUrl,
      status: title.status === "none" ? null : title.status,
      rating: title.ratingHalves,
    };
  },

  /** Swift's `json`: what the server takes, with absent fields left out. */
  toJson(card: TitleCard): Record<string, unknown> {
    const out: Record<string, unknown> = { name: card.name, kind: card.kind };
    if (card.year !== null) out.year = card.year;
    if (card.imdbId !== null) out.imdbId = card.imdbId;
    if (card.posterUrl !== null) out.posterUrl = card.posterUrl;
    if (card.status !== null) out.status = card.status;
    if (card.rating !== null) out.rating = card.rating;
    return out;
  },

  fromJson(value: unknown): TitleCard {
    const e = J.requireObject(value);
    return {
      name: J.string(e, "name"),
      year: J.lenientInt(e, "year"),
      kind: J.lenientString(e, "kind") ?? "unknown",
      imdbId: J.lenientString(e, "imdbId"),
      posterUrl: J.lenientString(e, "posterUrl"),
      status: J.lenientString(e, "status"),
      rating: J.lenientInt(e, "rating"),
    };
  },

  /** Swift's `titleKind`. */
  titleKind(card: TitleCard): TitleKind {
    return titleKindFromRaw(card.kind) ?? "unknown";
  },

  /** Swift's `posterURL`: the poster address when it is one. */
  posterUri(card: TitleCard): string | null {
    return parseUrl(card.posterUrl);
  },
};

export interface ShareInfo {
  code: string;
  label: string;
  ownerName: string;
  titles: TitleCard[];
  createdAt: number;
}

export const ShareInfo = {
  fromJson(value: unknown): ShareInfo {
    const e = J.requireObject(value);
    return {
      code: J.string(e, "code"),
      label: J.string(e, "label"),
      ownerName: J.string(e, "ownerName"),
      titles: J.array(e, "titles", TitleCard.fromJson),
      createdAt: J.number(e, "createdAt"),
    };
  },
  /** Swift's `ShareInfo?`: null when the server says there's no such share. */
  fromJsonOrNull(value: unknown): ShareInfo | null {
    return J.isNull(value) ? null : ShareInfo.fromJson(value);
  },
};

export interface PartyMember {
  personId: string;
  name: string;
  lastSeen: number;
  /** Their pixel pet's code, when they share one. */
  pet: string | null;
}

export const PartyMember = {
  fromJson(value: unknown): PartyMember {
    const e = J.requireObject(value);
    return {
      personId: J.string(e, "personId"),
      name: J.string(e, "name"),
      lastSeen: J.number(e, "lastSeen"),
      pet: J.optionalString(e, "pet"),
    };
  },
};

export interface PartyReaction {
  name: string;
  emoji: string;
  at: number;
  pet: string | null;
}

export const PartyReaction = {
  fromJson(value: unknown): PartyReaction {
    const e = J.requireObject(value);
    return { name: J.string(e, "name"), emoji: J.string(e, "emoji"), at: J.number(e, "at"), pet: J.optionalString(e, "pet") };
  },
};

export interface PartyMessage {
  personId: string;
  name: string;
  pet: string | null;
  text: string;
  at: number;
}

export const PartyMessage = {
  /** Tells messages apart, for showing each once. */
  id(message: PartyMessage): string {
    return `${message.personId}|${numberText(message.at)}|${message.text}`;
  },
  fromJson(value: unknown): PartyMessage {
    const e = J.requireObject(value);
    return {
      personId: J.string(e, "personId"),
      name: J.string(e, "name"),
      pet: J.optionalString(e, "pet"),
      text: J.string(e, "text"),
      at: J.number(e, "at"),
    };
  },
};

export interface PartyState {
  code: string;
  ended: boolean;
  hostId: string;
  hostName: string;
  title: TitleCard | null;
  pageUrl: string;
  playing: boolean;
  /** Seconds into the film, as the host last said. */
  position: number;
  rate: number;
  /** Server time of the host's last update, in milliseconds since 1970. */
  updatedAt: number;
  /** Server time of this answer, in milliseconds since 1970. */
  now: number;
  members: PartyMember[];
  reactions: PartyReaction[];
  /** Chat, oldest first. Missing from servers older than chat. */
  messages: PartyMessage[];
  hostPet: string | null;
}

export const PartyState = {
  /** Where the host's film is right now, from the last thing the host said. */
  expectedPosition(state: PartyState): number {
    if (!state.playing) return state.position;
    return state.position + (Math.max(0, state.now - state.updatedAt) / 1000) * state.rate;
  },
  fromJson(value: unknown): PartyState {
    const e = J.requireObject(value);
    return {
      code: J.string(e, "code"),
      ended: J.bool(e, "ended"),
      hostId: J.string(e, "hostId"),
      hostName: J.string(e, "hostName"),
      title: J.optional(e, "title", TitleCard.fromJson),
      pageUrl: J.string(e, "pageUrl"),
      playing: J.bool(e, "playing"),
      position: J.number(e, "position"),
      rate: J.number(e, "rate"),
      updatedAt: J.number(e, "updatedAt"),
      now: J.number(e, "now"),
      members: J.array(e, "members", PartyMember.fromJson),
      reactions: J.array(e, "reactions", PartyReaction.fromJson),
      messages: J.lenientArray(e, "messages", PartyMessage.fromJson) ?? [],
      hostPet: J.lenientString(e, "hostPet"),
    };
  },
  /** Swift's `PartyState?`: null when there's no party with that code. */
  fromJsonOrNull(value: unknown): PartyState | null {
    return J.isNull(value) ? null : PartyState.fromJson(value);
  },
};

export interface ChallengeMember {
  personId: string;
  name: string;
  fraction: number;
  watchedEpisodes: number;
  label: string;
  finishedAt: number | null;
  updatedAt: number;
  pet: string | null;
}

export const ChallengeMember = {
  fromJson(value: unknown): ChallengeMember {
    const e = J.requireObject(value);
    return {
      personId: J.string(e, "personId"),
      name: J.string(e, "name"),
      fraction: J.number(e, "fraction"),
      watchedEpisodes: J.number(e, "watchedEpisodes"),
      label: J.string(e, "label"),
      finishedAt: J.optionalNumber(e, "finishedAt"),
      updatedAt: J.number(e, "updatedAt"),
      pet: J.optionalString(e, "pet"),
    };
  },
};

export interface ChallengeState {
  code: string;
  title: TitleCard;
  totalEpisodes: number;
  createdAt: number;
  creatorId: string;
  winnerId: string | null;
  winnerName: string | null;
  now: number;
  /** Furthest first; at equal progress, whoever finished or got there first. */
  members: ChallengeMember[];
}

export const ChallengeState = {
  fromJson(value: unknown): ChallengeState {
    const e = J.requireObject(value);
    return {
      code: J.string(e, "code"),
      title: TitleCard.fromJson(J.required(e, "title")),
      totalEpisodes: J.number(e, "totalEpisodes"),
      createdAt: J.number(e, "createdAt"),
      creatorId: J.string(e, "creatorId"),
      winnerId: J.optionalString(e, "winnerId"),
      winnerName: J.optionalString(e, "winnerName"),
      now: J.number(e, "now"),
      members: J.array(e, "members", ChallengeMember.fromJson),
    };
  },
  fromJsonOrNull(value: unknown): ChallengeState | null {
    return J.isNull(value) ? null : ChallengeState.fromJson(value);
  },
};

export interface ChallengeSummary {
  code: string;
  title: TitleCard;
  totalEpisodes: number;
  winnerName: string | null;
  memberCount: number;
  myFraction: number;
  leaderName: string | null;
  leaderFraction: number;
}

export const ChallengeSummary = {
  fromJson(value: unknown): ChallengeSummary {
    const e = J.requireObject(value);
    return {
      code: J.string(e, "code"),
      title: TitleCard.fromJson(J.required(e, "title")),
      totalEpisodes: J.number(e, "totalEpisodes"),
      winnerName: J.optionalString(e, "winnerName"),
      memberCount: J.number(e, "memberCount"),
      myFraction: J.number(e, "myFraction"),
      leaderName: J.optionalString(e, "leaderName"),
      leaderFraction: J.number(e, "leaderFraction"),
    };
  },
  listFromJson(value: unknown): ChallengeSummary[] {
    return J.arrayOf(value, ChallengeSummary.fromJson);
  },
};

/** What `codes:resolve` says a code points at: share, party or challenge. */
export interface CodeKind {
  kind: string;
}

export const CodeKind = {
  fromJsonOrNull(value: unknown): CodeKind | null {
    if (J.isNull(value)) return null;
    return { kind: J.string(J.requireObject(value), "kind") };
  },
};

/** `people:register`'s answer. */
export interface Registered {
  personId: string;
  name: string;
}

export const Registered = {
  fromJson(value: unknown): Registered {
    const e = J.requireObject(value);
    return { personId: J.string(e, "personId"), name: J.string(e, "name") };
  },
};

/** The new code from `shares:create`, `parties:create` and `challenges:create`. */
export interface CodeReply {
  code: string;
}

export const CodeReply = {
  fromJson(value: unknown): CodeReply {
    return { code: J.string(J.requireObject(value), "code") };
  },
};

/** One title as the cloud keeps it (times in milliseconds since 1970). */
export interface CloudItem {
  key: string;
  name: string;
  rating: number | null;
  ratedAt: number | null;
  status: string | null;
  statusAt: number | null;
  finishedAt: number | null;
}

export const CloudItem = {
  make(key: string, name: string, fields: Partial<Omit<CloudItem, "key" | "name">> = {}): CloudItem {
    return {
      key,
      name,
      rating: fields.rating ?? null,
      ratedAt: fields.ratedAt ?? null,
      status: fields.status ?? null,
      statusAt: fields.statusAt ?? null,
      finishedAt: fields.finishedAt ?? null,
    };
  },
  newest(item: CloudItem): number {
    return Math.max(item.ratedAt ?? 0, item.statusAt ?? 0);
  },
  fromJson(value: unknown): CloudItem {
    const e = J.requireObject(value);
    return {
      key: J.string(e, "key"),
      name: J.string(e, "name"),
      rating: J.optionalNumber(e, "rating"),
      ratedAt: J.optionalNumber(e, "ratedAt"),
      status: J.optionalString(e, "status"),
      statusAt: J.optionalNumber(e, "statusAt"),
      finishedAt: J.optionalNumber(e, "finishedAt"),
    };
  },
};
