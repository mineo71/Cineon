// The settings cases from windows/Cineon.Core.Tests/Data/ModelsTests.cs and DatabaseTests.cs.

import { AppSettings } from "../../src/core/data";
import { freshDatabase } from "./helpers";

test("settings written by the Mac load", () => {
  const mac = String.raw`{"hibernateMinutes":20,"sidebarWidth":300,"playNextDownload":true,"redirectShield":true,"pauseOtherTabs":true,"fetchMetadata":true,"theme":"white","launchAnimation":true,"downloadsFolder":"\/Volumes\/Films","popupShield":true,"autoResume":true,"enabledLists":["ublock","easylist"],"voiceBoost":true,"binWatchedDownloads":true,"autoNextEpisode":true,"captionStyle":"huge","cloudBackup":true,"downloadShield":true,"learnSkips":true,"ambientStrength":0.3,"showDownloadButton":true,"newEpisodeAlerts":true,"sidebarHidden":false,"finishThreshold":0.92,"searchEngine":"kagi","keepFrames":true,"overlaySweeper":true,"ambientLight":true,"saveBrowsingHistory":true,"networkBlocking":true,"minimumSecondsToTrack":5,"autoRescue":true,"sharePet":true}`;
  const settings = AppSettings.decode(mac)!;
  expect(settings).not.toBeNull();
  expect(settings.theme).toBe("white");
  expect(settings.sidebarWidth).toBe(300);
  expect(settings.downloadsFolder).toBe("/Volumes/Films");
  expect(new Set(settings.enabledLists)).toEqual(new Set(["ublock", "easylist"]));
  expect(settings.voiceBoost).toBe(true);
  expect(settings.captionStyle).toBe("huge");
  expect(settings.searchEngine).toBe("kagi");
  expect(settings.ambientStrength).toBe(0.3);
  expect(settings.minimumSecondsToTrack).toBe(5);
  // The same bytes, as the database's BLOB would hold them.
  expect(AppSettings.decode(new TextEncoder().encode(mac))).toEqual(settings);
});

test("bad settings fall back one by one", () => {
  const settings = AppSettings.decode(
    `{"theme":"purple","ambientLight":1,"sidebarWidth":"wide","enabledLists":["a",2],"searchEngine":"google","keepFrames":false}`,
  );
  expect(settings).toEqual(AppSettings.make({ searchEngine: "google", keepFrames: false }));
  expect(AppSettings.decode("[1,2]")).toBeNull();
  expect(AppSettings.decode("not json")).toBeNull();
  expect(AppSettings.decode("")).toBeNull();
  expect(AppSettings.decode(new Uint8Array())).toBeNull();
  expect(AppSettings.decode(`{"ambientStrength":1e400}`)!.ambientStrength).toBe(0.55);
});

test("settings round trip with the Mac's keys", () => {
  const settings = AppSettings.make({
    theme: "white",
    ambientStrength: 0.4,
    enabledLists: ["easylist"],
    downloadsFolder: "D:\\Films",
    captionStyle: "large",
    searchEngine: "brave",
    cloudBackup: false,
  });
  const json = AppSettings.encode(settings);
  expect(AppSettings.equals(AppSettings.decode(json)!, settings)).toBe(true);
  expect(AppSettings.decode(json)).toEqual(settings);

  const keys = Object.keys(JSON.parse(json)).sort();
  const macKeys = [
    "ambientLight", "ambientStrength", "autoNextEpisode", "autoRescue", "autoResume", "binWatchedDownloads", "captionStyle",
    "cloudBackup", "downloadShield", "downloadsFolder", "enabledLists", "fetchMetadata", "finishThreshold", "hibernateMinutes",
    "keepFrames", "launchAnimation", "learnSkips", "minimumSecondsToTrack", "networkBlocking", "newEpisodeAlerts",
    "overlaySweeper", "pauseOtherTabs", "playNextDownload", "popupShield", "redirectShield", "saveBrowsingHistory",
    "searchEngine", "sharePet", "showDownloadButton", "sidebarHidden", "sidebarWidth", "theme", "voiceBoost",
  ];
  expect(keys).toEqual(macKeys);
  expect(AppSettings.keys).toHaveLength(33);
  expect(AppSettings.encode(AppSettings.defaults())).toContain(`"sidebarWidth":252`);
  expect(AppSettings.encode(AppSettings.defaults())).toContain(`"ambientStrength":0.55`);
});

test("default settings match the Mac", () => {
  const s = AppSettings.defaults();
  expect([s.theme, s.ambientLight, s.ambientStrength, s.launchAnimation, s.sidebarWidth, s.sidebarHidden]).toEqual([
    "dark", true, 0.55, true, 252, false,
  ]);
  expect([
    s.autoResume, s.finishThreshold, s.minimumSecondsToTrack, s.hibernateMinutes, s.pauseOtherTabs, s.autoRescue, s.learnSkips,
    s.autoNextEpisode, s.keepFrames,
  ]).toEqual([true, 0.92, 15, 20, true, true, true, true, true]);
  expect([s.networkBlocking, s.popupShield, s.redirectShield, s.overlaySweeper, s.downloadShield]).toEqual([
    true, true, true, true, true,
  ]);
  expect(new Set(s.enabledLists)).toEqual(new Set(["easylist", "easyprivacy", "ublock", "peterlowe", "cineon-streaming"]));
  expect([s.fetchMetadata, s.saveBrowsingHistory, s.searchEngine, s.showDownloadButton, s.downloadsFolder, s.captionStyle]).toEqual([
    true, true, "duckDuckGo", true, "", "site",
  ]);
  expect([s.voiceBoost, s.binWatchedDownloads, s.playNextDownload, s.newEpisodeAlerts, s.sharePet, s.cloudBackup]).toEqual([
    false, true, true, true, true, true,
  ]);
  // Each call gives its own copy.
  (AppSettings.defaults().enabledLists as string[]).push("x");
  expect(AppSettings.defaults().enabledLists).toHaveLength(5);
});

test("settings compare by value, lists as sets", () => {
  const a = AppSettings.defaults();
  expect(AppSettings.equals(a, { ...a, enabledLists: [...a.enabledLists].reverse() })).toBe(true);
  expect(AppSettings.equals(a, { ...a, enabledLists: ["easylist"] })).toBe(false);
  expect(AppSettings.equals(a, { ...a, theme: "white" })).toBe(false);
});

test("settings survive unknown fields and live in the profile database", async () => {
  const db = await freshDatabase();
  expect(await db.loadSettings()).toEqual(AppSettings.defaults());
  await db.saveSettings(AppSettings.make({ theme: "white" }));
  expect((await db.loadSettings()).theme).toBe("white");
  const decoded = AppSettings.decode(`{"theme":"dark","somethingNew":true}`)!;
  expect(decoded.theme).toBe("dark");
  expect(decoded.autoResume).toBe(true);
  db.close();
});
