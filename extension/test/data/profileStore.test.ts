// Port of windows/Cineon.Core.Tests/Data/ProfileStoreTests.cs, with extension storage in place of
// profiles.json.

import { Database, MemoryStorage, ProfileStore, StoredDate } from "../../src/core/data";
import { makeTitle } from "./helpers";

// The shape the Mac writes: dates in seconds since 2001, escaped slashes, absent optionals left out.
const MAC_PROFILES = String.raw`{"askOnLaunch":true,"lastUsedID":"8415E693-96B8-40B2-9390-CDB1317C6598","profiles":[{"id":"190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D","createdAt":815607320.735974,"name":"Guest","lastPosterURL":"https:\/\/m.media-amazon.com\/images\/M\/MV5BMTQ5OTgzOTczM15BMl5BanBnXkFtZTcwMDM2OTY4MQ@@._V1_QL75_UX500_.jpg"},{"id":"8415E693-96B8-40B2-9390-CDB1317C6598","createdAt":815607454.151418,"name":"Кіно"}]}`;

const KEY = ProfileStore.storageKey;

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

test("the first run makes one profile", async () => {
  const store = await ProfileStore.open({ storage, defaultName: "oleh petrenko" });
  expect(store.profiles).toHaveLength(1);
  const only = store.profiles[0]!;
  expect(store.lastUsedId).toBe(only.id);
  expect(store.askOnLaunch).toBe(false);
  expect(only.name).toBe("Oleh");
  expect(only.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  expect(storage.values.has(KEY)).toBe(true);

  const again = await ProfileStore.open({ storage });
  expect(again.profiles).toHaveLength(1);
  expect({ ...again.profiles[0]!, createdAt: only.createdAt }).toEqual(only);
  expect(Math.abs(again.profiles[0]!.createdAt - only.createdAt)).toBeLessThan(0.001);
});

test("with no name to go by, the first person is Me", async () => {
  const store = await ProfileStore.open({ storage });
  expect(store.profiles[0]!.name).toBe("Me");
});

test("reads the Mac's profiles file", async () => {
  await storage.set(KEY, JSON.parse(MAC_PROFILES));
  const store = await ProfileStore.open({ storage });
  expect(store.profiles).toHaveLength(2);
  expect(store.askOnLaunch).toBe(true);
  expect(store.lastUsedId).toBe("8415E693-96B8-40B2-9390-CDB1317C6598");
  expect(store.lastUsed.name).toBe("Кіно");
  const guest = store.profiles[0]!;
  expect(guest.name).toBe("Guest");
  expect(StoredDate.toReference(guest.createdAt)).toBeCloseTo(815607320.735974, 5);
  expect(StoredDate.iso8601(guest.createdAt)).toBe("2026-11-05T21:35:20Z");
  expect(guest.lastPosterUrl).toBe(
    "https://m.media-amazon.com/images/M/MV5BMTQ5OTgzOTczM15BMl5BanBnXkFtZTcwMDM2OTY4MQ@@._V1_QL75_UX500_.jpg",
  );
  expect(store.profiles[1]!.lastPosterUrl).toBeNull();
  // The file's text works as well as the object.
  expect(ProfileStore.decode(MAC_PROFILES)?.profiles).toHaveLength(2);
});

test("writes the Mac's shape", async () => {
  await storage.set(KEY, JSON.parse(MAC_PROFILES));
  const store = await ProfileStore.open({ storage });
  await store.rename(store.profiles[0]!.id, "Guest");
  await store.markUsed(store.profiles[0]!.id.toLowerCase());

  const root = (await storage.get(KEY)) as Record<string, unknown>;
  expect(Object.keys(root)).toEqual(["profiles", "lastUsedID", "askOnLaunch"]);
  expect(root.lastUsedID).toBe("190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D");
  expect(root.askOnLaunch).toBe(true);
  const [guest, second] = root.profiles as Record<string, unknown>[];
  expect(Object.keys(guest!)).toEqual(["id", "name", "createdAt", "lastPosterURL"]);
  // Not moved by a bit on the way through.
  expect(JSON.stringify(root)).toContain(`"createdAt":815607320.735974`);
  expect(JSON.stringify(root)).toContain(`"createdAt":815607454.151418`);
  expect("lastPosterURL" in second!).toBe(false);
  expect(second!.name).toBe("Кіно");

  // And the Mac's strict reading accepts what was written.
  expect(ProfileStore.decode(root)).not.toBeNull();
  expect(ProfileStore.decode(ProfileStore.encodeJson(store.profiles, store.lastUsedId, store.askOnLaunch))).not.toBeNull();
});

test("adding a second person asks who is watching", async () => {
  const store = await ProfileStore.open({ storage });
  const first = store.profiles[0]!;
  const changes: string[] = [];
  store.changed.on((keys) => changes.push(...keys));
  const guest = await store.add("Guest");
  expect(store.askOnLaunch).toBe(true);
  await store.setAskOnLaunch(false);
  await store.add("Third");
  expect(store.askOnLaunch).toBe(false);
  expect(changes).toContain("profiles");

  await store.rename(guest.id, "Visitor");
  await store.setPoster(guest.id, "https://img.example/p.jpg");
  const reloaded = await ProfileStore.open({ storage });
  expect(reloaded.profiles.slice(1).map((p) => p.name)).toEqual(["Visitor", "Third"]);
  expect(reloaded.profiles[1]!.lastPosterUrl).toBe("https://img.example/p.jpg");
  expect(reloaded.askOnLaunch).toBe(false);
  expect(reloaded.lastUsedId).toBe(first.id);
});

test("deleting removes the person's data but never the last person", async () => {
  const store = await ProfileStore.open({ storage });
  const first = store.profiles[0]!;
  const guest = await store.add("Guest");
  expect(store.databaseName(guest.id)).toBe(`cineon-${guest.id}`);
  const db = await Database.openProfile(guest.id);
  await db.insertTitle(makeTitle("Theirs"));

  await store.markUsed(guest.id);
  await store.delete(guest.id);
  // Their database went (and this open connection was let go).
  const reopened = await Database.openProfile(guest.id);
  expect(await reopened.allTitles()).toEqual([]);
  reopened.close();
  expect(store.lastUsedId).toBe(first.id);
  await store.delete(first.id);
  expect(store.profiles).toHaveLength(1);
});

test("deleting uses the given clean-up", async () => {
  const removed: string[] = [];
  const store = await ProfileStore.open({ storage, deleteProfileData: async (id) => void removed.push(id) });
  const guest = await store.add("Guest");
  await store.delete(guest.id.toLowerCase());
  expect(removed).toEqual([guest.id]);
});

test.each([
  "",
  "{}",
  `{"profiles":[],"askOnLaunch":false}`,
  `{"profiles":[{"id":"nope","name":"A","createdAt":1}],"askOnLaunch":false}`,
  `{"profiles":[{"id":"190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D","name":"A","createdAt":1}]}`,
])("an unreadable list starts over: %s", async (json) => {
  await storage.set(KEY, json);
  const store = await ProfileStore.open({ storage });
  expect(store.profiles).toHaveLength(1);
  expect(store.profiles[0]!.name).not.toBe("A");
});

test("decode is as strict as Swift", () => {
  const lower = ProfileStore.decode(
    `{"profiles":[{"id":"190b6f43-16f2-4ee1-8e5c-7ddf3d54ab0d","name":"A","createdAt":1}],"askOnLaunch":false}`,
  );
  expect(lower?.profiles[0]!.id).toBe("190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D");
  expect(
    ProfileStore.decode(`{"profiles":[{"id":"190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D","name":"A","createdAt":"1"}],"askOnLaunch":false}`),
  ).toBeNull();
  expect(
    ProfileStore.decode(
      `{"profiles":[{"id":"190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D","name":"A","createdAt":1,"lastPosterURL":""}],"askOnLaunch":false}`,
    ),
  ).toBeNull();
  expect(ProfileStore.decode(`{"profiles":[],"askOnLaunch":false,"lastUsedID":"nope"}`)).toBeNull();
});
