using Microsoft.UI.Xaml;

namespace Cineon.App.UI;

/// The page for each route. Pages register here as they're ported.
public static class Pages
{
    public static UIElement For(AppModel app) => app.Route switch
    {
        Route.Home => new HomePage(app),
        Route.Library => new LibraryPage(app),
        Route.Timeline => new TimelinePage(app),
        Route.Rate => new RatePage(app),
        _ => Placeholder(app.Route.ToString()),
    };

    private static UIElement Placeholder(string name) =>
        Ui.VStack(8,
            Ui.Text(name, Typeface.Title(30)),
            Ui.Text("This page is being ported from the Mac app.", Typeface.Ui(13), Theme.P.Ink3))
        .Padding(32, 34 + TopBar.Height, 32, 0);
}
