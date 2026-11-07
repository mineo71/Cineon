// LibraryView.swift: status tabs with counts, kinds, genre/rating/decade filters, find and sort,
// then the posters (a virtualized adaptive grid) or the backlog as a checklist.

import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  LibraryKind,
  LibraryList,
  LibraryQuery,
  LibrarySort,
  RatingFilter,
  type Title,
} from "../../core/data";
import { Icon } from "../components/Icon";
import { HoverButton, IconButton, OutlineButton, SearchCapsule, SilverButton } from "../components/controls";
import { MenuDivider, MenuItem, menuButtonProps } from "../components/menu";
import { LogoMark } from "../components/media";
import { AdaptivePosterCell, ChecklistRow } from "../components/titles";
import { useLive, useModel, useSession, useWidth } from "../lib/hooks";
import { genreLabel, gridLayout, libraryEmptyText, librarySummary, listCount, visibleRows } from "../lib/library";
import { UiDefaults } from "../lib/session";
import { addStyles } from "../lib/styles";
import css from "./library.css";

addStyles(css);

type Layout = "grid" | "checklist";

export function LibraryView() {
  const model = useModel();
  const session = useSession();
  const downloads = useLive((l) => l.downloads);
  const [query, setQuery] = useState<LibraryQuery>(() => LibraryQuery.make());
  const [layout, setLayout] = useState<Layout>("grid");
  const [sort, setSortState] = useState<LibrarySort>(() => LibrarySort.fromRaw(UiDefaults.get("library.sort")) ?? "recent");
  const [headRef, headWidth] = useWidth<HTMLDivElement>();
  const setSort = (value: LibrarySort) => {
    setSortState(value);
    UiDefaults.set("library.sort", value);
  };

  const titles = session.library.titles;
  const inLists = useMemo(() => [...titles.values()].filter((t) => t.status !== "none"), [titles]);
  const downloaded = useMemo(
    () => new Set((downloads.value?.items ?? []).flatMap((d) => (d.status === "done" && d.titleId != null ? [d.titleId] : []))),
    [downloads.value],
  );
  const shown = useMemo(() => LibraryQuery.apply({ ...query, sort }, inLists, downloaded), [query, sort, inLists, downloaded]);
  const update = (change: Partial<LibraryQuery>) => setQuery((q) => ({ ...q, ...change }));

  // A narrow window first shortens the buttons, then lets the lists scroll sideways.
  const headStyle = headWidth >= 980 ? "regular" : headWidth >= 800 ? "compact" : "scroll";

  return (
    <div class="library">
      <div class="library-head" ref={headRef}>
        <div class={`lib-tabs-row ${headStyle}`}>
          <div class="lib-tabs hscroll">
            {LibraryList.allCases.map((list) => (
              <button
                key={list}
                type="button"
                class={`status-tab${query.list === list ? " selected" : ""}`}
                aria-pressed={query.list === list}
                onClick={() => {
                  update({ list });
                  setLayout(list === "backlog" ? "checklist" : "grid");
                }}
              >
                <span class="t-title">{LibraryList.label(list)}</span>
                <span class="time count">{listCount(titles.values(), list)}</span>
              </button>
            ))}
          </div>
          <span class="spacer" />
          <div class="lib-actions">
            <OutlineButton title="Rate films" aria-label="Rate films" onClick={() => model.go("rate")} icon="star.leadinghalf.filled">
              {headStyle === "regular" ? "Rate films" : null}
            </OutlineButton>
            <SilverButton title="Add a film" aria-label="Add a film" onClick={() => model.openSheet({ kind: "addTitle", query: null })} icon="plus">
              {headStyle === "regular" ? "Add a film" : null}
            </SilverButton>
          </div>
        </div>

        <div class="lib-filters">
          <div class="lib-filter-group">
            {LibraryKind.allCases.map((kind) => (
              <HoverButton key={kind} selected={query.kind === kind} class={`kind-button${query.kind === kind ? " on" : ""}`} onClick={() => update({ kind })}>
                {LibraryKind.label(kind)}
              </HoverButton>
            ))}
            <span class="filter-divider" />
            <GenreMenu titles={inLists} query={query} update={update} />
            <FilterMenu label={query.rating.kind === "any" ? "Rating" : RatingFilter.label(query.rating)} active={query.rating.kind !== "any"}>
              {RatingFilter.choices.map((choice) => (
                <MenuItem key={RatingFilter.label(choice)} checked={RatingFilter.equals(query.rating, choice)} onSelect={() => update({ rating: choice })}>
                  {RatingFilter.label(choice)}
                </MenuItem>
              ))}
            </FilterMenu>
            <FilterMenu label={query.decade != null ? `${query.decade}s` : "Decade"} active={query.decade != null}>
              <MenuItem checked={query.decade == null} onSelect={() => update({ decade: null })}>
                Any decade
              </MenuItem>
              <MenuDivider />
              {LibraryQuery.decadesIn(titles.values()).map((decade) => (
                <MenuItem key={decade} checked={query.decade === decade} onSelect={() => update({ decade: query.decade === decade ? null : decade })}>
                  {`${decade}s`}
                </MenuItem>
              ))}
            </FilterMenu>
            <HoverButton selected={query.onThisMac} class={`kind-button downloaded${query.onThisMac ? " on" : ""}`} onClick={() => update({ onThisMac: !query.onThisMac })}>
              <Icon name="arrow.down.circle" size={14} />
              Downloaded
            </HoverButton>
            {LibraryQuery.hasFilters(query) && (
              <HoverButton class="clear-button" onClick={() => setQuery(LibraryQuery.make({ list: query.list, kind: query.kind }))}>
                Clear
              </HoverButton>
            )}
          </div>
          <span class="spacer" />
          <div class="lib-filter-group">
            <SearchCapsule value={query.text} onInput={(text) => update({ text })} placeholder="Find in library" />
            <FilterMenu label={LibrarySort.label(sort)} icon="arrow.up.arrow.down" active={false}>
              {LibrarySort.allCases.map((value) => (
                <MenuItem key={value} checked={sort === value} onSelect={() => setSort(value)}>
                  {LibrarySort.label(value)}
                </MenuItem>
              ))}
            </FilterMenu>
            <IconButton
              icon={layout === "grid" ? "checklist" : "square.grid.2x2"}
              label={layout === "grid" ? "Show as checklist" : "Show as posters"}
              onClick={() => setLayout(layout === "grid" ? "checklist" : "grid")}
            />
          </div>
        </div>
        <span class="lib-summary">{librarySummary(shown)}</span>
      </div>

      {shown.length === 0 ? (
        <div class="empty-state">
          <LogoMark size={52} color="var(--ink3)" />
          <span>{libraryEmptyText(query)}</span>
          {LibraryQuery.hasFilters(query) ? (
            <OutlineButton style={{ marginTop: "4px" }} onClick={() => setQuery(LibraryQuery.make())}>
              Clear filters
            </OutlineButton>
          ) : query.list === "backlog" || query.list === "all" ? (
            <OutlineButton style={{ marginTop: "4px" }} onClick={() => model.openSheet({ kind: "addTitle", query: null })}>
              Add a film
            </OutlineButton>
          ) : null}
        </div>
      ) : layout === "grid" ? (
        <PosterGrid titles={shown} />
      ) : (
        <div class="lib-scroll scroll">
          <div class="checklist">
            {shown.map((title) => (
              <ChecklistRow key={title.id} title={title} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A quiet menu button for one filter, lit when it's narrowing the list (FilterMenu). */
export function FilterMenu({
  label,
  icon,
  active,
  children,
}: {
  label: string;
  icon?: string;
  active: boolean;
  children: ComponentChildren;
}) {
  return (
    <button type="button" class={`filter-menu${active ? " active" : ""}`} {...menuButtonProps(() => children)}>
      {icon && <Icon name={icon} size={12} />}
      <span class="line1">{label}</span>
      {!icon && <Icon name="chevron.down" size={9} />}
    </button>
  );
}

function GenreMenu({ titles, query, update }: { titles: readonly Title[]; query: LibraryQuery; update: (change: Partial<LibraryQuery>) => void }) {
  const genres = useMemo(() => LibraryQuery.genresIn(titles), [titles]);
  return (
    <FilterMenu label={genreLabel(query.genres)} active={query.genres.length > 0}>
      {query.genres.length > 0 && (
        <>
          <MenuItem onSelect={() => update({ genres: [] })}>Any genre</MenuItem>
          <MenuDivider />
        </>
      )}
      {genres.map((genre) => {
        const on = query.genres.includes(genre.name);
        return (
          <MenuItem
            key={genre.name}
            checked={on}
            onSelect={() => update({ genres: on ? query.genres.filter((g) => g !== genre.name) : [...query.genres, genre.name] })}
          >
            {genre.name}
            <span class="spacer" />
            <span class="time" style={{ color: "var(--ink3)", marginLeft: "12px" }}>
              {genre.count}
            </span>
          </MenuItem>
        );
      })}
      {genres.length === 0 && <div class="menu-header">Genres appear once Cineon finds your films' details</div>}
    </FilterMenu>
  );
}

const ROW_SPACING = 24;
const GRID_PADDING = 32;

/** LazyVGrid(adaptive 138–190, spacing 18, rows 24 apart), building only the rows near the screen. */
function PosterGrid({ titles }: { titles: readonly Title[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [viewport, setViewport] = useState(800);
  const [scrollTop, setScrollTop] = useState(0);
  const frame = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      setWidth(Math.max(0, element.clientWidth - GRID_PADDING * 2));
      setViewport(element.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
  }, []);

  const layout = gridLayout(width, titles.length);
  const { first, last } = visibleRows(layout, scrollTop, viewport, ROW_SPACING);
  const rows: Title[][] = [];
  for (let row = first; row <= last; row++) rows.push(titles.slice(row * layout.columns, (row + 1) * layout.columns) as Title[]);

  return (
    <div
      ref={scroller}
      class="lib-scroll scroll"
      onScroll={(event) => {
        const top = (event.currentTarget as HTMLDivElement).scrollTop;
        if (frame.current != null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => setScrollTop(top));
      }}
    >
      <div class="poster-grid" style={{ height: `${layout.height + 40}px` }}>
        {rows.map((items, index) => {
          const row = first + index;
          return (
            <div
              key={row}
              class="grid-row"
              style={{ top: `${row * (layout.rowHeight + ROW_SPACING)}px`, height: `${layout.rowHeight}px`, gap: "18px" }}
            >
              {items.map((title) => (
                <AdaptivePosterCell key={title.id} title={title} width={layout.itemWidth} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
