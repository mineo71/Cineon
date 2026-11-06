import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { libraryStatus, titleCard } from "./lib";

export default defineSchema({
  // One row per device profile. Only the SHA-256 (hex) of the device secret is stored.
  people: defineTable({
    secretHash: v.string(),
    name: v.string(),
    // Short code the app turns into a pixel-pet avatar, like `p1-Ab3_x9`. Absent until set.
    pet: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_secretHash", ["secretHash"]),

  // Every code ever handed out, so codes are unique across shares, parties and challenges.
  codes: defineTable({
    code: v.string(),
    kind: v.union(v.literal("share"), v.literal("party"), v.literal("challenge")),
    refId: v.string(),
  }).index("by_code", ["code"]),

  shares: defineTable({
    code: v.string(),
    ownerId: v.id("people"),
    label: v.string(),
    titleCount: v.number(),
    createdAt: v.number(),
  }).index("by_code", ["code"]),

  // Titles live in their own rows so a 500-title share can't hit the 1 MiB document limit.
  shareTitles: defineTable({
    shareId: v.id("shares"),
    position: v.number(),
    card: titleCard,
  }).index("by_share", ["shareId", "position"]),

  parties: defineTable({
    code: v.string(),
    hostId: v.id("people"),
    title: v.optional(titleCard),
    pageUrl: v.string(),
    position: v.number(),
    playing: v.boolean(),
    rate: v.number(),
    updatedAt: v.number(),
    ended: v.boolean(),
    createdAt: v.number(),
  }).index("by_code", ["code"]),

  partyMembers: defineTable({
    partyId: v.id("parties"),
    personId: v.id("people"),
    joinedAt: v.number(),
    lastSeen: v.number(),
  })
    .index("by_party_person", ["partyId", "personId"])
    .index("by_party_lastSeen", ["partyId", "lastSeen"]),

  // At most ~20 kept per party; older ones are pruned on insert.
  partyReactions: defineTable({
    partyId: v.id("parties"),
    personId: v.id("people"),
    name: v.string(),
    emoji: v.string(),
    at: v.number(),
  }).index("by_party_at", ["partyId", "at"]),

  // Party chat. `name` is the sender's name when they said it; `pet` is looked up at read time.
  messages: defineTable({
    partyId: v.id("parties"),
    personId: v.id("people"),
    name: v.string(),
    text: v.string(),
    at: v.number(),
  })
    .index("by_party_at", ["partyId", "at"])
    .index("by_person_at", ["personId", "at"]),

  challenges: defineTable({
    code: v.string(),
    creatorId: v.id("people"),
    title: titleCard,
    totalEpisodes: v.number(),
    createdAt: v.number(),
    winnerId: v.union(v.id("people"), v.null()),
    finishedAt: v.union(v.number(), v.null()),
  }).index("by_code", ["code"]),

  challengeMembers: defineTable({
    challengeId: v.id("challenges"),
    personId: v.id("people"),
    fraction: v.number(),
    watchedEpisodes: v.number(),
    label: v.string(),
    finishedAt: v.union(v.number(), v.null()),
    updatedAt: v.number(),
    // When `fraction` last changed; breaks ties between equal fractions ("who got there first").
    progressAt: v.number(),
    joinedAt: v.number(),
  })
    .index("by_challenge_person", ["challengeId", "personId"])
    .index("by_person", ["personId"]),

  // Library backup: one row per title per person. `key` is an IMDb id ("tt0903747") or
  // "n:<normalised name>|<year or empty>". Ratings are half-star steps 1-20 (15 = 7.5/10).
  // `ratedAt` / `statusAt` decide last-write-wins and stay behind when a rating or status is cleared.
  libraryItems: defineTable({
    personId: v.id("people"),
    key: v.string(),
    name: v.string(),
    year: v.optional(v.number()),
    kind: v.optional(v.string()),
    rating: v.optional(v.number()),
    ratedAt: v.optional(v.number()),
    status: v.optional(libraryStatus),
    statusAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_person_key", ["personId", "key"]),
});
