// Port of windows/Cineon.Core.Tests/Together/TogetherIdentityTests.cs. The identity is the text of the
// apps' together.json, kept in an IdentityStore instead of a file.

import { TogetherIdentity, memoryIdentityStore, type IdentityStore } from "../../src/core/together";

/** What Swift's JSONEncoder writes for TogetherIdentity: slashes escaped, keys in any order. */
const MAC_FILE =
  '{"pet":"p1-Ab3_x9","openedShares":["K7Q2MX","ABCDEF"],"personId":"jd7f2k9q1x8w3m4n5b6v7c8x9z0a1s2d","name":"Oleh","secret":"q8Hk2v\\/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu="}';

function decodedLength(base64: string): number {
  return atob(base64).length;
}

test("a new profile gets a secret and keeps it", async () => {
  const store = memoryIdentityStore();
  const created = await TogetherIdentity.load(store, "Oleh");
  expect(created.secret).toHaveLength(44);
  expect(decodedLength(created.secret)).toBe(32);
  expect(TogetherIdentity.isStrictBase64(created.secret)).toBe(true);
  expect(created.name).toBe("Oleh");
  expect(created.personId).toBeNull();
  expect(store.text).not.toBeNull();

  const again = await TogetherIdentity.load(store, "Someone else");
  expect(again.secret).toBe(created.secret);
  expect(again.name).toBe("Oleh");
  expect((await TogetherIdentity.load(memoryIdentityStore(), "Oleh")).secret).not.toBe(created.secret);
});

test("everything round-trips", async () => {
  const store = memoryIdentityStore();
  const identity = await TogetherIdentity.load(store, "Oleh");
  identity.personId = "people0001";
  identity.openedShares = ["K7Q2MX", "ABCDEF"];
  identity.partyCode = "PARTY2";
  identity.pet = "p1-Ab3_x9";
  await identity.save(store);

  const loaded = await TogetherIdentity.load(store, "ignored");
  expect(loaded.secret).toBe(identity.secret);
  expect(loaded.personId).toBe("people0001");
  expect(loaded.openedShares).toEqual(["K7Q2MX", "ABCDEF"]);
  expect(loaded.partyCode).toBe("PARTY2");
  expect(loaded.pet).toBe("p1-Ab3_x9");
});

test("a file from a Mac loads", async () => {
  const store = memoryIdentityStore(MAC_FILE);
  const identity = await TogetherIdentity.load(store, "Someone else");
  expect(identity.secret).toBe("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=");
  expect(identity.name).toBe("Oleh");
  expect(identity.personId).toBe("jd7f2k9q1x8w3m4n5b6v7c8x9z0a1s2d");
  expect(identity.openedShares).toEqual(["K7Q2MX", "ABCDEF"]);
  expect(identity.partyCode).toBeNull();
  expect(identity.pet).toBe("p1-Ab3_x9");
  // Loading doesn't rewrite it.
  expect(store.text).toBe(MAC_FILE);
  expect(store.writes).toBe(0);
});

test("what the extension writes is what the Mac reads", () => {
  const identity = new TogetherIdentity();
  identity.secret = "a+b/c=";
  identity.name = "Оля";
  // Absent optionals are left out; openedShares is always there, since Swift's decoder requires it.
  expect(identity.encode()).toBe('{"secret":"a+b/c=","name":"Оля","openedShares":[]}');
  expect("personId" in JSON.parse(identity.encode())).toBe(false);
});

test("a missing share list is forgiven but a missing secret is not", async () => {
  const store = memoryIdentityStore('{"secret":"q8Hk2v\\/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=","name":"Oleh"}');
  expect((await TogetherIdentity.load(store, "x")).secret).toBe("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=");

  // Like the Mac, an identity that can't be read is replaced with a new one.
  store.text = '{"name":"Oleh"}';
  const replaced = await TogetherIdentity.load(store, "Oleh");
  expect(replaced.secret).toHaveLength(44);
  expect((await TogetherIdentity.load(store, "Oleh")).secret).toBe(replaced.secret);

  store.text = "not json";
  expect((await TogetherIdentity.load(store, "Oleh")).secret).toHaveLength(44);

  // A field of the wrong type is a file the Mac couldn't read either.
  store.text = '{"secret":"abc","name":"Oleh","personId":5}';
  expect((await TogetherIdentity.load(store, "Oleh")).secret).toHaveLength(44);
});

test("storage that fails to read gets a new identity, and failed writes are dropped", async () => {
  const broken: IdentityStore = {
    read: () => Promise.reject(new Error("storage is gone")),
    write: () => Promise.reject(new Error("storage is gone")),
  };
  const identity = await TogetherIdentity.load(broken, "Oleh");
  expect(identity.secret).toHaveLength(44);
  await expect(identity.save(broken)).resolves.toBeUndefined();
});

test.each([
  ["q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=", true],
  ["q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTuv", true],
  ["q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsT==", true],
  ["q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu", false],
  ["q8Hk2v/9+Zr1tYpQe3LmN0aBcDe gHiJkLmNoPqRsTu=", false],
  ["q8Hk2v_9-Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=", false],
  ["q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqR=sTu", false],
])("recovery code %s is strict base64: %s", (code, valid) => {
  expect(TogetherIdentity.isStrictBase64(code)).toBe(valid);
});
