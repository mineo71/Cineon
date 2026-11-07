// Port of Cineon.Core.Tests/Downloads/SeasonGrabberTests.cs: a streaming site as SeasonGrabber sees
// it through the browser (episode pages in a helper tab, and their files), against the real
// DownloadCenter over the fakes.

import { DownloadItem, EpisodeRef, MediaSource, type Title } from "../../src/core/data";
import {
  type EpisodeHelperTab,
  type EpisodeResolver,
  type PageMethod,
  type PublishedEpisode,
  SeasonGrabber,
  SeasonJob,
} from "../../src/core/downloads";
import { DownloadRig, FakeTab } from "./fakes";

const PAGE = "https://site.test/series/severance";
const key = (r: EpisodeRef) => `${r.season}x${r.episode}`;

class FakeSite implements EpisodeResolver {
  readonly files = new Map<string, string>();
  readonly alive = new Set<string>();
  readonly published: PublishedEpisode[] = [];
  pageList = true;
  readonly tabs: FakeHelperTab[] = [];

  episodes(season: number, ...numbers: number[]): void {
    for (const n of numbers) {
      const ref = EpisodeRef.make(season, n);
      this.files.set(key(ref), `https://cdn.test/media/s${season}e${n}.mp4`);
      this.alive.add(key(ref));
    }
  }

  static urlOf(ref: EpisodeRef): string {
    return `${PAGE}/s${ref.season}e${ref.episode}`;
  }

  static episodeOf(url: string): EpisodeRef | null {
    const m = /\/s(\d+)e(\d+)$/.exec(url);
    return m ? EpisodeRef.make(Number(m[1]), Number(m[2])) : null;
  }

  async makeHelperTab(): Promise<EpisodeHelperTab> {
    const tab = new FakeHelperTab(this);
    this.tabs.push(tab);
    return tab;
  }

  episodeUrl(_page: string, _current: EpisodeRef, target: EpisodeRef): string | null {
    return FakeSite.urlOf(target);
  }

  async isAlive(url: string): Promise<boolean> {
    const ref = FakeSite.episodeOf(url);
    return ref != null && this.alive.has(key(ref));
  }

  async publishedEpisodes(_title: Title): Promise<readonly PublishedEpisode[]> {
    return this.published;
  }
}

/** The hidden tab: opening an episode makes its player ask for its file. */
class FakeHelperTab implements EpisodeHelperTab {
  currentUrl: string | null = null;
  readonly displayTitle = "Severance";
  readonly linkedTitleId = null;
  readonly trackRef = null;
  readonly parsed = null;
  readonly sourcesFrameUrl = "https://player.test/embed";
  readonly mediaDuration = 3000;
  closed = false;
  paused = 0;
  private list: MediaSource[] = [];
  private clock = 0;

  constructor(private readonly site: FakeSite) {}

  get url(): string | null {
    return this.currentUrl;
  }

  get sources(): readonly MediaSource[] {
    return this.list;
  }

  get bestSource(): MediaSource | null {
    return MediaSource.best(this.list, null);
  }

  private show(ref: EpisodeRef | null): void {
    this.list = this.list.map((s) => ({ ...s, isCurrent: false }));
    const file = ref == null ? undefined : this.site.files.get(key(ref));
    if (file != null) this.list = [...this.list, { url: file, kind: "file", foundAt: ++this.clock, isCurrent: true }];
  }

  load(url: string): void {
    this.currentUrl = url;
    this.show(FakeSite.episodeOf(url));
  }

  reload(): void {
    this.load(this.currentUrl!);
  }

  pausePlayback(): void {
    this.paused++;
  }

  close(): void {
    this.closed = true;
  }

  async callPage(method: PageMethod, ...args: (number | boolean)[]): Promise<unknown> {
    if (method === "openEpisode") {
      if (!this.site.pageList) return false;
      this.show(EpisodeRef.make(args[0] as number, args[1] as number));
      return true;
    }
    return true;
  }
}

let rig: DownloadRig;
let site: FakeSite;
beforeEach(async () => {
  rig = await DownloadRig.make();
  site = new FakeSite();
});
afterEach(() => rig.dispose());

const jobKey = () => `${rig.db.name}/${SeasonGrabber.jobFileName}`;

async function make(): Promise<SeasonGrabber> {
  for (const file of site.files.values()) {
    const path = new URL(file).pathname;
    rig.server.bytes(path, new TextEncoder().encode(path));
  }
  const grabber = await SeasonGrabber.open({
    downloads: rig.center,
    host: rig.host,
    resolver: site,
    storage: rig.storage,
    estimate: async () => ({ quota: 100e9, usage: 1e9 }),
  });
  grabber.pollInterval = 5;
  grabber.slotInterval = 5;
  grabber.nudgeInterval = 50;
  grabber.firstLoadTimeout = 400;
  grabber.episodeWait = 400;
  return grabber;
}

/** The tab on screen, on season 1 episode 2, with the page's own episode list. */
function screenTab(seasons?: unknown, episodes?: (season: number) => unknown): FakeTab {
  return new FakeTab({
    url: FakeSite.urlOf(EpisodeRef.make(1, 2)),
    trackRef: EpisodeRef.make(1, 2),
    parsed: { name: "Severance", ref: EpisodeRef.make(1, 2), kindHint: "series" },
    page: (method, args) => {
      if (method === "seasonsOnPage") return seasons ?? null;
      if (method === "episodesOnPage") return episodes?.(args[0] as number) ?? null;
      return null;
    },
  });
}

/** The grabber and the center hand work to each other: wait until a whole pass finds nothing new. */
async function settle(grabber: SeasonGrabber): Promise<void> {
  let last: string | null = null;
  for (let pass = 0; pass < 200; pass++) {
    await grabber.idle();
    await rig.center.idle();
    await new Promise((r) => setTimeout(r, 15));
    const job = grabber.job;
    const now =
      rig.center.items.map((i) => `${key(i.ref)}:${i.status}`).join(",") +
      `|${job ? SeasonJob.handled(job) : ""}|${job?.isFinished}|${job?.isPaused}|${grabber.isBusy}|${rig.center.activeCount}`;
    if (now === last && !grabber.isBusy) return;
    last = now;
  }
}

function downloaded(): string[] {
  return rig.center.items
    .filter((i) => i.status === "done")
    .map((i) => i.ref)
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .map(key);
}

test("a season from the page's own list is queued one by one", async () => {
  site.episodes(1, 1, 2, 3);
  const grabber = await make();
  await grabber.start(screenTab(undefined, (s) => (s === 1 ? [1, 2, 3] : [])), false);
  await settle(grabber);

  expect(downloaded()).toEqual(["1x1", "1x2", "1x3"]);
  const job = grabber.job!;
  expect(job.isFinished).toBe(true);
  expect(job.usesPageList).toBe(true);
  expect(job.queued).toHaveLength(3);
  // A finished job is forgotten.
  expect(await rig.storage.get(jobKey())).toBeNull();
  expect(rig.host.toasts).toContain("Getting 3 episodes of Severance, season 1");
  expect(rig.host.toasts).toContain("All 3 episodes of Severance, season 1 are downloading");
  expect(site.tabs).toHaveLength(1);
  expect(site.tabs[0]!.closed).toBe(true);

  const item = rig.center.items.find((i) => key(i.ref) === "1x3")!;
  expect(item.file).toBe(DownloadRig.path("Severance S01E03.mp4"));
  expect(item.pageUrl).toBe(FakeSite.urlOf(EpisodeRef.make(1, 3)));
  expect(item.referer).toBe("https://player.test/embed");
  expect(item.titleId).toBe([...rig.library.titles.values()][0]!.id);

  grabber.dismiss();
  expect(grabber.job).toBeNull();
});

test("from the current episode leaves out the ones before", async () => {
  site.episodes(1, 1, 2, 3);
  const grabber = await make();
  await grabber.start(screenTab(undefined, () => [1, 2, 3]), true);
  await settle(grabber);
  expect(downloaded()).toEqual(["1x2", "1x3"]);
});

test("without a list the addresses are walked", async () => {
  site.episodes(1, 1, 2, 3, 4);
  site.pageList = false;
  const grabber = await make();
  await grabber.start(screenTab(), false);
  await settle(grabber);
  expect(downloaded()).toHaveLength(4);
  expect(grabber.job!.usesPageList).toBe(false);
});

test("missed episodes are reported", async () => {
  site.episodes(1, 1, 2);
  // Episode 3 has a page but its player never asks for a file.
  site.alive.add("1x3");
  const grabber = await make();
  await grabber.start(screenTab(undefined, () => [1, 2, 3]), false);
  await settle(grabber);
  expect(grabber.job!.missed.map(key)).toEqual(["1x3"]);
  expect(rig.host.toasts).toContain("Queued 2 of 3. Couldn't find the file for S1 E3");
});

test("episodes already here are not fetched twice", async () => {
  site.episodes(1, 1, 2);
  const grabber = await make();
  await grabber.start(screenTab(undefined, () => [1, 2]), false);
  await settle(grabber);
  grabber.dismiss();
  await grabber.start(screenTab(undefined, () => [1, 2]), false);
  await settle(grabber);
  expect(rig.host.toasts).toContain("Every episode of this season is already on this computer");
  expect(rig.center.items).toHaveLength(2);
});

test("a whole series waits for a yes", async () => {
  site.episodes(1, 1, 2);
  site.episodes(2, 1);
  const grabber = await make();
  let looked = false;
  grabber.changed.on(() => (looked ||= grabber.isLooking));
  await grabber.startSeries(screenTab([1, 2], (s) => (s === 1 ? [1, 2] : [1])));
  await settle(grabber);
  expect(looked).toBe(true);
  expect(grabber.isLooking).toBe(false);
  expect(rig.host.toasts).toContain("Looking for every episode of Severance…");

  const proposal = grabber.proposal!;
  expect(proposal.job.episodes).toHaveLength(3);
  expect(proposal.job.scope).toBe("series");
  expect(proposal.bytesPerEpisode).toBe(SeasonGrabber.guessedBytesPerEpisode);
  expect(proposal.isMeasured).toBe(false);
  expect(proposal.freeBytes).toBe(99e9);
  expect(rig.center.items).toEqual([]);

  grabber.confirm();
  await settle(grabber);
  expect(downloaded()).toHaveLength(3);
  expect(rig.host.toasts).toContain("All 3 episodes of Severance, all 2 seasons are downloading");
});

test("seasons come from the catalogue when the page has no list", async () => {
  site.episodes(1, 1, 2);
  site.episodes(2, 1, 2);
  const now = Date.now() / 1000;
  const released = now - 30 * 86400;
  site.published.push(
    { season: 1, episode: 1, released },
    { season: 1, episode: 2, released },
    { season: 2, episode: 1, released },
    { season: 2, episode: 2, released },
    { season: 2, episode: 3, released: now + 30 * 86400 },
  );
  const grabber = await make();
  await grabber.startSeries(screenTab());
  await settle(grabber);
  expect(grabber.proposal!.job.episodes.map(key)).toEqual(["1x1", "1x2", "2x1", "2x2"]);
  grabber.decline();
  expect(grabber.proposal).toBeNull();
});

test("only one job at a time, and only from an episode", async () => {
  const grabber = await make();
  await grabber.start(new FakeTab({ url: "https://site.test/film", parsed: { name: "Dune" } }), false);
  expect(rig.host.toasts).toContain("Open an episode of the series first");
});

test("a job left by a closed browser carries on, even one the Mac wrote", async () => {
  site.episodes(1, 1, 2, 3);
  // Episode 1 was queued and stopped with the browser; episode 2 finished.
  const stopped = DownloadItem.make({
    name: "Severance",
    ref: EpisodeRef.make(1, 1),
    sourceUrl: site.files.get("1x1")!,
    status: "downloading",
    createdAt: Date.now() / 1000,
  });
  await rig.db.insertDownload(stopped);
  await rig.db.insertDownload({ ...stopped, ref: EpisodeRef.make(1, 2), status: "done", sourceUrl: site.files.get("1x2")! });
  rig.center.detach();
  rig.center = await rig.open();
  // As the Mac writes it, mid-run.
  const page = FakeSite.urlOf(EpisodeRef.make(1, 2)).replaceAll("/", "\\/");
  await rig.storage.set(
    jobKey(),
    `{"scope":"season","name":"Severance","season":1,"episodes":[{"season":1,"episode":1},{"season":1,"episode":2},{"season":1,"episode":3}],"queued":[{"season":1,"episode":1},{"season":1,"episode":2}],"missed":[],"current":{"season":1,"episode":3},"pageURL":"${page}","startRef":{"season":1,"episode":2},"usesPageList":true,"isFinished":false,"isPaused":false}`,
  );

  const grabber = await make();
  const job = grabber.job!;
  expect(job.isPaused).toBe(true);
  expect(job.current).toBeNull();
  expect(grabber.isRunning).toBe(false);
  const offer = rig.host.actions.find((a) => a.message.includes("stopped when Cineon closed"))!;
  expect(offer.message).toBe("Getting Severance, season 1 stopped when Cineon closed");
  expect(offer.title).toBe("Carry on");

  offer.action!();
  expect(rig.host.toasts).toContain("Carrying on with Severance, season 1: 2 to go");
  await settle(grabber);
  expect(downloaded()).toEqual(["1x1", "1x2", "1x3"]);
  // The stopped copy went, rather than staying beside the new one.
  expect(rig.center.items.some((i) => i.status === "failed")).toBe(false);
  expect(grabber.job!.isFinished).toBe(true);
});

test("suspending keeps the job for next time", async () => {
  site.episodes(1, 1, 2, 3);
  // Nothing can start, so the job waits for a free slot.
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  rig.server.route("/busy.mp4", async () => {
    await gate;
    return { status: 200, body: new Uint8Array([1]) };
  });
  await rig.enqueue("https://cdn.test/busy.mp4", { name: "A" });
  await rig.enqueue("https://cdn.test/busy.mp4", { name: "B" });
  const grabber = await make();
  void grabber.start(screenTab(undefined, () => [1, 2, 3]), false);
  const deadline = Date.now() + 5000;
  while ((await rig.storage.get(jobKey())) == null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  expect(grabber.isRunning).toBe(true);
  expect(grabber.isBusy).toBe(true);

  await grabber.start(screenTab(undefined, () => [1, 2, 3]), false);
  expect(rig.host.toasts).toContain("Already getting Severance, season 1");

  grabber.suspend();
  expect(grabber.job!.isPaused).toBe(true);
  await grabber.idle();
  const saved = SeasonJob.decode((await rig.storage.get(jobKey())) as string)!;
  expect(saved.isPaused).toBe(true);
  expect(SeasonJob.remaining(saved)).toHaveLength(3);
  open();
  await settle(grabber);
  expect(rig.center.items.some((i) => i.name === "Severance")).toBe(false);

  // Cancelling instead finishes it and says so.
  grabber.cancel();
  await grabber.idle();
  expect(rig.host.toasts).toContain("Stopped getting Severance, season 1");
  expect(await rig.storage.get(jobKey())).toBeNull();
});

test("page answers count only as lists of numbers", () => {
  expect(SeasonGrabber.numbers([1, 2.7, 3])).toEqual([1, 2, 3]);
  expect(SeasonGrabber.numbers([1, "2"])).toBeNull();
  expect(SeasonGrabber.numbers(null)).toBeNull();
  expect(SeasonGrabber.numbers("[1,2]")).toBeNull();
  expect(SeasonGrabber.shortLabel(EpisodeRef.make(1, 2))).toBe("S1 E2");
});
