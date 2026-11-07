// DownloadsView.swift: everything saved, ready to watch without the site, its player or its ads.
// Plus the season job card and Sheets.swift's SeriesDownloadSheet (the series proposal). The
// download center lives in the background; with no background the rows come from IndexedDB.

import { useEffect } from "preact/hooks";
import { DownloadItem, DownloadStatus } from "../../core/data";
import { type DownloadsSnapshot, type SeasonJobSnapshot, type SeriesProposalSnapshot, type UiRequestType, send } from "../../shared/messages";
import { Icon } from "../components/Icon";
import { IconButton, OutlineButton, SilverButton, Spinner } from "../components/controls";
import { MenuDivider, MenuItem, contextMenuProps, menuButtonProps } from "../components/menu";
import { PosterPlaceholder, ProgressLine, RemoteImage, useFrameUrl } from "../components/media";
import { NO_BACKGROUND } from "../lib/app";
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
} from "../lib/downloads";
import { useHover, useLive, useModel, useSession } from "../lib/hooks";
import { addStyles } from "../lib/styles";
import { Overlay } from "../components/overlay";
import css from "./downloads.css";

addStyles(css);

type Simple = Extract<UiRequestType, "seasons.confirm" | "seasons.decline" | "seasons.resume" | "seasons.cancel" | "seasons.dismiss">;

/** Asks the background for something with no payload; says so when it doesn't answer. */
async function ask(type: Simple, toast: (text: string) => void): Promise<boolean> {
  const answer = await send(type, {});
  if (!answer) toast(NO_BACKGROUND);
  return answer?.ok ?? false;
}

export function DownloadsView() {
  const model = useModel();
  const downloads = useLive((l) => l.downloads);
  const items = downloads.value?.items ?? [];
  const job = downloads.value?.job ?? null;
  const downloadsApi = (globalThis as { chrome?: typeof chrome }).chrome?.downloads;
  return (
    <div class="downloads">
      <div class="row downloads-head">
        <div class="col" style={{ gap: "6px" }}>
          <h1 class="t-title">Downloads</h1>
          <span class="downloads-line">{downloadsHeaderLine(items)}</span>
        </div>
        <span class="spacer" />
        {downloadsApi?.showDefaultFolder && (
          <OutlineButton
            onClick={() => {
              try {
                downloadsApi.showDefaultFolder();
              } catch {
                model.toast("Couldn't open the downloads folder");
              }
            }}
          >
            Show downloads folder
          </OutlineButton>
        )}
      </div>
      {job && (
        <div class="job-wrap">
          <SeasonJobCard job={job} />
        </div>
      )}
      {items.length === 0 && !job ? (
        <div class="empty-state downloads-empty">
          <Icon name="arrow.down.circle" size={46} class="thin-icon" />
          <span class="t-title" style={{ fontSize: "22px", color: "var(--ink)" }}>
            Nothing downloaded yet
          </span>
          <span style={{ fontSize: "13px", maxWidth: "420px" }}>
            Start a film on any site, then press Download in the player's corner, or Alt+Shift+S. Cineon saves the file the player streams, so it plays without the site.
          </span>
        </div>
      ) : (
        <div class="downloads-list scroll">
          {items.map((item) => (
            <DownloadRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const model = useModel();
  const session = useSession();
  const [hovered, hover] = useHover();
  const title = item.titleId != null ? session.library.titles.get(item.titleId) ?? null : null;
  const frame = title?.posterUrl || item.posterUrl || item.titleId == null ? null : session.library.bestFrame(item.titleId);
  const frameUrl = useFrameUrl(frame);
  const poster = title?.posterUrl ?? item.posterUrl ?? frameUrl;
  const badge = DownloadItem.episodeBadge(item);

  const run = async (type: "downloads.play" | "downloads.retry" | "downloads.cancel" | "downloads.remove" | "downloads.show") => {
    const answer = await send(type, { id: item.id });
    if (!answer) model.toast(NO_BACKGROUND);
    else if ("message" in answer && answer.message) model.toast(answer.message);
  };

  const menuItems = () => (
    <>
      {item.status === "done" && <MenuItem onSelect={() => void run("downloads.play")}>Play</MenuItem>}
      <MenuItem onSelect={() => void run("downloads.show")}>Show in folder</MenuItem>
      {item.pageUrl && <MenuItem onSelect={() => void model.openUrl(item.pageUrl!)}>Open the page</MenuItem>}
      {title && <MenuItem onSelect={() => model.openTitle(title.id)}>Details</MenuItem>}
      <MenuDivider />
      <MenuItem onSelect={() => void run("downloads.remove")}>{item.status === "done" ? "Delete file" : "Remove"}</MenuItem>
    </>
  );

  return (
    <div
      class={`row download-row${hovered ? " hovered" : ""}`}
      {...hover}
      onDblClick={() => {
        if (item.status === "done") void run("downloads.play");
      }}
      {...contextMenuProps(menuItems)}
    >
      <RemoteImage url={poster} class="download-poster" placeholder={<PosterPlaceholder name={item.name} />} />
      <div class="col download-text">
        <div class="row" style={{ gap: "8px", alignItems: "baseline", minWidth: 0 }}>
          <span class="t-title download-name line1">{item.name}</span>
          {badge && <span class="time episode-badge">{badge}</span>}
        </div>
        <span class="download-detail line1">{downloadDetail(item)}</span>
        <DownloadStatusLine item={item} />
      </div>
      <span class="spacer" style={{ minWidth: "12px" }} />
      <div class="row download-actions">
        {item.status === "done" ? (
          <SilverButton icon="play.fill" onClick={() => void run("downloads.play")}>
            {playLabel(item)}
          </SilverButton>
        ) : item.status === "failed" ? (
          <OutlineButton onClick={() => void run("downloads.retry")}>Try again</OutlineButton>
        ) : (
          <IconButton icon="xmark" label="Stop downloading" onClick={() => void run("downloads.cancel")} />
        )}
        <button type="button" class="more-button" aria-label="More" {...menuButtonProps(menuItems)}>
          <Icon name="ellipsis" size={16} />
        </button>
      </div>
    </div>
  );
}

function DownloadStatusLine({ item }: { item: DownloadItem }) {
  if (DownloadStatus.isActive(item.status)) {
    const fraction = DownloadItem.fraction(item);
    return (
      <div class="row" style={{ gap: "10px", marginTop: "2px" }}>
        <ProgressLine fraction={fraction} height={3} style={{ maxWidth: "260px", flex: "1 1 auto" }} />
        <span class="time" style={{ fontSize: "11.5px", color: "var(--ink2)", whiteSpace: "nowrap" }}>
          {downloadProgressText(item, fraction)}
        </span>
      </div>
    );
  }
  if (item.status === "failed") {
    return <span class="line2" style={{ fontSize: "12px", color: "var(--ink2)" }}>{item.error ?? "Didn't finish"}</span>;
  }
  const left = leftText(item);
  if (!left) return null;
  return (
    <div class="row" style={{ gap: "10px", marginTop: "2px" }}>
      <ProgressLine fraction={DownloadItem.watchedFraction(item)} height={2} style={{ maxWidth: "160px", flex: "1 1 auto" }} />
      <span style={{ fontSize: "11.5px", color: "var(--ink3)", whiteSpace: "nowrap" }}>{left}</span>
    </div>
  );
}

/** A season being fetched: which episode the helper is on, and what's queued. */
function SeasonJobCard({ job }: { job: SeasonJobSnapshot }) {
  const model = useModel();
  const icon = jobIcon(job);
  return (
    <div class="row job-card">
      {icon ? (
        <span style={{ color: "var(--ink2)", display: "flex" }}>
          <Icon name={icon} size={21} />
        </span>
      ) : (
        <Spinner />
      )}
      <div class="col" style={{ gap: "3px", minWidth: 0 }}>
        <span class="t-title" style={{ fontSize: "15px", color: "var(--ink)" }}>
          {jobHeading(job)}
        </span>
        <span class="line2" style={{ fontSize: "12px", color: "var(--ink3)" }}>
          {jobDetail(job)}
        </span>
      </div>
      <span class="spacer" />
      <div class="col" style={{ gap: "5px", alignItems: "flex-end" }}>
        <ProgressLine fraction={jobFraction(job)} height={3} width={140} />
        <span class="time" style={{ fontSize: "10.5px", color: "var(--ink3)" }}>{`${job.handled} of ${job.episodes.length}`}</span>
      </div>
      {job.isPaused && <SilverButton onClick={() => void ask("seasons.resume", (t) => model.toast(t))}>Carry on</SilverButton>}
      <OutlineButton onClick={() => void ask(job.isFinished ? "seasons.dismiss" : "seasons.cancel", (t) => model.toast(t))}>
        {job.isFinished ? "Dismiss" : "Stop"}
      </OutlineButton>
    </div>
  );
}

/** Asks before getting a whole series: how many seasons and episodes, about how big, and the room left. */
export function SeriesProposalOverlay() {
  const downloads = useLive((l) => l.downloads);
  const proposal = downloads.value?.proposal ?? null;
  if (!proposal) return null;
  return <SeriesProposal proposal={proposal} snapshot={downloads.value!} hide={(next) => downloads.live.patch(next)} />;
}

function SeriesProposal({
  proposal,
  snapshot,
  hide,
}: {
  proposal: SeriesProposalSnapshot;
  snapshot: DownloadsSnapshot;
  hide: (next: DownloadsSnapshot) => void;
}) {
  const model = useModel();
  const answer = (type: "seasons.confirm" | "seasons.decline") => {
    hide({ ...snapshot, proposal: null });
    void ask(type, (t) => model.toast(t));
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        answer("seasons.decline");
      } else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        answer("seasons.confirm");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [proposal]);

  return (
    <Overlay onDismiss={() => answer("seasons.decline")}>
      <div class="glass series-sheet" role="dialog" aria-label={`Download all of ${proposal.name}?`}>
        <div class="row" style={{ gap: "16px", alignItems: "flex-start" }}>
          <RemoteImage
            url={proposal.posterUrl}
            class="series-poster"
            placeholder={
              <span class="series-poster-blank">
                <Icon name="film.stack" size={18} />
              </span>
            }
          />
          <div class="col" style={{ gap: "6px", flex: "1 1 auto", minWidth: 0 }}>
            <span class="t-title" style={{ fontSize: "22px", color: "var(--ink)" }}>{`Download all of ${proposal.name}?`}</span>
            <span style={{ fontSize: "13px", color: "var(--ink2)" }}>{proposalCountLine(proposal)}</span>
            <span style={{ fontSize: "13px", color: "var(--ink2)" }}>{proposalSizeLine(proposal)}</span>
          </div>
          <IconButton icon="xmark" label="Close" onClick={() => answer("seasons.decline")} />
        </div>
        <div class="season-grid">
          {proposal.seasonCounts.map((entry) => (
            <div key={entry.season} class="row season-chip">
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--ink)" }}>{`Season ${entry.season}`}</span>
              <span class="time" style={{ fontSize: "11px", color: "var(--ink3)" }}>
                {entry.count}
              </span>
            </div>
          ))}
        </div>
        {!proposal.fits && (
          <div class="row" style={{ gap: "8px", fontSize: "12.5px", fontWeight: 500, color: "var(--ink)", alignItems: "flex-start" }}>
            <Icon name="exclamationmark.triangle" size={15} />
            <span>That's more than the free space on this computer. Downloads that don't fit will stop with an error.</span>
          </div>
        )}
        <span style={{ fontSize: "12px", color: "var(--ink3)" }}>
          Season by season, two at a time. Stop whenever you like in Downloads. If the browser closes, it carries on from there next time.
        </span>
        <div class="row" style={{ gap: "10px" }}>
          <span class="spacer" />
          <OutlineButton onClick={() => answer("seasons.decline")}>Not now</OutlineButton>
          <SilverButton onClick={() => answer("seasons.confirm")}>{proposalButton(proposal)}</SilverButton>
        </div>
      </div>
    </Overlay>
  );
}
