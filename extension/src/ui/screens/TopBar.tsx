// TopBar.swift: the logo on the left, the sections in one capsule in the middle like a TV app's,
// and what's playing, the tools and you (your pixel pet) on the right. Over Home's film it's a
// shadow falling from the top; elsewhere the room's black with a hairline.

import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { DownloadStatus, Timecode } from "../../core/data";
import type { TabSnapshot } from "../../shared/messages";
import { Icon } from "../components/Icon";
import { HoverButton, IconButton } from "../components/controls";
import { MenuDivider, MenuItem, openMenu } from "../components/menu";
import { LogoMark, PetView, RemoteImage, SiteIcon } from "../components/media";
import { PlayerControlsPanel, tabName, tabRef } from "../components/player";
import type { Route } from "../lib/app";
import { RefText } from "../lib/format";
import { useLive, useModel, useSession, useUi, useWidth } from "../lib/hooks";
import { unratedCount } from "../lib/library";
import { shortcut } from "../lib/platform";
import { addStyles } from "../lib/styles";
import css from "./topbar.css";

addStyles(css);

export const TOP_BAR_HEIGHT = 56;

type TabStyle = "regular" | "compact" | "icons";

interface SectionItem {
  label: string;
  symbol: string;
  route: Route;
  count: number | null;
  isLive: boolean;
}

export function TopBar() {
  const ui = useUi();
  const [ref, width] = useWidth<HTMLElement>();
  const onHero = ui.route === "home";
  // Narrow windows first lose the playing title, then tighten the sections, then show only their icons.
  const style: TabStyle = width >= 1200 ? "regular" : width >= 1100 ? "compact" : "icons";
  const compactPill = width < 1360;
  return (
    <header ref={ref} class={`top-bar${onHero ? " on-hero" : ""}`} style={{ height: `${TOP_BAR_HEIGHT}px` }}>
      <div class="top-bar-lead">
        <LogoButton />
      </div>
      <SectionTabs style={style} />
      <div class="top-bar-trail">
        <NowPlayingPill compact={compactPill} />
        <div class="bar-capsule tools">
          <ToolButtons />
        </div>
        <AvatarButton onHero={onHero} />
      </div>
    </header>
  );
}

function LogoButton() {
  const model = useModel();
  return (
    <button type="button" class="logo-button" title="Home" onClick={() => model.go("home")}>
      <LogoMark size={22} />
      <span class="t-bold">Cineon</span>
    </button>
  );
}

/** The sections, each with its icon. The one you're in is lit silver, and the light slides across. */
function SectionTabs({ style }: { style: TabStyle }) {
  const model = useModel();
  const ui = useUi();
  const downloads = useLive((l) => l.downloads);
  const together = useLive((l) => l.together);
  const active = downloads.value?.items.filter((d) => DownloadStatus.isActive(d.status)).length ?? 0;
  const items: SectionItem[] = [
    { label: "Home", symbol: "house", route: "home", count: null, isLive: false },
    { label: "Library", symbol: "film.stack", route: "library", count: null, isLive: false },
    { label: "Timeline", symbol: "clock", route: "timeline", count: null, isLive: false },
    { label: "Downloads", symbol: "arrow.down.circle", route: "downloads", count: active > 0 ? active : null, isLive: false },
    { label: "Together", symbol: "person.2", route: "together", count: null, isLive: together.value?.party != null },
  ];
  const strip = useRef<HTMLDivElement>(null);
  const [light, setLight] = useState<{ left: number; width: number } | null>(null);
  const selectedIndex = items.findIndex((item) => item.route === ui.route);

  useLayoutEffect(() => {
    const element = strip.current?.querySelectorAll<HTMLElement>(".section-tab")[selectedIndex];
    setLight(element ? { left: element.offsetLeft, width: element.offsetWidth } : null);
  }, [selectedIndex, style, active > 0, together.value?.party != null]);

  return (
    <nav class={`bar-capsule section-tabs ${style}`} aria-label="Sections">
      <div class="section-strip" ref={strip}>
        {light && <span class="section-light" style={{ left: `${light.left}px`, width: `${light.width}px` }} />}
        {items.map((item) => {
          const selected = item.route === ui.route;
          return (
            <button
              key={item.route}
              type="button"
              class={`section-tab${selected ? " selected" : ""}${item.count != null ? " counted" : ""}`}
              title={style === "icons" ? item.label : undefined}
              aria-label={item.label}
              aria-current={selected ? "page" : undefined}
              onClick={() => model.go(item.route)}
            >
              <Icon name={selected ? `${item.symbol}.fill` : item.symbol} size={style === "regular" ? 17 : 16} />
              {style !== "icons" && <span class="t-title label">{item.label}</span>}
              {item.isLive && <span class="live-dot" title="A watch party is on" />}
              {item.count != null && <span class="count time">{item.count}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** What's playing, from any page: poster, name, episode, play/pause and a hairline of how far. */
function NowPlayingPill({ compact }: { compact: boolean }) {
  const model = useModel();
  const session = useSession();
  const player = useLive((l) => l.player);
  const tab = player.value?.tab ?? null;
  const media = tab?.media;
  if (!tab || !media || media.duration <= 0) return null;
  const title = tab.linkedTitleId != null ? session.library.titles.get(tab.linkedTitleId) ?? null : null;
  const name = tabName(tab, title?.name ?? null);
  const ref = tabRef(tab);
  const fraction = Math.min(1, Math.max(0, media.position / media.duration));
  return (
    <div class="bar-capsule now-playing">
      <button type="button" class="now-main" title={compact ? name : "Go to what's playing"} onClick={() => void model.focusTab(tab.tabId)}>
        <RemoteImage
          url={title?.posterUrl ?? tab.parsed?.posterUrl ?? null}
          class="now-thumb"
          placeholder={
            <span class="now-thumb-blank">
              <Icon name="film" size={9} />
            </span>
          }
        />
        {!compact && (
          <>
            <span class="t-title now-name line1">{name}</span>
            <span class="time now-detail">{ref ? RefText.short(ref) : `−${Timecode.string(Math.max(0, media.duration - media.position))}`}</span>
          </>
        )}
      </button>
      <IconButton
        icon={media.isPlaying ? "pause.fill" : "play.fill"}
        label={media.isPlaying ? "Pause" : "Play"}
        size={10.5}
        onClick={() => void model.playerCommand(tab.tabId, { kind: "toggle" })}
      />
      <IconButton
        icon="chevron.down"
        label="Player controls"
        size={8.5}
        onClick={(event) =>
          openMenu((event.currentTarget as HTMLElement).getBoundingClientRect(), (close) => <LivePlayerPanel close={close} initial={tab} />, {
            kind: "popover",
            label: "Player controls",
          })
        }
      />
      <span class="now-progress" style={{ width: `${fraction * 100}%` }} />
    </div>
  );
}

function LivePlayerPanel({ close, initial }: { close: () => void; initial: TabSnapshot }) {
  const player = useLive((l) => l.player);
  return <PlayerControlsPanel tab={player.value?.tab ?? initial} close={close} />;
}

function ToolButtons() {
  const model = useModel();
  const ui = useUi();
  const session = useSession();
  const unrated = unratedCount(session.library.titles.values());
  return (
    <>
      <IconButton icon="magnifyingglass" label={`Search films and sites (${shortcut("K")})`} onClick={() => model.openCommandBar()} />
      <IconButton
        icon="square.grid.2x2"
        label="Sites"
        onClick={(event) =>
          openMenu((event.currentTarget as HTMLElement).getBoundingClientRect(), (close) => <SitesPanel close={close} />, {
            kind: "popover",
            label: "Sites",
          })
        }
      />
      <button
        type="button"
        class={`btn-icon${ui.route === "rate" ? " gold-icon" : ""}`}
        title={unrated > 0 ? `Rate your films: ${unrated} watched without stars` : "Rate your films"}
        aria-label={unrated > 0 ? `Rate your films, ${unrated} waiting` : "Rate your films"}
        onClick={() => model.go("rate")}
      >
        <Icon name="star.leadinghalf.filled" size={16} />
      </button>
    </>
  );
}

/** The sites you watch on, as a grid. */
export function SitesPanel({ close }: { close: () => void }) {
  const model = useModel();
  return (
    <div class="col sites-panel">
      <span class="t-title" style={{ fontSize: "16px", color: "var(--ink)" }}>
        Where to watch
      </span>
      <SitesGrid onPick={close} />
      <HoverButton
        style={{ alignSelf: "flex-start", fontSize: "12.5px", color: "var(--ink2)" }}
        onClick={() => {
          close();
          model.openCommandBar();
        }}
      >
        <Icon name="plus" size={13} />
        Open an address
      </HoverButton>
    </div>
  );
}

export function SitesGrid({ onPick }: { onPick?: () => void }) {
  const model = useModel();
  const session = useSession();
  return (
    <div class="sites-grid">
      {session.library.sites.map((site) => (
        <button
          key={site.id}
          type="button"
          class="site-tile"
          title={site.name}
          aria-label={site.name}
          onClick={() => {
            onPick?.();
            void model.openSite(site);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu({ x: event.clientX, y: event.clientY }, () => (
              <>
                <MenuItem onSelect={() => void model.openUrl(site.homeUrl)}>Open in new tab</MenuItem>
                <MenuItem onSelect={() => model.openSheet({ kind: "editSite", siteId: site.id })}>Edit…</MenuItem>
                <MenuDivider />
                <MenuItem onSelect={() => void model.library.removeSite(site.id)}>Remove</MenuItem>
              </>
            ));
          }}
        >
          <SiteIcon name={site.name} url={site.iconUrl} size={20} />
        </button>
      ))}
      <button
        type="button"
        class="site-tile add"
        title="Add a site"
        aria-label="Add a site"
        onClick={() => {
          onPick?.();
          model.openSheet({ kind: "addSite", prefill: null });
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

/** Your pet, which is you. Click for your profile; hold or right-click for the rest. */
function AvatarButton({ onHero }: { onHero: boolean }) {
  const model = useModel();
  const ui = useUi();
  const session = useSession();
  const { pet } = session.statsAndPet();
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opened = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const showMenu = () => {
    if (!button.current) return;
    opened.current = true;
    openMenu(button.current.getBoundingClientRect(), () => (
      <>
        <MenuItem onSelect={() => model.go("profile")}>Profile</MenuItem>
        <MenuItem onSelect={() => model.showProfilePicker(true)}>Who's watching…</MenuItem>
        <MenuDivider />
        <MenuItem onSelect={() => model.toggleTheme()}>{session.settings.theme === "dark" ? "Light theme" : "Dark theme"}</MenuItem>
        <MenuItem onSelect={() => model.go("settings")}>Settings…</MenuItem>
      </>
    ));
  };
  return (
    <button
      ref={button}
      type="button"
      class={`avatar-button${ui.route === "profile" ? " current" : ""}${onHero ? " hero" : ""}`}
      title={`${session.profile.name}: profile`}
      aria-label={`${session.profile.name}: profile`}
      aria-haspopup="menu"
      onMouseDown={() => {
        opened.current = false;
        hold.current = setTimeout(showMenu, 450);
      }}
      onMouseUp={() => {
        if (hold.current) clearTimeout(hold.current);
      }}
      onMouseLeave={() => {
        if (hold.current) clearTimeout(hold.current);
      }}
      onClick={() => {
        if (!opened.current) model.go("profile");
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        showMenu();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          showMenu();
        }
      }}
    >
      <PetView pet={pet} size={28} animated={false} />
    </button>
  );
}
