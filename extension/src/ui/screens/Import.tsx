// ImportSheet.swift: brings in what this browser already knows, and Cineon libraries exported on a
// Mac, on Windows or here. Nothing from the history is written until you've reviewed the list and
// pressed Import.

import { useEffect, useRef, useState } from "preact/hooks";
import { EpisodeRef, LibraryExport, type TitleStatus } from "../../core/data";
import { Icon } from "../components/Icon";
import { Checkbox, HoverButton, IconButton, OutlineButton, Picker, SilverButton, Spinner } from "../components/controls";
import { DateText, RefText, grouped } from "../lib/format";
import { useModel, useSession } from "../lib/hooks";
import {
  DISTANT_PAST,
  type HistoryItemLike,
  ImportAnalyzer,
  type ImportScan,
  type ImportSiteCandidate,
  type ImportTitleCandidate,
  ImportTitleCandidate as Candidate,
  pagesFromHistory,
} from "../lib/importAnalyzer";
import { applyImport, fileImportSummary, importSummary } from "../lib/importApply";
import { shortcut } from "../lib/platform";
import { addStyles } from "../lib/styles";
import css from "./import.css";

addStyles(css);

/** How many pages to read from the history, as the Mac's query does. */
const HISTORY_LIMIT = 200_000;
const SOURCE_LABEL = "this browser's history";

type Stage =
  | { readonly kind: "looking" }
  | { readonly kind: "choose"; readonly historyCount: number | null; readonly problem: string | null }
  | { readonly kind: "scanning" }
  | { readonly kind: "review"; readonly scan: ImportScan }
  | { readonly kind: "importing" }
  | { readonly kind: "done"; readonly message: string };

function historyApi(): typeof chrome.history | null {
  return (globalThis as { chrome?: typeof chrome }).chrome?.history ?? null;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The review's line under a film: "S2 E4, 2019, on site.to, 3 days ago". */
export function candidateDetail(candidate: ImportTitleCandidate, now: Date = new Date()): string {
  const parts: string[] = [];
  const ref = Candidate.latestRef(candidate);
  if (EpisodeRef.isEpisode(ref)) parts.push(RefText.short(ref));
  if (candidate.year != null) parts.push(String(candidate.year));
  parts.push(`on ${Candidate.host(candidate)}`);
  const last = Candidate.lastVisit(candidate);
  if (last > DISTANT_PAST) parts.push(DateText.relative(last, now));
  return parts.join(", ");
}

/** "Make the latest 25,000 of 31,204 visited pages searchable with ⌘K". */
export function pagesLabel(scan: Pick<ImportScan, "pages" | "totalPages">, key: string): string {
  if (scan.totalPages > scan.pages.length) {
    return `Make the latest ${grouped(scan.pages.length)} of ${grouped(scan.totalPages)} visited pages searchable with ${key}`;
  }
  return `Make ${grouped(scan.pages.length)} visited pages searchable with ${key}`;
}

export function ImportSheet() {
  const model = useModel();
  const session = useSession();
  const [stage, setStage] = useState<Stage>(() => (historyApi() ? { kind: "looking" } : { kind: "choose", historyCount: null, problem: null }));
  const history = useRef<HistoryItemLike[]>([]);
  const [chosenSites, setChosenSites] = useState<Set<string>>(new Set());
  const [chosenTitles, setChosenTitles] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Map<string, TitleStatus>>(new Map());
  const [includePages, setIncludePages] = useState(true);

  const lookAtHistory = async () => {
    const api = historyApi();
    if (!api) {
      setStage({ kind: "choose", historyCount: null, problem: null });
      return;
    }
    setStage({ kind: "looking" });
    try {
      history.current = await api.search({ text: "", startTime: 0, maxResults: HISTORY_LIMIT });
      setStage({ kind: "choose", historyCount: history.current.length, problem: null });
    } catch {
      setStage({ kind: "choose", historyCount: null, problem: null });
    }
  };

  useEffect(() => {
    if (historyApi()) void lookAtHistory();
  }, []);

  const scan = async () => {
    setStage({ kind: "scanning" });
    // Lets the progress view draw before the work, which takes a moment on a long history.
    await pause(30);
    const result = ImportAnalyzer.analyze(pagesFromHistory(history.current), SOURCE_LABEL);
    setChosenSites(new Set(result.sites.map((s) => s.id)));
    setChosenTitles(new Set(result.titles.map((t) => t.id)));
    setStatuses(new Map());
    setIncludePages(true);
    setStage({ kind: "review", scan: result });
  };

  const readFile = async (file: File) => {
    const text = await file.text().catch(() => null);
    const result = text == null ? null : await LibraryExport.importText(session.library, text);
    if (!result) {
      setStage({ kind: "choose", historyCount: history.current.length || (historyApi() ? 0 : null), problem: "That file isn't a Cineon library." });
      return;
    }
    session.noteCloudChanges(result.titles.map((t) => t.id));
    for (const title of result.titles) {
      if (!title.metadataChecked) session.metadata.enrich(title.id, null, true);
    }
    setStage({ kind: "done", message: fileImportSummary(result) });
  };

  const runImport = async (scanned: ImportScan) => {
    setStage({ kind: "importing" });
    await pause(30);
    const result = await applyImport(session.library, {
      sites: scanned.sites.filter((s) => chosenSites.has(s.id)),
      titles: scanned.titles
        .filter((t) => chosenTitles.has(t.id))
        .map((candidate) => ({ candidate, status: statuses.get(candidate.id) ?? candidate.suggestedStatus })),
      pages: includePages && session.settings.saveBrowsingHistory ? scanned.pages : [],
    });
    for (const { id, altName } of result.newTitleIds) session.metadata.enrich(id, altName, true);
    setStage({ kind: "done", message: importSummary(result) });
  };

  const heading = stage.kind === "review" ? `Found in ${stage.scan.sourceLabel}` : stage.kind === "done" ? "Import finished" : "Import into Cineon";

  return (
    <div class="sheet glass import-sheet" role="dialog" aria-label={heading} style={{ width: "680px" }}>
      <div class="row">
        <h2 class="t-title sheet-heading line1">{heading}</h2>
        <span class="spacer" />
        <IconButton icon="xmark" label="Close" onClick={() => model.openSheet(null)} />
      </div>
      {stage.kind === "looking" && <Progress text="Looking at this browser's history" />}
      {stage.kind === "choose" && (
        <ChooseView historyCount={stage.historyCount} problem={stage.problem} onHistory={() => void scan()} onFile={(file) => void readFile(file)} />
      )}
      {stage.kind === "scanning" && <Progress text="Looking for films in this browser's history" />}
      {stage.kind === "review" && (
        <ReviewView
          scan={stage.scan}
          chosenSites={chosenSites}
          setChosenSites={setChosenSites}
          chosenTitles={chosenTitles}
          setChosenTitles={setChosenTitles}
          statuses={statuses}
          setStatus={(id, status) => setStatuses((map) => new Map(map).set(id, status))}
          includePages={includePages}
          setIncludePages={setIncludePages}
          showPages={session.settings.saveBrowsingHistory}
          onBack={() => setStage({ kind: "choose", historyCount: history.current.length, problem: null })}
          onImport={() => void runImport(stage.scan)}
        />
      )}
      {stage.kind === "importing" && <Progress text="Importing" />}
      {stage.kind === "done" && (
        <div class="col" style={{ gap: "14px" }}>
          <p class="import-message">{stage.message}</p>
          <p class="import-note">Posters and details are filling in. Anything can be moved or removed from your library later.</p>
          <div class="row">
            <span class="spacer" />
            <SilverButton
              onClick={() => {
                model.openSheet(null);
                model.go("library");
              }}
            >
              Open library
            </SilverButton>
          </div>
        </div>
      )}
    </div>
  );
}

function Progress({ text }: { text: string }) {
  return (
    <div class="import-progress">
      <Spinner />
      <span>{text}</span>
    </div>
  );
}

// MARK: Choosing a source

function ChooseView({
  historyCount,
  problem,
  onHistory,
  onFile,
}: {
  historyCount: number | null;
  problem: string | null;
  onHistory: () => void;
  onFile: (file: File) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div class="col" style={{ gap: "12px" }}>
      {historyCount == null ? (
        <p class="import-text">Cineon needs permission to read this browser's history to find your films in it. A Cineon library file can still come in.</p>
      ) : historyCount === 0 ? (
        <p class="import-text">This browser's history is empty, so there's nothing to look through. A Cineon library file can still come in.</p>
      ) : (
        <p class="import-text">Cineon finds the sites and films in there. You choose what to keep on the next step, and nothing changes in your browser.</p>
      )}
      <div class="col" style={{ gap: "1px" }}>
        {historyCount != null && historyCount > 0 && (
          <SourceRow icon="globe" label="This browser's history" detail={`${grouped(historyCount)} pages`} onClick={onHistory} />
        )}
        <SourceRow
          icon="square.and.arrow.down"
          label="A Cineon library file"
          detail="Exported by Cineon on a Mac, on Windows or in this browser"
          onClick={() => fileInput.current?.click()}
        />
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const input = event.currentTarget as HTMLInputElement;
            const file = input.files?.[0];
            input.value = "";
            if (file) onFile(file);
          }}
        />
      </div>
      {problem && <p class="import-problem">{problem}</p>}
      <p class="import-note">Passwords and cookies are never read.</p>
    </div>
  );
}

function SourceRow({ icon, label, detail, onClick }: { icon: string; label: string; detail: string; onClick: () => void }) {
  return (
    <HoverButton class="source-row" onClick={onClick}>
      <span class="source-icon">
        <Icon name={icon} size={19} />
      </span>
      <span class="col" style={{ gap: "1px", minWidth: 0 }}>
        <span style={{ fontSize: "14px", fontWeight: 500, color: "var(--ink)" }}>{label}</span>
        <span class="line1" style={{ fontSize: "12px", color: "var(--ink3)" }}>
          {detail}
        </span>
      </span>
      <span class="spacer" />
      <Icon name="chevron.right" size={13} class="source-chevron" />
    </HoverButton>
  );
}

// MARK: Reviewing

function ReviewView({
  scan,
  chosenSites,
  setChosenSites,
  chosenTitles,
  setChosenTitles,
  statuses,
  setStatus,
  includePages,
  setIncludePages,
  showPages,
  onBack,
  onImport,
}: {
  scan: ImportScan;
  chosenSites: Set<string>;
  setChosenSites: (value: Set<string>) => void;
  chosenTitles: Set<string>;
  setChosenTitles: (value: Set<string>) => void;
  statuses: Map<string, TitleStatus>;
  setStatus: (id: string, status: TitleStatus) => void;
  includePages: boolean;
  setIncludePages: (value: boolean) => void;
  showPages: boolean;
  onBack: () => void;
  onImport: () => void;
}) {
  const session = useSession();
  const newSites = scan.sites.filter((s) => session.library.siteForHost(s.host) == null);
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  return (
    <div class="col" style={{ gap: "14px" }}>
      <div class="import-review scroll">
        {newSites.length > 0 && (
          <SitesSection
            sites={newSites}
            chosen={chosenSites}
            onToggle={(id, on) => setChosenSites(toggle(chosenSites, id, on))}
            onAll={() => setChosenSites(new Set(newSites.map((s) => s.id)))}
            onNone={() => setChosenSites(new Set())}
          />
        )}
        {scan.titles.length > 0 && (
          <TitlesSection
            titles={scan.titles}
            chosen={chosenTitles}
            statuses={statuses}
            setStatus={setStatus}
            onToggle={(id, on) => setChosenTitles(toggle(chosenTitles, id, on))}
            onAll={() => setChosenTitles(new Set(scan.titles.map((t) => t.id)))}
            onNone={() => setChosenTitles(new Set())}
          />
        )}
        {newSites.length === 0 && scan.titles.length === 0 && (
          <p class="import-text">No film sites or films turned up here, but your history can still be made searchable.</p>
        )}
      </div>

      {scan.totalPages > 0 && showPages && (
        <Checkbox on={includePages} onChange={setIncludePages}>
          <span style={{ fontSize: "13px", color: "var(--ink)" }}>{pagesLabel(scan, shortcut("K"))}</span>
        </Checkbox>
      )}

      <div class="row">
        <OutlineButton onClick={onBack}>Back</OutlineButton>
        <span class="spacer" />
        <SilverButton onClick={onImport}>Import</SilverButton>
      </div>
    </div>
  );
}

function SectionHeader({ text, count, onAll, onNone }: { text: string; count: number; onAll: () => void; onNone: () => void }) {
  return (
    <div class="import-section-head">
      <span class="t-title" style={{ fontSize: "17px", color: "var(--ink)" }}>
        {text}
      </span>
      <span class="time" style={{ fontSize: "12px", color: "var(--ink3)" }}>
        {count}
      </span>
      <span class="spacer" />
      <button type="button" class="btn-plain all-none" onClick={onAll}>
        All
      </button>
      <button type="button" class="btn-plain all-none" onClick={onNone}>
        None
      </button>
    </div>
  );
}

function SitesSection({
  sites,
  chosen,
  onToggle,
  onAll,
  onNone,
}: {
  sites: readonly ImportSiteCandidate[];
  chosen: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  return (
    <section class="col" style={{ gap: "6px" }}>
      <SectionHeader text="Sites you watch on" count={sites.length} onAll={onAll} onNone={onNone} />
      {sites.map((site) => (
        <Checkbox key={site.id} on={chosen.has(site.id)} onChange={(on) => onToggle(site.id, on)}>
          <span class="row" style={{ gap: "8px", flex: "1 1 auto", minWidth: 0 }}>
            <span class="line1" style={{ fontSize: "13px", color: "var(--ink)" }}>
              {site.host}
            </span>
            <span class="spacer" />
            {site.filmPages > 0 && (
              <span style={{ fontSize: "12px", color: "var(--ink3)", whiteSpace: "nowrap" }}>
                {site.filmPages === 1 ? "1 film page" : `${grouped(site.filmPages)} film pages`}
              </span>
            )}
          </span>
        </Checkbox>
      ))}
    </section>
  );
}

const STATUS_OPTIONS: readonly { value: TitleStatus; label: string }[] = [
  { value: "watched", label: "Watched" },
  { value: "watching", label: "Watching" },
  { value: "backlog", label: "Backlog" },
];

function TitlesSection({
  titles,
  chosen,
  statuses,
  setStatus,
  onToggle,
  onAll,
  onNone,
}: {
  titles: readonly ImportTitleCandidate[];
  chosen: Set<string>;
  statuses: Map<string, TitleStatus>;
  setStatus: (id: string, status: TitleStatus) => void;
  onToggle: (id: string, on: boolean) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  const now = new Date();
  return (
    <section class="col" style={{ gap: "6px" }}>
      <SectionHeader text="Films and series" count={titles.length} onAll={onAll} onNone={onNone} />
      <div class="col" style={{ gap: "2px" }}>
        {titles.map((title) => {
          const on = chosen.has(title.id);
          return (
            <div key={title.id} class="row import-title-row">
              <Checkbox on={on} onChange={(value) => onToggle(title.id, value)}>
                <span class="col" style={{ gap: "1px", minWidth: 0 }}>
                  <span class="t-title line1" style={{ fontSize: "14px", color: "var(--ink)" }}>
                    {title.name}
                  </span>
                  <span class="line1" style={{ fontSize: "11.5px", color: "var(--ink3)" }}>
                    {candidateDetail(title, now)}
                  </span>
                </span>
              </Checkbox>
              <Picker
                label={`List for ${title.name}`}
                value={statuses.get(title.id) ?? title.suggestedStatus}
                options={STATUS_OPTIONS}
                disabled={!on}
                onChange={(status) => setStatus(title.id, status)}
                style={{ fontSize: "12px", flex: "none" }}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
