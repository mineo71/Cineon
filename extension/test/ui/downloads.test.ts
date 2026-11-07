import { describe, expect, it } from "vitest";
import { DownloadItem, EpisodeRef } from "../../src/core/data";
import type { SeasonJobSnapshot, SeriesProposalSnapshot } from "../../src/shared/messages";
import {
  downloadDetail,
  downloadProgressText,
  downloadsHeaderLine,
  jobDetail,
  jobFraction,
  jobHeading,
  jobIcon,
  leftText,
  playLabel,
  proposalButton,
  proposalCountLine,
  proposalSizeLine,
} from "../../src/ui/lib/downloads";

function item(extra: Partial<DownloadItem> = {}): DownloadItem {
  return DownloadItem.make({ sourceUrl: "https://cdn/x.mp4", name: "Dune", host: "player.vod.site.to", ...extra });
}

describe("download rows", () => {
  it("describe the file", () => {
    expect(downloadDetail(item())).toBe("site.to");
    expect(
      downloadDetail(item({ quality: "1080p", kind: "hls", status: "done", bytes: 1_234_000_000, duration: 2520, subtitles: ["a.vtt", "b.vtt"] })),
    ).toBe("site.to · 1080p · stream · 1.2 GB · 42 min · 2 subtitles");
    expect(downloadDetail(item({ subtitles: ["a.vtt"] }))).toBe("site.to · subtitles");
    // Bytes only count once it's saved.
    expect(downloadDetail(item({ status: "downloading", bytes: 5_000_000 }))).toBe("site.to");
  });

  it("show progress", () => {
    expect(downloadProgressText(item({ status: "queued" }))).toBe("Starting…");
    expect(downloadProgressText(item({ status: "downloading", bytes: 0, totalBytes: 100 }))).toBe("Starting…");
    expect(downloadProgressText(item({ status: "downloading", bytes: 512_000_000, totalBytes: 1_200_000_000 }))).toBe(
      "42%  512 MB of 1.2 GB",
    );
    expect(downloadProgressText(item({ status: "downloading" }), 0.3)).toBe("30%");
  });

  it("offer to resume once you're past the start", () => {
    expect(playLabel(item({ position: 3 }))).toBe("Play");
    expect(playLabel(item({ position: 723 }))).toBe("Resume at 12:03");
    expect(leftText(item({ position: 4, duration: 3000 }))).toBeNull();
    expect(leftText(item({ position: 600, duration: 0 }))).toBeNull();
    expect(leftText(item({ position: 600, duration: 3000 }))).toBe("40 min left");
  });

  it("sum up what's saved", () => {
    expect(downloadsHeaderLine([])).toBe("Saved to your browser's downloads folder");
    expect(downloadsHeaderLine([item({ status: "downloading", bytes: 9 })])).toBe("Saved to your browser's downloads folder");
    expect(downloadsHeaderLine([item({ status: "done", bytes: 2_000_000_000 }), item({ status: "done", bytes: 500_000_000 })])).toBe(
      "2 saved, 2.5 GB in your browser's downloads folder",
    );
  });
});

function job(extra: Partial<SeasonJobSnapshot> = {}): SeasonJobSnapshot {
  const episodes = [1, 2, 3, 4].map((e) => EpisodeRef.make(2, e));
  return {
    name: "Severance",
    label: "Season 2",
    posterUrl: null,
    episodes,
    handled: 1,
    queued: episodes.slice(0, 1),
    missed: [],
    remaining: episodes.slice(1),
    current: episodes[1]!,
    isFinished: false,
    isPaused: false,
    ...extra,
  };
}

describe("the season job", () => {
  it("says what it's doing", () => {
    expect(jobHeading(job())).toBe("Getting Season 2");
    expect(jobDetail(job())).toBe("Opening S2 E2 to find its file. Two download at a time, the rest wait their turn.");
    expect(jobIcon(job())).toBeNull();
    expect(jobFraction(job())).toBe(0.25);
  });

  it("when paused", () => {
    const paused = job({ isPaused: true, current: null });
    expect(jobHeading(paused)).toBe("Season 2, paused");
    expect(jobDetail(paused)).toBe("Stopped when the browser closed, with 3 episodes to go. Carry on picks up where it left off.");
    expect(jobIcon(paused)).toBe("pause.circle");
  });

  it("when finished", () => {
    const done = job({ isFinished: true, current: null, handled: 4, queued: job().episodes.slice(0, 3), missed: [EpisodeRef.make(2, 4)] });
    expect(jobHeading(done)).toBe("Season 2: 3 of 4 queued");
    expect(jobDetail(done)).toBe("Couldn't find the file for S2 E4. Open those episodes and download them by hand.");
    expect(jobIcon(done)).toBe("exclamationmark.circle");
    expect(jobIcon({ ...done, missed: [] })).toBe("checkmark.circle");
    expect(jobDetail({ ...done, missed: [] })).toBe("Each episode's link is fetched right before its turn, so none expire while waiting.");
    expect(jobFraction({ ...done, episodes: [] })).toBe(0);
  });
});

describe("the series proposal", () => {
  const proposal: SeriesProposalSnapshot = {
    name: "Severance",
    posterUrl: null,
    episodes: 19,
    seasonCounts: [
      { season: 1, count: 9 },
      { season: 2, count: 10 },
    ],
    totalBytes: 19_000_000_000,
    isMeasured: false,
    freeBytes: 120_000_000_000,
    fits: true,
  };

  it("counts and sizes", () => {
    expect(proposalCountLine(proposal)).toBe("2 seasons, 19 episodes not downloaded yet");
    expect(proposalCountLine({ ...proposal, episodes: 1, seasonCounts: [{ season: 1, count: 1 }] })).toBe(
      "1 season, 1 episode not downloaded yet",
    );
    expect(proposalSizeLine(proposal)).toBe("About 19 GB, guessing a gigabyte an episode. 120 GB free on this computer");
    expect(proposalSizeLine({ ...proposal, isMeasured: true, freeBytes: null })).toBe("About 19 GB");
    expect(proposalButton(proposal)).toBe("Download 19 episodes");
    expect(proposalButton({ ...proposal, episodes: 1 })).toBe("Download 1 episode");
  });
});
