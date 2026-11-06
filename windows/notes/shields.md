# Shields (Cineon.Core.Shields)

Ported 1:1 from `Cineon/Shields`. The C# converter's JSON is identical to the Mac's for all five lists
(116,157 rules). A matcher checked against WebKit-style regex matching serves WebView2 at about
2-3 µs a request.

## API
- `FilterEngine(directory, bundledDirectory?, http?, now?)`: `directory` = AppPaths root + `Filters`.
  `Status`, `IsReady`, `Changed`, `RulesSummary` (debug `rules=`, e.g. `5/116157`), `PrepareAsync()`,
  `UpdateIfDueAsync()`, `RulesFor(networkBlocking, enabledLists)` -> `ShieldEngine` (re-fetch on `Changed`).
- `ShieldEngine.Match(url, documentUrl, ResourceType, isMainFrame)` -> `Decision.Allow|Block`;
  `CssFor(host)` -> `sel{display:none !important;}` rules or "".
- `ResourceType` = `CoreWebView2WebResourceContext` values: `(ResourceType)(int)args.ResourceContext`.
- `ShieldState(IShieldStore)`: per-site prefs (`ShieldsOff/AllowPopups/AllowRedirects/TrackingOff`,
  `Update(...)`), totals and `Record(ads:, popups:, redirects:, overlays:)`. The app adapts
  `IShieldStore` over the Database (SitePrefs, ShieldStats tables).

## WebView2 wiring
- `AddWebResourceRequestedFilter("*", All, CoreWebView2WebResourceRequestSourceKinds.All)` so iframe
  requests arrive. Main-frame navigation: `documentUrl: null, isMainFrame: true`. Others: the tab's
  top-level URL.
- Block with a 403 from `CreateWebResourceResponse`; count `tab.blocked.ads++` and `Record(ads: 1)`.
- Skip `Match` and `CssFor` when `ShieldsOff(host)`.
- Inject `CssFor(host)` into every frame.

## Not 1:1
Third-party uses the Mac's short registrable-domain list (WebKit uses the full PSL); `$subdocument`
only applies to non-main-frame Document requests; cosmetic exceptions only through whole-site
exceptions; rule metadata in `Filters/filters.json` instead of UserDefaults; injected CSS is a page
stylesheet, not a user stylesheet.
