// What Downloads says (DownloadsView.swift, SeasonJobCard, SeriesDownloadSheet), as text. Pure,
// tested in test/ui/downloads.test.ts. "This Mac" becomes the browser's downloads folder.

import { DomainName, DownloadItem, Timecode } from "../../core/data";
import type { SeasonJobSnapshot, SeriesProposalSnapshot } from "../../shared/messages";
import { RefText, fileSize, percent } from "./format";

/** "3 saved, 4.2 GB in your browser's downloads folder". */
export function downloadsHeaderLine(items: readonly DownloadItem[]): string {
  const done = items.filter((d) => d.status === "done");
  if (done.length === 0) return "Saved to your browser's downloads folder";
  const bytes = done.reduce((sum, d) => sum + d.bytes, 0);
  return `${done.length} saved, ${fileSize(bytes)} in your browser's downloads folder`;
}

/** "site.to · 1080p · stream · 1.2 GB · 42 min · 2 subtitles". */
export function downloadDetail(item: DownloadItem): string {
  const parts = [DomainName.registrable(item.host)];
  if (item.quality != null) parts.push(item.quality);
  if (item.kind === "hls") parts.push("stream");
  if (item.status === "done" && item.bytes > 0) parts.push(fileSize(item.bytes));
  if (item.duration > 0) parts.push(Timecode.spoken(item.duration));
  if (item.subtitles.length > 0) parts.push(item.subtitles.length === 1 ? "subtitles" : `${item.subtitles.length} subtitles`);
  return parts.join(" · ");
}

/** "42%  512 MB of 1.2 GB", "42%", or "Starting…". */
export function downloadProgressText(item: DownloadItem, fraction: number = DownloadItem.fraction(item)): string {
  if (item.status !== "downloading" || fraction <= 0) return "Starting…";
  if (item.totalBytes > 0) return `${percent(fraction)}%  ${fileSize(item.bytes)} of ${fileSize(item.totalBytes)}`;
  return `${percent(fraction)}%`;
}

/** The done row's main button. */
export function playLabel(item: DownloadItem): string {
  return item.position > 5 ? `Resume at ${Timecode.string(item.position)}` : "Play";
}

/** "1 h 2 min left", once you're past the first seconds of a finished download. */
export function leftText(item: DownloadItem): string | null {
  if (item.position <= 5 || item.duration <= 0) return null;
  return `${Timecode.spoken(Math.max(0, item.duration - item.position))} left`;
}

// MARK: Season job

export function jobFraction(job: SeasonJobSnapshot): number {
  return job.episodes.length === 0 ? 0 : job.handled / job.episodes.length;
}

export function jobHeading(job: SeasonJobSnapshot): string {
  if (job.isFinished) return `${job.label}: ${job.queued.length} of ${job.episodes.length} queued`;
  if (job.isPaused) return `${job.label}, paused`;
  return `Getting ${job.label}`;
}

export function jobDetail(job: SeasonJobSnapshot): string {
  if (job.isPaused) {
    return `Stopped when the browser closed, with ${job.remaining.length} episodes to go. Carry on picks up where it left off.`;
  }
  if (job.current) return `Opening ${RefText.short(job.current)} to find its file. Two download at a time, the rest wait their turn.`;
  if (job.missed.length > 0) {
    return `Couldn't find the file for ${job.missed.map(RefText.short).join(", ")}. Open those episodes and download them by hand.`;
  }
  return "Each episode's link is fetched right before its turn, so none expire while waiting.";
}

export function jobIcon(job: SeasonJobSnapshot): "checkmark.circle" | "exclamationmark.circle" | "pause.circle" | null {
  if (job.isFinished) return job.missed.length === 0 ? "checkmark.circle" : "exclamationmark.circle";
  if (job.isPaused) return "pause.circle";
  return null;
}

// MARK: Series proposal

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "2 seasons, 18 episodes not downloaded yet". */
export function proposalCountLine(proposal: SeriesProposalSnapshot): string {
  return `${count(proposal.seasonCounts.length, "season")}, ${count(proposal.episodes, "episode")} not downloaded yet`;
}

/** "About 18 GB, guessing a gigabyte an episode. 120 GB free on this computer". */
export function proposalSizeLine(proposal: SeriesProposalSnapshot): string {
  let text = `About ${fileSize(proposal.totalBytes)}`;
  if (!proposal.isMeasured) text += ", guessing a gigabyte an episode";
  if (proposal.freeBytes != null) text += `. ${fileSize(proposal.freeBytes)} free on this computer`;
  return text;
}

export function proposalButton(proposal: SeriesProposalSnapshot): string {
  return `Download ${count(proposal.episodes, "episode")}`;
}
