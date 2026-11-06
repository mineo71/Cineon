import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { capName, checkPet, checkSecret, hashSecret } from "./lib";

/**
 * Creates the person for this device secret, or updates them if they already exist.
 * `pet`: leave it out (or send `null`) to keep the stored pet, so the app can rename alone;
 * send `""` to remove it; send a code to set it.
 */
export const register = mutation({
  args: { deviceSecret: v.string(), name: v.string(), pet: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ personId: v.id("people"), name: v.string(), pet: v.union(v.string(), v.null()) }),
  handler: async (ctx, { deviceSecret, name, pet }) => {
    const secretHash = await hashSecret(checkSecret(deviceSecret));
    const cleanName = capName(name);
    // undefined: keep the stored pet; null: remove it; a string: set it.
    const wantedPet = pet == null ? undefined : pet.trim() === "" ? null : checkPet(pet);
    const now = Date.now();
    const existing = await ctx.db
      .query("people")
      .withIndex("by_secretHash", (q) => q.eq("secretHash", secretHash))
      .unique();
    if (existing) {
      const nextPet = wantedPet === undefined ? existing.pet : (wantedPet ?? undefined);
      // Patching a field to undefined removes it from the row.
      const changes = {
        ...(existing.name !== cleanName ? { name: cleanName } : {}),
        ...(nextPet !== existing.pet ? { pet: nextPet } : {}),
      };
      if (Object.keys(changes).length > 0) await ctx.db.patch(existing._id, { ...changes, updatedAt: now });
      return { personId: existing._id, name: cleanName, pet: nextPet ?? null };
    }
    const personId = await ctx.db.insert("people", {
      secretHash,
      name: cleanName,
      ...(wantedPet ? { pet: wantedPet } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return { personId, name: cleanName, pet: wantedPet ?? null };
  },
});
