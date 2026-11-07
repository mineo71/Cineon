// The Cineon page's AppModel: which section is showing, the overlays (title card, sheets, command
// bar, profile picker), toasts, and the actions screens share (resume, open a site, find on my
// sites, add to backlog). Tabs and players go through the background (shared/messages.ts); when it
// doesn't answer, the browser's own APIs stand in where they can.

import {
  DomainName,
  type Site,
  Site as SiteModel,
  type Title,
  type TitleKind,
  type TitleStatus,
} from "../../core/data";
import type { MetadataHit } from "../../core/metadata";
import { type PlayerCommand, send } from "../../shared/messages";
import { Session } from "./session";
import { Timecode } from "./format";

export type Route = "home" | "library" | "timeline" | "downloads" | "together" | "profile" | "rate" | "settings";
export const ROUTES: readonly Route[] = ["home", "library", "timeline", "downloads", "together", "profile", "rate", "settings"];

export type Sheet =
  | { readonly kind: "addSite"; readonly prefill: string | null }
  | { readonly kind: "editSite"; readonly siteId: number }
  | { readonly kind: "addTitle"; readonly query: string | null }
  | { readonly kind: "relink"; readonly tabId: number }
  | { readonly kind: "import" }
  | { readonly kind: "newChallenge" };

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly action: { readonly title: string; readonly run: () => void } | null;
}

export interface UiState {
  readonly route: Route;
  readonly detailTitleId: number | null;
  readonly sheet: Sheet | null;
  /** The command bar, open with this text. */
  readonly commandBar: { readonly seed: string } | null;
  readonly profilePicker: boolean;
  readonly toast: Toast | null;
}

/** `#library`, `#library?title=12`, `#home?add=Dune`, `#settings?sheet=import`. */
export function parseHash(hash: string): { route: Route | "panel" | null; params: URLSearchParams } {
  const text = hash.replace(/^#/, "");
  const [path = "", query = ""] = text.split("?");
  const route = path === "panel" ? "panel" : (ROUTES as readonly string[]).includes(path) ? (path as Route) : null;
  return { route, params: new URLSearchParams(query) };
}

let toastIds = 0;

/** What pages say when something needs the background and it doesn't answer. */
export const NO_BACKGROUND = "Cineon's background isn't answering. Reload the extension and try again.";

export class AppModel {
  private listeners = new Set<() => void>();
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  state: UiState = { route: "home", detailTitleId: null, sheet: null, commandBar: null, profilePicker: false, toast: null };

  /** True while the reel changes to another person (ReelChange). */
  changingReel = false;

  constructor(public session: Session) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * AppModel.switchProfile: closes this person's session and opens theirs. `announce` tells the
   * other contexts (false when this page is following someone else's switch).
   */
  async switchProfile(profileId: string, announce = true): Promise<void> {
    if (profileId === this.session.profile.id && announce) {
      this.showProfilePicker(false);
      return;
    }
    this.changingReel = true;
    this.emit();
    const old = this.session;
    try {
      if (announce) {
        await old.profiles.setPoster(old.profile.id, old.library.continueWatching[0]?.title.posterUrl ?? old.profile.lastPosterUrl);
        await old.profiles.markUsed(profileId);
        old.channel.post({ type: "profile", profileId });
        void send("session.switchProfile", { profileId });
      }
      const next = await Session.open(profileId, { channel: old.channel });
      old.close();
      this.session = next;
      this.state = { ...this.state, route: "home", detailTitleId: null, sheet: null, commandBar: null, profilePicker: false };
    } catch (error) {
      this.toast(`Couldn't open that profile: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTimeout(() => {
        this.changingReel = false;
        this.emit();
      }, 320);
      this.emit();
    }
  }

  private set(change: Partial<UiState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  get library() {
    return this.session.library;
  }

  get settings() {
    return this.session.settings;
  }

  // MARK: Navigation

  go(route: Route): void {
    if (this.state.route === route) return;
    this.set({ route });
    const hash = `#${route}`;
    if (typeof location !== "undefined" && location.hash !== hash && !location.hash.startsWith("#panel")) {
      history.replaceState(null, "", hash);
    }
  }

  /** Applies `#route?title=…&add=…&sheet=…` (from the popup or a notification). */
  applyHash(hash: string): void {
    const { route, params } = parseHash(hash);
    if (route && route !== "panel") this.set({ route });
    const title = Number(params.get("title"));
    if (Number.isInteger(title) && title > 0) this.openTitle(title);
    const add = params.get("add");
    if (add != null) this.openSheet({ kind: "addTitle", query: add });
    const sheet = params.get("sheet");
    if (sheet === "import") this.openSheet({ kind: "import" });
    if (sheet === "addSite") this.openSheet({ kind: "addSite", prefill: params.get("prefill") });
    const relink = Number(params.get("relink"));
    if (Number.isInteger(relink) && relink > 0) this.openSheet({ kind: "relink", tabId: relink });
  }

  openTitle(id: number | null): void {
    this.set({ detailTitleId: id });
  }

  openSheet(sheet: Sheet | null): void {
    this.set({ sheet });
  }

  openCommandBar(seed = ""): void {
    this.set({ commandBar: { seed } });
  }

  closeCommandBar(): void {
    this.set({ commandBar: null });
  }

  showProfilePicker(visible: boolean): void {
    this.set({ profilePicker: visible });
  }

  /** Esc: the topmost overlay closes. True when something did. */
  dismissTop(): boolean {
    if (this.state.profilePicker) return this.showProfilePicker(false), true;
    if (this.state.commandBar) return this.closeCommandBar(), true;
    if (this.state.sheet) return this.openSheet(null), true;
    if (this.state.detailTitleId != null) return this.openTitle(null), true;
    return false;
  }

  // MARK: Toasts (ToastCenter)

  toast(message: string, action: Toast["action"] = null): void {
    // A burst of the same message shouldn't restart it over and over.
    if (this.state.toast?.message === message && this.state.toast.action == null && action == null) return;
    this.set({ toast: { id: ++toastIds, message, action } });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.dismissToast(), action == null ? 3000 : 6000);
  }

  dismissToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    if (this.state.toast) this.set({ toast: null });
  }

  // MARK: Settings

  toggleTheme(): void {
    void this.session.updateSettings({ theme: this.settings.theme === "dark" ? "white" : "dark" });
  }

  // MARK: Watching

  /** Takes you to where you stopped, on the site you stopped on (AppModel.resume(_:)). */
  resume(title: Title): void {
    this.openTitle(null);
    const progress = this.library.latestProgress(title.id);
    if (progress?.url) {
      void this.resumeUrl(progress.url, progress.position);
    } else {
      void this.searchEverywhere(title.name, title.id);
    }
  }

  /** AppModel.resume(url:at:): a new tab, jumping to the second once the video loads. */
  async resumeUrl(url: string, position: number | null): Promise<void> {
    this.openTitle(null);
    if (url.startsWith("file:")) {
      this.toast("Open the file from Downloads");
      return;
    }
    const answer = await send("tabs.open", { url, resumeAt: position, active: true });
    if (answer) return;
    await openTabDirectly(url);
    if (position != null && position > 5) this.toast(`Opened. Cineon jumps to ${Timecode.string(position)} once its background is running`);
  }

  /** AppModel.openSite: the open tab on that site, or a new one. */
  async openSite(site: Site): Promise<void> {
    const tabs = await queryTabs();
    const existing = tabs.find((tab) => DomainName.isSameSite(hostOf(tab.url), site.host));
    if (existing?.id != null) {
      const focused = await send("tabs.focus", { tabId: existing.id });
      if (!focused) await focusTabDirectly(existing);
      return;
    }
    const answer = await send("tabs.open", { url: site.homeUrl, resumeAt: null, active: true });
    if (!answer) await openTabDirectly(site.homeUrl);
  }

  /** BrowserModel.searchEverywhere: every site that can search, or the web. */
  async searchEverywhere(query: string, titleId: number | null = null): Promise<void> {
    this.openTitle(null);
    const answer = await send("search.everywhere", { query, titleId });
    if (answer) return;
    const urls = this.library.sites
      .map((site) => SiteModel.searchUrl(site, query))
      .filter((url): url is string => url != null);
    if (urls.length === 0) {
      const { SearchEngine } = await import("../../core/data");
      const web = SearchEngine.url(this.settings.searchEngine, query);
      if (web) await openTabDirectly(web);
      return;
    }
    for (const [index, url] of urls.entries()) await openTabDirectly(url, index === 0);
  }

  /** Opens any address in a new tab (the command bar's Go to, history, web search). */
  async openUrl(url: string): Promise<void> {
    const answer = await send("tabs.open", { url, resumeAt: null, active: true });
    if (!answer) await openTabDirectly(url);
  }

  async playerCommand(tabId: number, command: PlayerCommand): Promise<boolean> {
    const answer = await send("player.command", { tabId, command });
    if (!answer) this.toast(NO_BACKGROUND);
    return answer?.ok ?? false;
  }

  /** Brings a tab to the front. */
  async focusTab(tabId: number): Promise<void> {
    const answer = await send("tabs.focus", { tabId });
    if (answer) return;
    const tab = (await queryTabs()).find((t) => t.id === tabId);
    if (tab) await focusTabDirectly(tab);
  }

  /** "This isn't a film" and "Don't track this site". */
  async trackerCommand(type: "tracker.ignore" | "tracker.stopSite", tabId: number): Promise<void> {
    const answer = await send(type, { tabId });
    if (!answer) this.toast(NO_BACKGROUND);
  }

  // MARK: Library

  /** AppModel.addToBacklog(hit:): the catalogue's choice, with its details filled in. */
  async addToBacklog(hit: MetadataHit): Promise<Title | null> {
    const title = await this.library.addTitle(hit.name, {
      year: hit.year,
      kind: hit.kind as TitleKind,
      status: "backlog",
      imdbId: hit.id,
      posterUrl: hit.posterUrl,
    });
    if (!title) return null;
    // Fills in the description and backdrop.
    this.session.metadata.apply(hit, title.id);
    this.toast(`Added ${hit.name} to backlog`);
    return title;
  }

  /** Adds by name alone, then looks for details in the background. */
  async addByName(name: string, status: TitleStatus = "backlog"): Promise<Title | null> {
    const title = await this.library.addTitle(name, { status });
    if (!title) return null;
    this.session.metadata.enrich(title.id);
    return title;
  }

  async setStatus(id: number, status: TitleStatus): Promise<void> {
    await this.library.setStatus(id, status);
  }

  async remove(id: number): Promise<void> {
    if (this.state.detailTitleId === id) this.openTitle(null);
    await this.library.delete(id);
  }

  // MARK: Clipboard

  async copy(text: string, toast: string | null = null): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      if (toast) this.toast(toast);
    } catch {
      this.toast("Couldn't copy");
    }
  }
}

// MARK: Browser fallbacks (when the background doesn't answer)

function tabsApi(): typeof chrome.tabs | null {
  return (globalThis as { chrome?: typeof chrome }).chrome?.tabs ?? null;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export async function queryTabs(): Promise<chrome.tabs.Tab[]> {
  const tabs = tabsApi();
  if (!tabs) return [];
  try {
    return await tabs.query({});
  } catch {
    return [];
  }
}

export async function openTabDirectly(url: string, active = true): Promise<void> {
  const tabs = tabsApi();
  if (tabs) {
    try {
      await tabs.create({ url, active });
      return;
    } catch {
      // Fall through to a plain window.
    }
  }
  globalThis.open?.(url, "_blank", "noopener");
}

export async function focusTabDirectly(tab: chrome.tabs.Tab): Promise<void> {
  const chromeApi = (globalThis as { chrome?: typeof chrome }).chrome;
  if (tab.id == null || !chromeApi?.tabs) return;
  try {
    await chromeApi.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chromeApi.windows?.update(tab.windowId, { focused: true });
  } catch {
    // The tab closed meanwhile.
  }
}
