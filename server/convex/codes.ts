import { query } from "./_generated/server";
import { v } from "convex/values";
import { normalizeCode } from "./lib";

/** What a code points at. Accepts any case, with or without a dash or spaces. */
export const resolve = query({
  args: { code: v.string() },
  returns: v.union(
    v.object({ kind: v.union(v.literal("share"), v.literal("party"), v.literal("challenge")) }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    if (!code) return null;
    const row = await ctx.db
      .query("codes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();
    return row ? { kind: row.kind } : null;
  },
});
