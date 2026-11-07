// CommandBar.swift: type a film, a site or an address. The first thing you reach for in Cineon.
// In the extension it also runs Cineon's own commands (sections, theme, add…).

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { HistoryEntry } from "../../core/data";
import { Icon } from "../components/Icon";
import { RemoteImage } from "../components/media";
import { queryTabs } from "../lib/app";
import { type CommandAction, type CommandItem, type CommandTab, buildCommandItems, listHeight, tabsForBar, trimmedQuery, wantsCatalogue } from "../lib/commandBar";
import { useModel, useSession } from "../lib/hooks";
import { addStyles } from "../lib/styles";
import { useCatalogueSearch } from "./Sheets";
import css from "./commandbar.css";

addStyles(css);

export function CommandBar({ seed }: { seed: string }) {
  const model = useModel();
  const session = useSession();
  const [query, setQuery] = useState(seed);
  const [selection, setSelection] = useState(0);
  const [tabs, setTabs] = useState<CommandTab[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const trimmed = trimmedQuery(query);
  const { hits } = useCatalogueSearch(trimmed, session.settings.fetchMetadata && wantsCatalogue(trimmed));

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    let cancelled = false;
    void queryTabs().then((all) => {
      if (!cancelled) setTabs(tabsForBar(all, typeof location === "undefined" ? null : location.href));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSelection(0);
    if (trimmed.length === 0) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    void session.db
      .searchHistory(trimmed, 5)
      .catch(() => [] as HistoryEntry[])
      .then((found) => {
        if (!cancelled) setHistory(found);
      });
    return () => {
      cancelled = true;
    };
  }, [trimmed, session]);

  const items = useMemo(
    () =>
      buildCommandItems({
        text: query,
        library: session.library,
        tabs,
        history,
        hits,
        searchEngine: session.settings.searchEngine,
        theme: session.settings.theme,
      }),
    [query, session.version, tabs, history, hits],
  );
  const selected = Math.min(selection, items.length - 1);

  useEffect(() => {
    rows.current[selected]?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const runAction = (action: CommandAction) => {
    switch (action.kind) {
      case "resume": {
        const title = session.library.titles.get(action.titleId);
        if (title) model.resume(title);
        break;
      }
      case "focusTab":
        void model.focusTab(action.tabId);
        break;
      case "openSite": {
        const site = session.library.sites.find((s) => s.id === action.siteId);
        if (site) void model.openSite(site);
        break;
      }
      case "openUrl":
        void model.openUrl(action.url);
        break;
      case "searchEverywhere":
        void model.searchEverywhere(action.query);
        break;
      case "openTitle":
        model.openTitle(action.titleId);
        break;
      case "addHit":
        void model.addToBacklog(action.hit);
        break;
      case "import":
        model.openSheet({ kind: "import" });
        break;
      case "go":
        model.go(action.route);
        break;
      case "toggleTheme":
        model.toggleTheme();
        break;
      case "profilePicker":
        model.showProfilePicker(true);
        break;
      case "addTitle":
        model.openSheet({ kind: "addTitle", query: null });
        break;
      case "addSite":
        model.openSheet({ kind: "addSite", prefill: null });
        break;
    }
  };

  const run = (index: number) => {
    const item = items[Math.min(index, items.length - 1)];
    if (!item) return;
    model.closeCommandBar();
    runAction(item.action);
  };

  return (
    <div class="command-bar glass" role="dialog" aria-label="Search">
      <div class="command-field">
        <Icon name="magnifyingglass" size={19} />
        <input
          ref={input}
          value={query}
          placeholder="Search your sites, your library or the web"
          aria-label="Search your sites, your library or the web"
          aria-controls="command-results"
          aria-activedescendant={items[selected] ? `command-${items[selected]!.id}` : undefined}
          spellcheck={false}
          autoComplete="off"
          onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              setSelection(Math.min(selected + 1, items.length - 1));
            } else if (event.key === "ArrowUp") {
              setSelection(Math.max(selected - 1, 0));
            } else if (event.key === "Enter") {
              run(selected);
            } else {
              return;
            }
            event.preventDefault();
          }}
        />
      </div>
      {items.length > 0 && (
        <>
          <div class="command-divider" />
          <div id="command-results" class="command-list scroll" role="listbox" style={{ height: `${listHeight(items.length)}px` }}>
            {items.map((item, index) => (
              <CommandRow
                key={item.id}
                item={item}
                selected={index === selected}
                rowRef={(element) => {
                  rows.current[index] = element;
                }}
                onClick={() => {
                  setSelection(index);
                  run(index);
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CommandRow({
  item,
  selected,
  rowRef,
  onClick,
}: {
  item: CommandItem;
  selected: boolean;
  rowRef: (element: HTMLDivElement | null) => void;
  onClick: () => void;
}) {
  const icon = <Icon name={item.symbol ?? "film"} size={15} />;
  return (
    <div
      ref={rowRef}
      id={`command-${item.id}`}
      class={`command-row${selected ? " selected" : ""}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <span class="command-art">
        {item.imageUrl ? (
          <RemoteImage
            url={item.imageUrl}
            fit={item.symbol == null ? "cover" : "contain"}
            placeholder={<span class="command-art-fallback">{icon}</span>}
            style={{ width: "24px", height: item.symbol == null ? "34px" : "24px", borderRadius: "3px" }}
          />
        ) : (
          icon
        )}
      </span>
      <span class={`command-primary line1${selected ? " selected" : ""}`}>{item.primary}</span>
      <span class="spacer" style={{ minWidth: "8px" }} />
      {item.secondary && <span class="command-secondary line1">{item.secondary}</span>}
    </div>
  );
}
