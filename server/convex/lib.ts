// Shared helpers: errors, device-secret hashing, person lookup, codes, string capping.
import { ConvexError, v, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// ---------- Errors ----------

export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "UNKNOWN_DEVICE"
  | "NOT_FOUND"
  | "NOT_MEMBER"
  | "NOT_HOST"
  | "PARTY_ENDED";

/** Thrown errors reach the client as `errorData: { code, message }` (also in production). */
export function fail(code: ErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

// ---------- Limits ----------

export const LIMITS = {
  name: 40,
  title: 200,
  label: 200,
  url: 2000,
  emoji: 8,
  imdbId: 40,
  status: 200,
  shareTitles: 500,
  message: 280,
  pet: 48,
  libraryKey: 160,
  libraryKind: 16,
  libraryPut: 200,
} as const;

// ---------- Strings ----------

/** Trims, turns control characters into spaces, and caps to `max` code points. */
export function cap(input: string, max: number): string {
  const cleaned = input.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  const chars = Array.from(cleaned);
  return chars.length <= max ? cleaned : chars.slice(0, max).join("").trim();
}

export function capName(input: string): string {
  const name = cap(input, LIMITS.name);
  if (!name) fail("INVALID_ARGUMENT", "Name must not be empty.");
  return name;
}

/** A pet code: 1 to 48 of `[A-Za-z0-9_-]`, after trimming. Throws otherwise. */
export function checkPet(input: string): string {
  const pet = input.trim();
  if (pet.length === 0 || pet.length > LIMITS.pet || !/^[A-Za-z0-9_-]+$/.test(pet)) {
    fail("INVALID_ARGUMENT", `pet must be 1 to ${LIMITS.pet} characters of A-Z, a-z, 0-9, "_" or "-".`);
  }
  return pet;
}

function isHttpUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/** A required http(s) URL, trimmed and capped. Throws if it isn't one. */
export function requireUrl(input: string, what: string): string {
  const url = input.trim();
  if (url.length > LIMITS.url) fail("INVALID_ARGUMENT", `${what} is longer than ${LIMITS.url} characters.`);
  if (!isHttpUrl(url)) fail("INVALID_ARGUMENT", `${what} must be an http(s) URL.`);
  return url;
}

/** An optional http(s) URL: anything else (or too long) is dropped. */
function optionalUrl(input: string | null | undefined): string | undefined {
  if (input == null) return undefined;
  const url = input.trim();
  return url.length <= LIMITS.url && isHttpUrl(url) ? url : undefined;
}

export function finite(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------- TitleCard ----------

const kind = v.union(v.literal("film"), v.literal("series"), v.literal("cartoon"), v.literal("unknown"));

/** Stored / returned shape. */
export const titleCard = v.object({
  name: v.string(),
  year: v.optional(v.number()),
  kind,
  imdbId: v.optional(v.string()),
  posterUrl: v.optional(v.string()),
  status: v.optional(v.string()),
  rating: v.optional(v.number()),
});
export type TitleCard = Infer<typeof titleCard>;

/** Accepted input shape: like `titleCard`, but optional fields may also be `null`. */
export const titleCardInput = v.object({
  name: v.string(),
  year: v.optional(v.union(v.number(), v.null())),
  kind,
  imdbId: v.optional(v.union(v.string(), v.null())),
  posterUrl: v.optional(v.union(v.string(), v.null())),
  status: v.optional(v.union(v.string(), v.null())),
  rating: v.optional(v.union(v.number(), v.null())),
});
export type TitleCardInput = Infer<typeof titleCardInput>;

export function cleanTitleCard(t: TitleCardInput): TitleCard {
  const name = cap(t.name, LIMITS.title);
  if (!name) fail("INVALID_ARGUMENT", "Every title needs a name.");
  const card: TitleCard = { name, kind: t.kind };
  if (t.year != null && Number.isFinite(t.year)) card.year = Math.trunc(t.year);
  const imdbId = t.imdbId == null ? "" : cap(t.imdbId, LIMITS.imdbId);
  if (imdbId) card.imdbId = imdbId;
  const posterUrl = optionalUrl(t.posterUrl);
  if (posterUrl) card.posterUrl = posterUrl;
  const status = t.status == null ? "" : cap(t.status, LIMITS.status);
  if (status) card.status = status;
  if (t.rating != null && Number.isFinite(t.rating)) card.rating = t.rating;
  return card;
}

// ---------- Library ----------

export const LIBRARY_STATUSES = ["none", "backlog", "watching", "watched"] as const;
export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];
export const libraryStatus = v.union(
  v.literal("none"),
  v.literal("backlog"),
  v.literal("watching"),
  v.literal("watched"),
);

// ---------- Device secrets ----------

/** Hex SHA-256 of the secret's UTF-8 bytes (the base64 string as sent, not decoded). */
export async function hashSecret(secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function checkSecret(secret: string): string {
  const s = secret.trim();
  if (s.length < 16 || s.length > 256) {
    fail("INVALID_ARGUMENT", "deviceSecret must be 16 to 256 characters (32 random bytes, base64).");
  }
  return s;
}

export async function findPerson(ctx: QueryCtx, deviceSecret: string): Promise<Doc<"people"> | null> {
  const secretHash = await hashSecret(checkSecret(deviceSecret));
  return await ctx.db
    .query("people")
    .withIndex("by_secretHash", (q) => q.eq("secretHash", secretHash))
    .unique();
}

/** Resolves the caller from their device secret, or throws UNKNOWN_DEVICE. */
export async function requirePerson(ctx: QueryCtx, deviceSecret: string): Promise<Doc<"people">> {
  const person = await findPerson(ctx, deviceSecret);
  if (!person) fail("UNKNOWN_DEVICE", "Unknown device. Call people:register first.");
  return person;
}

export async function nameOf(ctx: QueryCtx, personId: Id<"people"> | null | undefined): Promise<string | null> {
  if (!personId) return null;
  const person = await ctx.db.get(personId);
  return person?.name ?? null;
}

/**
 * Reads each person row at most once per call, for views that name the same people many times
 * (members, reactions, messages). Names and pets come from the row as it is now.
 */
export function peopleReader(ctx: QueryCtx) {
  const rows = new Map<Id<"people">, Promise<Doc<"people"> | null>>();
  const row = (id: Id<"people">) => {
    let p = rows.get(id);
    if (!p) {
      p = ctx.db.get(id);
      rows.set(id, p);
    }
    return p;
  };
  return {
    name: async (id: Id<"people">) => (await row(id))?.name ?? "",
    pet: async (id: Id<"people">) => (await row(id))?.pet ?? null,
  };
}

// ---------- Codes ----------

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
export type CodeKind = "share" | "party" | "challenge";

/** Uppercases and strips spaces and dashes. Returns null unless it is a well-formed code. */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s\-–—_.]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

function randomCode(): string {
  // Rejection sampling keeps every character equally likely (256 isn't a multiple of 31).
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = "";
  while (code.length < CODE_LENGTH) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return code;
}

/** Picks a code not used by any share, party or challenge. Call `claimCode` once the row exists. */
export async function freshCode(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomCode();
    const taken = await ctx.db
      .query("codes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();
    if (!taken) return code;
  }
  throw new Error("Could not allocate a unique code.");
}

export async function claimCode(ctx: MutationCtx, code: string, kind: CodeKind, refId: string): Promise<void> {
  await ctx.db.insert("codes", { code, kind, refId });
}
