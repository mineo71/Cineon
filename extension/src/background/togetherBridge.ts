// Together's two seams (core/together): TogetherHost (the profile session's side: settings, the pet,
// toasts, the clipboard, metadata) and PartyPlayer (the browser's tabs and media.js), as the Windows
// port's TogetherHost.cs does it for WebView2. The model itself lives here in the background, so a
// party outlives any page.

import type { KeyValueStorage, Title } from "../core/data";
import { metadataHit } from "../core/metadata";
import {
  type IdentityStore,
  type PartyPlayer,
  type PartyTab,
  type PlayerCommand,
  TitleCard,
  type TogetherHost,
  type TogetherModel,
  type TogetherRoute,
  type TogetherSettings,
} from "../core/together";
import type { SessionContext } from "./context";
import { detach, isWebUrl } from "./env";
import type { TabState } from "./tabState";

/** The identity file (the apps' together.json) as text in chrome.storage.local, per profile. */
export function storageIdentityStore(storage: KeyValueStorage, profileId: string): IdentityStore {
  const key = `together:${profileId}`;
  return {
    async read() {
      const value = await storage.get(key);
      return typeof value === "string" ? value : null;
    },
    async write(text) {
      await storage.set(key, text);
    },
  };
}

/** The party's tab id (the model keeps it to itself; TogetherSnapshot shows it). */
export function partyTabId(model: TogetherModel<Title> | null): number | null {
  if (!model) return null;
  const id = (model as unknown as { partyTabId: number | null }).partyTabId;
  return typeof id === "number" ? id : null;
}

export interface TogetherHostDeps {
  readonly ctx: SessionContext;
  readonly petCode: () => string;
  /** The Cineon page: `together` or a library route. */
  readonly openPage: (route: string) => void;
  readonly copyText: (text: string) => void;
  readonly model: () => TogetherModel<Title> | null;
}

export class BackgroundTogetherHost implements TogetherHost<Title> {
  constructor(private readonly deps: TogetherHostDeps) {}

  get settings(): TogetherSettings {
    return this.deps.ctx.settings;
  }

  get petCode(): string {
    return this.deps.petCode();
  }

  /** "web" when a site is in front; the background can't see which section a Cineon page shows. */
  get route(): TogetherRoute {
    return isWebUrl(this.deps.ctx.browser.selected?.url) ? "web" : "other";
  }

  go(route: "web" | "together"): void {
    if (route === "together") {
      this.deps.openPage("together");
      return;
    }
    const tab = this.deps.ctx.browser.tab(partyTabId(this.deps.model()));
    if (tab) detach(this.deps.ctx.browser.select(tab));
  }

  showToast(text: string): void {
    this.deps.ctx.toasts.show(text);
  }

  copyText(text: string): void {
    this.deps.copyText(text);
  }

  applyMetadata(titleId: number, card: TitleCard): void {
    if (!card.imdbId) return;
    const hit = metadataHit(card.imdbId, card.name, card.year, TitleCard.titleKind(card), { posterUrl: TitleCard.posterUri(card) });
    detach(this.deps.ctx.metadata.apply(hit, titleId));
  }

  enrichMetadata(titleId: number): void {
    this.deps.ctx.metadata.enrich(titleId);
  }

  async episodeCount(title: Title): Promise<number> {
    const episodes = await this.deps.ctx.metadata.episodes(title).catch(() => []);
    return episodes.filter((e) => e.season > 0).length;
  }
}

/** The tabs as a party drives them. A closed tab is null and every call on it does nothing. */
export class TabPartyPlayer implements PartyPlayer {
  /** The tab `together.startParty` named, used as the selected tab while the party starts. */
  chosenTabId: number | null = null;

  constructor(private readonly ctx: SessionContext) {}

  private snapshot(tab: TabState): PartyTab {
    const parsed = tab.parsed;
    return {
      id: tab.id,
      url: tab.url,
      media: tab.media ? { ...tab.media } : null,
      linkedTitleId: tab.linkedTitleId,
      parsed: parsed ? TitleCard.make(parsed.name, parsed.year, parsed.kindHint) : null,
    };
  }

  selectedTab(): PartyTab | null {
    const chosen = this.ctx.browser.tab(this.chosenTabId);
    const tab = chosen ?? this.ctx.browser.selected;
    return tab ? this.snapshot(tab) : null;
  }

  tab(id: number): PartyTab | null {
    const tab = this.ctx.browser.tab(id);
    return tab ? this.snapshot(tab) : null;
  }

  async openTab(url: string, select: boolean): Promise<number> {
    const tab = await this.ctx.browser.openTab(url, { select });
    return tab?.id ?? -1;
  }

  load(id: number, url: string): void {
    const tab = this.ctx.browser.tab(id);
    if (tab) detach(this.ctx.browser.load(tab, url));
  }

  async playerState(id: number): Promise<unknown> {
    const tab = this.ctx.browser.tab(id);
    return tab ? await this.ctx.browser.evaluateInPlayer(tab, "state") : null;
  }

  playerCommand(id: number, command: PlayerCommand): void {
    const tab = this.ctx.browser.tab(id);
    if (!tab) return;
    switch (command.kind) {
      case "play":
        this.ctx.browser.play(tab);
        break;
      case "pause":
        this.ctx.browser.pausePlayback(tab);
        break;
      case "seek":
        this.ctx.browser.seek(tab, command.seconds);
        break;
      case "rate":
        this.ctx.browser.setRate(tab, command.rate);
        break;
    }
  }

  showBanner(id: number, bannerId: string, text: string, timeout: number): void {
    const tab = this.ctx.browser.tab(id);
    if (tab) this.ctx.browser.showBanner(tab, { id: bannerId, text, timeout });
  }
}
