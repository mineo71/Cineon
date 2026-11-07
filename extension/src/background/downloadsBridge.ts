// What the download center (core/downloads) needs from the browser: a tab as the downloads see it
// (DownloadTab), the episode resolver and its helper tab for season jobs (the Mac's helper
// BrowserTab in an off-screen window: here a muted background tab that's never discarded).

import { EpisodeRef, type Title } from "../core/data";
import type { DownloadTab, EpisodeHelperTab, EpisodeResolver, PageMethod, PageTitle, PublishedEpisode } from "../core/downloads";
import { EpisodeLinks } from "../core/parsing";
import type { Browser } from "./browser";
import type { SessionContext } from "./context";
import { DomainName } from "../core/data";
import type { Platform } from "./platform";
import { TabState } from "./tabState";

function pageTitle(tab: TabState): PageTitle | null {
  const p = tab.parsed;
  if (!p) return null;
  return { name: p.name, altName: p.altName, year: p.year, ref: p.ref, kindHint: p.kindHint, posterUrl: p.posterUrl, overview: p.overview };
}

/** A live view of a tab for the downloads (reads the tab's state each time). */
export function asDownloadTab(browser: Browser, tab: TabState): DownloadTab {
  const current = () => browser.registry.get(tab.id) ?? tab;
  return {
    get url() {
      return current().url;
    },
    get displayTitle() {
      return TabState.displayTitle(current(), DomainName.displayName);
    },
    get linkedTitleId() {
      return current().linkedTitleId;
    },
    get trackRef() {
      return current().track?.ref ?? null;
    },
    get parsed() {
      return pageTitle(current());
    },
    get sources() {
      return current().sources;
    },
    get bestSource() {
      return TabState.bestSource(current());
    },
    get sourcesFrameUrl() {
      return current().sourcesFrame?.url ?? null;
    },
    get mediaDuration() {
      return current().media?.duration ?? 0;
    },
    callPage(method: PageMethod, ...args: (number | boolean)[]): Promise<unknown> {
      return browser.platform.page.call(tab.id, 0, "__cineon", method, args);
    },
  };
}

/** The hidden tab a season job opens episodes in. Calls after `close()` do nothing. */
class HelperTab implements EpisodeHelperTab {
  private closed = false;
  private readonly view: DownloadTab;

  constructor(
    private readonly browser: Browser,
    private readonly state: TabState,
  ) {
    this.view = asDownloadTab(browser, state);
  }

  private get tab(): TabState {
    return this.browser.registry.get(this.state.id) ?? this.state;
  }

  get url() {
    return this.view.url;
  }
  get displayTitle() {
    return this.view.displayTitle;
  }
  get linkedTitleId() {
    return this.view.linkedTitleId;
  }
  get trackRef() {
    return this.view.trackRef;
  }
  get parsed() {
    return this.view.parsed;
  }
  get sources() {
    return this.view.sources;
  }
  get bestSource() {
    return this.view.bestSource;
  }
  get sourcesFrameUrl() {
    return this.view.sourcesFrameUrl;
  }
  get mediaDuration() {
    return this.view.mediaDuration;
  }
  get currentUrl(): string | null {
    return this.tab.url;
  }

  callPage(method: PageMethod, ...args: (number | boolean)[]): Promise<unknown> {
    if (this.closed) return Promise.resolve(null);
    return this.view.callPage(method, ...args);
  }

  load(url: string): void {
    if (this.closed) return;
    const tab = this.tab;
    tab.url = url;
    TabState.forgetSources(tab);
    void this.browser.platform.tabs.update(tab.id, { url }).catch(() => undefined);
  }

  reload(): void {
    if (this.closed) return;
    void this.browser.platform.tabs.reload(this.tab.id).catch(() => undefined);
  }

  pausePlayback(): void {
    if (this.closed) return;
    this.browser.pausePlayback(this.tab);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const id = this.tab.id;
    this.browser.registry.remove(id);
    void this.browser.platform.tabs.remove(id).catch(() => undefined);
  }
}

/** SeasonGrabber's way into the browser and the catalogue (C#'s EpisodeResolver). */
export class TabEpisodeResolver implements EpisodeResolver {
  constructor(
    private readonly ctx: SessionContext,
    private readonly platform: Platform,
  ) {}

  async makeHelperTab(): Promise<EpisodeHelperTab> {
    const opener = this.ctx.browser.selected;
    const info = await this.platform.tabs.create({ url: "about:blank", active: false, windowId: opener?.windowId });
    if (!info) throw new Error("Couldn't open a tab for the episodes");
    await this.platform.tabs.update(info.id, { muted: true, autoDiscardable: false }).catch(() => undefined);
    const tab = this.ctx.browser.registry.ensure(info.id, { ...info, url: null });
    tab.isHelper = true;
    this.ctx.browser.changed(tab);
    return new HelperTab(this.ctx.browser, tab);
  }

  episodeUrl(pageUrl: string, current: EpisodeRef, target: EpisodeRef): string | null {
    return EpisodeLinks.url(pageUrl, current, target);
  }

  async isAlive(url: string, signal: AbortSignal): Promise<boolean> {
    return (await this.ctx.probe.check(url, signal)).kind === "alive";
  }

  async publishedEpisodes(title: Title, _signal: AbortSignal): Promise<readonly PublishedEpisode[]> {
    const episodes = await this.ctx.metadata.episodes(title).catch(() => []);
    return episodes.map((e) => ({ season: e.season, episode: e.episode, released: e.released == null ? null : e.released / 1000 }));
  }
}
