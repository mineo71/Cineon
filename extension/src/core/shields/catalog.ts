// The filter lists, as the apps' FilterEngine.catalog lists them, plus what the extension needs to
// know about each one's static ruleset.

export interface FilterListInfo {
  id: string;
  name: string;
  summary: string;
  /** Where the apps download updates. The extension ships the lists as built; see notes/shields.md. */
  updateUrl: string | null;
}

/** Catalog order: the order the apps keep lists in, and the order their CSS is joined in. */
export const FILTER_CATALOG: readonly FilterListInfo[] = [
  { id: "easylist", name: "EasyList", summary: "The main list of ads", updateUrl: "https://easylist.to/easylist/easylist.txt" },
  { id: "easyprivacy", name: "EasyPrivacy", summary: "Trackers and analytics", updateUrl: "https://easylist.to/easylist/easyprivacy.txt" },
  { id: "ublock", name: "uBlock filters", summary: "Extra rules from the uBlock Origin project", updateUrl: "https://ublockorigin.github.io/uAssets/filters/filters.txt" },
  {
    id: "peterlowe", name: "Peter Lowe's list", summary: "Ad and tracking servers",
    updateUrl: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext",
  },
  { id: "cineon-streaming", name: "Cineon streaming", summary: "Pop-under networks used by streaming sites", updateUrl: null },
];

/** The apps' default `enabledLists`: every list. */
export const DEFAULT_ENABLED_LISTS: readonly string[] = FILTER_CATALOG.map((l) => l.id);

/**
 * The order rulesets are declared in the manifest, most valuable first: if the browser can't give
 * the extension room for all of them, it's the last ones that miss out. The streaming list and
 * uBlock's are small and aimed at exactly the sites Cineon is for; Peter Lowe's is ad servers only.
 */
export const RULESET_ORDER: readonly string[] = ["cineon-streaming", "ublock", "peterlowe", "easylist", "easyprivacy"];
