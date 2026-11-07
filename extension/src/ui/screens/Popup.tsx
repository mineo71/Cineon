// The toolbar popup: what's playing in this tab and its controls, add it to the backlog, download
// it, fix what it's recognised as, this site's shields, and the way into Cineon. It has no Root:
// it opens the profile itself, for the title's stars and the shields fallback.

import { useEffect, useMemo, useState } from "preact/hooks";
import { DomainName, type SitePrefs } from "../../core/data";
import { type PlayerCommand, send, type TabSnapshot } from "../../shared/messages";
import { Icon } from "../components/Icon";
import { HoverButton, IconButton, OutlineButton, SilverButton, Spinner, Switch } from "../components/controls";
import { LogoMark, PosterPlaceholder, ProgressLine, RemoteImage, StarRatingControl } from "../components/media";
import { tabName, tabRef } from "../components/player";
import { NO_BACKGROUND } from "../lib/app";
import { RefText } from "../lib/format";
import {
  type BrowserTabInfo,
  addOutcome,
  mediaFraction,
  popupView,
  prefsKey,
  relinkHash,
  shieldsBreakdown,
  shieldsLine,
  timeLine,
  withShields,
} from "../lib/popup";
import { Session, applyTheme } from "../lib/session";
import { addStyles } from "../lib/styles";
import css from "./popup.css";

addStyles(css);

type ChromeApi = typeof chrome;

function chromeApi(): ChromeApi | null {
  return (globalThis as { chrome?: ChromeApi }).chrome ?? null;
}

interface FirefoxSidebar {
  sidebarAction?: { open(): Promise<void> };
}

function firefoxSidebar(): FirefoxSidebar["sidebarAction"] | null {
  return (globalThis as { browser?: FirefoxSidebar }).browser?.sidebarAction ?? null;
}

/** The Cineon page's address, with a hash such as `#library?add=Dune`. */
function appUrl(hash = ""): string {
  const runtime = chromeApi()?.runtime;
  return (runtime?.getURL ? runtime.getURL("app.html") : "app.html") + hash;
}

/** Opens Cineon (reusing an open Cineon tab), then closes the popup. */
async function openApp(hash = ""): Promise<void> {
  const api = chromeApi();
  const base = appUrl();
  try {
    if (api?.tabs) {
      const tabs = await api.tabs.query({});
      const existing = tabs.find((t) => t.url?.startsWith(base) && !t.url.slice(base.length).startsWith("#panel"));
      if (existing?.id != null) {
        await api.tabs.update(existing.id, { active: true, ...(hash ? { url: base + hash } : {}) });
        if (existing.windowId != null) await api.windows?.update(existing.windowId, { focused: true });
      } else {
        await api.tabs.create({ url: base + hash });
      }
    } else {
      globalThis.open?.(base + hash, "_blank");
    }
  } finally {
    globalThis.close?.();
  }
}

/** Opens the side panel (Chrome) or sidebar (Firefox); must run inside the click. */
function sidePanelOpener(windowId: number | null): (() => void) | null {
  const api = chromeApi();
  if (api?.sidePanel?.open && windowId != null) {
    return () => {
      void api.sidePanel.open({ windowId }).then(() => globalThis.close?.(), () => undefined);
    };
  }
  const sidebar = firefoxSidebar();
  if (sidebar?.open) {
    return () => {
      void sidebar.open().then(() => globalThis.close?.(), () => undefined);
    };
  }
  return null;
}

async function activeTab(): Promise<BrowserTabInfo | null> {
  const api = chromeApi();
  if (!api?.tabs) return null;
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    return { id: tab.id ?? null, windowId: tab.windowId ?? null, url: tab.url ?? tab.pendingUrl ?? null, title: tab.title ?? "" };
  } catch {
    return null;
  }
}

export function Popup() {
  const [session, setSession] = useState<Session | null>(null);
  const [, setVersion] = useState(0);
  const [browserTab, setBrowserTab] = useState<BrowserTabInfo | null | undefined>(undefined);
  const [answer, setAnswer] = useState<{ tab: TabSnapshot | null } | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);

  // The profile: the library (for stars) and the shields fallback.
  useEffect(() => {
    let opened: Session | null = null;
    let off: (() => void) | null = null;
    let cancelled = false;
    Session.open(null, { metadata: false })
      .then((s) => {
        if (cancelled) return s.close();
        opened = s;
        off = s.subscribe(() => setVersion((n) => n + 1));
        setSession(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off?.();
      opened?.close();
    };
  }, []);

  const theme = session?.settings.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    void activeTab().then(setBrowserTab);
  }, []);

  // What the background knows about this tab, every second while the popup is open.
  const tabId = browserTab?.id ?? null;
  const view = popupView(browserTab ?? null, answer);
  const restricted = browserTab !== undefined && view.kind === "restricted";
  useEffect(() => {
    if (tabId == null || restricted) return;
    let cancelled = false;
    const ask = async () => {
      const value = await send("tab.state", { tabId }, { timeoutMs: 1500 });
      if (!cancelled) setAnswer(value);
    };
    void ask();
    const timer = setInterval(() => void ask(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tabId, restricted]);

  const refresh = async () => {
    if (tabId == null) return;
    setAnswer(await send("tab.state", { tabId }, { timeoutMs: 1500 }));
  };

  if (browserTab === undefined) {
    return (
      <main class="popup">
        <PopupHeader windowId={null} />
      </main>
    );
  }

  if (view.kind === "restricted") {
    return (
      <main class="popup">
        <PopupHeader windowId={browserTab?.windowId ?? null} />
        <p class="pop-note">Cineon works on the sites you watch on. This page belongs to the browser, so there's nothing to do here.</p>
        <PopupFooter windowId={browserTab?.windowId ?? null} />
      </main>
    );
  }

  const tab = view.kind === "page" ? view.tab : null;
  const pageHost = tab?.host ?? (view.kind === "page" ? null : view.host);
  const pageTitle = tab?.title ?? (view.kind === "page" ? "" : view.title);

  const command = async (c: PlayerCommand) => {
    if (!tab) return;
    const done = await send("player.command", { tabId: tab.tabId, command: c });
    if (!done) setNote(NO_BACKGROUND);
    void refresh();
  };

  const addToBacklog = async () => {
    if (tabId == null) return;
    const outcome = addOutcome(await send("library.addFromTab", { tabId }), pageTitle);
    if (outcome.kind === "message") setNote(outcome.text);
    else await openApp(outcome.hash);
  };

  const download = async () => {
    if (!tab) return;
    const result = await send("downloads.start", { tabId: tab.tabId });
    if (!result) setNote(NO_BACKGROUND);
    else setNote(result.message ?? (result.ok ? "Downloading. Follow it in Cineon's Downloads." : "Couldn't start that download"));
  };

  return (
    <main class="popup">
      <PopupHeader windowId={browserTab?.windowId ?? null} />
      <FilmCard tab={tab} session={session} host={pageHost} title={pageTitle} loading={view.kind === "loading"} onCommand={(c) => void command(c)} />
      {view.kind === "offline" && <p class="pop-note">{NO_BACKGROUND} Until then, playback controls and downloads are off.</p>}
      <div class="pop-actions">
        <OutlineButton icon="plus" onClick={() => void addToBacklog()}>
          Add to backlog
        </OutlineButton>
        <OutlineButton icon="arrow.down.circle" disabled={!tab?.canDownload} title={tab?.canDownload ? undefined : "Start the video first"} onClick={() => void download()}>
          Download this video
        </OutlineButton>
        {tab && (tab.parsed || tab.linkedTitleId != null || tab.media) && (
          <HoverButton class="pop-fix" onClick={() => void openApp(relinkHash(tab.tabId))}>
            Fix title…
          </HoverButton>
        )}
      </div>
      {pageHost && <ShieldsRow tab={tab} tabId={tabId} host={pageHost} session={session} onNote={setNote} />}
      {note && (
        <p class="pop-note pop-message" role="status">
          {note}
        </p>
      )}
      <PopupFooter windowId={browserTab?.windowId ?? null} />
    </main>
  );
}

function PopupHeader({ windowId }: { windowId: number | null }) {
  const openPanel = sidePanelOpener(windowId);
  return (
    <header class="pop-header">
      <LogoMark size={18} />
      <span class="t-bold">Cineon</span>
      <span class="spacer" />
      {openPanel && <IconButton icon="sidebar.right" label="Open the side panel" size={12} onClick={openPanel} />}
    </header>
  );
}

function PopupFooter({ windowId }: { windowId: number | null }) {
  const openPanel = sidePanelOpener(windowId);
  return (
    <footer class="pop-footer">
      <SilverButton class="pop-open" onClick={() => void openApp()}>
        Open Cineon
      </SilverButton>
      {openPanel && (
        <OutlineButton icon="sidebar.right" onClick={openPanel}>
          Side panel
        </OutlineButton>
      )}
    </footer>
  );
}

/** The film in this tab: poster, name, episode, site, stars, progress and the transport. */
function FilmCard({
  tab,
  session,
  host,
  title,
  loading,
  onCommand,
}: {
  tab: TabSnapshot | null;
  session: Session | null;
  host: string | null;
  title: string;
  loading: boolean;
  onCommand: (command: PlayerCommand) => void;
}) {
  const linked = tab?.linkedTitleId != null ? session?.library.titles.get(tab.linkedTitleId) ?? null : null;
  const name = tab ? tabName(tab, linked?.name ?? null) : title || (host ? DomainName.registrable(host) : "This page");
  const ref = tab ? tabRef(tab) : null;
  const poster = linked?.posterUrl ?? tab?.parsed?.posterUrl ?? null;
  const media = tab?.media ?? null;
  const site = host ? DomainName.registrable(host) : null;
  return (
    <section class="pop-film">
      <div class="row" style={{ gap: "12px", alignItems: "flex-start" }}>
        <RemoteImage url={poster} placeholder={<PosterPlaceholder name="" />} style={{ width: "44px", height: "66px", borderRadius: "4px", flex: "none" }} />
        <div class="col" style={{ gap: "3px", minWidth: 0, flex: "1 1 auto" }}>
          <span class="t-title line2 pop-name">{name}</span>
          {ref && <span class="pop-ref">{RefText.long(ref)}</span>}
          {site && <span class="pop-site line1">{site}</span>}
          {linked && session && (
            <StarRatingControl halves={linked.ratingHalves} size={12} label={`Rate ${linked.name}`} onChange={(value) => void session.library.setRating(linked.id, value)} />
          )}
        </div>
        {loading && <Spinner size={14} />}
      </div>
      {media && media.duration > 0 ? (
        <div class="col" style={{ gap: "6px" }}>
          <ProgressLine fraction={mediaFraction(media)} height={2} />
          <div class="row">
            <span class="time pop-time">{timeLine(media)}</span>
            <span class="spacer" />
            <IconButton icon="gobackward.10" label="Back 10 seconds" size={11} onClick={() => onCommand({ kind: "skip", seconds: -10 })} />
            <IconButton icon={media.isPlaying ? "pause.fill" : "play.fill"} label={media.isPlaying ? "Pause" : "Play"} size={12} onClick={() => onCommand({ kind: "toggle" })} />
            <IconButton icon="goforward.10" label="Forward 10 seconds" size={11} onClick={() => onCommand({ kind: "skip", seconds: 10 })} />
            {ref && (
              <IconButton icon="forward.end.fill" label="Next episode" size={10} disabled={!tab?.hasNextEpisode} onClick={() => onCommand({ kind: "nextEpisode" })} />
            )}
          </div>
        </div>
      ) : (
        !loading && tab && <span class="pop-quiet">No video playing on this page yet.</span>
      )}
    </section>
  );
}

/** This site's shields: what was blocked here, and on or off. */
function ShieldsRow({
  tab,
  tabId,
  host,
  session,
  onNote,
}: {
  tab: TabSnapshot | null;
  tabId: number | null;
  host: string;
  session: Session | null;
  onNote: (text: string) => void;
}) {
  const [stored, setStored] = useState<SitePrefs | null>(null);
  const [override, setOverride] = useState<boolean | null>(null);
  const key = prefsKey(host);
  useEffect(() => {
    if (!session || tab) return;
    void session.db
      .sitePrefs()
      .then((all) => setStored(all.get(key) ?? null))
      .catch(() => undefined);
  }, [session, key, tab == null]);
  const prefs = tab?.sitePrefs ?? stored;
  const on = override ?? !(prefs?.shieldsOff ?? false);
  const line = useMemo(() => shieldsLine(tab?.blocked ?? null, on), [tab?.blocked, on]);
  const breakdown = on ? shieldsBreakdown(tab?.blocked ?? null) : "";

  const toggle = async (value: boolean) => {
    setOverride(value);
    const next = withShields(prefs, host, value);
    const answer = await send("shields.setSite", { host, prefs: next, tabId });
    if (answer?.ok) return;
    // No background: save it for when it's back, tell everyone, and reload so the page sees it.
    if (!session) {
      onNote(NO_BACKGROUND);
      setOverride(null);
      return;
    }
    try {
      await session.db.saveSitePrefs(next);
      setStored(next);
      session.channel.post({ type: "sitePrefs", profileId: session.profile.id, host: next.host });
      if (tabId != null) await chromeApi()?.tabs?.reload(tabId);
      onNote(value ? "Shields are back on for this site" : "Shields are off for this site");
    } catch {
      onNote("Couldn't save that. Try again.");
      setOverride(null);
    }
  };

  return (
    <section class="pop-shields">
      <Icon name={on ? "shield.lefthalf.filled" : "shield.slash"} size={17} />
      <div class="col" style={{ gap: "1px", flex: "1 1 auto", minWidth: 0 }}>
        <span class="pop-shields-label">Shields on {DomainName.registrable(host)}</span>
        <span class="pop-shields-line">{line}</span>
        {breakdown && <span class="pop-shields-detail">{breakdown}</span>}
      </div>
      <Switch on={on} label="Shields on this site" onChange={(value) => void toggle(value)} />
    </section>
  );
}
