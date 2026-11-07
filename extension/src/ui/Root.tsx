// RootView.swift for the extension: opens the profile, then the top bar over the page, and the
// overlays above (title card, sheets, the series proposal, the command bar, toasts, the profile
// picker). `app.html#panel` is the side panel's compact layout over the same model.

import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { send } from "../shared/messages";
import { Icon } from "./components/Icon";
import { MenuLayer, isMenuOpen } from "./components/menu";
import { LogoMark } from "./components/media";
import { AppModel, type Route, parseHash } from "./lib/app";
import { Page, type PageContext, useKeys, useModel, useSession, useUi } from "./lib/hooks";
import { type LiveSet, makeLive } from "./lib/live";
import { hasCommand } from "./lib/platform";
import { Session } from "./lib/session";
import { addStyles } from "./lib/styles";
import { CommandBar } from "./screens/CommandBar";
import { DownloadsView, SeriesProposalOverlay } from "./screens/Downloads";
import { HomeView } from "./screens/Home";
import { LibraryView } from "./screens/Library";
import { SidePanel } from "./screens/Panel";
import { ProfilePicker } from "./screens/ProfilePicker";
import { ProfileView } from "./screens/Profile";
import { RateModeView } from "./screens/Rate";
import { SettingsView } from "./screens/Settings";
import { SheetHost } from "./screens/Sheets";
import { Splash } from "./screens/Splash";
import { TimelineView } from "./screens/Timeline";
import { TitleDetailView } from "./screens/TitleDetail";
import { TogetherView } from "./screens/Together";
import { TOP_BAR_HEIGHT, TopBar } from "./screens/TopBar";
import css from "./root.css";

addStyles(css);

/** Opens the profile and provides the page model to everything under it. */
export function Root({ mode }: { mode: "app" | "panel" }) {
  const [page, setPage] = useState<PageContext | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let model: AppModel | null = null;
    Session.open()
      .then((session) => {
        if (cancelled) return session.close();
        model = new AppModel(session);
        const live: LiveSet = makeLive(session.channel, () => model!.session.db);
        model.applyHash(location.hash);
        setPage({ model, live });
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      model?.session.close();
    };
  }, []);

  if (failure) {
    return (
      <div class="boot">
        <LogoMark size={52} color="var(--ink3)" />
        <p>Cineon couldn't open your library: {failure}</p>
      </div>
    );
  }
  if (!page) return <div class="boot" aria-busy="true" />;
  return (
    <Page.Provider value={page}>
      <Theme />
      <Signals />
      {mode === "panel" ? <SidePanel /> : <Workspace />}
      <MenuLayer />
    </Page.Provider>
  );
}

/** `data-theme` on the root from the profile's settings. */
function Theme() {
  const session = useSession();
  const theme = session.settings.theme;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return null;
}

/** The background's toasts and requests to change section, and other pages' profile switches. */
function Signals() {
  const model = useModel();
  const session = useSession();
  useEffect(
    () =>
      session.channel.on((signal) => {
        if (signal.type === "toast") model.toast(signal.text);
        else if (signal.type === "navigate") model.applyHash(`#${signal.route}`);
        else if (signal.type === "profile" && signal.profileId !== model.session.profile.id) void model.switchProfile(signal.profileId, false);
      }),
    [session],
  );
  useEffect(() => {
    const listener = () => model.applyHash(location.hash);
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  return null;
}

/** The top bar over everything, and below it the page; Home runs under the bar. */
function Workspace() {
  const model = useModel();
  const ui = useUi();
  const session = useSession();

  useKeys((event) => {
    if (hasCommand(event) && event.key.toLowerCase() === "k" && !event.shiftKey && !event.altKey) {
      if (ui.commandBar) model.closeCommandBar();
      else model.openCommandBar();
      return true;
    }
    if (event.key === "Escape" && !isMenuOpen()) return model.dismissTop();
    return false;
  });

  useEffect(() => {
    document.title = ui.route === "home" ? "Cineon" : `${routeTitle(ui.route)} · Cineon`;
  }, [ui.route]);

  const detail = ui.detailTitleId != null ? session.library.titles.get(ui.detailTitleId) ?? null : null;
  return (
    <div class="workspace">
      <main class={`page route-${ui.route}`} style={{ top: ui.route === "home" ? "0px" : `${TOP_BAR_HEIGHT}px` }} key={`${session.profile.id}-${ui.route}`}>
        <RouteView route={ui.route} />
      </main>
      <TopBar />
      {detail && (
        <Overlay onDismiss={() => model.openTitle(null)}>
          <TitleDetailView title={detail} />
        </Overlay>
      )}
      {ui.sheet && (
        <Overlay onDismiss={() => model.openSheet(null)}>
          <SheetHost sheet={ui.sheet} />
        </Overlay>
      )}
      <SeriesProposalOverlay />
      {ui.commandBar && (
        <Overlay strength={0.3} onDismiss={() => model.closeCommandBar()} align="top">
          <CommandBar seed={ui.commandBar.seed} />
        </Overlay>
      )}
      <ToastHost />
      {ui.profilePicker && <ProfilePicker />}
      {model.changingReel && <div class="reel-change" />}
      <Splash />
    </div>
  );
}

function routeTitle(route: Route): string {
  return { home: "Home", library: "Library", timeline: "Timeline", downloads: "Downloads", together: "Together", profile: "Profile", rate: "Rate", settings: "Settings" }[route];
}

function RouteView({ route }: { route: Route }) {
  switch (route) {
    case "home":
      return <HomeView />;
    case "library":
      return <LibraryView />;
    case "timeline":
      return <TimelineView />;
    case "downloads":
      return <DownloadsView />;
    case "together":
      return <TogetherView />;
    case "profile":
      return <ProfileView />;
    case "rate":
      return <RateModeView />;
    case "settings":
      return <SettingsView />;
  }
}

/** DimmedBackdrop and the card above it. */
export function Overlay({
  children,
  onDismiss,
  strength = 0.5,
  align = "center",
}: {
  children: ComponentChildren;
  onDismiss: () => void;
  strength?: number;
  align?: "center" | "top";
}) {
  return (
    <div class="overlay">
      <div class="dim" style={{ background: `rgba(0,0,0,${strength})` }} onClick={onDismiss} />
      <div class={`overlay-${align}`}>{children}</div>
    </div>
  );
}

/** ToastHost: one at a time, at the bottom, in glass. */
export function ToastHost() {
  const model = useModel();
  const ui = useUi();
  const toast = ui.toast;
  if (!toast) return null;
  return (
    <div class="toast-host" role="status" aria-live="polite">
      <div class="toast glass" key={toast.id}>
        <span class="message">{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            class="btn-link"
            onClick={() => {
              toast.action!.run();
              model.dismissToast();
            }}
          >
            {toast.action.title}
          </button>
        )}
      </div>
    </div>
  );
}

/** Whether the background answers at all, for pages that want to say so. */
export function useBackgroundAlive(): boolean | null {
  const [alive, setAlive] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void send("ping", {}, { timeoutMs: 1500 }).then((answer) => {
      if (!cancelled) setAlive(answer != null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return alive;
}

/** A section's "this needs the background" note. */
export function BackgroundNote({ text }: { text: string }) {
  return (
    <p class="background-note">
      <Icon name="exclamationmark.circle" size={14} />
      {text}
    </p>
  );
}

export function useMemoOnce<T>(make: () => T): T {
  return useMemo(make, []);
}
