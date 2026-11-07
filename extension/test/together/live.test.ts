// Port of windows/Cineon.Core.Tests/Together/TogetherLiveTests.cs. Against the real dev deployment,
// only with CINEON_TOGETHER_LIVE=1. Never the production URL. It leaves a throwaway person, a one-title
// share and an ended party behind on dev.

import {
  ChallengeSummary,
  CodeKind,
  CodeReply,
  PartyState,
  Registered,
  ShareCode,
  ShareInfo,
  TitleCard,
  TogetherClient,
  TogetherError,
  TogetherIdentity,
} from "../../src/core/together";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

test.skipIf(env.CINEON_TOGETHER_LIVE !== "1")("the dev deployment answers like the fake", async () => {
  const url = TogetherClient.DEVELOPMENT_URL;
  expect(url).not.toContain("admired-mouse");
  const client = new TogetherClient(url);
  const secret = TogetherIdentity.newSecret();

  const me = await client.mutation("people:register", { deviceSecret: secret, name: "Cineon extension test", pet: "" }, Registered.fromJson);
  expect(me.personId).not.toBe("");

  const share = await client.mutation(
    "shares:create",
    { deviceSecret: secret, label: "Live test", titles: [TitleCard.toJson(TitleCard.make("Heat", 1995, "film", "tt0113277"))] },
    CodeReply.fromJson,
  );
  expect((await client.query("codes:resolve", { code: ShareCode.display(share.code) }, CodeKind.fromJsonOrNull))!.kind).toBe("share");
  const shared = await client.query("shares:get", { code: share.code }, ShareInfo.fromJsonOrNull);
  expect(shared!.titles[0]!.year).toBe(1995);
  expect(shared!.ownerName).toBe("Cineon extension test");

  const party = await client.mutation(
    "parties:create",
    { deviceSecret: secret, pageUrl: "https://example.com/film", position: 12.5, playing: true, rate: 1.0 },
    CodeReply.fromJson,
  );
  const state = await client.query("parties:get", { code: party.code, t: Date.now() }, PartyState.fromJsonOrNull);
  expect(state!.hostId).toBe(me.personId);
  expect(PartyState.expectedPosition(state!)).toBeGreaterThanOrEqual(12.5);
  await client.mutation("parties:say", { deviceSecret: secret, code: party.code, text: "hello" });
  await client.mutation("parties:leave", { deviceSecret: secret, code: party.code });
  const ended = await client.mutation("parties:react", { deviceSecret: secret, code: party.code, emoji: "🎉" }).catch((e: unknown) => e);
  expect(ended).toBeInstanceOf(TogetherError);
  expect((ended as TogetherError).code).toBe("PARTY_ENDED");

  const unknown = await client
    .query("challenges:mine", { deviceSecret: TogetherIdentity.newSecret() }, ChallengeSummary.listFromJson)
    .catch((e: unknown) => e);
  expect((unknown as TogetherError).code).toBe("UNKNOWN_DEVICE");
}, 60_000);
