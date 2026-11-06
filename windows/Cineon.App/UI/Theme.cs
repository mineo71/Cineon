using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Windows.UI;
using Windows.UI.Text;

namespace Cineon.App.UI;

/// Black and silver, or white and graphite. The chrome never takes a hue of its own, so the only
/// colour on screen comes from the films. Same values as the Mac's `Palette`.
public sealed record Palette(
    bool IsDark,
    Color Canvas,
    Color Ink,
    Color Ink2,
    Color Ink3,
    Color Raised,
    Color Raised2,
    Color Line,
    Color SilverTop,
    Color SilverBottom,
    Color OnSilver,
    Color StripBody,
    Color StripHole,
    Color CardFill)
{
    /// Ratings: the one colour Cineon allows itself besides the films' own, the gold of an award statuette.
    public LinearGradientBrush Gold => IsDark
        ? Vertical(Rgb(1, 0.86, 0.5), Rgb(0.93, 0.66, 0.22))
        : Vertical(Rgb(0.93, 0.69, 0.2), Rgb(0.74, 0.5, 0.08));

    public Color GoldInk => IsDark ? Rgb(1, 0.8, 0.4) : Rgb(0.7, 0.47, 0.06);

    public static Color Rgb(double r, double g, double b, double a = 1) =>
        Color.FromArgb((byte)Math.Round(a * 255), (byte)Math.Round(r * 255), (byte)Math.Round(g * 255), (byte)Math.Round(b * 255));

    public static LinearGradientBrush Vertical(Color top, Color bottom) => new()
    {
        StartPoint = new Windows.Foundation.Point(0.5, 0),
        EndPoint = new Windows.Foundation.Point(0.5, 1),
        GradientStops = { new GradientStop { Color = top, Offset = 0 }, new GradientStop { Color = bottom, Offset = 1 } },
    };

    public static readonly Palette Dark = new(
        IsDark: true,
        Canvas: Colors.Black,
        Ink: Colors.White,
        Ink2: Grey(1, 0.62),
        Ink3: Grey(1, 0.38),
        Raised: Grey(1, 0.07),
        Raised2: Grey(1, 0.13),
        Line: Grey(1, 0.11),
        SilverTop: Grey(0.96),
        SilverBottom: Grey(0.62),
        OnSilver: Colors.Black,
        StripBody: Grey(0.11),
        StripHole: Colors.Black,
        CardFill: Grey(0.055));

    public static readonly Palette White = new(
        IsDark: false,
        Canvas: Colors.White,
        Ink: Colors.Black,
        Ink2: Grey(0, 0.62),
        Ink3: Grey(0, 0.42),
        Raised: Grey(0, 0.045),
        Raised2: Grey(0, 0.09),
        Line: Grey(0, 0.11),
        SilverTop: Grey(0.26),
        SilverBottom: Colors.Black,
        OnSilver: Colors.White,
        StripBody: Colors.Black,
        StripHole: Colors.White,
        CardFill: Colors.White);

    /// SwiftUI's `Color(white:opacity:)`.
    public static Color Grey(double white, double opacity = 1)
    {
        var v = (byte)Math.Round(Math.Clamp(white, 0, 1) * 255);
        return Color.FromArgb((byte)Math.Round(Math.Clamp(opacity, 0, 1) * 255), v, v, v);
    }

    public static Color WithOpacity(Color color, double opacity) =>
        Color.FromArgb((byte)Math.Round(color.A * Math.Clamp(opacity, 0, 1)), color.R, color.G, color.B);

    public LinearGradientBrush Silver => Vertical(SilverTop, SilverBottom);
}

/// The palette in use, and a way to hear when it changes. Views read `Theme.P` while building and
/// rebuild on `Changed`.
public static class Theme
{
    public static Palette P { get; private set; } = Palette.Dark;
    public static event Action? Changed;

    public static void Set(bool dark)
    {
        var next = dark ? Palette.Dark : Palette.White;
        if (next == P) return;
        P = next;
        Changed?.Invoke();
    }

    public static SolidColorBrush Brush(Color color) => new(color);
}

/// Futura names films on the Mac. Windows has no Futura, so titles use Jost, an open geometric face
/// drawn after it. Segoe UI Variable is the interface around it, the way SF is on the Mac.
public static class Typeface
{
    private static readonly FontFamily Jost = new("ms-appx:///Assets/Fonts/Jost.ttf#Jost");
    private static readonly FontFamily Segoe = new("Segoe UI Variable Text, Segoe UI");
    private static readonly FontFamily SegoeDisplay = new("Segoe UI Variable Display, Segoe UI");
    public static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");

    public readonly record struct Font(FontFamily Family, double Size, FontWeight Weight, bool Tabular = false);

    public static Font Title(double size) => new(Jost, size, FontWeights.Medium);
    public static Font Bold(double size) => new(Jost, size, FontWeights.Bold);
    public static Font Condensed(double size) => new(Jost, size, FontWeights.ExtraBold);
    public static Font Ui(double size, FontWeight? weight = null) => new(size >= 20 ? SegoeDisplay : Segoe, size, weight ?? FontWeights.Normal);
    public static Font Time(double size, FontWeight? weight = null) => new(Segoe, size, weight ?? FontWeights.Normal, Tabular: true);

    public static readonly FontWeight Medium = FontWeights.Medium;
    public static readonly FontWeight Semibold = FontWeights.SemiBold;
}

/// Segoe Fluent Icons glyphs for the SF Symbols the Mac app uses.
public static class Glyph
{
    public const string House = "";
    public const string Films = "";
    public const string Clock = "";
    public const string Download = "";
    public const string People = "";
    public const string Globe = "";
    public const string Search = "";
    public const string Star = "";
    public const string StarFilled = "";
    public const string Back = "";
    public const string Forward = "";
    public const string Reload = "";
    public const string Add = "";
    public const string Close = "";
    public const string Play = "";
    public const string Pause = "";
    public const string Next = "";
    public const string Previous = "";
    public const string Settings = "";
    public const string Shield = "";
    public const string ChevronDown = "";
    public const string ChevronUp = "";
    public const string ChevronRight = "";
    public const string More = "";
    public const string Moon = "";
    public const string Volume = "";
    public const string Mute = "";
    public const string Subtitles = "";
    public const string PictureInPicture = "";
    public const string FullScreen = "";
    public const string Trash = "";
    public const string Folder = "";
    public const string Check = "";
    public const string Warning = "";
    public const string Link = "";
    public const string Share = "";
    public const string Chat = "";
    public const string Trophy = "";
    public const string Camera = "";
    public const string Edit = "";
    public const string Filter = "";
    public const string Sort = "";
    public const string Calendar = "";
    public const string Bell = "";
    public const string Sparkle = "";
    public const string Pin = "";
    public const string Grid = "";
    public const string List = "";
    public const string Retry = "";
    public const string Rewind10 = "";
    public const string Forward10 = "";
}
