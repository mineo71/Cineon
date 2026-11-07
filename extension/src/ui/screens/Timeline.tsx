// WatchTimelineView.swift: everything you've watched, as one long strip of film. Row heights are
// multiples of the perforation pitch, so the holes line up from row to row.

import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type FilmFrame, type HistoryEntry, LibraryEventKind, Timecode, type WatchSession } from "../../core/data";
import { Switch, OutlineButton, SearchCapsule, SilverButton } from "../components/controls";
import { MenuDivider, MenuItem, contextMenuProps } from "../components/menu";
import { FILM_PITCH, FilmStripBody, LogoMark, ProgressLine, RemoteImage, useFrameUrl } from "../components/media";
import { TitleMenuItems } from "../components/titles";
import { DateText } from "../lib/format";
import { useHover, useModel, useSession, useTask } from "../lib/hooks";
import { addStyles } from "../lib/styles";
import {
  type TimelineEntry,
  canResume,
  heroFrame,
  reels as reelsFor,
  scrubIndex,
  sessionFraction,
  sessionStill,
  sessionSubtitle,
  sessionWhere,
  startOfMonth,
  startOfWeek,
  statText,
  timelineDays,
  visitName,
  watchedSince,
} from "../lib/timeline";
import css from "./timeline.css";

addStyles(css);

/** Wide enough for a 16:9 frame between the perforations. */
const STRIP_WIDTH = 190;
const FRAME_WIDTH = 156;
const FRAME_HEIGHT = FILM_PITCH * 6 - 8;
const ROW_HEIGHT = FILM_PITCH * 6;

export function TimelineView() {
  const session = useSession();
  const library = session.library;
  const [showBrowsing, setShowBrowsing] = useState(false);
  const [query, setQuery] = useState("");
  const [visits] = useTask(
    () => (showBrowsing ? session.db.recentHistory(300).catch(() => [] as HistoryEntry[]) : Promise.resolve([] as HistoryEntry[])),
    [showBrowsing, session.version],
    [] as HistoryEntry[],
  );
  const days = useMemo(
    () => timelineDays(library.sessions, library.events, showBrowsing ? visits : null, library.titles, query),
    [library.sessions, library.events, library.titles, visits, showBrowsing, query],
  );
  const now = new Date();
  const week = watchedSince(library.sessions, startOfWeek(now));
  const month = watchedSince(library.sessions, startOfMonth(now));

  return (
    <div class="timeline">
      <div class="timeline-head">
        <div class="row timeline-title-row">
          <h1 class="t-title">Timeline</h1>
          <span class="spacer" />
          <label class="row browse-toggle">
            <span>Show pages I browsed</span>
            <Switch mini on={showBrowsing} onChange={setShowBrowsing} label="Show pages I browsed" />
          </label>
          <SearchCapsule value={query} onInput={setQuery} placeholder="Filter" width={120} rounded="rect" />
        </div>
        {(month > 0 || week > 0) && (
          <div class="row timeline-stats">
            <span>
              <span class="ink3">This week</span> <span class="ink">{statText(week)}</span>
            </span>
            <span>
              <span class="ink3">This month</span> <span class="ink">{statText(month)}</span>
            </span>
          </div>
        )}
      </div>
      {days.length === 0 ? (
        <div class="empty-state">
          <LogoMark size={52} color="var(--ink3)" />
          <span style={{ maxWidth: "380px" }}>Play something on any site, and it's recorded here: what, where, and how far you got.</span>
        </div>
      ) : (
        <div class="timeline-scroll scroll">
          {days.map((day) => (
            <div key={day.id}>
              <TimelineDayHeader day={day.id} />
              {day.entries.map((entry) => (
                <TimelineEntryRow key={entry.id} entry={entry} />
              ))}
            </div>
          ))}
          {/* The strip runs off the end of the roll. */}
          <FilmStripBody width={STRIP_WIDTH} height={FILM_PITCH * 6} style={{ marginLeft: "32px" }} />
          <div class="roll-end-fade" />
        </div>
      )}
    </div>
  );
}

function TimelineEntryRow({ entry }: { entry: TimelineEntry }) {
  const session = useSession();
  switch (entry.kind) {
    case "session":
      return (
        <LazyMount height={sessionHeight(session.library.frames(entry.session.id).length, entry.session.watchedSeconds)}>
          <TimelineSessionRow session={entry.session} />
        </LazyMount>
      );
    case "event":
      return (
        <TimelineNoteRow
          time={entry.event.at}
          text={LibraryEventKind.label(entry.event.kind)}
          name={session.library.titles.get(entry.event.titleId)?.name ?? ""}
        />
      );
    case "visit":
      return <TimelineNoteRow time={entry.visit.visitedAt} text={entry.visit.host} name={visitName(entry.visit)} />;
  }
}

function sessionHeight(frameCount: number, watchedSeconds: number): number {
  if (frameCount === 0) return ROW_HEIGHT;
  return ROW_HEIGHT * Math.min(3, frameCount, Math.trunc(watchedSeconds / 1500) + 1);
}

/** Builds its row once it comes near the screen (LazyVStack), so a long timeline stays light. */
function LazyMount({ height, children }: { height: number; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (shown || !box.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [shown]);
  if (shown) return <>{children}</>;
  return (
    <div ref={box} class="lazy-row" style={{ height: `${height}px` }}>
      <FilmStripBody width={STRIP_WIDTH} height={height} />
    </div>
  );
}

/** A day heading sits beside a clear stretch of film, like the gap between shots. */
function TimelineDayHeader({ day }: { day: number }) {
  return (
    <div class="row day-header">
      <FilmStripBody width={STRIP_WIDTH} height={FILM_PITCH * 4} />
      <span class="t-title day-name">{DateText.day(day)}</span>
    </div>
  );
}

function TimelineSessionRow({ session }: { session: WatchSession }) {
  const model = useModel();
  const store = useSession();
  const [hovered, hover] = useHover();
  const title = store.library.titles.get(session.titleId) ?? null;
  const reels = reelsFor(store.library.frames(session.id), session.watchedSeconds);
  const multi = reels.length > 1;
  const subtitle = sessionSubtitle(session);
  return (
    <div
      class={`row session-row${multi ? " multi" : ""}`}
      {...hover}
      onClick={() => {
        if (title) model.openTitle(title.id);
      }}
      {...contextMenuProps(() => (
        <>
          {title && <TitleMenuItems title={title} />}
          <MenuDivider />
          <MenuItem onSelect={() => void store.library.deleteSession(session.id)}>Remove from timeline</MenuItem>
        </>
      ))}
    >
      {reels.length === 0 ? (
        <FilmStripBody width={STRIP_WIDTH} height={ROW_HEIGHT} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <RemoteImage
            url={sessionStill(session, title)}
            class={`film-frame${session.finished && !hovered ? " mono" : ""}`}
            placeholder={<span class="unexposed" />}
          />
        </FilmStripBody>
      ) : (
        <div class="col reels">
          {reels.map((frames, index) => (
            <FrameReel key={index} frames={frames} duration={session.duration} fallbackUrl={session.url} isMono={session.finished && !hovered} />
          ))}
        </div>
      )}
      <div class="col session-details">
        <span class="t-title session-name line1">{title?.name ?? "Removed title"}</span>
        {subtitle && <span class="session-sub line1">{subtitle}</span>}
        <span class="time session-where line1">{sessionWhere(session)}</span>
        {session.duration > 0 && <ProgressLine fraction={sessionFraction(session)} height={2} width={180} style={{ marginTop: "4px" }} />}
      </div>
      <span class="spacer" style={{ minWidth: "12px" }} />
      {hovered && (
        <div class="session-actions fade-in" onClick={(event) => event.stopPropagation()}>
          {canResume(session) && session.url ? (
            <SilverButton icon="play.fill" onClick={() => void model.resumeUrl(session.url!, session.endPosition)}>
              {`Resume at ${Timecode.string(session.endPosition)}`}
            </SilverButton>
          ) : session.url ? (
            <OutlineButton onClick={() => void model.openUrl(session.url!)}>Open page</OutlineButton>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * One frame in the film strip. Moving across it flips through the frames around it, and clicking
 * carries on from the second that frame shows.
 */
function FrameReel({
  frames,
  duration,
  fallbackUrl,
  isMono,
}: {
  frames: readonly FilmFrame[];
  duration: number;
  fallbackUrl: string | null;
  isMono: boolean;
}) {
  const model = useModel();
  const [scrub, setScrub] = useState<number | null>(null);
  const [primed, setPrimed] = useState(false);
  const hero = heroFrame(frames, duration)!;
  const shown = scrub != null ? frames[Math.min(scrub, frames.length - 1)]! : hero;
  const url = useFrameUrl(shown);
  return (
    <FilmStripBody width={STRIP_WIDTH} height={ROW_HEIGHT} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        class="frame-hit"
        role="button"
        tabIndex={0}
        title={`Carry on from ${Timecode.string(shown.position)}`}
        aria-label={`Frame at ${Timecode.string(shown.position)}`}
        onMouseMove={(event) => {
          if (frames.length <= 1) return;
          setPrimed(true);
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          setScrub(scrubIndex(event.clientX - rect.left, FRAME_WIDTH, frames.length));
        }}
        onMouseLeave={() => setScrub(null)}
        onClick={(event) => {
          event.stopPropagation();
          const target = shown.url ?? fallbackUrl;
          if (target) void model.resumeUrl(target, shown.position);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.stopPropagation();
          const target = shown.url ?? fallbackUrl;
          if (target) void model.resumeUrl(target, shown.position);
        }}
      >
        <RemoteImage url={url} class={`film-frame${isMono ? " mono" : ""}`} placeholder={<span class="unexposed" />} />
        {scrub != null && <span class="time scrub-time">{Timecode.string(shown.position)}</span>}
        {/* Loaded the moment the pointer arrives, so scrubbing never shows an empty frame. */}
        {primed && frames.map((frame) => <FramePreload key={frame.id} frame={frame} />)}
      </div>
    </FilmStripBody>
  );
}

function FramePreload({ frame }: { frame: FilmFrame }) {
  useFrameUrl(frame);
  return null;
}

/** Smaller moments: added to backlog, marked as watched, a page visited. */
function TimelineNoteRow({ time, text, name }: { time: number; text: string; name: string }) {
  return (
    <div class="row note-row">
      <FilmStripBody width={STRIP_WIDTH} height={FILM_PITCH * 2} />
      <div class="row note-text">
        <span class="time ink3" style={{ fontSize: "12px" }}>
          {DateText.time(time)}
        </span>
        <span class="ink3">{`${text}:`}</span>
        <span class="note-name line1">{name}</span>
      </div>
    </div>
  );
}

export { FRAME_HEIGHT, FRAME_WIDTH, STRIP_WIDTH };
