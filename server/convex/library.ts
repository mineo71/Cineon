// Library backup: ratings, statuses and a little title data, per person, so a cleared or
// re-imported library can be restored. Identity is the device secret, as everywhere else.
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v, type Infer } from "convex/values";
import { LIBRARY_STATUSES, LIMITS, cap, fail, libraryStatus, requirePerson, type LibraryStatus } from "./lib";

const optNumber = v.optional(v.union(v.number(), v.null()));
const optString = v.optional(v.union(v.string(), v.null()));

// For every optional field: left out = keep what's stored, null = clear, a value = set.
const itemInput = v.object({
  key: v.string(),
  name: v.string(),
  year: optNumber,
  kind: optString,
  rating: optNumber,
  ratedAt: optNumber,
  status: optString,
  statusAt: optNumber,
  finishedAt: optNumber,
});

const itemView = v.object({
  key: v.string(),
  name: v.string(),
  year: v.union(v.number(), v.null()),
  kind: v.union(v.string(), v.null()),
  rating: v.union(v.number(), v.null()),
  ratedAt: v.union(v.number(), v.null()),
  status: v.union(libraryStatus, v.null()),
  statusAt: v.union(v.number(), v.null()),
  finishedAt: v.union(v.number(), v.null()),
  updatedAt: v.number(),
});

type Fields = Omit<Doc<"libraryItems">, "_id" | "_creationTime" | "personId" | "updatedAt">;

/** A timestamp in ms: finite and not negative. `clampToNow` keeps a fast clock from winning forever. */
function time(n: number | null | undefined, what: string, now: number, clampToNow: boolean): number | null | undefined {
  if (n == null) return n;
  if (!Number.isFinite(n) || n < 0) fail("INVALID_ARGUMENT", `${what} must be a time in milliseconds.`);
  const ms = Math.trunc(n);
  return clampToNow ? Math.min(ms, now) : ms;
}

/** `undefined` keeps `stored`, `null` clears, anything else replaces. */
function merge<T>(incoming: T | null | undefined, stored: T | undefined): T | undefined {
  if (incoming === undefined) return stored;
  return incoming ?? undefined;
}

/** Last write wins: a missing time counts as older than any time, and a tie goes to the incoming value. */
function newerOrSame(incomingAt: number | null | undefined, storedAt: number | undefined): boolean {
  return (incomingAt ?? -Infinity) >= (storedAt ?? -Infinity);
}

function clean(raw: Infer<typeof itemInput>, i: number, now: number) {
  const at = `items[${i}]`;
  const key = raw.key.trim();
  if (!key || Array.from(key).length > LIMITS.libraryKey) {
    fail("INVALID_ARGUMENT", `${at}.key must be 1 to ${LIMITS.libraryKey} characters.`);
  }
  const name = cap(raw.name, LIMITS.title);
  if (!name) fail("INVALID_ARGUMENT", `${at}.name must not be empty.`);

  let year = raw.year;
  if (year != null) {
    if (!Number.isFinite(year)) fail("INVALID_ARGUMENT", `${at}.year must be a number.`);
    year = Math.trunc(year);
  }

  let kind = raw.kind;
  if (kind != null) {
    kind = kind.trim();
    if (Array.from(kind).length > LIMITS.libraryKind) {
      fail("INVALID_ARGUMENT", `${at}.kind must be at most ${LIMITS.libraryKind} characters.`);
    }
    if (!kind) kind = null;
  }

  const rating = raw.rating;
  if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 20)) {
    fail("INVALID_ARGUMENT", `${at}.rating must be a whole number from 1 to 20 (half-star steps), or null.`);
  }

  const status = raw.status;
  if (status != null && !(LIBRARY_STATUSES as readonly string[]).includes(status)) {
    fail("INVALID_ARGUMENT", `${at}.status must be one of ${LIBRARY_STATUSES.join(", ")}, or null.`);
  }

  return {
    key,
    name,
    year,
    kind,
    rating,
    ratedAt: time(raw.ratedAt, `${at}.ratedAt`, now, true),
    status: status as LibraryStatus | null | undefined,
    statusAt: time(raw.statusAt, `${at}.statusAt`, now, true),
    finishedAt: time(raw.finishedAt, `${at}.finishedAt`, now, false),
  };
}

function nextFields(item: ReturnType<typeof clean>, stored: Fields | null): Fields {
  const s: Partial<Fields> = stored ?? {};
  const fields: Partial<Fields> = {
    key: item.key,
    name: item.name,
    year: merge(item.year, s.year),
    kind: merge(item.kind, s.kind),
    finishedAt: merge(item.finishedAt, s.finishedAt),
    rating: s.rating,
    ratedAt: s.ratedAt,
    status: s.status,
    statusAt: s.statusAt,
  };
  if (item.rating !== undefined && newerOrSame(item.ratedAt, s.ratedAt)) {
    fields.rating = item.rating ?? undefined;
    fields.ratedAt = item.ratedAt ?? undefined;
  }
  if (item.status !== undefined && newerOrSame(item.statusAt, s.statusAt)) {
    fields.status = item.status ?? undefined;
    fields.statusAt = item.statusAt ?? undefined;
  }
  // Drop undefined keys so the row simply lacks those fields.
  for (const k of Object.keys(fields) as (keyof Fields)[]) if (fields[k] === undefined) delete fields[k];
  return fields as Fields;
}

function sameFields(a: Fields, b: Fields): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Fields)[]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Upserts up to 200 titles by key. Rating and status follow last-write-wins on ratedAt/statusAt;
 * a cleared rating or status keeps its time so an older value from another device can't return.
 * `saved` counts the items accepted, including ones that changed nothing.
 */
export const put = mutation({
  args: { deviceSecret: v.string(), items: v.array(itemInput) },
  returns: v.object({ saved: v.number() }),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    if (args.items.length > LIMITS.libraryPut) {
      fail("INVALID_ARGUMENT", `At most ${LIMITS.libraryPut} items per call (got ${args.items.length}).`);
    }
    const now = Date.now();
    const items = args.items.map((raw, i) => clean(raw, i, now));
    for (const item of items) {
      const row = await ctx.db
        .query("libraryItems")
        .withIndex("by_person_key", (q) => q.eq("personId", person._id).eq("key", item.key))
        .unique();
      if (row) {
        const { _id, _creationTime, personId, updatedAt, ...stored } = row;
        const fields = nextFields(item, stored);
        if (!sameFields(fields, stored)) await ctx.db.replace(_id, { ...fields, personId, updatedAt: now });
      } else {
        await ctx.db.insert("libraryItems", { ...nextFields(item, null), personId: person._id, updatedAt: now });
      }
    }
    return { saved: items.length };
  },
});

/** Every backed-up title for the caller, by key. `t` is ignored (a cache-buster, as on parties:get). */
export const all = query({
  args: { deviceSecret: v.string(), t: v.optional(v.number()) },
  returns: v.array(itemView),
  handler: async (ctx, args) => {
    const person = await requirePerson(ctx, args.deviceSecret);
    const rows = await ctx.db
      .query("libraryItems")
      .withIndex("by_person_key", (q) => q.eq("personId", person._id))
      .collect();
    return rows.map((r) => ({
      key: r.key,
      name: r.name,
      year: r.year ?? null,
      kind: r.kind ?? null,
      rating: r.rating ?? null,
      ratedAt: r.ratedAt ?? null,
      status: r.status ?? null,
      statusAt: r.statusAt ?? null,
      finishedAt: r.finishedAt ?? null,
      updatedAt: r.updatedAt,
    }));
  },
});
