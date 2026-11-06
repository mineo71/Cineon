using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.UI;

namespace Cineon.App.UI;

public static class Images
{
    public static Uri Asset(string name) => new($"ms-appx:///Assets/{name}");

    public static BitmapImage Logo => new(Asset("logo-mark.png"));

    /// The logo mark tinted with the ink colour, like the Mac's template image.
    public static BitmapIcon LogoMark(double size = 28, Color? color = null) => new()
    {
        UriSource = Asset("logo-mark.png"),
        ShowAsMonochrome = true,
        Foreground = new SolidColorBrush(color ?? Theme.P.Ink),
        Width = size,
        Height = size,
    };
}
