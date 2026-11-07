/* eslint-disable @typescript-eslint/no-explicit-any */
// A stand-in for the Convex deployment, behind a fetch function (port of
// windows/Cineon.Core.Tests/Together/FakeConvex.cs). It speaks Convex's HTTP API (/api/query and
// /api/mutation, {"status":"success","value":…} or {"status":"error",…}, numbers as floats like
// 2022.0), checks arguments against the validators in server/convex/*.ts (extra fields and wrong types
// are rejected, as Convex does), and runs ports of the functions there.

import type { Fetch } from "../../src/core/together";
import { sha256Hex } from "./sha256";

export interface Call {
  kind: string;
  path: string;
  args: any;
  url: string;
}

class Fail extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A plain `throw new Error(...)` in a server function. */
class ServerBug extends Error {}

// MARK: Validators (convex/values), enough for the functions here

type V =
  | { t: "string" }
  | { t: "number" }
  | { t: "bool" }
  | { t: "null" }
  | { t: "literal"; value: string }
  | { t: "array"; item: V }
  | { t: "union"; options: V[] }
  | { t: "object"; fields: [string, V, boolean][] };

const Str: V = { t: "string" };
const Num: V = { t: "number" };
const Bool: V = { t: "bool" };
const req = (name: string, v: V): [string, V, boolean] => [name, v, false];
const opt = (name: string, v: V): [string, V, boolean] => [name, v, true];
const orNull = (v: V): V => ({ t: "union", options: [v, { t: "null" }] });
const obj = (...fields: [string, V, boolean][]): V => ({ t: "object", fields });

const TitleCardInput = obj(
  req("name", Str),
  opt("year", orNull(Num)),
  req("kind", { t: "union", options: ["film", "series", "cartoon", "unknown"].map((value) => ({ t: "literal", value }) as V) }),
  opt("imdbId", orNull(Str)),
  opt("posterUrl", orNull(Str)),
  opt("status", orNull(Str)),
  opt("rating", orNull(Num)),
);

const LibraryItemInput = obj(
  req("key", Str),
  req("name", Str),
  opt("year", orNull(Num)),
  opt("kind", orNull(Str)),
  opt("rating", orNull(Num)),
  opt("ratedAt", orNull(Num)),
  opt("status", orNull(Str)),
  opt("statusAt", orNull(Num)),
  opt("finishedAt", orNull(Num)),
);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(value: unknown, v: V, at: string): string | null {
  switch (v.t) {
    case "string":
      return typeof value === "string" ? null : `Value at ${at} must be a string`;
    case "number":
      return typeof value === "number" ? null : `Value at ${at} must be a number`;
    case "bool":
      return typeof value === "boolean" ? null : `Value at ${at} must be a boolean`;
    case "null":
      return value === null ? null : `Value at ${at} must be null`;
    case "literal":
      return value === v.value ? null : `Value at ${at} must be "${v.value}"`;
    case "array": {
      if (!Array.isArray(value)) return `Value at ${at} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const bad = validate(value[i], v.item, `${at}[${i}]`);
        if (bad) return bad;
      }
      return null;
    }
    case "union":
      return v.options.some((o) => validate(value, o, at) === null) ? null : `Value does not match validator at ${at}`;
    case "object": {
      if (!isObject(value)) return `Value at ${at} must be an object`;
      for (const name of Object.keys(value)) {
        if (!v.fields.some(([field]) => field === name)) return `Object contains extra field \`${name}\` that is not in the validator.`;
      }
      for (const [name, validator, optional] of v.fields) {
        if (!(name in value)) {
          if (!optional) return `Object is missing the required field \`${name}\`.`;
          continue;
        }
        const bad = validate(value[name], validator, `${at}.${name}`);
        if (bad) return bad;
      }
      return null;
    }
  }
}

// MARK: Convex JSON out: every number is a float64, written like 2022.0

export function convexJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    const text = String(value);
    return /[.e]/.test(text) ? text : text + ".0";
  }
  if (Array.isArray(value)) return "[" + value.map(convexJson).join(",") + "]";
  if (isObject(value)) {
    return "{" + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ":" + convexJson(v)).join(",") + "}";
  }
  throw new Error(`Can't write ${typeof value}`);
}

// MARK: Tables

export interface Person {
  id: string;
  secretHash: string;
  name: string;
  pet: string | null;
  createdAt: number;
  updatedAt: number;
}

interface CodeRow {
  code: string;
  kind: string;
  refId: string;
}

interface ShareRow {
  id: string;
  code: string;
  ownerId: string;
  label: string;
  titles: Record<string, unknown>[];
  createdAt: number;
}

export interface PartyRow {
  id: string;
  code: string;
  hostId: string;
  pageUrl: string;
  title: Record<string, unknown> | null;
  position: number;
  rate: number;
  updatedAt: number;
  createdAt: number;
  playing: boolean;
  ended: boolean;
}

interface MemberRow {
  partyId: string;
  personId: string;
  joinedAt: number;
  lastSeen: number;
  order: number;
}

interface ReactionRow {
  partyId: string;
  personId: string;
  name: string;
  emoji: string;
  at: number;
}

interface MessageRow {
  partyId: string;
  personId: string;
  name: string;
  text: string;
  at: number;
}

interface ChallengeRow {
  id: string;
  code: string;
  creatorId: string;
  title: Record<string, unknown>;
  totalEpisodes: number;
  createdAt: number;
  winnerId: string | null;
  finishedAt: number | null;
}

interface ChallengeMemberRow {
  challengeId: string;
  personId: string;
  fraction: number;
  watchedEpisodes: number;
  updatedAt: number;
  progressAt: number;
  joinedAt: number;
  label: string;
  finishedAt: number | null;
}

export interface LibraryFields {
  key: string;
  name: string;
  year?: number | null;
  kind?: string | null;
  rating?: number | null;
  ratedAt?: number | null;
  status?: string | null;
  statusAt?: number | null;
  finishedAt?: number | null;
}

interface LibraryRow {
  personId: string;
  fields: Required<LibraryFields>;
  updatedAt: number;
}

function fullFields(f: LibraryFields): Required<LibraryFields> {
  return {
    key: f.key,
    name: f.name,
    year: f.year ?? null,
    kind: f.kind ?? null,
    rating: f.rating ?? null,
    ratedAt: f.ratedAt ?? null,
    status: f.status ?? null,
    statusAt: f.statusAt ?? null,
    finishedAt: f.finishedAt ?? null,
  };
}

function sameFields(a: Required<LibraryFields>, b: Required<LibraryFields>): boolean {
  return (Object.keys(a) as (keyof LibraryFields)[]).every((k) => a[k] === b[k]);
}

// MARK: lib.ts

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function cap(input: string, max: number): string {
  const cleaned = input.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  const points = Array.from(cleaned);
  return points.length <= max ? cleaned : points.slice(0, max).join("").trim();
}

function capName(input: string): string {
  const name = cap(input, 40);
  if (name.length === 0) throw new Fail("INVALID_ARGUMENT", "Name must not be empty.");
  return name;
}

function checkPet(input: string): string {
  const pet = input.trim();
  if (pet.length === 0 || pet.length > 48 || !/^[A-Za-z0-9_-]+$/.test(pet)) {
    throw new Fail("INVALID_ARGUMENT", 'pet must be 1 to 48 characters of A-Z, a-z, 0-9, "_" or "-".');
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

function requireUrl(input: string, what: string): string {
  const url = input.trim();
  if (url.length > 2000) throw new Fail("INVALID_ARGUMENT", `${what} is longer than 2000 characters.`);
  if (!isHttpUrl(url)) throw new Fail("INVALID_ARGUMENT", `${what} must be an http(s) URL.`);
  return url;
}

const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function stringOrNull(o: any, key: string): string | null {
  return typeof o?.[key] === "string" ? o[key] : null;
}

function numberOrNull(o: any, key: string): number | null {
  return typeof o?.[key] === "number" ? o[key] : null;
}

function cleanTitleCard(t: any): Record<string, unknown> {
  const name = cap(t.name, 200);
  if (name.length === 0) throw new Fail("INVALID_ARGUMENT", "Every title needs a name.");
  const card: Record<string, unknown> = { name, kind: t.kind };
  const year = numberOrNull(t, "year");
  if (year !== null) card.year = Math.trunc(year);
  const imdb = stringOrNull(t, "imdbId");
  if (imdb !== null && cap(imdb, 40).length > 0) card.imdbId = cap(imdb, 40);
  const poster = stringOrNull(t, "posterUrl")?.trim();
  if (poster !== undefined && poster.length <= 2000 && isHttpUrl(poster)) card.posterUrl = poster;
  const status = stringOrNull(t, "status");
  if (status !== null && cap(status, 200).length > 0) card.status = cap(status, 200);
  const rating = numberOrNull(t, "rating");
  if (rating !== null) card.rating = rating;
  return card;
}

export const hashSecret = (secret: string) => sha256Hex(secret);

function checkSecret(secret: string): string {
  const s = secret.trim();
  if (s.length < 16 || s.length > 256) {
    throw new Fail("INVALID_ARGUMENT", "deviceSecret must be 16 to 256 characters (32 random bytes, base64).");
  }
  return s;
}

function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s\-–—_.]/g, "");
  if (code.length !== 6) return null;
  return [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

interface Fn {
  kind: "query" | "mutation";
  args: V;
  run: (args: any) => unknown;
}

const LIBRARY_STATUSES = ["none", "backlog", "watching", "watched"];

/** A field as sent: left out (keep), null (clear), or a value. */
interface In<T> {
  sent: boolean;
  value: T | null;
}

function inNumber(o: any, key: string): In<number> {
  return key in o ? { sent: true, value: typeof o[key] === "number" ? o[key] : null } : { sent: false, value: null };
}

function inString(o: any, key: string): In<string> {
  return key in o ? { sent: true, value: typeof o[key] === "string" ? o[key] : null } : { sent: false, value: null };
}

function time(n: In<number>, what: string, now: number, clampToNow: boolean): In<number> {
  if (n.value === null) return n;
  let ms = n.value;
  if (!Number.isFinite(ms) || ms < 0) throw new Fail("INVALID_ARGUMENT", `${what} must be a time in milliseconds.`);
  ms = Math.trunc(ms);
  return { sent: true, value: clampToNow ? Math.min(ms, now) : ms };
}

function mergeField<T>(incoming: In<T>, stored: T | null): T | null {
  return incoming.sent ? incoming.value : stored;
}

function newerOrSame(incomingAt: number | null, storedAt: number | null): boolean {
  return (incomingAt ?? -Infinity) >= (storedAt ?? -Infinity);
}

/** A seeded generator, so random codes are the same every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export class FakeConvex {
  private readonly random = seeded(7);
  private readonly functions: Record<string, Fn>;
  private nextId = 0;

  /** When set, every request fails like a dropped connection. */
  offline = false;
  /** Codes handed out next, before random ones. */
  readonly nextCodes: string[] = [];
  /** When it returns a body, that is sent instead of running the function. */
  intercept: ((call: Call) => string | null | undefined) | null = null;
  readonly calls: Call[] = [];

  readonly people: Person[] = [];
  private readonly codes: CodeRow[] = [];
  private readonly shares: ShareRow[] = [];
  readonly parties: PartyRow[] = [];
  private readonly partyMembers: MemberRow[] = [];
  private readonly reactions: ReactionRow[] = [];
  private readonly messages: MessageRow[] = [];
  private readonly challenges: ChallengeRow[] = [];
  private readonly challengeMembers: ChallengeMemberRow[] = [];
  private readonly library: LibraryRow[] = [];

  constructor(private readonly clock: { now(): number }) {
    this.functions = this.makeFunctions();
  }

  /** Server time in milliseconds, like JavaScript's Date.now(). */
  get now(): number {
    return Math.trunc(this.clock.now());
  }

  callsTo(path: string): Call[] {
    return this.calls.filter((c) => c.path === path);
  }

  /** The server behind a fetch. */
  readonly fetch: Fetch = async (url, init) => {
    if (this.offline) throw new TypeError("The Internet connection appears to be offline.");
    const [status, body] = this.handle(url, init.method, init.headers["Content-Type"] ?? "", init.body);
    // A plain reply rather than a Response, so a call settles in microtasks.
    return { status, text: async () => body };
  };

  /** The backed-up library of whoever holds this secret. */
  libraryOf(secret: string): Required<LibraryFields>[] {
    const person = this.people.find((p) => p.secretHash === hashSecret(secret));
    return person ? this.library.filter((r) => r.personId === person.id).map((r) => r.fields) : [];
  }

  seedLibrary(secret: string, fields: LibraryFields): void {
    const person = this.people.find((p) => p.secretHash === hashSecret(secret));
    if (!person) throw new Error("No such person");
    this.library.push({ personId: person.id, fields: fullFields(fields), updatedAt: this.now });
  }

  private handle(url: string, method: string, contentType: string, body: string): [number, string] {
    const path = new URL(url).pathname;
    const kind = path === "/api/query" ? "query" : path === "/api/mutation" ? "mutation" : null;
    if (method !== "POST" || kind === null) return [404, '{"code":"NotFound","message":"Not found"}'];
    if (contentType !== "application/json") return [400, '{"code":"BadJsonBody","message":"Expected JSON"}'];
    let root: any;
    try {
      root = JSON.parse(body);
    } catch {
      return [400, '{"code":"BadJsonBody","message":"Failed to parse the request body as JSON"}'];
    }
    const name: string = root.path;
    const args = root.args ?? {};
    if (root.format !== "json") throw new Error(`format must be json, was ${root.format}`);

    const call: Call = { kind, path: name, args, url };
    this.calls.push(call);
    const canned = this.intercept?.(call);
    if (canned) return [200, canned];
    const fn = this.functions[name];
    if (!fn) return [200, error(`Could not find public function for '${name}'.`)];
    if (fn.kind !== kind) {
      const want = fn.kind === "query" ? "Query" : "Mutation";
      const got = kind === "query" ? "Query" : "Mutation";
      return [200, error(`Trying to execute ${name} as ${got}, but it is defined as ${want}.`)];
    }
    const invalid = validate(args, fn.args, "");
    if (invalid) return [200, error(`ArgumentValidationError: ${invalid}\n\nObject: ${JSON.stringify(args)}\n`)];
    try {
      const value = fn.run(args);
      return [200, `{"status":"success","value":${convexJson(value)}}`];
    } catch (e) {
      if (e instanceof Fail) {
        const data = { code: e.code, message: e.message };
        const message = `[Request ID: fake] Server Error\nUncaught ConvexError: ${convexJson(data)}\n    at fail (../../convex/lib.ts:18:0)\n`;
        return [200, `{"status":"error","errorMessage":${convexJson(message)},"errorData":${convexJson(data)}}`];
      }
      if (e instanceof ServerBug) return [200, error(`Uncaught Error: ${e.message}\n    at handler (../convex/lib.ts:1:0)`)];
      throw e;
    }
  }

  private newId(table: string): string {
    return `${table}${String(++this.nextId).padStart(4, "0")}`;
  }

  private findPerson(deviceSecret: string): Person | undefined {
    const hash = hashSecret(checkSecret(deviceSecret));
    return this.people.find((p) => p.secretHash === hash);
  }

  private requirePerson(args: any): Person {
    const person = this.findPerson(args.deviceSecret);
    if (!person) throw new Fail("UNKNOWN_DEVICE", "Unknown device. Call people:register first.");
    return person;
  }

  private personById(id: string | null): Person | undefined {
    return id === null ? undefined : this.people.find((p) => p.id === id);
  }

  private nameOf(id: string | null): string | null {
    return this.personById(id)?.name ?? null;
  }

  private peopleName(id: string): string {
    return this.personById(id)?.name ?? "";
  }

  private peoplePet(id: string): string | null {
    return this.personById(id)?.pet ?? null;
  }

  private freshCode(): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code =
        this.nextCodes.length > 0
          ? this.nextCodes.shift()!
          : Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)]).join("");
      if (normalizeCode(code) !== code) throw new Error(`${code} isn't a code the server could hand out`);
      if (!this.codes.some((c) => c.code === code)) return code;
    }
    throw new ServerBug("Could not allocate a unique code.");
  }

  private claimCode(code: string, kind: string, refId: string): void {
    this.codes.push({ code, kind, refId });
  }

  // MARK: The functions

  private makeFunctions(): Record<string, Fn> {
    return {
      "people:register": { kind: "mutation", args: obj(req("deviceSecret", Str), req("name", Str), opt("pet", orNull(Str))), run: (a) => this.register(a) },
      "codes:resolve": {
        kind: "query",
        args: obj(req("code", Str)),
        run: (a) => {
          const code = normalizeCode(a.code);
          const row = code === null ? undefined : this.codes.find((c) => c.code === code);
          return row ? { kind: row.kind } : null;
        },
      },
      "shares:create": {
        kind: "mutation",
        args: obj(req("deviceSecret", Str), req("label", Str), req("titles", { t: "array", item: TitleCardInput })),
        run: (a) => this.createShare(a),
      },
      "shares:get": { kind: "query", args: obj(req("code", Str)), run: (a) => this.getShare(a) },
      "parties:create": {
        kind: "mutation",
        args: obj(req("deviceSecret", Str), opt("title", orNull(TitleCardInput)), req("pageUrl", Str), req("position", Num), req("playing", Bool), req("rate", Num)),
        run: (a) => this.createParty(a),
      },
      "parties:join": { kind: "mutation", args: obj(req("deviceSecret", Str), req("code", Str)), run: (a) => this.joinParty(a) },
      "parties:leave": { kind: "mutation", args: obj(req("deviceSecret", Str), req("code", Str)), run: (a) => this.leaveParty(a) },
      "parties:update": {
        kind: "mutation",
        args: obj(req("deviceSecret", Str), req("code", Str), req("position", Num), req("playing", Bool), req("rate", Num), opt("pageUrl", orNull(Str))),
        run: (a) => this.updateParty(a),
      },
      "parties:heartbeat": { kind: "mutation", args: obj(req("deviceSecret", Str), req("code", Str)), run: (a) => this.heartbeat(a) },
      "parties:react": { kind: "mutation", args: obj(req("deviceSecret", Str), req("code", Str), req("emoji", Str)), run: (a) => this.react(a) },
      "parties:say": { kind: "mutation", args: obj(req("deviceSecret", Str), req("code", Str), req("text", Str)), run: (a) => this.say(a) },
      "parties:get": {
        kind: "query",
        args: obj(req("code", Str), opt("t", Num)),
        run: (a) => {
          const party = this.findParty(a.code);
          return party ? this.partyView(party, this.now) : null;
        },
      },
      "challenges:create": {
        kind: "mutation",
        args: obj(req("deviceSecret", Str), req("title", TitleCardInput), req("totalEpisodes", Num)),
        run: (a) => this.createChallenge(a),
      },
      "challenges:join": { kind: "mutation", args: obj(req("deviceSecret", Str), req("code", Str)), run: (a) => this.joinChallenge(a) },
      "challenges:leave": { kind: "mutation", args: obj(req("deviceSecret", Str), req("code", Str)), run: (a) => this.leaveChallenge(a) },
      "challenges:report": {
        kind: "mutation",
        args: obj(req("deviceSecret", Str), req("code", Str), req("fraction", Num), req("watchedEpisodes", Num), req("label", Str), req("finished", Bool)),
        run: (a) => this.report(a),
      },
      "challenges:get": {
        kind: "query",
        args: obj(req("code", Str), opt("t", Num)),
        run: (a) => {
          const challenge = this.findChallenge(a.code);
          return challenge ? this.challengeView(challenge) : null;
        },
      },
      "challenges:mine": { kind: "query", args: obj(req("deviceSecret", Str)), run: (a) => this.mine(a) },
      "library:put": {
        kind: "mutation",
        args: obj(req("deviceSecret", Str), req("items", { t: "array", item: LibraryItemInput })),
        run: (a) => this.putLibrary(a),
      },
      "library:all": { kind: "query", args: obj(req("deviceSecret", Str), opt("t", Num)), run: (a) => this.allLibrary(a) },
    };
  }

  // people.ts
  private register(args: any): unknown {
    const secretHash = hashSecret(checkSecret(args.deviceSecret));
    const cleanName = capName(args.name);
    // keep: no change; clear: remove; otherwise the new pet.
    const pet = stringOrNull(args, "pet");
    const keep = pet === null;
    const wanted = keep ? null : pet.trim().length === 0 ? null : checkPet(pet);
    const now = this.now;
    const existing = this.people.find((p) => p.secretHash === secretHash);
    if (existing) {
      const nextPet = keep ? existing.pet : wanted;
      if (existing.name !== cleanName || nextPet !== existing.pet) {
        existing.name = cleanName;
        existing.pet = nextPet;
        existing.updatedAt = now;
      }
      return { personId: existing.id, name: cleanName, pet: nextPet };
    }
    const person: Person = { id: this.newId("people"), secretHash, name: cleanName, pet: wanted, createdAt: now, updatedAt: now };
    this.people.push(person);
    return { personId: person.id, name: cleanName, pet: wanted };
  }

  // shares.ts
  private createShare(args: any): unknown {
    const person = this.requirePerson(args);
    const raw: any[] = args.titles;
    if (raw.length > 500) throw new Fail("INVALID_ARGUMENT", `A share holds at most 500 titles (got ${raw.length}).`);
    const titles = raw.map(cleanTitleCard);
    const code = this.freshCode();
    const share: ShareRow = { id: this.newId("shares"), code, ownerId: person.id, label: cap(args.label, 200), titles, createdAt: this.now };
    this.shares.push(share);
    this.claimCode(code, "share", share.id);
    return { code };
  }

  private getShare(args: any): unknown {
    const code = normalizeCode(args.code);
    if (code === null) return null;
    const share = this.shares.find((s) => s.code === code);
    if (!share) return null;
    return { code: share.code, label: share.label, ownerName: this.nameOf(share.ownerId) ?? "", titles: share.titles.slice(0, 500), createdAt: share.createdAt };
  }

  // parties.ts
  private findParty(rawCode: string): PartyRow | undefined {
    const code = normalizeCode(rawCode);
    return code === null ? undefined : this.parties.find((p) => p.code === code);
  }

  private requireParty(args: any): PartyRow {
    const party = this.findParty(args.code);
    if (!party) throw new Fail("NOT_FOUND", `No watch party with code ${String(args.code).trim()}.`);
    return party;
  }

  private partyMember(partyId: string, personId: string): MemberRow | undefined {
    return this.partyMembers.find((m) => m.partyId === partyId && m.personId === personId);
  }

  private touchMember(partyId: string, personId: string, now: number): void {
    const row = this.partyMember(partyId, personId);
    if (row) row.lastSeen = now;
    else this.partyMembers.push({ partyId, personId, joinedAt: now, lastSeen: now, order: ++this.nextId });
  }

  private partyView(party: PartyRow, now: number): unknown {
    const members = this.partyMembers
      .filter((m) => m.partyId === party.id && m.lastSeen >= now - 30_000)
      .sort((a, b) => a.lastSeen - b.lastSeen || a.order - b.order)
      .sort((a, b) => (a.personId === party.hostId ? 0 : 1) - (b.personId === party.hostId ? 0 : 1) || a.joinedAt - b.joinedAt)
      .map((m) => ({ personId: m.personId, name: this.peopleName(m.personId), lastSeen: m.lastSeen, pet: this.peoplePet(m.personId) }));
    const reactions = this.reactions
      .filter((r) => r.partyId === party.id && r.at >= now - 10_000)
      .slice(0, 40)
      .map((r) => ({ name: r.name, emoji: r.emoji, at: r.at, pet: this.peoplePet(r.personId) }));
    const messages = this.messages
      .filter((m) => m.partyId === party.id)
      .slice(-50)
      .map((m) => ({ personId: m.personId, name: m.name, pet: this.peoplePet(m.personId), text: m.text, at: m.at }));
    return {
      code: party.code,
      ended: party.ended,
      hostId: party.hostId,
      hostName: this.peopleName(party.hostId),
      hostPet: this.peoplePet(party.hostId),
      title: party.title,
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

  private createParty(args: any): unknown {
    const person = this.requirePerson(args);
    const now = this.now;
    const code = this.freshCode();
    const party: PartyRow = {
      id: this.newId("parties"),
      code,
      hostId: person.id,
      title: isObject(args.title) ? cleanTitleCard(args.title) : null,
      pageUrl: requireUrl(args.pageUrl, "pageUrl"),
      position: clamp(finite(args.position, 0), 0, 1e7),
      playing: args.playing,
      rate: clamp(finite(args.rate, 1), 0, 16),
      updatedAt: now,
      ended: false,
      createdAt: now,
    };
    this.parties.push(party);
    this.partyMembers.push({ partyId: party.id, personId: person.id, joinedAt: now, lastSeen: now, order: ++this.nextId });
    this.claimCode(code, "party", party.id);
    return { code };
  }

  private joinParty(args: any): unknown {
    const person = this.requirePerson(args);
    const party = this.requireParty(args);
    if (party.ended) throw new Fail("PARTY_ENDED", "This watch party has ended.");
    const now = this.now;
    this.touchMember(party.id, person.id, now);
    return this.partyView(party, now);
  }

  private leaveParty(args: any): unknown {
    const person = this.requirePerson(args);
    const party = this.requireParty(args);
    const row = this.partyMember(party.id, person.id);
    if (row) this.partyMembers.splice(this.partyMembers.indexOf(row), 1);
    if (party.hostId === person.id && !party.ended) {
      party.ended = true;
      party.updatedAt = this.now;
    }
    return null;
  }

  private updateParty(args: any): unknown {
    const person = this.requirePerson(args);
    const party = this.requireParty(args);
    if (party.hostId !== person.id) throw new Fail("NOT_HOST", "Only the host can control this watch party.");
    if (party.ended) throw new Fail("PARTY_ENDED", "This watch party has ended.");
    const now = this.now;
    party.position = clamp(finite(args.position, 0), 0, 1e7);
    party.playing = args.playing;
    party.rate = clamp(finite(args.rate, 1), 0, 16);
    const url = stringOrNull(args, "pageUrl");
    if (url !== null) party.pageUrl = requireUrl(url, "pageUrl");
    party.updatedAt = now;
    this.touchMember(party.id, person.id, now);
    return null;
  }

  private heartbeat(args: any): unknown {
    const person = this.requirePerson(args);
    const party = this.requireParty(args);
    if (party.ended) return null;
    const row = this.partyMember(party.id, person.id);
    if (!row) throw new Fail("NOT_MEMBER", "Join the watch party first.");
    row.lastSeen = this.now;
    return null;
  }

  private react(args: any): unknown {
    const person = this.requirePerson(args);
    const party = this.requireParty(args);
    if (party.ended) throw new Fail("PARTY_ENDED", "This watch party has ended.");
    const row = this.partyMember(party.id, person.id);
    if (!row) throw new Fail("NOT_MEMBER", "Join the watch party first.");
    const emoji = cap(args.emoji, 8);
    if (emoji.length === 0) throw new Fail("INVALID_ARGUMENT", "emoji must not be empty.");
    const now = this.now;
    row.lastSeen = now;
    this.reactions.push({ partyId: party.id, personId: person.id, name: person.name, emoji, at: now });
    const newest = this.reactions.filter((r) => r.partyId === party.id).reverse().slice(0, 70);
    for (const old of newest.slice(20)) this.reactions.splice(this.reactions.indexOf(old), 1);
    return null;
  }

  private say(args: any): unknown {
    const person = this.requirePerson(args);
    const party = this.requireParty(args);
    if (party.ended) throw new Fail("PARTY_ENDED", "This watch party has ended.");
    const row = this.partyMember(party.id, person.id);
    if (!row && party.hostId !== person.id) throw new Fail("NOT_MEMBER", "Join the watch party first.");
    const text = cap(args.text, 280);
    if (text.length === 0) throw new Fail("INVALID_ARGUMENT", "Message must not be empty.");
    const now = this.now;
    const recent = this.messages.filter((m) => m.personId === person.id && m.at > now - 5_000).length;
    if (recent >= 5) throw new Fail("INVALID_ARGUMENT", "Slow down. At most 5 messages every 5 seconds.");
    this.messages.push({ partyId: party.id, personId: person.id, name: person.name, text, at: now });
    if (row) row.lastSeen = now;
    else this.partyMembers.push({ partyId: party.id, personId: person.id, joinedAt: now, lastSeen: now, order: ++this.nextId });
    return null;
  }

  // challenges.ts
  private findChallenge(rawCode: string): ChallengeRow | undefined {
    const code = normalizeCode(rawCode);
    return code === null ? undefined : this.challenges.find((c) => c.code === code);
  }

  private requireChallenge(args: any): ChallengeRow {
    const challenge = this.findChallenge(args.code);
    if (!challenge) throw new Fail("NOT_FOUND", `No challenge with code ${String(args.code).trim()}.`);
    return challenge;
  }

  private challengeMember(challengeId: string, personId: string): ChallengeMemberRow | undefined {
    return this.challengeMembers.find((m) => m.challengeId === challengeId && m.personId === personId);
  }

  private sortedMembers(challengeId: string): ChallengeMemberRow[] {
    const byProgress = (a: ChallengeMemberRow, b: ChallengeMemberRow) => {
      if (a.fraction !== b.fraction) return b.fraction - a.fraction;
      if ((a.finishedAt === null) !== (b.finishedAt === null)) return a.finishedAt === null ? 1 : -1;
      return (a.finishedAt ?? a.progressAt) - (b.finishedAt ?? b.progressAt);
    };
    // Stable, as JavaScript's sort is.
    return this.challengeMembers.filter((m) => m.challengeId === challengeId).slice(0, 500).sort(byProgress);
  }

  private challengeView(challenge: ChallengeRow): unknown {
    return {
      code: challenge.code,
      title: challenge.title,
      totalEpisodes: challenge.totalEpisodes,
      createdAt: challenge.createdAt,
      creatorId: challenge.creatorId,
      winnerId: challenge.winnerId,
      winnerName: this.nameOf(challenge.winnerId),
      now: this.now,
      members: this.sortedMembers(challenge.id).map((m) => ({
        personId: m.personId,
        name: this.peopleName(m.personId),
        fraction: m.fraction,
        watchedEpisodes: m.watchedEpisodes,
        label: m.label,
        finishedAt: m.finishedAt,
        updatedAt: m.updatedAt,
        pet: this.peoplePet(m.personId),
      })),
    };
  }

  private newMember(challengeId: string, personId: string, now: number): ChallengeMemberRow {
    return { challengeId, personId, fraction: 0, watchedEpisodes: 0, updatedAt: now, progressAt: now, joinedAt: now, label: "", finishedAt: null };
  }

  private createChallenge(args: any): unknown {
    const person = this.requirePerson(args);
    const now = this.now;
    const code = this.freshCode();
    const challenge: ChallengeRow = {
      id: this.newId("challenges"),
      code,
      creatorId: person.id,
      title: cleanTitleCard(args.title),
      totalEpisodes: clamp(Math.trunc(finite(args.totalEpisodes, 0)), 0, 100_000),
      createdAt: now,
      winnerId: null,
      finishedAt: null,
    };
    this.challenges.push(challenge);
    this.challengeMembers.push(this.newMember(challenge.id, person.id, now));
    this.claimCode(code, "challenge", challenge.id);
    return { code };
  }

  private joinChallenge(args: any): unknown {
    const person = this.requirePerson(args);
    const challenge = this.requireChallenge(args);
    if (!this.challengeMember(challenge.id, person.id)) this.challengeMembers.push(this.newMember(challenge.id, person.id, this.now));
    return this.challengeView(challenge);
  }

  private leaveChallenge(args: any): unknown {
    const person = this.requirePerson(args);
    const challenge = this.requireChallenge(args);
    const row = this.challengeMember(challenge.id, person.id);
    if (row) this.challengeMembers.splice(this.challengeMembers.indexOf(row), 1);
    return null;
  }

  private report(args: any): unknown {
    const person = this.requirePerson(args);
    const challenge = this.requireChallenge(args);
    const now = this.now;
    let row = this.challengeMember(challenge.id, person.id);
    // Finishing is sticky.
    const finishedAt = row?.finishedAt ?? (args.finished ? now : null);
    const fraction = finishedAt !== null ? 1 : clamp(finite(args.fraction, 0), 0, 1);
    if (!row) {
      row = this.newMember(challenge.id, person.id, now);
      this.challengeMembers.push(row);
    } else if (row.fraction !== fraction) {
      row.progressAt = now;
    }
    row.fraction = fraction;
    row.watchedEpisodes = clamp(Math.trunc(finite(args.watchedEpisodes, 0)), 0, 100_000);
    row.label = cap(args.label, 200);
    row.finishedAt = finishedAt;
    row.updatedAt = now;
    if (finishedAt !== null && challenge.winnerId === null) {
      challenge.winnerId = person.id;
      challenge.finishedAt = finishedAt;
    }
    return null;
  }

  private mine(args: any): unknown {
    const person = this.requirePerson(args);
    return this.challengeMembers
      .filter((m) => m.personId === person.id)
      .slice(0, 200)
      .map((mine) => {
        const challenge = this.challenges.find((c) => c.id === mine.challengeId);
        if (!challenge) return null;
        const rows = this.sortedMembers(challenge.id);
        const leader = rows[0] ?? mine;
        return {
          createdAt: challenge.createdAt,
          item: {
            code: challenge.code,
            title: challenge.title,
            totalEpisodes: challenge.totalEpisodes,
            winnerName: this.nameOf(challenge.winnerId),
            memberCount: rows.length,
            myFraction: mine.fraction,
            leaderName: this.nameOf(leader.personId) ?? "",
            leaderFraction: leader.fraction,
          },
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((x) => x.item);
  }

  // library.ts
  private putLibrary(args: any): unknown {
    const person = this.requirePerson(args);
    const raw: any[] = args.items;
    if (raw.length > 200) throw new Fail("INVALID_ARGUMENT", `At most 200 items per call (got ${raw.length}).`);
    const now = this.now;
    const items = raw.map((item, i) => {
      const at = `items[${i}]`;
      const key = String(item.key).trim();
      if (key.length === 0 || Array.from(key).length > 160) throw new Fail("INVALID_ARGUMENT", `${at}.key must be 1 to 160 characters.`);
      const name = cap(item.name, 200);
      if (name.length === 0) throw new Fail("INVALID_ARGUMENT", `${at}.name must not be empty.`);
      let year = inNumber(item, "year");
      if (year.value !== null) year = { sent: true, value: Math.trunc(year.value) };
      let kind = inString(item, "kind");
      if (kind.value !== null) {
        const k = kind.value.trim();
        if (Array.from(k).length > 16) throw new Fail("INVALID_ARGUMENT", `${at}.kind must be at most 16 characters.`);
        kind = { sent: true, value: k.length === 0 ? null : k };
      }
      const rating = inNumber(item, "rating");
      if (rating.value !== null) {
        const r = rating.value;
        if (!(r === Math.floor(r) && r >= 1 && r <= 20)) {
          throw new Fail("INVALID_ARGUMENT", `${at}.rating must be a whole number from 1 to 20 (half-star steps), or null.`);
        }
      }
      const status = inString(item, "status");
      if (status.value !== null && !LIBRARY_STATUSES.includes(status.value)) {
        throw new Fail("INVALID_ARGUMENT", `${at}.status must be one of none, backlog, watching, watched, or null.`);
      }
      return {
        key,
        name,
        year,
        kind,
        rating,
        ratedAt: time(inNumber(item, "ratedAt"), `${at}.ratedAt`, now, true),
        status,
        statusAt: time(inNumber(item, "statusAt"), `${at}.statusAt`, now, true),
        finishedAt: time(inNumber(item, "finishedAt"), `${at}.finishedAt`, now, false),
      };
    });

    for (const item of items) {
      const row = this.library.find((r) => r.personId === person.id && r.fields.key === item.key);
      const s = row?.fields;
      let fields: Required<LibraryFields> = {
        key: item.key,
        name: item.name,
        year: mergeField(item.year, s?.year ?? null),
        kind: mergeField(item.kind, s?.kind ?? null),
        finishedAt: mergeField(item.finishedAt, s?.finishedAt ?? null),
        rating: s?.rating ?? null,
        ratedAt: s?.ratedAt ?? null,
        status: s?.status ?? null,
        statusAt: s?.statusAt ?? null,
      };
      if (item.rating.sent && newerOrSame(item.ratedAt.value, s?.ratedAt ?? null)) {
        fields = { ...fields, rating: item.rating.value, ratedAt: item.ratedAt.value };
      }
      if (item.status.sent && newerOrSame(item.statusAt.value, s?.statusAt ?? null)) {
        fields = { ...fields, status: item.status.value, statusAt: item.statusAt.value };
      }
      if (!row) this.library.push({ personId: person.id, fields, updatedAt: now });
      else if (!sameFields(row.fields, fields)) {
        row.fields = fields;
        row.updatedAt = now;
      }
    }
    return { saved: items.length };
  }

  private allLibrary(args: any): unknown {
    const person = this.requirePerson(args);
    return this.library
      .filter((r) => r.personId === person.id)
      .sort((a, b) => (a.fields.key < b.fields.key ? -1 : a.fields.key > b.fields.key ? 1 : 0))
      .map((r) => ({ ...r.fields, updatedAt: r.updatedAt }));
  }
}

function error(message: string): string {
  return `{"status":"error","errorMessage":${convexJson("[Request ID: fake] Server Error\n" + message + "\n")}}`;
}
