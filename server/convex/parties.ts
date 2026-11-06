import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  LIMITS,
  cap,
  claimCode,
  clamp,
  cleanTitleCard,
  fail,
  finite,
  freshCode,
  normalizeCode,
  peopleReader,
  requirePerson,
  requireUrl,
  titleCard,
  titleCardInput,
} from "./lib";

const MEMBER_WINDOW_MS = 30_000; // members not seen for this long drop out of `members`
const REACTION_WINDOW_MS = 10_000; // reactions older than this aren't returned
const MAX_REACTIONS = 20; // stored per party
const MAX_MESSAGES = 50; // latest chat messages returned
const SAY_WINDOW_MS = 5_000; // rate limit: at most SAY_MAX messages per person in this window
const SAY_MAX = 5;

const partyView = v.object({
  code: v.string(),
  ended: v.boolean(),
  hostId: v.id("people"),
  hostName: v.string(),
  hostPet: v.union(v.string(), v.null()),
  title: v.union(titleCard, v.null()),
  pageUrl: v.string(),
  playing: v.boolean(),
  position: v.number(),
  rate: v.number(),
  updatedAt: v.number(),
  now: v.number(),
  members: v.array(
    v.object({ personId: v.id("people"), name: v.string(), lastSeen: v.number(), pet: v.union(v.string(), v.null()) }),
  ),
  reactions: v.array(
    v.object({ name: v.string(), emoji: v.string(), at: v.number(), pet: v.union(v.string(), v.null()) }),
  ),
  // The latest MAX_MESSAGES, oldest first.
  messages: v.array(
    v.object({
      personId: v.id("people"),
      name: v.string(),
      pet: v.union(v.string(), v.null()),
      text: v.string(),
      at: v.number(),
    }),
  ),
});

const cleanPosition = (n: number) => clamp(finite(n, 0), 0, 1e7);
const cleanRate = (n: number) => clamp(finite(n, 1), 0, 16);

async function findParty(ctx: QueryCtx, rawCode: string): Promise<Doc<"parties"> | null> {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  return await ctx.db
    .query("parties")
    .withIndex("by_code", (q) => q.eq("code", code))
    .unique();
}

async function requireParty(ctx: QueryCtx, rawCode: string): Promise<Doc<"parties">> {
  const party = await findParty(ctx, rawCode);
  if (!party) fail("NOT_FOUND", `No watch party with code ${rawCode.trim()}.`);
  return party;
}

async function memberRow(ctx: QueryCtx, partyId: Id<"parties">, personId: Id<"people">) {
  return await ctx.db
    .query("partyMembers")
    .withIndex("by_party_person", (q) => q.eq("partyId", partyId).eq("personId", personId))
    .unique();
}

async function touchMember(ctx: MutationCtx, partyId: Id<"parties">, personId: Id<"people">, now: number) {
  const row = await memberRow(ctx, partyId, personId);
  if (row) await ctx.db.patch(row._id, { lastSeen: now });
  else await ctx.db.insert("partyMembers", { partyId, personId, joinedAt: now, lastSeen: now });
}

async function viewOf(ctx: QueryCtx, party: Doc<"parties">, now: number) {
  const memberRows = await ctx.db
    .query("partyMembers")
    .withIndex("by_party_lastSeen", (q) => q.eq("partyId", party._id).gte("lastSeen", now - MEMBER_WINDOW_MS))
    .collect();
  memberRows.sort((a, b) => {
    if (a.personId === party.hostId) return -1;
    if (b.personId === party.hostId) return 1;
    return a.joinedAt - b.joinedAt;
  });
  const people = peopleReader(ctx);
  const members = await Promise.all(
    memberRows.map(async (m) => ({
      personId: m.personId,
      name: await people.name(m.personId),
      lastSeen: m.lastSeen,
      pet: await people.pet(m.personId),
    })),
  );
  const reactionRows = await ctx.db
    .query("partyReactions")
    .withIndex("by_party_at", (q) => q.eq("partyId", party._id).gte("at", now - REACTION_WINDOW_MS))
    .take(MAX_REACTIONS * 2);
  const reactions = await Promise.all(
    reactionRows.map(async (r) => ({ name: r.name, emoji: r.emoji, at: r.at, pet: await people.pet(r.personId) })),
  );
  const messageRows = await ctx.db
    .query("messages")
    .withIndex("by_party_at", (q) => q.eq("partyId", party._id))
    .order("desc")
    .take(MAX_MESSAGES);
  messageRows.reverse();
  const messages = await Promise.all(
    messageRows.map(async (m) => ({
      personId: m.personId,
      name: m.name,
      pet: await people.pet(m.personId),
      text: m.text,
      at: m.at,
    })),
  );
  return {
    code: party.code,
    ended: party.ended,
    hostId: party.hostId,
    hostName: await people.name(party.hostId),
    hostPet: await people.pet(party.hostId),
    title: party.title ?? null,
    pageUrl: party.pageUrl,
    playing: party.playing,
    position: party.position,
    rate: party.rate,
    updatedAt: party.updatedAt,
    now,
    members,
    reactions,
    messages,
  };
}

/** Starts a party from the film playing; the host is its first member. */
export const create = mutation({
  args: {
    deviceSecret: v.string(),
    title: v.optional(v.union(titleCardInput, v.null())),
    pageUrl: v.string(),
    position: v.number(),
    playing: v.boolean(),
    rate: v.number(),
  },
  returns: v.object({ code: v.string() }),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const now = Date.now();
    const code = await freshCode(ctx);
    const partyId = await ctx.db.insert("parties", {
      code,
      hostId: person._id,
      ...(args.title ? { title: cleanTitleCard(args.title) } : {}),
      pageUrl: requireUrl(args.pageUrl, "pageUrl"),
      position: cleanPosition(args.position),
      playing: args.playing,
      rate: cleanRate(args.rate),
      updatedAt: now,
      ended: false,
      createdAt: now,
    });
    await ctx.db.insert("partyMembers", { partyId, personId: person._id, joinedAt: now, lastSeen: now });
    await claimCode(ctx, code, "party", partyId);
    return { code };
  },
});

export const join = mutation({
  args: { deviceSecret: v.string(), code: v.string() },
  returns: partyView,
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const party = await requireParty(ctx, args.code);
    if (party.ended) fail("PARTY_ENDED", "This watch party has ended.");
    const now = Date.now();
    await touchMember(ctx, party._id, person._id, now);
    return await viewOf(ctx, party, now);
  },
});

/** Leaves the party. When the host leaves, the party ends. */
export const leave = mutation({
  args: { deviceSecret: v.string(), code: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const party = await requireParty(ctx, args.code);
    const row = await memberRow(ctx, party._id, person._id);
    if (row) await ctx.db.delete(row._id);
    if (party.hostId === person._id && !party.ended) {
      await ctx.db.patch(party._id, { ended: true, updatedAt: Date.now() });
    }
    return null;
  },
});

/** Host only: the playback state everyone follows. */
export const update = mutation({
  args: {
    deviceSecret: v.string(),
    code: v.string(),
    position: v.number(),
    playing: v.boolean(),
    rate: v.number(),
    pageUrl: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const party = await requireParty(ctx, args.code);
    if (party.hostId !== person._id) fail("NOT_HOST", "Only the host can control this watch party.");
    if (party.ended) fail("PARTY_ENDED", "This watch party has ended.");
    const now = Date.now();
    await ctx.db.patch(party._id, {
      position: cleanPosition(args.position),
      playing: args.playing,
      rate: cleanRate(args.rate),
      ...(args.pageUrl != null ? { pageUrl: requireUrl(args.pageUrl, "pageUrl") } : {}),
      updatedAt: now,
    });
    await touchMember(ctx, party._id, person._id, now);
    return null;
  },
});

/** Keeps the caller in `members`. A no-op once the party has ended. */
export const heartbeat = mutation({
  args: { deviceSecret: v.string(), code: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const party = await requireParty(ctx, args.code);
    if (party.ended) return null;
    const row = await memberRow(ctx, party._id, person._id);
    if (!row) fail("NOT_MEMBER", "Join the watch party first.");
    await ctx.db.patch(row._id, { lastSeen: Date.now() });
    return null;
  },
});

export const react = mutation({
  args: { deviceSecret: v.string(), code: v.string(), emoji: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const party = await requireParty(ctx, args.code);
    if (party.ended) fail("PARTY_ENDED", "This watch party has ended.");
    const row = await memberRow(ctx, party._id, person._id);
    if (!row) fail("NOT_MEMBER", "Join the watch party first.");
    const emoji = cap(args.emoji, LIMITS.emoji);
    if (!emoji) fail("INVALID_ARGUMENT", "emoji must not be empty.");
    const now = Date.now();
    await ctx.db.patch(row._id, { lastSeen: now });
    await ctx.db.insert("partyReactions", { partyId: party._id, personId: person._id, name: person.name, emoji, at: now });
    const newest = await ctx.db
      .query("partyReactions")
      .withIndex("by_party_at", (q) => q.eq("partyId", party._id))
      .order("desc")
      .take(MAX_REACTIONS + 50);
    for (const old of newest.slice(MAX_REACTIONS)) await ctx.db.delete(old._id);
    return null;
  },
});

/**
 * Party chat. Members (and the host) only; counts as a heartbeat. The text is trimmed, control
 * characters become spaces, and anything past 280 characters is cut off. At most 5 messages per
 * person in any 5 seconds.
 */
export const say = mutation({
  args: { deviceSecret: v.string(), code: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const party = await requireParty(ctx, args.code);
    if (party.ended) fail("PARTY_ENDED", "This watch party has ended.");
    const row = await memberRow(ctx, party._id, person._id);
    if (!row && party.hostId !== person._id) fail("NOT_MEMBER", "Join the watch party first.");
    const text = cap(args.text, LIMITS.message);
    if (!text) fail("INVALID_ARGUMENT", "Message must not be empty.");
    const now = Date.now();
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_person_at", (q) => q.eq("personId", person._id).gt("at", now - SAY_WINDOW_MS))
      .take(SAY_MAX);
    if (recent.length >= SAY_MAX) {
      fail("INVALID_ARGUMENT", `Slow down. At most ${SAY_MAX} messages every ${SAY_WINDOW_MS / 1000} seconds.`);
    }
    await ctx.db.insert("messages", { partyId: party._id, personId: person._id, name: person.name, text, at: now });
    if (row) await ctx.db.patch(row._id, { lastSeen: now });
    else await ctx.db.insert("partyMembers", { partyId: party._id, personId: person._id, joinedAt: now, lastSeen: now });
    return null;
  },
});

/**
 * `t` is ignored. Convex caches a query's result until what it read changes, which would freeze
 * `now` and the presence and reaction windows between host updates. A fresh `t` on every poll
 * makes each one run, so `now` is the real server clock.
 */
export const get = query({
  args: { code: v.string(), t: v.optional(v.number()) },
  returns: v.union(partyView, v.null()),
  handler: async (ctx, args) => {
    const party = await findParty(ctx, args.code);
    if (!party) return null;
    return await viewOf(ctx, party, Date.now());
  },
});
