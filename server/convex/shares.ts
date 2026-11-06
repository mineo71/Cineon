import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  LIMITS,
  cap,
  claimCode,
  cleanTitleCard,
  fail,
  freshCode,
  nameOf,
  normalizeCode,
  requirePerson,
  titleCard,
  titleCardInput,
} from "./lib";

/** Shares a list of titles (the Watched list, or one title) under a new code. */
export const create = mutation({
  args: { deviceSecret: v.string(), label: v.string(), titles: v.array(titleCardInput) },
  returns: v.object({ code: v.string() }),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    if (args.titles.length > LIMITS.shareTitles) {
      fail("INVALID_ARGUMENT", `A share holds at most ${LIMITS.shareTitles} titles (got ${args.titles.length}).`);
    }
    const titles = args.titles.map(cleanTitleCard);
    const code = await freshCode(ctx);
    const shareId = await ctx.db.insert("shares", {
      code,
      ownerId: person._id,
      label: cap(args.label, LIMITS.label),
      titleCount: titles.length,
      createdAt: Date.now(),
    });
    for (let i = 0; i < titles.length; i++) {
      await ctx.db.insert("shareTitles", { shareId, position: i, card: titles[i] });
    }
    await claimCode(ctx, code, "share", shareId);
    return { code };
  },
});

export const get = query({
  args: { code: v.string() },
  returns: v.union(
    v.object({
      code: v.string(),
      label: v.string(),
      ownerName: v.string(),
      titles: v.array(titleCard),
      createdAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    if (!code) return null;
    const share = await ctx.db
      .query("shares")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!share) return null;
    const rows = await ctx.db
      .query("shareTitles")
      .withIndex("by_share", (q) => q.eq("shareId", share._id))
      .take(LIMITS.shareTitles);
    return {
      code: share.code,
      label: share.label,
      ownerName: (await nameOf(ctx, share.ownerId)) ?? "",
      titles: rows.map((r) => r.card),
      createdAt: share.createdAt,
    };
  },
});
