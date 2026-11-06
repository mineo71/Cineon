import { mutation, query, type QueryCtx } from "./_generated/server";
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
  nameOf,
  normalizeCode,
  peopleReader,
  requirePerson,
  titleCard,
  titleCardInput,
} from "./lib";

const MAX_MEMBERS_READ = 500;
const MAX_MINE = 200;

const memberView = v.object({
  personId: v.id("people"),
  name: v.string(),
  fraction: v.number(),
  watchedEpisodes: v.number(),
  label: v.string(),
  finishedAt: v.union(v.number(), v.null()),
  updatedAt: v.number(),
  pet: v.union(v.string(), v.null()),
});

const challengeView = v.object({
  code: v.string(),
  title: titleCard,
  totalEpisodes: v.number(),
  createdAt: v.number(),
  creatorId: v.id("people"),
  winnerId: v.union(v.id("people"), v.null()),
  winnerName: v.union(v.string(), v.null()),
  now: v.number(),
  members: v.array(memberView),
});

const cleanCount = (n: number) => clamp(Math.trunc(finite(n, 0)), 0, 100_000);

async function findChallenge(ctx: QueryCtx, rawCode: string): Promise<Doc<"challenges"> | null> {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  return await ctx.db
    .query("challenges")
    .withIndex("by_code", (q) => q.eq("code", code))
    .unique();
}

async function requireChallenge(ctx: QueryCtx, rawCode: string): Promise<Doc<"challenges">> {
  const challenge = await findChallenge(ctx, rawCode);
  if (!challenge) fail("NOT_FOUND", `No challenge with code ${rawCode.trim()}.`);
  return challenge;
}

async function memberRow(ctx: QueryCtx, challengeId: Id<"challenges">, personId: Id<"people">) {
  return await ctx.db
    .query("challengeMembers")
    .withIndex("by_challenge_person", (q) => q.eq("challengeId", challengeId).eq("personId", personId))
    .unique();
}

/** Progress first; at equal progress, finished before unfinished, then whoever got there first. */
function byProgress(a: Doc<"challengeMembers">, b: Doc<"challengeMembers">): number {
  if (a.fraction !== b.fraction) return b.fraction - a.fraction;
  if ((a.finishedAt === null) !== (b.finishedAt === null)) return a.finishedAt === null ? 1 : -1;
  return (a.finishedAt ?? a.progressAt) - (b.finishedAt ?? b.progressAt);
}

async function sortedMembers(ctx: QueryCtx, challengeId: Id<"challenges">) {
  const rows = await ctx.db
    .query("challengeMembers")
    .withIndex("by_challenge_person", (q) => q.eq("challengeId", challengeId))
    .take(MAX_MEMBERS_READ);
  return rows.sort(byProgress);
}

async function viewOf(ctx: QueryCtx, challenge: Doc<"challenges">) {
  const rows = await sortedMembers(ctx, challenge._id);
  const people = peopleReader(ctx);
  const members = await Promise.all(
    rows.map(async (m) => ({
      personId: m.personId,
      name: await people.name(m.personId),
      fraction: m.fraction,
      watchedEpisodes: m.watchedEpisodes,
      label: m.label,
      finishedAt: m.finishedAt,
      updatedAt: m.updatedAt,
      pet: await people.pet(m.personId),
    })),
  );
  return {
    code: challenge.code,
    title: challenge.title,
    totalEpisodes: challenge.totalEpisodes,
    createdAt: challenge.createdAt,
    creatorId: challenge.creatorId,
    winnerId: challenge.winnerId,
    winnerName: await nameOf(ctx, challenge.winnerId),
    now: Date.now(),
    members,
  };
}

/** "First to finish <title>". The creator joins straight away. */
export const create = mutation({
  args: { deviceSecret: v.string(), title: titleCardInput, totalEpisodes: v.number() },
  returns: v.object({ code: v.string() }),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const now = Date.now();
    const code = await freshCode(ctx);
    const challengeId = await ctx.db.insert("challenges", {
      code,
      creatorId: person._id,
      title: cleanTitleCard(args.title),
      totalEpisodes: cleanCount(args.totalEpisodes),
      createdAt: now,
      winnerId: null,
      finishedAt: null,
    });
    await ctx.db.insert("challengeMembers", {
      challengeId,
      personId: person._id,
      fraction: 0,
      watchedEpisodes: 0,
      label: "",
      finishedAt: null,
      updatedAt: now,
      progressAt: now,
      joinedAt: now,
    });
    await claimCode(ctx, code, "challenge", challengeId);
    return { code };
  },
});

export const join = mutation({
  args: { deviceSecret: v.string(), code: v.string() },
  returns: challengeView,
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const challenge = await requireChallenge(ctx, args.code);
    if (!(await memberRow(ctx, challenge._id, person._id))) {
      const now = Date.now();
      await ctx.db.insert("challengeMembers", {
        challengeId: challenge._id,
        personId: person._id,
        fraction: 0,
        watchedEpisodes: 0,
        label: "",
        finishedAt: null,
        updatedAt: now,
        progressAt: now,
        joinedAt: now,
      });
    }
    return await viewOf(ctx, challenge);
  },
});

export const leave = mutation({
  args: { deviceSecret: v.string(), code: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const challenge = await requireChallenge(ctx, args.code);
    const row = await memberRow(ctx, challenge._id, person._id);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/** Upserts the caller's progress. The first report with `finished: true` wins the challenge. */
export const report = mutation({
  args: {
    deviceSecret: v.string(),
    code: v.string(),
    fraction: v.number(),
    watchedEpisodes: v.number(),
    label: v.string(),
    finished: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const challenge = await requireChallenge(ctx, args.code);
    const now = Date.now();
    const row = await memberRow(ctx, challenge._id, person._id);

    // Finishing is sticky: once finished, a member stays at 1 with their original finishedAt.
    const finishedAt = row?.finishedAt ?? (args.finished ? now : null);
    const fraction = finishedAt !== null ? 1 : clamp(finite(args.fraction, 0), 0, 1);
    const fields = {
      fraction,
      watchedEpisodes: cleanCount(args.watchedEpisodes),
      label: cap(args.label, LIMITS.label),
      finishedAt,
      updatedAt: now,
    };
    if (row) {
      await ctx.db.patch(row._id, { ...fields, ...(row.fraction !== fraction ? { progressAt: now } : {}) });
    } else {
      await ctx.db.insert("challengeMembers", {
        challengeId: challenge._id,
        personId: person._id,
        ...fields,
        progressAt: now,
        joinedAt: now,
      });
    }

    if (finishedAt !== null && challenge.winnerId === null) {
      await ctx.db.patch(challenge._id, { winnerId: person._id, finishedAt });
    }
    return null;
  },
});

/** `t` is ignored; send the current time so `now` isn't served from Convex's query cache. */
export const get = query({
  args: { code: v.string(), t: v.optional(v.number()) },
  returns: v.union(challengeView, v.null()),
  handler: async (ctx, args) => {
    const challenge = await findChallenge(ctx, args.code);
    return challenge ? await viewOf(ctx, challenge) : null;
  },
});

/** The challenges the caller is in, newest first. */
export const mine = query({
  args: { deviceSecret: v.string() },
  returns: v.array(
    v.object({
      code: v.string(),
      title: titleCard,
      totalEpisodes: v.number(),
      winnerName: v.union(v.string(), v.null()),
      memberCount: v.number(),
      myFraction: v.number(),
      leaderName: v.string(),
      leaderFraction: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const memberships = await ctx.db
      .query("challengeMembers")
      .withIndex("by_person", (q) => q.eq("personId", person._id))
      .take(MAX_MINE);
    const items = await Promise.all(
      memberships.map(async (mine) => {
        const challenge = await ctx.db.get(mine.challengeId);
        if (!challenge) return null;
        const rows = await sortedMembers(ctx, challenge._id);
        const leader = rows[0] ?? mine;
        return {
          createdAt: challenge.createdAt,
          item: {
            code: challenge.code,
            title: challenge.title,
            totalEpisodes: challenge.totalEpisodes,
            winnerName: await nameOf(ctx, challenge.winnerId),
            memberCount: rows.length,
            myFraction: mine.fraction,
            leaderName: (await nameOf(ctx, leader.personId)) ?? "",
            leaderFraction: leader.fraction,
          },
        };
      }),
    );
    return items
      .filter((x) => x !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((x) => x.item);
  },
});
