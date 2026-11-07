// TitleDetailView.swift: the title card over everything: the hero, what to do, the overview,
// moments, where you watched it, episodes, history, what Cineon skips, and your stars.

import { useMemo, useState } from "preact/hooks";
import {
  DomainName,
  EpisodeRef,
  type FilmFrame,
  type SkipRule,
  Timecode,
  type Title,
  type WatchProgress,
  type WatchSession,
} from "../../core/data";
import type { EpisodeInfo } from "../../core/metadata";
import { send } from "../../shared/messages";
import { Icon } from "../components/Icon";
import { HoverButton, IconButton, OutlineButton, SilverButton } from "../components/controls";
import { MenuDivider, MenuItem, contextMenuProps, menuButtonProps } from "../components/menu";
import { PosterImage, RemoteImage, SiteIcon, StarRatingControl, useFrameUrl } from "../components/media";
import { StatusPicker } from "../components/titles";
import { NO_BACKGROUND } from "../lib/app";
import { DateText, RefText, isVisitOnly } from "../lib/format";
import { useHover, useLive, useModel, useSession, useTask } from "../lib/hooks";
import { factsLine, resumeLabel } from "../lib/library";
import { addStyles } from "../lib/styles";
import css from "./detail.css";

addStyles(css);

/** Each site you've watched this on, latest first. */
export function placesFor(progressList: readonly WatchProgress[]): WatchProgress[] {
  const seen = new Set<string>();
  return progressList.filter((p) => {
    if (seen.has(p.host) || p.url == null) return false;
    seen.add(p.host);
    return true;
  });
}

/** Which season to show first: the one you're in, else the first. */
export function initialSeason(episodes: readonly EpisodeInfo[], latest: WatchProgress | null): number {
  if (latest && latest.ref.season > 0) return latest.ref.season;
  const seasons = [...new Set(episodes.map((e) => e.season))].sort((a, b) => a - b);
  return seasons[0] ?? 1;
}

/** "Intro, 0:40 to 1:52" or "Credits, last 2 min". */
export function skipText(rule: SkipRule): string {
  return rule.kind === "intro"
    ? `Intro, ${Timecode.string(rule.start)} to ${Timecode.string(rule.end)}`
    : `Credits, last ${Timecode.spoken(rule.start)}`;
}

export function TitleDetailView({ title }: { title: Title }) {
  const model = useModel();
  const session = useSession();
  const library = session.library;
  const progressList = library.progressList(title.id);
  const latest = progressList[0] ?? null;
  const places = placesFor(progressList);
  const moments = library.moments(title.id);
  const [sessions] = useTask(() => library.sessionsForTitle(title.id), [title.id, library.revision, session.version], [] as WatchSession[]);
  const [skipRules, setSkipRules] = useState<SkipRule[] | null>(null);
  const [loadedRules] = useTask(() => session.db.skipRules(title.id).catch(() => [] as SkipRule[]), [title.id], [] as SkipRule[]);
  const rules = skipRules ?? loadedRules;
  const [episodes] = useTask(() => session.metadata.episodes(title).catch(() => [] as EpisodeInfo[]), [title.id, title.imdbId], [] as EpisodeInfo[]);

  return (
    <div class="title-card" role="dialog" aria-label={title.name}>
      <div class="title-card-scroll scroll">
        <Hero title={title} latest={latest} />
        <div class="title-card-body">
          {title.overview && <p class="overview">{title.overview}</p>}
          {moments.length > 0 && (
            <section class="detail-section">
              <h3 class="t-title">Moments</h3>
              <div class="moments-grid">
                {moments.map((moment) => (
                  <MomentCell key={moment.id} moment={moment} />
                ))}
              </div>
            </section>
          )}
          {places.length > 0 && (
            <section class="detail-section tight">
              <h3 class="t-title">Where you watched it</h3>
              {places.map((place) => (
                <HoverButton key={place.host} class="place-row" onClick={() => place.url && void model.resumeUrl(place.url, place.position)}>
                  <SiteIcon name={place.host} url={library.siteForHost(place.host)?.iconUrl} size={18} />
                  <span class="place-host">{DomainName.registrable(place.host)}</span>
                  {EpisodeRef.isEpisode(place.ref) && <span class="place-ref">{RefText.short(place.ref)}</span>}
                  <span class="spacer" />
                  <span class="time place-state">{isVisitOnly(place) ? "Opened" : place.finished ? "Finished" : `Stopped at ${Timecode.string(place.position)}`}</span>
                  <span class="place-when">{DateText.relative(place.updatedAt)}</span>
                </HoverButton>
              ))}
            </section>
          )}
          {episodes.length > 0 && <EpisodesSection title={title} episodes={episodes} progressList={progressList} latest={latest} />}
          {sessions.length > 0 && (
            <section class="detail-section history">
              <h3 class="t-title">History</h3>
              {sessions.slice(0, 12).map((s) => (
                <div key={s.id} class="history-row time">
                  <span class="ink2">{DateText.day(s.startedAt)}</span>
                  {EpisodeRef.isEpisode(s.ref) && <span class="ink2">{RefText.short(s.ref)}</span>}
                  <span class="ink3">{isVisitOnly(s) ? "Opened" : Timecode.spoken(s.watchedSeconds)}</span>
                  <span class="spacer" />
                  <span class="ink3">{DomainName.registrable(s.host)}</span>
                </div>
              ))}
            </section>
          )}
          {rules.length > 0 && (
            <section class="detail-section history">
              <h3 class="t-title">What Cineon skips</h3>
              {rules.map((rule) => (
                <div key={rule.id} class="skip-row">
                  <span class="ink2">{skipText(rule)}</span>
                  <span class="ink3">{rule.site}</span>
                  <span class="spacer" />
                  <button
                    type="button"
                    class="btn-plain ink2"
                    onClick={() => {
                      void session.db.deleteSkipRule(rule.id).catch(() => undefined);
                      setSkipRules(rules.filter((r) => r.id !== rule.id));
                    }}
                  >
                    Forget
                  </button>
                </div>
              ))}
            </section>
          )}
          <div class="detail-footer">
            <StarRatingControl halves={title.ratingHalves} size={15} onChange={(value) => void library.setRating(title.id, value)} />
            <span class="spacer" />
            <button type="button" class="btn-plain remove-title" onClick={() => void model.remove(title.id)}>
              Remove from library
            </button>
          </div>
        </div>
      </div>
      <span class="close-button">
        <IconButton icon="xmark" label="Close" onClick={() => model.openTitle(null)} />
      </span>
    </div>
  );
}

function Hero({ title, latest }: { title: Title; latest: WatchProgress | null }) {
  const session = useSession();
  const frame = title.backdropUrl ? null : session.library.bestFrame(title.id);
  const frameUrl = useFrameUrl(frame);
  const image = title.backdropUrl ?? frameUrl;
  return (
    <div class="title-hero">
      <RemoteImage url={image} class={`title-hero-image${title.status === "watched" ? " mono" : ""}`} placeholder={<div class="hero-blank" />} />
      <div class="title-hero-shade" />
      <div class="title-hero-row">
        <PosterImage title={title} width={118} />
        <div class="col" style={{ gap: "8px", minWidth: 0, flex: "1 1 auto" }}>
          <h2 class="t-title title-name">{title.name}</h2>
          <span class="facts line1">{factsLine(title)}</span>
          <ActionRow title={title} latest={latest} />
        </div>
      </div>
    </div>
  );
}

function ActionRow({ title, latest }: { title: Title; latest: WatchProgress | null }) {
  const model = useModel();
  const downloads = useLive((l) => l.downloads);
  const together = useLive((l) => l.together);
  const copy = downloads.value?.items.find((d) => d.titleId === title.id && d.status === "done") ?? null;
  const badge = copy && EpisodeRef.isEpisode(copy.ref) ? `S${String(copy.ref.season).padStart(2, "0")}E${String(copy.ref.episode).padStart(2, "0")}` : null;
  return (
    <div class="row action-row">
      {latest?.url && !latest.finished ? (
        <SilverButton icon="play.fill" onClick={() => model.resume(title)}>
          {resumeLabel(latest)}
        </SilverButton>
      ) : (
        <SilverButton icon="magnifyingglass" onClick={() => void model.searchEverywhere(title.name, title.id)}>
          Find on my sites
        </SilverButton>
      )}
      {copy && (
        <OutlineButton
          icon="arrow.down.circle"
          onClick={() =>
            void send("downloads.play", { id: copy.id }).then((answer) => {
              if (!answer) model.toast(NO_BACKGROUND);
              else if (answer.message) model.toast(answer.message);
            })
          }
        >
          {badge ? `Play ${badge} from Downloads` : "Play the downloaded copy"}
        </OutlineButton>
      )}
      <StatusPicker title={title} />
      {together.value?.isAvailable && (
        <button
          type="button"
          class="together-menu"
          title="Together"
          aria-label="Together"
          {...menuButtonProps(() => (
            <>
              <MenuItem
                onSelect={() => {
                  model.openTitle(null);
                  void send("together.createChallenge", { titleId: title.id }).then((a) => a || model.toast(NO_BACKGROUND));
                }}
              >
                Challenge friends to finish it
              </MenuItem>
              <MenuItem onSelect={() => void send("together.share", { titleId: title.id }).then((a) => a || model.toast(NO_BACKGROUND))}>
                Share it as a code
              </MenuItem>
            </>
          ))}
        >
          <Icon name="person.2" size={16} />
        </button>
      )}
    </div>
  );
}

function EpisodesSection({
  title,
  episodes,
  progressList,
  latest,
}: {
  title: Title;
  episodes: readonly EpisodeInfo[];
  progressList: readonly WatchProgress[];
  latest: WatchProgress | null;
}) {
  const seasons = useMemo(() => [...new Set(episodes.map((e) => e.season))].sort((a, b) => a - b), [episodes]);
  const [selected, setSelected] = useState(() => initialSeason(episodes, latest));
  const season = seasons.includes(selected) ? selected : seasons[0] ?? 1;
  const byRef = new Map<string, WatchProgress>();
  for (const p of progressList) {
    const key = `${p.ref.season}x${p.ref.episode}`;
    if (!byRef.has(key)) byRef.set(key, p);
  }
  return (
    <section class="detail-section episodes">
      <div class="row" style={{ gap: "14px" }}>
        <h3 class="t-title">Episodes</h3>
        <div class="row hscroll" style={{ gap: "2px" }}>
          {seasons.map((s) => (
            <HoverButton key={s} selected={s === season} class={`season-button${s === season ? " on" : ""}`} onClick={() => setSelected(s)}>
              Season {s}
            </HoverButton>
          ))}
        </div>
      </div>
      <div class="col" style={{ gap: "1px" }}>
        {episodes
          .filter((e) => e.season === season)
          .map((episode) => (
            <EpisodeRow key={episode.id} episode={episode} progress={byRef.get(`${episode.season}x${episode.episode}`) ?? null} title={title} />
          ))}
      </div>
    </section>
  );
}

function EpisodeRow({ episode, progress, title }: { episode: EpisodeInfo; progress: WatchProgress | null; title: Title }) {
  const model = useModel();
  const icon = progress?.finished ? "checkmark.circle.fill" : progress ? "circle.lefthalf.filled" : "circle";
  return (
    <HoverButton
      class="episode-row"
      onClick={() => {
        if (progress?.url) void model.resumeUrl(progress.url, progress.position);
        else void model.searchEverywhere(`${title.name} season ${episode.season} episode ${episode.episode}`, title.id);
      }}
    >
      <span style={{ width: "18px", color: progress ? "var(--ink)" : "var(--ink3)" }}>
        <Icon name={icon} size={15} />
      </span>
      <span class="time episode-number">{episode.episode}</span>
      <span class="episode-name line1">{episode.name ?? `Episode ${episode.episode}`}</span>
      <span class="spacer" />
      {progress && !progress.finished && !isVisitOnly(progress) && <span class="time episode-at">{Timecode.string(progress.position)}</span>}
    </HoverButton>
  );
}

/** A saved frame. Click to carry on from it. */
function MomentCell({ moment }: { moment: FilmFrame }) {
  const model = useModel();
  const session = useSession();
  const url = useFrameUrl(moment);
  const [hovered, hover] = useHover();
  const label = EpisodeRef.isEpisode(moment.ref) ? `${RefText.short(moment.ref)}, ${Timecode.string(moment.position)}` : Timecode.string(moment.position);
  return (
    <button
      type="button"
      class="moment-cell"
      aria-label={`Moment at ${label}`}
      onClick={() => moment.url && void model.resumeUrl(moment.url, moment.position)}
      {...hover}
      {...contextMenuProps(() => (
        <>
          {moment.url && <MenuItem onSelect={() => void model.resumeUrl(moment.url!, moment.position)}>Carry on from here</MenuItem>}
          <MenuItem onSelect={() => void copyImage(url).then((ok) => model.toast(ok ? "Image copied" : "Couldn't copy the image"))}>Copy image</MenuItem>
          <MenuItem onSelect={() => url && saveImage(url, `${session.library.titles.get(moment.titleId)?.name ?? "Moment"} ${label}.jpg`)}>Save image…</MenuItem>
          <MenuDivider />
          <MenuItem destructive onSelect={() => void session.library.deleteFrame(moment)}>
            Delete moment
          </MenuItem>
        </>
      ))}
    >
      <RemoteImage url={url} placeholder={<div style={{ position: "absolute", inset: "0", background: "var(--raised)" }} />} style={{ position: "absolute", inset: "0" }} />
      {hovered && <span class="moment-label time">{label}</span>}
    </button>
  );
}

/** Puts a frame on the clipboard (as PNG: the clipboard takes no JPEG). */
async function copyImage(url: string | null): Promise<boolean> {
  if (!url || typeof ClipboardItem === "undefined") return false;
  try {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

/** "Show in Finder" becomes saving the image where the browser saves downloads. */
function saveImage(url: string, name: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[/\\:?%*|"<>]/g, " ");
  link.click();
}
