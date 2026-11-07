// Sheets.swift: adding and editing sites, adding a title from the catalogue, fixing what a tab is
// showing, and picking a challenge. ImportSheet.swift is in Import.tsx.

import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type EpisodeRef, LibraryText, type Site, type Title, TitleKind, TitleStatus } from "../../core/data";
import { MetadataClient, type MetadataHit } from "../../core/metadata";
import { send } from "../../shared/messages";
import { HoverButton, IconButton, OutlineButton, SilverButton, TextField } from "../components/controls";
import { CardPoster, PosterImage } from "../components/media";
import { NO_BACKGROUND, type Sheet } from "../lib/app";
import { directUrl } from "../lib/format";
import { useModel, useSession } from "../lib/hooks";
import { addStyles } from "../lib/styles";
import { ImportSheet } from "./Import";
import css from "./sheets.css";

addStyles(css);

export function SheetHost({ sheet }: { sheet: Sheet }) {
  switch (sheet.kind) {
    case "addSite":
      return <AddSiteSheet prefill={sheet.prefill} />;
    case "editSite":
      return <EditSiteSheetFor siteId={sheet.siteId} />;
    case "addTitle":
      return <AddTitleSheet initial={sheet.query} />;
    case "relink":
      return <RelinkSheet tabId={sheet.tabId} />;
    case "import":
      return <ImportSheet />;
    case "newChallenge":
      return <NewChallengeSheet />;
  }
}

/** SheetFrame: the heading, a close button, and the sheet's content in glass. */
export function SheetFrame({ heading, width = 480, children }: { heading: string; width?: number; children: ComponentChildren }) {
  const model = useModel();
  return (
    <div class="sheet glass" role="dialog" aria-label={heading} style={{ width: `${width}px` }}>
      <div class="row">
        <h2 class="t-title sheet-heading line1">{heading}</h2>
        <span class="spacer" />
        <IconButton icon="xmark" label="Close" onClick={() => model.openSheet(null)} />
      </div>
      {children}
    </div>
  );
}

function FieldLabel({ text }: { text: string }) {
  return <span class="field-label">{text}</span>;
}

// MARK: Catalogue search

/**
 * `debouncedSearch`: waits for a 220 ms pause in typing, then asks the catalogue. Two letters at
 * least; an answer to text that has since changed is dropped.
 */
export function useCatalogueSearch(text: string, enabled = true): { hits: MetadataHit[]; isSearching: boolean } {
  const [hits, setHits] = useState<MetadataHit[]>([]);
  const [isSearching, setSearching] = useState(false);
  useEffect(() => {
    if (!enabled || [...text].length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      MetadataClient.shared
        .search(text, controller.signal)
        .then(
          (found) => {
            if (!controller.signal.aborted) setHits(found);
          },
          () => {
            if (!controller.signal.aborted) setHits([]);
          },
        )
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, enabled]);
  return { hits, isSearching };
}

/** The year, or "2014, series" (MetadataResults.subtitle). */
export function hitSubtitle(hit: Pick<MetadataHit, "year" | "kind">): string {
  const year = hit.year != null ? String(hit.year) : "";
  return hit.kind === "series" ? (year.length === 0 ? "Series" : `${year}, series`) : year;
}

function MetadataResults({
  hits,
  isSearching,
  query,
  pick,
}: {
  hits: readonly MetadataHit[];
  isSearching: boolean;
  query: string;
  pick: (hit: MetadataHit) => void;
}) {
  if (hits.length === 0) {
    if ([...query].length >= 2 && !isSearching) {
      return <p class="no-matches">No matches yet. You can still add it by name.</p>;
    }
    return null;
  }
  return (
    <div class="hits hscroll">
      {hits.map((hit) => (
        <button key={hit.id} type="button" class="hit" onClick={() => pick(hit)}>
          <CardPoster url={hit.posterUrl} name={hit.name} width={94} height={141} radius={5} />
          <span class="hit-name line2">{hit.name}</span>
          <span class="hit-sub line1">{hitSubtitle(hit)}</span>
        </button>
      ))}
    </div>
  );
}

// MARK: Challenges

/** Picks the film or series to race friends through. */
function NewChallengeSheet() {
  const model = useModel();
  const session = useSession();
  const [query, setQuery] = useState("");
  const library = session.library;
  const candidates = useMemo(() => {
    const needle = LibraryText.normalize(query);
    return [...library.watching, ...library.backlog].filter((t) => needle.length === 0 || t.normName.includes(needle)).slice(0, 40);
  }, [library.titles, query]);

  const start = async (title: Title) => {
    model.openSheet(null);
    const answer = await send("together.createChallenge", { titleId: title.id }, { timeoutMs: 15_000 });
    if (!answer) model.toast(NO_BACKGROUND);
  };

  return (
    <SheetFrame heading="Who finishes first?" width={560}>
      <p class="sheet-text">Choose something from Watching or your backlog. Everyone who joins races from where they are now.</p>
      <TextField
        value={query}
        onInput={setQuery}
        placeholder="Filter"
        autoFocus
        onSubmit={() => {
          const first = candidates[0];
          if (first) void start(first);
        }}
      />
      <div class="challenge-list scroll">
        {candidates.map((title) => (
          <HoverButton key={title.id} class="challenge-row" onClick={() => void start(title)}>
            <PosterImage title={title} width={30} radius={3} />
            <span class="col" style={{ gap: "2px", minWidth: 0 }}>
              <span class="line1" style={{ fontSize: "13.5px", fontWeight: 500, color: "var(--ink)" }}>
                {title.name}
              </span>
              <span style={{ fontSize: "11.5px", color: "var(--ink3)" }}>
                {[TitleKind.label(title.kind), title.year != null ? String(title.year) : null].filter(Boolean).join(", ")}
              </span>
            </span>
            <span class="spacer" />
            <span style={{ fontSize: "11.5px", color: "var(--ink3)" }}>{TitleStatus.label(title.status)}</span>
          </HoverButton>
        ))}
        {candidates.length === 0 && <p class="challenge-empty">Nothing here yet. Add something to your backlog first.</p>}
      </div>
    </SheetFrame>
  );
}

// MARK: Sites

function AddSiteSheet({ prefill }: { prefill: string | null }) {
  const model = useModel();
  const session = useSession();
  const [address, setAddress] = useState(prefill ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  const add = async () => {
    const url = directUrl(address.trim());
    if (!url) {
      setProblem("That doesn't look like a web address. Try something like example.com.");
      return;
    }
    const site = await session.library.addSite(url);
    if (!site) {
      setProblem("Couldn't add that site.");
      return;
    }
    model.openSheet(null);
    void model.openSite(site);
  };

  return (
    <SheetFrame heading="Add a site">
      <div class="col" style={{ gap: "6px" }}>
        <FieldLabel text="Address" />
        <TextField value={address} onInput={setAddress} onSubmit={() => void add()} placeholder="example.com" autoFocus label="Address" />
        {problem && <span style={{ fontSize: "12px", color: "var(--ink2)" }}>{problem}</span>}
        <span style={{ fontSize: "12px", color: "var(--ink3)", marginTop: "2px" }}>Cineon learns how the site searches the first time you open it.</span>
      </div>
      <div class="row">
        <span class="spacer" />
        <SilverButton onClick={() => void add()}>Add site</SilverButton>
      </div>
    </SheetFrame>
  );
}

function EditSiteSheetFor({ siteId }: { siteId: number }) {
  const session = useSession();
  const site = session.library.sites.find((s) => s.id === siteId);
  return site ? <EditSiteSheet site={site} /> : null;
}

/** The host an edited address gives: lower-cased by the URL reader, without `www.`. */
export function editedHost(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    if (!host) return null;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function EditSiteSheet({ site }: { site: Site }) {
  const model = useModel();
  const session = useSession();
  const [name, setName] = useState(site.name);
  const [address, setAddress] = useState(site.homeUrl);
  const [searchTemplate, setSearchTemplate] = useState(site.searchTemplate ?? "");

  const save = () => {
    let updated: Site = { ...site, name: name.length === 0 ? site.name : name };
    const url = directUrl(address.trim());
    const host = url ? editedHost(url) : null;
    if (url && host) updated = { ...updated, homeUrl: url, host };
    const template = searchTemplate.trim();
    updated = { ...updated, searchTemplate: template.length === 0 ? null : template };
    void session.library.updateSite(updated);
    model.openSheet(null);
  };

  return (
    <SheetFrame heading="Edit site">
      <div class="col" style={{ gap: "6px" }}>
        <FieldLabel text="Name" />
        <TextField value={name} onInput={setName} onSubmit={save} placeholder="Name" />
      </div>
      <div class="col" style={{ gap: "6px" }}>
        <FieldLabel text="Address" />
        <TextField value={address} onInput={setAddress} onSubmit={save} placeholder="https://example.com" label="Address" />
      </div>
      <div class="col" style={{ gap: "6px" }}>
        <FieldLabel text="Search address" />
        <TextField value={searchTemplate} onInput={setSearchTemplate} onSubmit={save} placeholder="https://example.com/search?q=%s" label="Search address" />
        <span style={{ fontSize: "12px", color: "var(--ink3)" }}>Use %s where the search words go. Leave it empty, and Cineon learns it from the site.</span>
      </div>
      <div class="row">
        <OutlineButton
          onClick={() => {
            void session.library.removeSite(site.id);
            model.openSheet(null);
          }}
        >
          Remove site
        </OutlineButton>
        <span class="spacer" />
        <SilverButton onClick={save}>Save</SilverButton>
      </div>
    </SheetFrame>
  );
}

// MARK: Titles

/** Search the catalogue and add, or just type a name and add it by hand. */
function AddTitleSheet({ initial }: { initial: string | null }) {
  const model = useModel();
  const [query, setQuery] = useState(initial ?? "");
  const trimmed = query.trim();
  const { hits, isSearching } = useCatalogueSearch(trimmed);

  const addManually = async () => {
    const title = await model.addByName(trimmed, "backlog");
    if (!title) return;
    model.toast(`Added ${title.name} to backlog`);
    model.openSheet(null);
  };

  const addFirst = () => {
    const first = hits[0];
    if (first) {
      void model.addToBacklog(first);
      model.openSheet(null);
    } else if (trimmed.length > 0) {
      void addManually();
    }
  };

  return (
    <SheetFrame heading="Add to backlog" width={620}>
      <TextField value={query} onInput={setQuery} onSubmit={addFirst} placeholder="Film or series name" autoFocus />
      <MetadataResults
        hits={hits}
        isSearching={isSearching}
        query={trimmed}
        pick={(hit) => {
          void model.addToBacklog(hit);
          model.openSheet(null);
        }}
      />
      <div class="row">
        <span class="spacer" />
        {trimmed.length > 0 && <OutlineButton onClick={() => void addManually()}>{`Add “${trimmed}” by name`}</OutlineButton>}
      </div>
    </SheetFrame>
  );
}

/** The episode the season and episode fields name (0 when empty or not a number). */
export function enteredRef(season: string, episode: string): EpisodeRef {
  const read = (text: string) => {
    const n = Number.parseInt(text.trim(), 10);
    return Number.isFinite(n) && /^\s*[+-]?\d+\s*$/.test(text) ? n : 0;
  };
  return { season: read(season), episode: read(episode) };
}

/** "That's not what this page is showing." Corrects the recognised title. */
function RelinkSheet({ tabId }: { tabId: number }) {
  const model = useModel();
  const session = useSession();
  const [query, setQuery] = useState("");
  const [season, setSeason] = useState("");
  const [episode, setEpisode] = useState("");
  const [hasTab, setHasTab] = useState(true);
  const trimmed = query.trim();
  const { hits, isSearching } = useCatalogueSearch(trimmed);
  const libraryMatches = useMemo(() => session.library.search(trimmed, 4), [session.library.titles, trimmed]);

  useEffect(() => {
    let cancelled = false;
    void send("tab.state", { tabId }).then((answer) => {
      if (cancelled) return;
      const tab = answer?.tab ?? null;
      setHasTab(answer == null || tab != null);
      const parsed = tab?.parsed;
      if (!parsed) return;
      setQuery((current) => (current.length === 0 ? parsed.name : current));
      if (parsed.ref.season > 0 || parsed.ref.episode > 0) {
        setSeason(String(parsed.ref.season));
        setEpisode(String(parsed.ref.episode));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tabId]);

  const link = async (id: number) => {
    const answer = await send("tracker.relink", { tabId, titleId: id, ref: enteredRef(season, episode) });
    if (!answer) {
      model.toast(NO_BACKGROUND);
      return;
    }
    model.toast(`Now tracking ${session.library.titles.get(id)?.name ?? "this title"}`);
    model.openSheet(null);
  };

  return (
    <SheetFrame heading="What's playing here?" width={620}>
      <TextField value={query} onInput={setQuery} placeholder="Film or series name" autoFocus />
      <div class="row" style={{ gap: "10px" }}>
        <FieldLabel text="For a series" />
        <TextField value={season} onInput={setSeason} placeholder="Season" style={{ width: "84px" }} label="Season" />
        <TextField value={episode} onInput={setEpisode} placeholder="Episode" style={{ width: "84px" }} label="Episode" />
        <span class="spacer" />
      </div>

      {libraryMatches.length > 0 && (
        <div class="col" style={{ gap: "2px" }}>
          <FieldLabel text="In your library" />
          {libraryMatches.map((title) => (
            <HoverButton key={title.id} class="relink-row" onClick={() => void link(title.id)}>
              <PosterImage title={title} width={22} radius={2} />
              <span class="line1" style={{ fontSize: "13px", color: "var(--ink)" }}>
                {title.name}
              </span>
              <span class="spacer" />
            </HoverButton>
          ))}
        </div>
      )}

      <MetadataResults
        hits={hits}
        isSearching={isSearching}
        query={trimmed}
        pick={async (hit) => {
          const title = await session.library.addTitle(hit.name, {
            year: hit.year,
            kind: hit.kind,
            status: "watching",
            imdbId: hit.id,
            posterUrl: hit.posterUrl,
          });
          if (!title) return;
          void session.metadata.apply(hit, title.id);
          await link(title.id);
        }}
      />

      <div class="row">
        {hasTab && (
          <OutlineButton
            onClick={async () => {
              const answer = await send("tracker.ignore", { tabId });
              if (!answer) model.toast(NO_BACKGROUND);
              model.openSheet(null);
            }}
          >
            This isn't a film
          </OutlineButton>
        )}
        <span class="spacer" />
        {trimmed.length > 0 && (
          <OutlineButton
            onClick={async () => {
              const title = await session.library.addTitle(trimmed, { status: "watching" });
              if (title) await link(title.id);
            }}
          >
            {`Use “${trimmed}”`}
          </OutlineButton>
        )}
      </div>
    </SheetFrame>
  );
}
