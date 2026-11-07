// Port of Swift's AppSettings (Models.swift) via windows/Cineon.Core/Data/AppSettings.cs.
// Stored per profile, so each family member keeps their own preferences: JSON in the profile
// database's `settings` store under the key `app`, with the Mac's key names, so settings move
// between the apps and the extension.

import { AppTheme, CaptionStyle, SearchEngine } from "./models";

export interface AppSettings {
  readonly theme: AppTheme;
  readonly ambientLight: boolean;
  readonly ambientStrength: number;
  readonly launchAnimation: boolean;
  readonly sidebarWidth: number;
  readonly sidebarHidden: boolean;

  readonly autoResume: boolean;
  readonly finishThreshold: number;
  readonly minimumSecondsToTrack: number;
  readonly hibernateMinutes: number;
  readonly pauseOtherTabs: boolean;
  readonly autoRescue: boolean;
  readonly learnSkips: boolean;
  readonly autoNextEpisode: boolean;
  readonly keepFrames: boolean;

  readonly networkBlocking: boolean;
  readonly popupShield: boolean;
  readonly redirectShield: boolean;
  readonly overlaySweeper: boolean;
  readonly downloadShield: boolean;
  /** A set: no duplicates, order doesn't matter (compare with `AppSettings.equals`). */
  readonly enabledLists: readonly string[];

  readonly fetchMetadata: boolean;
  readonly saveBrowsingHistory: boolean;
  readonly searchEngine: SearchEngine;

  readonly showDownloadButton: boolean;
  /** Empty means the default folder. Kept for the apps; the extension saves into the browser's downloads folder. */
  readonly downloadsFolder: string;
  readonly captionStyle: CaptionStyle;

  /** Dialogue louder, explosions softer, in players whose sound the page may process. */
  readonly voiceBoost: boolean;
  /** Downloaded episodes go to the bin once watched to the end. */
  readonly binWatchedDownloads: boolean;
  /** The native player moves on to the next downloaded episode. */
  readonly playNextDownload: boolean;
  /** A notification when a series you're watching gets a new episode. */
  readonly newEpisodeAlerts: boolean;
  /** Your pixel pet is your avatar in parties and challenges. */
  readonly sharePet: boolean;
  /** Ratings and lists are kept in the cloud too, so they survive starting over. */
  readonly cloudBackup: boolean;
}

type Kind = "bool" | "number" | "string" | "strings" | AppSettingsEnum;
type AppSettingsEnum = { fromRaw(raw: unknown): string | null };

/** Every key in the order the apps write them, with how each one is read. */
const FIELDS: readonly (readonly [keyof AppSettings, Kind])[] = [
  ["theme", AppTheme],
  ["ambientLight", "bool"],
  ["ambientStrength", "number"],
  ["launchAnimation", "bool"],
  ["sidebarWidth", "number"],
  ["sidebarHidden", "bool"],
  ["autoResume", "bool"],
  ["finishThreshold", "number"],
  ["minimumSecondsToTrack", "number"],
  ["hibernateMinutes", "number"],
  ["pauseOtherTabs", "bool"],
  ["autoRescue", "bool"],
  ["learnSkips", "bool"],
  ["autoNextEpisode", "bool"],
  ["keepFrames", "bool"],
  ["networkBlocking", "bool"],
  ["popupShield", "bool"],
  ["redirectShield", "bool"],
  ["overlaySweeper", "bool"],
  ["downloadShield", "bool"],
  ["enabledLists", "strings"],
  ["fetchMetadata", "bool"],
  ["saveBrowsingHistory", "bool"],
  ["searchEngine", SearchEngine],
  ["showDownloadButton", "bool"],
  ["downloadsFolder", "string"],
  ["captionStyle", CaptionStyle],
  ["voiceBoost", "bool"],
  ["binWatchedDownloads", "bool"],
  ["playNextDownload", "bool"],
  ["newEpisodeAlerts", "bool"],
  ["sharePet", "bool"],
  ["cloudBackup", "bool"],
];

const DEFAULTS: AppSettings = Object.freeze({
  theme: "dark",
  ambientLight: true,
  ambientStrength: 0.55,
  launchAnimation: true,
  sidebarWidth: 252.0,
  sidebarHidden: false,
  autoResume: true,
  finishThreshold: 0.92,
  minimumSecondsToTrack: 15.0,
  hibernateMinutes: 20.0,
  pauseOtherTabs: true,
  autoRescue: true,
  learnSkips: true,
  autoNextEpisode: true,
  keepFrames: true,
  networkBlocking: true,
  popupShield: true,
  redirectShield: true,
  overlaySweeper: true,
  downloadShield: true,
  enabledLists: Object.freeze(["easylist", "easyprivacy", "ublock", "peterlowe", "cineon-streaming"]),
  fetchMetadata: true,
  saveBrowsingHistory: true,
  searchEngine: "duckDuckGo",
  showDownloadButton: true,
  downloadsFolder: "",
  captionStyle: "site",
  voiceBoost: false,
  binWatchedDownloads: true,
  playNextDownload: true,
  newEpisodeAlerts: true,
  sharePet: true,
  cloudBackup: true,
});

/** Swift's `try? container.decode(T.self, forKey:)`: the value, or undefined when missing or the wrong type. */
function lenient(value: unknown, kind: Kind): unknown {
  switch (kind) {
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "string":
      return typeof value === "string" ? value : undefined;
    case "strings":
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
      return Array.from(new Set(value as string[]));
    default:
      return kind.fromRaw(value) ?? undefined;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export const AppSettings = {
  /** The Mac's keys, in the order they're written. */
  keys: FIELDS.map(([key]) => key) as readonly (keyof AppSettings)[],

  defaults(): AppSettings {
    return { ...DEFAULTS, enabledLists: [...DEFAULTS.enabledLists] };
  },

  make(fields: Partial<AppSettings> = {}): AppSettings {
    return { ...AppSettings.defaults(), ...fields };
  },

  /**
   * Reads settings JSON the way the Mac does: every field falls back to its default when it's
   * missing or the wrong type, so adding a setting never loses the others. Null when the text
   * isn't a JSON object at all (the Mac then uses the defaults).
   */
  decode(json: string | Uint8Array | ArrayBuffer): AppSettings | null {
    let text: string;
    try {
      text = typeof json === "string" ? json : utf8.decode(json);
    } catch {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    return AppSettings.fromObject(value);
  },

  /** `decode` for a value already parsed from JSON. */
  fromObject(value: unknown): AppSettings | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = AppSettings.defaults() as unknown as Record<string, unknown>;
    for (const [key, kind] of FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const read = lenient(source[key], kind);
      if (read !== undefined) result[key] = read;
    }
    return result as unknown as AppSettings;
  },

  /** The same JSON object the Mac writes, with the same keys in the same order. */
  toObject(settings: AppSettings): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key] of FIELDS) {
      const value = settings[key];
      out[key] = key === "enabledLists" ? Array.from(new Set(value as readonly string[])) : value;
    }
    return out;
  },

  /** JSON text. */
  encode(settings: AppSettings): string {
    return JSON.stringify(AppSettings.toObject(settings));
  },

  /** Value equality, with `enabledLists` compared as a set. */
  equals(a: AppSettings, b: AppSettings): boolean {
    for (const [key] of FIELDS) {
      if (key === "enabledLists") {
        const x = new Set(a.enabledLists);
        const y = new Set(b.enabledLists);
        if (x.size !== y.size || [...x].some((item) => !y.has(item))) return false;
      } else if (!Object.is(a[key], b[key])) {
        return false;
      }
    }
    return true;
  },
};
