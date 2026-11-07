// Port of Cineon.Core.Tests/Downloads/SeriesDownloadTests.cs (CineonTests/SeriesDownloadTests.swift),
// plus the job file's shape: a job the Mac or Windows wrote reads here, and the reverse.

import { EpisodeRef } from "../../src/core/data";
import { SeasonGrabber, SeasonJob, type SeasonProposal, SeasonProposal as Proposal, type SeasonScope } from "../../src/core/downloads";

function job(scope: SeasonScope, ...episodes: [number, number][]): SeasonJob {
  return SeasonJob.make({
    scope,
    titleId: 7,
    name: "The Sopranos",
    season: 1,
    episodes: episodes.map(([s, e]) => EpisodeRef.make(s, e)),
    pageUrl: "https://example.test/series/sopranos.html#t:1-s:1-e:1",
    startRef: EpisodeRef.make(1, 1),
    posterUrl: null,
    usesPageList: true,
  });
}

test("labels say how much is coming", () => {
  expect(SeasonJob.label(job("season", [1, 1], [1, 2]))).toBe("The Sopranos, season 1");
  expect(SeasonJob.label(job("series", [1, 1], [2, 1], [3, 1]))).toBe("The Sopranos, all 3 seasons");
  // A series that turns out to have one season says which.
  expect(SeasonJob.label(job("series", [4, 1], [4, 2]))).toBe("The Sopranos, season 4");
});

test("remaining skips what's been handled, in order", () => {
  const series: SeasonJob = { ...job("series", [1, 1], [1, 2], [2, 1], [2, 2]), queued: [EpisodeRef.make(1, 1)], missed: [EpisodeRef.make(2, 1)] };
  expect(SeasonJob.remaining(series)).toEqual([EpisodeRef.make(1, 2), EpisodeRef.make(2, 2)]);
  expect(SeasonJob.handled(series)).toBe(2);
  expect(SeasonJob.seasons(series)).toEqual([1, 2]);
});

test("a job survives being saved and read", () => {
  const series: SeasonJob = { ...job("series", [1, 1], [2, 3]), queued: [EpisodeRef.make(1, 1)], current: EpisodeRef.make(2, 3) };
  expect(SeasonJob.decode(SeasonJob.encode(series))).toEqual(series);
});

test("the proposal adds up and checks the room", () => {
  let proposal: SeasonProposal = { job: job("series", [1, 1], [1, 2], [2, 1]), bytesPerEpisode: 2_000, isMeasured: true, freeBytes: 10_000 };
  expect(Proposal.totalBytes(proposal)).toBe(6_000);
  expect(Proposal.fits(proposal)).toBe(true);
  expect(Proposal.seasonCounts(proposal)).toEqual([
    { season: 1, count: 2 },
    { season: 2, count: 1 },
  ]);
  proposal = { ...proposal, freeBytes: 5_000 };
  expect(Proposal.fits(proposal)).toBe(false);
  proposal = { ...proposal, freeBytes: null };
  // Unknown free space doesn't block anything.
  expect(Proposal.fits(proposal)).toBe(true);
});

test("free space is the room the browser gives, or unknown", async () => {
  expect(await SeasonGrabber.freeSpace(async () => ({ quota: 10_000, usage: 3_000 }))).toBe(7_000);
  expect(await SeasonGrabber.freeSpace(async () => ({}))).toBeNull();
  expect(
    await SeasonGrabber.freeSpace(async () => {
      throw new Error("no storage");
    }),
  ).toBeNull();
});

/** What Swift's JSONEncoder writes for a job, slashes escaped and nils left out. */
const MAC_JOB =
  '{"scope":"series","titleID":7,"name":"Клан Сопрано","season":1,"episodes":[{"season":1,"episode":1},{"season":2,"episode":3}],"queued":[{"season":1,"episode":1}],"missed":[],"current":{"season":2,"episode":3},"pageURL":"https:\\/\\/example.test\\/series\\/sopranos.html#t:1-s:1-e:1","startRef":{"season":1,"episode":1},"usesPageList":true,"isFinished":false,"isPaused":false}';

test("a job saved on a Mac reads here", () => {
  const read = SeasonJob.decode(MAC_JOB)!;
  expect(read).not.toBeNull();
  expect(read.scope).toBe("series");
  expect(read.titleId).toBe(7);
  expect(read.name).toBe("Клан Сопрано");
  expect(read.episodes).toEqual([EpisodeRef.make(1, 1), EpisodeRef.make(2, 3)]);
  expect(read.current).toEqual(EpisodeRef.make(2, 3));
  expect(read.pageUrl).toBe("https://example.test/series/sopranos.html#t:1-s:1-e:1");
  expect(read.posterUrl).toBeNull();
  expect(SeasonJob.remaining(read)).toEqual([EpisodeRef.make(2, 3)]);
  // Bytes too, as the file would be read.
  expect(SeasonJob.decode(new TextEncoder().encode(MAC_JOB))).toEqual(read);
});

test("a job written here has the Mac's keys", () => {
  const read = SeasonJob.decode(MAC_JOB)!;
  const written = JSON.parse(SeasonJob.encode(read)) as Record<string, unknown>;
  const mac = JSON.parse(MAC_JOB) as Record<string, unknown>;
  const shape = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? "array" : typeof v]);
  expect(shape(written)).toEqual(shape(mac));
  expect(SeasonJob.encode(read)).toBe(MAC_JOB.replaceAll("\\/", "/"));
});

test("nils are left out, and a missing key is not a job", () => {
  const j: SeasonJob = { ...job("season", [1, 1]), titleId: null, posterUrl: "https://img.test/p.jpg" };
  const doc = JSON.parse(SeasonJob.encode(j)) as Record<string, unknown>;
  expect("titleID" in doc).toBe(false);
  expect("current" in doc).toBe(false);
  expect(doc.posterURL).toBe("https://img.test/p.jpg");
  expect(SeasonJob.decode('{"scope":"season","name":"x"}')).toBeNull();
  expect(SeasonJob.decode("not json")).toBeNull();
  expect(SeasonJob.decode("[]")).toBeNull();
  // Optional flags may be missing (Swift needs them; the Windows port and this one don't).
  const lenient = SeasonJob.decode(
    '{"scope":"season","name":"x","season":1,"episodes":[],"pageURL":"https://a.test/","startRef":{"season":1,"episode":1},"usesPageList":false}',
  )!;
  expect(lenient.isFinished).toBe(false);
  expect(lenient.queued).toEqual([]);
  // An episode that isn't a pair of whole numbers spoils the list.
  expect(SeasonJob.decode(MAC_JOB.replace('{"season":2,"episode":3}],"queued"', '{"season":2.5,"episode":3}],"queued"'))).toBeNull();
});
