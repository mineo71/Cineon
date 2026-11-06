using Cineon.App.UI;

namespace Cineon.App.Browser;

/// All the tabs in a profile. A stand-in from Cineon/Browser/BrowserModel.swift with only the
/// members AppModel, ProfileSession and the menus use; the browser port owns this file.
public sealed class BrowserModel : Observable
{
    private readonly List<BrowserTab> _tabs = [];

    // TODO(port-browser): init(session: ProfileSession)
    public BrowserModel(ProfileSession session)
    {
        Session = session;
    }

    public ProfileSession Session { get; }

    // TODO(port-browser): private(set) var tabs: [BrowserTab]
    public IReadOnlyList<BrowserTab> Tabs => _tabs;

    // TODO(port-browser): var selectedID: UUID?
    public Guid? SelectedId { get; set; }

    // TODO(port-browser): var search: SearchSession?, and `selected` returning search.selectedTab first.
    // TODO(port-browser): var selected: BrowserTab?
    public BrowserTab? Selected => _tabs.FirstOrDefault(t => t.Id == SelectedId);

    /// Tabs shown in the bar. Search results stay out until they're kept.
    // TODO(port-browser): var listedTabs: [BrowserTab]
    public IReadOnlyList<BrowserTab> ListedTabs => [.. _tabs.Where(t => t.SearchGroup is null)];

    // TODO(port-browser): var playingTab: BrowserTab?
    public BrowserTab? PlayingTab => _tabs.FirstOrDefault(t => t.Media?.IsPlaying == true) ?? _tabs.FirstOrDefault(t => t.Track is not null);

    // TODO(port-browser): func start()  (restore saved tabs, hibernate timer, warm web view)
    public void Start() { }

    // TODO(port-browser): func shutdown()  (save tabs, stop rescue and tracking, tear down web views)
    public void Shutdown() { }

    // TODO(port-browser): @discardableResult func openTab(url: URL?, select: Bool = true, resumeAt: Double? = nil, siteID: Int64? = nil, keepWatching: Bool = false) -> BrowserTab
    public BrowserTab OpenTab(Uri? url, bool select = true, double? resumeAt = null, long? siteId = null, bool keepWatching = false) =>
        new(this, url);

    // TODO(port-browser): func open(url: URL, resumeAt: Double? = nil, siteID: Int64? = nil, keepWatching: Bool = false)
    public void Open(Uri url, double? resumeAt = null, long? siteId = null, bool keepWatching = false) { }

    // TODO(port-browser): func select(_ tab: BrowserTab)  (also sets the app's route to .web)
    public void Select(BrowserTab tab) { }

    // TODO(port-browser): func close(_ tab: BrowserTab)
    public void Close(BrowserTab tab) { }

    // TODO(port-browser): func reopenClosed()
    public void ReopenClosed() { }

    // TODO(port-browser): func selectTab(atIndex index: Int)
    public void SelectTab(int index) { }

    // TODO(port-browser): func selectAdjacent(_ delta: Int)
    public void SelectAdjacent(int delta) { }

    // TODO(port-browser): func searchEverywhere(_ query: String, titleID: Int64? = nil)
    public void SearchEverywhere(string query, long? titleId = null) { }

    // TODO(port-browser): func endSearch(keeping kept: BrowserTab?)
    public void EndSearch(BrowserTab? keeping) { }
}
