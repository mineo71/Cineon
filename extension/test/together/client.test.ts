// Port of windows/Cineon.Core.Tests/Together/TogetherClientTests.cs.

import {
  ChallengeSummary,
  CodeKind,
  CodeReply,
  DecodeError,
  PartyState,
  Registered,
  ShareCode,
  ShareInfo,
  TitleCard,
  TogetherClient,
  TogetherError,
  errorCodeFromRaw,
  type Fetch,
  type TogetherErrorCode,
  type TogetherTitle,
} from "../../src/core/together";
import { FakeConvex } from "./fakeConvex";
import { ManualClock, blockNetwork } from "./rig";

blockNetwork();

const SECRET = "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I=";

let clock: ManualClock;
let server: FakeConvex;
let client: TogetherClient;

beforeEach(() => {
  clock = new ManualClock(Date.UTC(2026, 10, 6, 20, 0, 0));
  server = new FakeConvex(clock);
  client = new TogetherClient("https://fake-deployment.convex.cloud/", { fetch: server.fetch });
});

function register(name = "Oleh", secret = SECRET): Promise<Registered> {
  return client.mutation("people:register", { deviceSecret: secret, name, pet: "" }, Registered.fromJson);
}

async function thrown(promise: Promise<unknown>): Promise<TogetherError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(TogetherError);
    return e as TogetherError;
  }
  throw new Error("Expected a TogetherError");
}

/** A server that answers every call with the same body, and remembers what it was sent. */
function canned(body: string) {
  const seen = { body: null as string | null, contentType: null as string | null };
  const fetch: Fetch = async (_url, init) => {
    seen.body = init.body;
    seen.contentType = init.headers["Content-Type"] ?? null;
    return { text: async () => body };
  };
  return { fetch, seen };
}

// MARK: Codes and positions

test("codes are typed any way", () => {
  expect(ShareCode.normalize(" k7q-2mx ")).toBe("K7Q2MX");
  expect(ShareCode.display("k7q2mx")).toBe("K7Q-2MX");
  expect(ShareCode.display("k7q-2m")).toBe("K7Q2M");
  // Swift upper-cases ß to SS, and so does JavaScript.
  expect(ShareCode.normalize("ß")).toBe("SS");
});

test("a party's position moves on while playing", () => {
  const state: PartyState = {
    code: "ABCDEF",
    ended: false,
    hostId: "h",
    hostName: "Host",
    title: null,
    pageUrl: "",
    playing: true,
    position: 100,
    rate: 1.5,
    updatedAt: 1_000,
    now: 5_000,
    members: [],
    reactions: [],
    messages: [],
    hostPet: null,
  };
  expect(PartyState.expectedPosition(state)).toBeCloseTo(106, 3);
  expect(PartyState.expectedPosition({ ...state, playing: false })).toBeCloseTo(100, 3);
  // The server's clock running behind the last update never moves the film backwards.
  expect(PartyState.expectedPosition({ ...state, now: 500 })).toBeCloseTo(100, 3);
});

// MARK: The HTTP API

test("calls go to Convex's HTTP API as JSON", async () => {
  const reply = await register();
  expect(reply.personId.startsWith("people")).toBe(true);
  expect(reply.name).toBe("Oleh");

  const resolved = await client.query("codes:resolve", { code: "K7Q-2MX" }, CodeKind.fromJsonOrNull);
  expect(resolved).toBeNull();

  const calls = server.calls;
  expect(calls[0]!.kind).toBe("mutation");
  expect(calls[0]!.url).toBe("https://fake-deployment.convex.cloud/api/mutation");
  expect(calls[1]!.kind).toBe("query");
  expect(calls[1]!.url).toBe("https://fake-deployment.convex.cloud/api/query");
  expect(calls[1]!.args.code).toBe("K7Q-2MX");
});

test("the endpoint keeps one slash whatever the base", () => {
  expect(new TogetherClient("https://x.convex.cloud").endpoint("query")).toBe("https://x.convex.cloud/api/query");
  expect(new TogetherClient("https://x.convex.cloud/").endpoint("query")).toBe("https://x.convex.cloud/api/query");
  expect(new TogetherClient("http://localhost:3210/base").endpoint("mutation")).toBe("http://localhost:3210/base/api/mutation");
});

test("configured prefers the override and wants http", () => {
  expect(TogetherClient.configured("https://env.example", TogetherClient.DEVELOPMENT_URL)!.baseUrl).toBe("https://env.example");
  expect(TogetherClient.configured(null, TogetherClient.DEVELOPMENT_URL)!.baseUrl).toBe(TogetherClient.DEVELOPMENT_URL);
  // Without a build URL, production: what people install.
  expect(TogetherClient.configured(undefined)!.baseUrl).toBe(TogetherClient.PRODUCTION_URL);
  expect(TogetherClient.PRODUCTION_URL).toBe("https://admired-mouse-481.eu-west-1.convex.cloud");
  // Set but empty switches Together off, as on the Mac.
  expect(TogetherClient.configured("", TogetherClient.DEVELOPMENT_URL)).toBeNull();
  expect(TogetherClient.configured(null, null)).toBeNull();
  expect(TogetherClient.configured("ftp://example.com", null)).toBeNull();
  expect(TogetherClient.configured("not a url", null)).toBeNull();
  expect(TogetherClient.configured("http://localhost:3210", null)!.baseUrl).toBe("http://localhost:3210");
});

test("numbers come back as floats", async () => {
  await register();
  const card = { ...TitleCard.make("Heat", 1995, "film", "tt0113277"), rating: 17, status: "watched" };
  const created = await client.mutation(
    "shares:create",
    { deviceSecret: SECRET, label: "One", titles: [TitleCard.toJson(card)] },
    CodeReply.fromJson,
  );
  // The raw reply has 1995.0; the card reads it as a whole number.
  let raw = "";
  const spy: Fetch = async (url, init) => {
    const reply = await server.fetch(url, init);
    raw = await reply.text();
    return { text: async () => raw };
  };
  await new TogetherClient("https://fake-deployment.convex.cloud", { fetch: spy }).queryRaw("shares:get", { code: created.code });
  expect(raw).toContain("1995.0");
  const share = await client.query("shares:get", { code: created.code }, ShareInfo.fromJsonOrNull);
  expect(share!.titles).toHaveLength(1);
  const got = share!.titles[0]!;
  expect(got.year).toBe(1995);
  expect(got.rating).toBe(17);
  expect(TitleCard.titleKind(got)).toBe("film");
  expect(share!.ownerName).toBe("Oleh");
  expect(share!.label).toBe("One");
});

test.each<[string, TogetherErrorCode | null]>([
  ["INVALID_ARGUMENT", "INVALID_ARGUMENT"],
  ["UNKNOWN_DEVICE", "UNKNOWN_DEVICE"],
  ["NOT_FOUND", "NOT_FOUND"],
  ["NOT_MEMBER", "NOT_MEMBER"],
  ["NOT_HOST", "NOT_HOST"],
  ["PARTY_ENDED", "PARTY_ENDED"],
  ["SOMETHING_NEW", null],
])("error code %s maps", (raw, code) => {
  expect(errorCodeFromRaw(raw)).toBe(code);
});

test("server errors carry their sentence and code", async () => {
  const unknown = await thrown(client.query("challenges:mine", { deviceSecret: SECRET }, ChallengeSummary.listFromJson));
  expect(unknown.message).toBe("Unknown device. Call people:register first.");
  expect(unknown.code).toBe("UNKNOWN_DEVICE");
  expect(unknown.rawCode).toBe("UNKNOWN_DEVICE");

  const invalid = await thrown(register("Oleh", "short"));
  expect(invalid.message).toBe("deviceSecret must be 16 to 256 characters (32 random bytes, base64).");
  expect(invalid.code).toBe("INVALID_ARGUMENT");

  await register();
  const missing = await thrown(client.mutation("parties:join", { deviceSecret: SECRET, code: "abc-def" }, PartyState.fromJson));
  expect(missing.code).toBe("NOT_FOUND");
  expect(missing.message).toBe("No watch party with code abc-def.");
  expect(missing.isTransport).toBe(false);
});

test("errors without data keep the sentence for people", async () => {
  // Convex's own text around a plain `throw new Error(...)`.
  server.intercept = () =>
    '{"status":"error","errorMessage":"[Request ID: 1] Server Error\\nUncaught Error: Could not allocate a unique code.\\n    at freshCode (../convex/lib.ts:1:0)\\n"}';
  const e = await thrown(client.queryRaw("codes:resolve", { code: "x" }));
  expect(e.message).toBe("Could not allocate a unique code.");
  expect(e.code).toBeNull();

  // Anything else: its first line.
  server.intercept = null;
  expect((await thrown(client.queryRaw("nope:nope", {}))).message).toBe("[Request ID: fake] Server Error");

  // A query sent as a mutation, and arguments the validator refuses.
  expect((await thrown(client.mutation("codes:resolve", { code: "x" }))).message).toBe("[Request ID: fake] Server Error");
  expect((await thrown(client.queryRaw("codes:resolve", { code: "x", t: 1.0 }))).message).toBe("[Request ID: fake] Server Error");
});

test.each([
  ["Uncaught Error: Boom\n    at x", "Boom"],
  ["prefix Uncaught Error: Boom    at handler (x.ts:1)", "Boom"],
  ["Uncaught Error: \nSecond line", "Second line"],
  ["\nFirst real line\nsecond", "First real line"],
  ["Plain", "Plain"],
  ["", ""],
])("clean keeps one sentence of %j", (raw, clean) => {
  expect(TogetherClient.clean(raw)).toBe(clean);
});

test("clean with nothing says the server didn't answer", () => {
  expect(TogetherClient.clean(null)).toBe("The Together server didn't answer");
});

test("odd replies are errors people can read", async () => {
  server.intercept = () => "[1,2]";
  expect((await thrown(client.queryRaw("codes:resolve", { code: "x" }))).message).toBe("The Together server sent something unexpected");

  server.intercept = () => "<html>";
  expect((await thrown(client.queryRaw("codes:resolve", { code: "x" }))).message).toBe("The Together server sent something unexpected");

  server.intercept = () => '{"status":"error"}';
  expect((await thrown(client.queryRaw("codes:resolve", { code: "x" }))).message).toBe("The Together server didn't answer");

  // A value of the wrong shape: Swift's DecodingError text.
  server.intercept = () => '{"status":"success","value":{"code":5}}';
  const bad = await thrown(client.mutation("shares:create", {}, CodeReply.fromJson));
  expect(bad.message).toBe("The data couldn't be read because it isn't in the correct format.");
  expect(bad.cause).toBeInstanceOf(DecodeError);

  server.intercept = null;
  server.offline = true;
  const offline = await thrown(client.queryRaw("codes:resolve", { code: "x" }));
  expect(offline.isTransport).toBe(true);
  expect(offline.message).toBe("The Internet connection appears to be offline.");
});

test("a silent server times out", async () => {
  const silent: Fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
  const impatient = new TogetherClient("https://x.convex.cloud", { fetch: silent, timeoutMs: 50 });
  const e = await thrown(impatient.queryRaw("codes:resolve", { code: "x" }));
  expect(e.message).toBe("The request timed out.");
  expect(e.isTransport).toBe(true);

  // Cancelling isn't a timeout: it stays a cancellation.
  const patient = new TogetherClient("https://x.convex.cloud", { fetch: silent });
  const cancel = new AbortController();
  const call = patient.queryRaw("codes:resolve", { code: "x" }, cancel.signal);
  cancel.abort();
  await expect(call).rejects.not.toBeInstanceOf(TogetherError);
  await expect(call).rejects.toHaveProperty("name", "AbortError");
});

test("the status line doesn't matter, only the body", async () => {
  const { fetch } = canned('{"status":"success","value":{"kind":"party"}}');
  const c = new TogetherClient("https://x.convex.cloud", { fetch });
  expect((await c.query("codes:resolve", { code: "x" }, CodeKind.fromJsonOrNull))!.kind).toBe("party");
});

test("arguments are written as the Mac writes them", async () => {
  const { fetch, seen } = canned('{"status":"success","value":null}');
  const c = new TogetherClient("https://x.convex.cloud", { fetch });
  await c.mutation("library:put", {
    deviceSecret: "a+b/c=",
    items: [{ rating: null, year: 1995, ratedAt: 1762459200123.0, position: 12.5 }],
  });
  expect(seen.body).toBe(
    '{"path":"library:put","args":{"deviceSecret":"a+b/c=","items":[{"rating":null,"year":1995,"ratedAt":1762459200123,"position":12.5}]},"format":"json"}',
  );
  expect(seen.contentType).toBe("application/json");

  // Numbers JSON can't hold never leave.
  const e = await thrown(c.mutation("parties:update", { position: Number.NaN }));
  expect(e.message).toBe("Invalid number in the request");
});

test("PartyState reads older servers and missing pieces", () => {
  // Before chat and pets: no messages, no hostPet.
  const old = JSON.parse(`{"code":"ABCDEF","ended":false,"hostId":"h","hostName":"Ann","title":null,"pageUrl":"https://example.com/film",
    "playing":true,"position":12.0,"rate":1.0,"updatedAt":1000.0,"now":2000.0,
    "members":[{"personId":"h","name":"Ann","lastSeen":1000.0}],"reactions":[]}`);
  const state = PartyState.fromJson(old);
  expect(state.messages).toEqual([]);
  expect(state.hostPet).toBeNull();
  expect(state.title).toBeNull();
  expect(state.members).toHaveLength(1);
  expect(state.members[0]!.pet).toBeNull();

  // A required field missing fails, as Swift's decoder does.
  expect(() => PartyState.fromJson({ code: "ABCDEF", ended: false })).toThrow(DecodeError);

  // Fields the Mac reads with `try?` fall back instead of failing.
  const card = TitleCard.fromJson({ name: "Heat", year: "1995", kind: 7, rating: "x" });
  expect(card.year).toBeNull();
  expect(card.kind).toBe("unknown");
  expect(card.rating).toBeNull();
});

test("title cards go out without empty fields", () => {
  const title: TogetherTitle = {
    id: 1,
    name: "Heat",
    normName: "heat",
    year: 1995,
    kind: "film",
    status: "none",
    imdbId: null,
    posterUrl: "https://img.example/heat%20poster.jpg",
    ratingHalves: 15,
    updatedAt: 0,
    ratedAt: null,
    statusAt: null,
    finishedAt: null,
  };
  const json = TitleCard.toJson(TitleCard.from(title));
  expect(Object.keys(json)).toEqual(["name", "kind", "year", "posterUrl", "rating"]);
  expect(json.posterUrl).toBe("https://img.example/heat%20poster.jpg");
  expect(TitleCard.toJson(TitleCard.from({ ...title, status: "watched" })).status).toBe("watched");
});
