using Cineon.App.UI;

namespace Cineon.App;

// The window's layout around sites, the part of the Mac's RootView (WorkspaceLayout) that depends
// on app state. Added by the browser port.
public sealed partial class AppModel
{
    /// The selected page's video went fullscreen or came back: the layout follows.
    public void BrowserLayoutChanged() => Notify();

    /// Sites and the player are a screen in a dark room. Everything else is the room.
    public bool IsScreen => Route is Route.Web or Route.Player;

    /// The top bar shows. On a site with the bars tucked away, they come back while the pointer is
    /// at the top. Cinema mode, and a video gone fullscreen, leave only the film.
    public bool ShowsBars
    {
        get
        {
            if (IsCinema || Browser.IsPageFullscreen) return false;
            if (Route == Route.Web && Settings.SidebarHidden) return IsSidebarPeeking;
            return true;
        }
    }

    /// Where the page starts below the window's top edge.
    public double ContentTop
    {
        get
        {
            if (IsCinema || Browser.IsPageFullscreen || Route == Route.Home) return 0;
            if (Route == Route.Web) return Settings.SidebarHidden ? 0 : TopBar.Height + BrowserBar.Height;
            return TopBar.Height;
        }
    }
}
