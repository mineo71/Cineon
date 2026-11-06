using Microsoft.UI.Xaml;

namespace Cineon.App.UI;

/// The page for each route. Pages register here as they're ported.
public static class Pages
{
    public static UIElement For(AppModel app) => app.Route switch
    {
        // The site itself is in the workspace's web layer; this is what floats over it.
        Route.Web => new WebOverlays(app),
        Route.Together => new TogetherPage(app),
        Route.Profile => new ProfilePage(app),
        Route.Settings => new SettingsPage(app),
        Route.Downloads => new DownloadsPage(app),
        Route.Player => new LocalPlayerView(app),
        _ => Placeholder(app.Route.ToString()),
    };

    private static UIElement Placeholder(string name) =>
        Ui.VStack(8,
            Ui.Text(name, Typeface.Title(30)),
            Ui.Text("This page is being ported from the Mac app.", Typeface.Ui(13), Theme.P.Ink3))
        .Padding(32, 34 + TopBar.Height, 32, 0);
}
