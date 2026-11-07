# Shields (src/core/shields)

Ported from `windows/Cineon.Core/Shields` (checked against `Cineon/Shields`). The apps' parser is
ported line for line: the same lines are kept and skipped, so the five lists come to the same
116,157 rules as on the Mac and Windows. What changes is the target. Network rules become
`declarativeNetRequest` static rulesets made at build time, and element hiding becomes per-host
CSS maps.

## Build output (`scripts/filters.mjs`)

The build runs it when `build/rules/index.json` is missing. It also runs alone:
`node scripts/filters.mjs [--lists dir] [--out dir]`. It bundles the TypeScript converter with
esbuild, so the build and the tests use the same code. `build.mjs` needed no change.

| File | What |
| --- | --- |
| `build/rules/<id>.json` | One static ruleset per list, written one rule per line. |
| `build/rules/index.json` | The manifest's `rule_resources`, most valuable list first, all enabled. |
| `build/rules/meta.json` | Counts per list (`RulesetMeta`), for Settings and for checking. |
| `build/cosmetic/<id>.json` | `CosmeticMap`: generic CSS, unless-rules, site selectors keyed by host, sites the list leaves alone. |

### Counts (bundled lists)

| List | Apps' rules | Network filters | Converted | DNR rules (block/allow) | Hosts folded | Trimmed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cineon-streaming | 73 | 72 | 72 | 1 (1/0) | 72 | 0 |
| ublock | 1,935 | 1,248 | 903 | 761 (481/280) | 213 | 0 |
| peterlowe | 3,562 | 3,562 | 3,562 | 1 (1/0) | 3,562 | 0 |
| easylist | 54,218 | 48,437 | 48,284 | 3,706 (3,196/510) | 44,717 | 0 |
| easyprivacy | 56,369 | 56,368 | 56,368 | 9,106 (8,266/840) | 47,449 | 0 |
| **total** | **116,157** | | | **13,575** | | **0** |

- "Apps' rules" is the apps' count: cosmetic batches plus network rules, as Settings shows it.
- The filters left unconverted are the 498 `$elemhide`/`$generichide` site exceptions (153 in
  EasyList, 345 in uBlock). They only switch element hiding off; see "Not 1:1" below.
- Every `||host^` filter with the same options is folded into one rule with a `requestDomains`
  list. That's how 96,013 filters fit in 407 rules, and why nothing needs trimming. Peter Lowe's
  whole list is one rule.
- No rule needs `regexFilter`, because the apps skip regex filters. The limit is 1,000 per ruleset.
- 13,575 rules are enabled by default, under Chrome's guaranteed 30,000. Chrome for Testing
  (playwright chromium-1248) loaded the build with all five rulesets enabled, and
  `getAvailableStaticRuleCount()` showed exactly 13,575 used, so no rule was rejected.

### Ordering and trimming (for when lists grow)

Rulesets are declared most valuable first: `cineon-streaming`, `ublock`, `peterlowe`, `easylist`,
`easyprivacy` (`RULESET_ORDER`). Inside a ruleset, rules are ranked:

1. folded host blocks
2. `$document` site exceptions
3. folded host exceptions
4. other exceptions
5. `$important` blocks
6. host-anchored path blocks
7. other generic blocks
8. `domain=` site-specific blocks

If the enabled lists ever exceed the 30,000 budget, `buildRulesets` cuts from the end of the least
valuable list first, and never cuts exceptions (the apps keep exceptions too). `meta.json` records
`trimmedRules` and `trimmedFilters`. There are no hit statistics, so "most hit" is approximated by
how widely a rule applies: host lists and rules for every site come before rules for named sites.

## Runtime API (`src/core/shields/index.ts`)

None of this calls browser APIs directly; the DNR API and the store are passed in, so it all runs
on Node.

- `ShieldState.open(store: ShieldStore, { flushDelayMs?, now? })`: the apps' ShieldState.
  - Per-site prefs keyed by registrable domain (`ShieldState.key`, the apps' algorithm):
    `prefsFor`, `shieldsOff`, `allowPopups`, `allowRedirects`, `trackingOff`, `allPrefs`,
    `sitesWithShieldsOff`, `update(host, { shieldsOff?, allowPopups?, allowRedirects?, trackingOff? })`.
  - Totals: `total`, `record({ ads?, popups?, redirects?, overlays? })` (written within 5 s),
    `flush()`, `onChange(fn)`.
  - `ShieldStore` mirrors Windows' `IShieldStore` over the `site_prefs` and `stats` tables. It may
    be async, and failures are ignored.
- `new ShieldRules(dnr: DnrApi, state, { cosmetic?: CosmeticIndex, rulesets? })`:
  - `apply({ networkBlocking, enabledLists })` diffs `getEnabledRulesets()` and calls
    `updateEnabledRulesets`. If the browser refuses for lack of room, it enables the lists one at a
    time, most valuable first, and returns `{ enabled, refused }`. It leaves alone rulesets it
    doesn't know.
  - Call `apply` on every worker start: an extension update resets rulesets to the manifest's
    defaults.
  - `setShieldsOff(host, off)` / `syncSites()` keep one dynamic rule up to date:
    `SITES_OFF_RULE_ID` (9,000,001), `allowAllRequests` on `main_frame` for the shields-off sites,
    at priority 100. Everything in such a page is then allowed, frames included; this is the apps'
    "skip Match when ShieldsOff(page host)". It takes effect from the next load, so reload the tab.
    Shields owns dynamic ids 9,000,000–9,000,999.
  - `cssFor(topUrlOrHost)` returns the element-hiding CSS for every frame of that page. It is ""
    when network blocking is off, when shields are off for the site, or when nothing applies.
    Inject it with `chrome.scripting.insertCSS({ target: { tabId, frameIds }, css, origin: "USER" })`;
    a user stylesheet is what the Mac uses.
  - `rulesetsFor(settings)`, `sitesOffRule()`, `settings`.
- `loadCosmeticIndex(ids, read)` loads the maps. In the worker,
  `read = (p) => fetch(chrome.runtime.getURL(p)).then((r) => r.json())`. Then
  `index.cssFor(host, activeLists?)` gives byte for byte the apps' `CssFor(host)`, cached for 256
  hosts.
- `popupAllowed({ popupShield, prefs, sameSite, realClick })` is the Windows rule;
  `redirectShieldActive(redirectShield, prefs)` says whether to apply it. The pop-up and redirect
  decisions themselves stay with `shield.js` and the runtime, as in the apps.
- `chromeDnr()` returns `chrome.declarativeNetRequest` as a `DnrApi`.
- `FILTER_CATALOG`, `DEFAULT_ENABLED_LISTS` (all five, as in the apps), `RULESET_ORDER`.

### Counting blocked requests (`ShieldCounter`)

`counterMode(dnr, (await chrome.management.getSelf()).installType)` picks one of three modes:

| Mode | When | How | Trade-off |
| --- | --- | --- | --- |
| `debug` | Unpacked (`installType === "development"`) | `onRuleMatchedDebug`, per request, with the URL | Exact and immediate, like the apps' per-request count. Chrome offers it only to unpacked extensions; Firefox only with `extensions.dnr.feedback`. |
| `matched` | Store and zip installs | Alarm every `POLL_MINUTES` (1) calls `counter.poll()`, which calls `getMatchedRules({ minTimeStamp })` | Works packed (`declarativeNetRequestFeedback` is in the manifest). Chrome allows 20 calls per 10 minutes and forgets matches of closed pages after 5 minutes, so totals lag up to a minute. No URLs, only rule ids. Exceptions are told apart by id (≥ `ALLOW_ID_BASE`). Save `counter.checkpoint` to `storage.session` after each poll and pass it back on restart. |
| `off` | Firefox without the pref | Nothing | Firefox could count with webRequest instead (out of scope here). |

Also call `counter.showCountOnBadge(true)` (`setExtensionActionOptions({ displayActionCountAsBadgeText })`).
The browser then keeps an exact per-tab count on the toolbar badge for free. Because the feedback
permission is held, `chrome.action.getBadgeText({ tabId })` returns the real number, which the
shield panel can show without spending the quota.

`counter.blockedOnTab(tabId)` and `resetTab(tabId)` keep the apps' per-tab count. Every block
counted also goes to `state.record({ ads })`.

## Not 1:1, and why

1. **Exceptions reach every list.** WebKit's `ignore-previous-rules` stays inside its own compiled
   list. A DNR `allow` covers the whole extension, and priorities can't scope it to one ruleset.
   This is how uBlock uses these lists together.
2. **`$important` beats exceptions** (priority 3 over 2), where the apps ignore it. This is what
   filter authors mean, and it keeps uBlock's important rules safe from another list's exceptions,
   which is what the apps' per-list isolation gave them.
3. **`^` is a real separator** (any character but a letter, a digit or `_-.%`, or the end). The
   Mac's regex makes it optional (`[/:&?=]?`), so the apps also block `popads.network` and
   `ads.com.evil.net` for `||popads.net^`.
4. **`$elemhide` / `$generichide` site exceptions only switch off that list's element hiding.** The
   apps turn the whole list off on those sites (498 of them), network rules included. DNR can't
   switch one list off for a site, and switching all of them off there would be a bigger change.
   `$document` exceptions do allow everything (`allowAllRequests`), and for every list (see 1).
5. **`domain=` and `$third-party` look at the frame that makes the request** (`initiatorDomains`,
   `domainType`). The apps look at the top-level page, as WebKit does. They agree for the page's
   own requests; inside a cross-site player iframe, `domain=site.com` rules don't fire. This is
   uBlock's and Adblock Plus's meaning. Chrome 145 adds `topDomains`, but older Chrome ignores the
   key (the rule would then match everywhere) and Firefox rejects it.
6. **Only host rules stop a top-level navigation.** WebKit applies every untyped rule to the page
   itself. DNR leaves out `main_frame` unless asked, and we ask only for `||host^` rules without
   party or site conditions: the ones that stop a pop-under landing on an ad network. A path rule
   like `/ads/` no longer blocks opening an article.
7. **`$script,subdocument` blocks scripts and frames.** The apps read `load-context: child-frame`
   as "frames only".
8. **The lists ship as built.** The apps download fresh lists weekly. Static rulesets can't change
   without an extension update, and dynamic rules are capped at 30,000, so updates come with
   releases.
9. **Element hiding is per list and keyed by the top-level page's host**, exactly as in the apps;
   the CSS is byte for byte theirs. It is injected as a user stylesheet, like the Mac (Windows uses
   a page stylesheet).
10. **Third-party uses the browser's full public-suffix list**, like WebKit. Windows uses the Mac's
    short list.

On the parity corpus (4,406 requests built from the rules), 89 of the 2,830 requests with real
hosts get a different answer: 79 from (4), and 10 from (3), (6) and URL form. Every difference is
attributed to one of the switches in `test/shields/appsMatcher.ts`.

## Tests (`test/shields`)

- `parity.test.ts` checks against the apps' own answers in `fixtures/apps-parity.json`, written by
  `apps-parity/` (Program.cs runs `windows/Cineon.Core`):
  - per-list counts are equal;
  - the reference matcher gives the apps' decisions on all 4,406 requests;
  - the DNR rules, run through `dnrMatcher.ts`, agree with that matcher once the deliberate
    differences are switched on;
  - each difference is counted;
  - `cssFor` matches the apps' `CssFor` on 543 hosts (SHA-256).
- To regenerate the fixture after a list or converter change:
  - `node test/shields/apps-parity/input.mjs <tmp>`
  - `dotnet run --project test/shields/apps-parity/AppsParity.csproj --artifacts-path <tmp>/bin -- <tmp> test/shields/fixtures/apps-parity.json`
- `filterConverter.test.ts` and `matching.test.ts` port `FilterConverterTests` and
  `ShieldEngineTests` to DNR. The "not 1:1" behaviours are tests of their own.
- `rulesets.test.ts` checks every rule against Chrome's validation, and checks the limits, the
  ordering and the trimming.
- `shieldState.test.ts` and `shieldRules.test.ts` cover the state and the runtime, the latter
  against a fake DNR API.
- Checked by hand in Chrome for Testing (headless, scratch profile, unpacked `dist/chrome`):
  - `testMatchOutcome` agrees with `dnrMatcher.ts` on every request of the corpus Chrome can
    parse, except where Chrome canonicalizes the URL first or where `allowAllRequests` needs a page
    around the request.
  - On real page loads, analytics, pop-under scripts and ad scripts inside a player iframe were
    blocked, and the sites-off rule let all of them through.
