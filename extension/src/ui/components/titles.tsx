// Titles wherever they appear: the menu every title has, Home's poster cell and shelf, the
// Library's adaptive cell with quick-rate stars, the backlog checklist row and the status picker.

import { type Title, TitleStatus, type WatchProgress } from "../../core/data";
import { useModel, useHover, useSession } from "../lib/hooks";
import { checklistDetail, posterSubtitle } from "../lib/library";
import { isVisitOnly } from "../lib/format";
import { OutlineButton } from "./controls";
import { Icon } from "./Icon";
import { MenuDivider, MenuItem, contextMenuProps, menuButtonProps } from "./menu";
import { PosterImage, ProgressLine, RatingBadge, StarRatingControl } from "./media";
import type { Route } from "../lib/app";

/** The same set of actions wherever a title appears (TitleMenu). */
export function TitleMenuItems({ title }: { title: Title }) {
  const model = useModel();
  const latest = model.library.latestProgress(title.id);
  return (
    <>
      {latest?.url && <MenuItem onSelect={() => model.resume(title)}>Resume</MenuItem>}
      <MenuItem onSelect={() => void model.searchEverywhere(title.name, title.id)}>Find on my sites</MenuItem>
      <MenuDivider />
      <MenuItem disabled={title.status === "backlog"} onSelect={() => void model.setStatus(title.id, "backlog")}>
        Move to backlog
      </MenuItem>
      <MenuItem disabled={title.status === "watching"} onSelect={() => void model.setStatus(title.id, "watching")}>
        Move to watching
      </MenuItem>
      <MenuItem disabled={title.status === "watched"} onSelect={() => void model.setStatus(title.id, "watched")}>
        Mark as watched
      </MenuItem>
      <MenuDivider />
      <MenuItem onSelect={() => void model.remove(title.id)}>Remove from library</MenuItem>
    </>
  );
}

export function titleContextMenu(title: Title) {
  return contextMenuProps(() => <TitleMenuItems title={title} />);
}

/** Home's poster: lifts a little on hover; right-click is the title menu. */
export function PosterCell({
  title,
  width = 150,
  showProgress = false,
  badge = null,
}: {
  title: Title;
  width?: number;
  showProgress?: boolean;
  badge?: string | null;
}) {
  const model = useModel();
  const [hovered, hover] = useHover();
  const progress: WatchProgress | null = showProgress || title.status === "watching" ? model.library.latestProgress(title.id) : null;
  return (
    <button
      type="button"
      class={`poster-cell${hovered ? " hovered" : ""}`}
      style={{ width: `${width}px` }}
      aria-label={title.name}
      onClick={() => model.openTitle(title.id)}
      {...hover}
      {...titleContextMenu(title)}
    >
      <div class="poster-lift">
        <PosterImage title={title} width={width} keepsColour={badge != null}>
          {title.ratingHalves != null && (
            <span class="corner top-left">
              <RatingBadge halves={title.ratingHalves} />
            </span>
          )}
          {badge && <span class="corner bottom-left poster-badge">{badge}</span>}
        </PosterImage>
      </div>
      {progress && !isVisitOnly(progress) && <ProgressLine fraction={progress.duration > 0 ? progress.position / progress.duration : 0} height={2} width={width} />}
      <span class="cell-name line1">{title.name}</span>
      <span class="cell-sub line1">{posterSubtitle(title, progress)}</span>
    </button>
  );
}

/** A named row of posters that scrolls sideways (PosterShelf). */
export function PosterShelf({
  name,
  titles,
  showProgress = false,
  destination = null,
  badges = null,
}: {
  name: string;
  titles: readonly Title[];
  showProgress?: boolean;
  destination?: Route | null;
  badges?: ReadonlyMap<number, string> | null;
}) {
  const model = useModel();
  return (
    <section class="shelf">
      <div class="shelf-head">
        <h2 class="t-title">{name}</h2>
        <span class="spacer" />
        {destination && (
          <button type="button" class="btn-plain show-all" onClick={() => model.go(destination)}>
            Show all
          </button>
        )}
      </div>
      <div class="shelf-row hscroll">
        {titles.map((title) => (
          <PosterCell key={title.id} title={title} width={138} showProgress={showProgress} badge={badges?.get(title.id) ?? null} />
        ))}
      </div>
    </section>
  );
}

/** Stars across the bottom of a poster, to rate it without opening it (always dark). */
export function QuickRate({ title }: { title: Title }) {
  const model = useModel();
  return (
    <div class="quick-rate" data-theme-dark onClick={(event) => event.stopPropagation()}>
      <StarRatingControl
        halves={title.ratingHalves}
        size={9.5}
        spacing={1.5}
        showsValue={false}
        label={`Rate ${title.name}`}
        onChange={(value) => void model.library.setRating(title.id, value)}
      />
    </div>
  );
}

/** The library's poster: fills its column, quick-rate stars on hover for watched and watching. */
export function AdaptivePosterCell({ title, width }: { title: Title; width: number }) {
  const model = useModel();
  const [hovered, hover] = useHover();
  const progress = title.status === "watching" ? model.library.latestProgress(title.id) : null;
  return (
    <div
      class={`poster-cell adaptive${hovered ? " hovered" : ""}`}
      style={{ width: `${width}px` }}
      role="button"
      tabIndex={0}
      aria-label={title.name}
      onClick={() => model.openTitle(title.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter") model.openTitle(title.id);
      }}
      {...hover}
      {...titleContextMenu(title)}
    >
      <div class="poster-lift small">
        <PosterImage title={title} width={width}>
          {title.ratingHalves != null && (
            <span class="corner top-left">
              <RatingBadge halves={title.ratingHalves} />
            </span>
          )}
          {hovered && (title.status === "watched" || title.status === "watching") && <QuickRate title={title} />}
        </PosterImage>
      </div>
      {progress && !isVisitOnly(progress) ? (
        <ProgressLine fraction={progress.duration > 0 ? progress.position / progress.duration : 0} height={2} />
      ) : (
        <span class="progress-slot" />
      )}
      <span class="cell-name line1">{title.name}</span>
      <span class="cell-sub line1">{title.year != null ? String(title.year) : TitleStatusKind(title)}</span>
    </div>
  );
}

function TitleStatusKind(title: Title): string {
  return { film: "Film", series: "Series", cartoon: "Cartoon", unknown: "Unsorted" }[title.kind];
}

/** Backlog as a real checklist. Ticking a film marks it watched, and it moves across. */
export function ChecklistRow({ title }: { title: Title }) {
  const model = useModel();
  const [hovered, hover] = useHover();
  const isDone = title.status === "watched";
  return (
    <div class={`checklist-row${hovered ? " hovered" : ""}`} {...hover} {...titleContextMenu(title)}>
      <button
        type="button"
        class="check-button"
        aria-label={isDone ? `Mark ${title.name} as not watched` : `Mark ${title.name} as watched`}
        onClick={() => {
          void model.setStatus(title.id, isDone ? "backlog" : "watched");
          if (!isDone) model.toast(`Marked ${title.name} as watched`);
        }}
      >
        <Icon name={isDone ? "checkmark.circle.fill" : "circle"} size={22} />
      </button>
      <button type="button" class="checklist-main" onClick={() => model.openTitle(title.id)}>
        <PosterImage title={title} width={34} radius={3} />
        <span class="col" style={{ gap: "2px", minWidth: 0, flex: "1 1 auto" }}>
          <span class="t-title line1" style={{ fontSize: "16px", color: "var(--ink)" }}>
            {title.name}
          </span>
          <span class="line1" style={{ fontSize: "12px", color: "var(--ink3)" }}>
            {checklistDetail(title)}
          </span>
        </span>
        {title.ratingHalves != null && <RatingBadge halves={title.ratingHalves} />}
      </button>
      {hovered && (
        <OutlineButton class="fade-in" onClick={() => void model.searchEverywhere(title.name, title.id)}>
          Find on my sites
        </OutlineButton>
      )}
    </div>
  );
}

/** Which list a title is in, as a menu (StatusPicker). */
export function StatusPicker({ title }: { title: Title }) {
  const model = useModel();
  useSession();
  return (
    <button
      type="button"
      class="status-picker"
      {...menuButtonProps(() =>
        (["backlog", "watching", "watched"] as const).map((status) => (
          <MenuItem key={status} checked={title.status === status} onSelect={() => void model.setStatus(title.id, status)}>
            {TitleStatus.label(status)}
          </MenuItem>
        )),
      )}
    >
      {title.status === "none" ? "Add to a list" : TitleStatus.label(title.status)}
      <Icon name="chevron.down" size={10} />
    </button>
  );
}
