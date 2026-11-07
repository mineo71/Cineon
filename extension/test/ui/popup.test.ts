import { EpisodeRef, ShieldStats, SitePrefs, WatchProgress } from "../../src/core/data";
import type { TabSnapshot } from "../../src/shared/messages";
import {
  addOutcome,
  continueDetail,
  isRestrictedUrl,
  mediaFraction,
  popupView,
  prefsKey,
  relinkHash,
  shieldsBreakdown,
  shieldsLine,
  timeLine,
  titleHash,
  waitingText,
  withShields,
} from "../../src/ui/lib/popup";

function snapshot(fields: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    tabId: 7,
    windowId: 1,
    url: "https://films.example/watch/dune",
    host: "www.films.example",
    title: "Dune (2021) watch online",
    favIconUrl: null,
    parsed: null,
    linkedTitleId: null,
    ref: null,
    media: null,
    canDownload: false,
    hasNextEpisode: false,
    blocked: ShieldStats.make(),
    sitePrefs: SitePrefs.make("films.example"),
    voiceBoost: "off",
    ...fields,
  };
}

const tab = { id: 7, windowId: 1, url: "https://films.example/watch/dune", title: "Dune (2021) watch online" };

describe("isRestrictedUrl", () => {
  it("keeps the browser's own pages and stores out", () => {
    for (const url of [
      null,
      "",
      "chrome://extensions",
      "chrome-extension://abc/app.html",
      "edge://settings",
      "about:blank",
      "moz-extension://x/app.html",
      "view-source:https://a.example",
      "file:///Users/me/film.mp4",
      "https://chromewebstore.google.com/detail/x",
      "https://chrome.google.com/webstore/detail/x",
      "https://addons.mozilla.org/en-US/firefox/",
      "https://microsoftedge.microsoft.com/addons/detail/x",
      "not a url",
    ]) {
      expect(isRestrictedUrl(url), String(url)).toBe(true);
    }
  });

  it("lets ordinary sites through", () => {
    expect(isRestrictedUrl("https://films.example/watch/dune")).toBe(false);
    expect(isRestrictedUrl("http://localhost:8080/player")).toBe(false);
    expect(isRestrictedUrl("https://chrome.google.com/search")).toBe(false);
  });
});

describe("popupView", () => {
  it("is restricted without a tab or on the browser's pages", () => {
    expect(popupView(null, undefined).kind).toBe("restricted");
    expect(popupView({ ...tab, id: null }, undefined).kind).toBe("restricted");
    expect(popupView({ ...tab, url: "chrome://newtab" }, { tab: snapshot() }).kind).toBe("restricted");
  });

  it("is loading until asked, offline when the background doesn't answer", () => {
    expect(popupView(tab, undefined)).toEqual({ kind: "loading", host: "films.example", title: tab.title });
    expect(popupView(tab, null)).toEqual({ kind: "offline", host: "films.example", title: tab.title });
    expect(popupView(tab, { tab: null })).toEqual({ kind: "offline", host: "films.example", title: tab.title });
  });

  it("shows the background's view of the tab", () => {
    const answer = snapshot({ media: { position: 60, duration: 600, isPlaying: true, rate: 1 } });
    expect(popupView(tab, { tab: answer })).toEqual({ kind: "page", tab: answer });
  });
});

describe("media text", () => {
  it("writes the time and the fraction", () => {
    expect(timeLine({ position: 723, duration: 2700, isPlaying: true, rate: 1 })).toBe("12:03 / 45:00");
    expect(timeLine({ position: 3725, duration: 7200, isPlaying: false, rate: 1 })).toBe("1:02:05 / 2:00:00");
    expect(mediaFraction({ position: 30, duration: 120, isPlaying: true, rate: 1 })).toBe(0.25);
    expect(mediaFraction({ position: 30, duration: 0, isPlaying: true, rate: 1 })).toBe(0);
    expect(mediaFraction({ position: 300, duration: 120, isPlaying: true, rate: 1 })).toBe(1);
    expect(mediaFraction(null)).toBe(0);
  });
});

describe("shields", () => {
  it("keys preferences by the registrable domain, as ShieldState does", () => {
    expect(prefsKey("www.player.films.example")).toBe("films.example");
    expect(prefsKey("watch.example.co.uk")).toBe("example.co.uk");
    expect(prefsKey(null)).toBe("");
  });

  it("turns shields on and off, keeping the other choices", () => {
    const stored = SitePrefs.make("films.example", { allowPopups: true });
    expect(withShields(stored, "www.films.example", false)).toEqual({ ...stored, shieldsOff: true });
    expect(withShields(null, "www.films.example", false)).toEqual(SitePrefs.make("films.example", { shieldsOff: true }));
    expect(withShields(SitePrefs.make("films.example", { shieldsOff: true }), "films.example", true).shieldsOff).toBe(false);
  });

  it("says what was blocked", () => {
    expect(shieldsLine(null, true)).toBe("Nothing blocked on this page yet");
    expect(shieldsLine(ShieldStats.make({ ads: 9, popups: 2, overlays: 1 }), true)).toBe("12 blocked on this page");
    expect(shieldsLine(ShieldStats.make({ ads: 9 }), false)).toBe("Shields are off on this site");
    expect(shieldsBreakdown(ShieldStats.make({ ads: 9, popups: 1, redirects: 2, overlays: 1 }))).toBe(
      "9 ads and trackers, 1 pop-up, 2 redirects, 1 click trap",
    );
    expect(shieldsBreakdown(ShieldStats.make({ ads: 1 }))).toBe("1 ad or tracker");
    expect(shieldsBreakdown(ShieldStats.make())).toBe("");
    expect(shieldsBreakdown(null)).toBe("");
  });
});

describe("add to backlog", () => {
  it("shows the background's message when it added something", () => {
    expect(addOutcome({ kind: "done", titleId: 3, message: "Added Dune to backlog" }, "x")).toEqual({
      kind: "message",
      text: "Added Dune to backlog",
    });
  });

  it("opens the Add sheet with what's known otherwise", () => {
    expect(addOutcome({ kind: "needsName", query: "Dune: Part Two" }, "x")).toEqual({ kind: "open", hash: "#library?add=Dune%3A%20Part%20Two" });
    expect(addOutcome(null, "  Some page  ")).toEqual({ kind: "open", hash: "#library?add=Some%20page" });
  });

  it("makes the Cineon page's addresses", () => {
    expect(titleHash(12)).toBe("#library?title=12");
    expect(relinkHash(34)).toBe("#library?relink=34");
  });
});

describe("continue watching", () => {
  it("names the episode, the time left, or where it was opened", () => {
    const base = WatchProgress.make({ titleId: 1, host: "www.films.example", position: 600, duration: 3120 });
    expect(continueDetail({ ...base, ref: EpisodeRef.make(2, 5) })).toBe("S2 E5");
    expect(continueDetail(base)).toBe("42 min left");
    expect(continueDetail({ ...base, duration: 0, position: 0 })).toBe("Opened on films.example");
    expect(waitingText(3)).toBe("3 waiting");
  });
});
