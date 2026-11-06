using System.Runtime.InteropServices.WindowsRuntime;
using Cineon.Core.Data;
using Microsoft.Graphics.Canvas.Effects;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Storage.Streams;
using Windows.UI;

namespace Cineon.App.UI;

// Pieces every screen shares, ported from the Mac's Theme.swift and Rating.swift: star ratings,
// the gold badge, the progress line, the film strip and posters that fade to black and white.

/// Fetches image bytes for posters, backdrops, site icons and saved frames (file paths), through
/// Core's ImageCache (memory, then disk, then network), like the Mac's image pipeline.
public static class ImageBytes
{
    public static async Task<byte[]?> GetAsync(Uri url)
    {
        try
        {
            if (url.IsFile) return await File.ReadAllBytesAsync(url.LocalPath);
            if (url.Scheme is "http" or "https") return await Cineon.Core.Metadata.ImageCache.Shared.DataAsync(url);
        }
        catch
        {
            // A missing image falls back to its placeholder.
        }
        return null;
    }

    public static async Task<IRandomAccessStream?> StreamAsync(Uri url)
    {
        var bytes = await GetAsync(url);
        if (bytes is null) return null;
        var stream = new InMemoryRandomAccessStream();
        await stream.WriteAsync(bytes.AsBuffer());
        stream.Seek(0);
        return stream;
    }
}

/// One star, filled from the left by `fill` (0, 0.5 or 1), gold over a faint empty star.
public static class Stars
{
    private const string Filled = "";

    public static Grid Star(double fill, double size, double emptyOpacity = 1, Palette? palette = null)
    {
        var p = palette ?? Theme.P;
        var box = size * 1.1;
        var grid = new Grid { Width = box, Height = box };
        grid.Children.Add(new FontIcon { Glyph = Filled, FontFamily = Typeface.Icons, FontSize = size, Foreground = new SolidColorBrush(Palette.WithOpacity(p.Raised2, emptyOpacity)), HorizontalAlignment = HorizontalAlignment.Left, IsTextScaleFactorEnabled = false });
        if (fill > 0)
        {
            var gold = new FontIcon { Glyph = Filled, FontFamily = Typeface.Icons, FontSize = size, Foreground = p.Gold, HorizontalAlignment = HorizontalAlignment.Left, IsTextScaleFactorEnabled = false };
            var clip = new Grid { Width = box * fill, HorizontalAlignment = HorizontalAlignment.Left, Children = { gold } };
            clip.Clip = new RectangleGeometry { Rect = new Windows.Foundation.Rect(0, 0, box * fill, box) };
            grid.Children.Add(clip);
        }
        return grid;
    }

    /// How full star `star` (1-10) is for a rating in halves.
    public static double Fill(int star, int halves)
    {
        var full = halves / 2;
        if (star <= full) return 1;
        if (star == full + 1 && halves % 2 == 1) return 0.5;
        return 0;
    }

    /// Ten stars, read only.
    public static StackPanel Row(int? halves, double size = 11, double spacing = 1.5)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = spacing };
        for (var star = 1; star <= 10; star++) row.Children.Add(Star(Fill(star, halves ?? 0), size));
        row.Label(halves is { } h ? $"Rated {Rating.Text(h)} out of 10" : "Not rated");
        return row;
    }

    /// A small gold badge with the rating, for poster corners and rows. Always dark, like the Mac's.
    public static Border Badge(int halves, bool compact = false)
    {
        var p = Palette.Dark;
        var content = Ui.HStack(compact ? 2.5 : 3.5,
            new FontIcon { Glyph = Filled, FontFamily = Typeface.Icons, FontSize = compact ? 8 : 9.5, Foreground = p.Gold, IsTextScaleFactorEnabled = false },
            Ui.Line(Rating.Text(halves), Typeface.Time(compact ? 10 : 11.5, Microsoft.UI.Text.FontWeights.Bold), Microsoft.UI.Colors.White));
        var badge = new Border
        {
            Child = content,
            Padding = compact ? new Thickness(5, 2, 5, 2) : new Thickness(7, 3, 7, 3),
            Background = new SolidColorBrush(Palette.Grey(0, 0.62)),
            BorderBrush = new SolidColorBrush(Palette.Grey(1, 0.14)),
            BorderThickness = new Thickness(0.5),
            CornerRadius = new CornerRadius(99),
        };
        return badge.Label($"Rated {Rating.Text(halves)} out of 10");
    }
}

/// Ten stars to rate with. Hovering shows what a click would give, down to half a star; clicking
/// the rating it already has clears it. Arrow keys move by half a star when it has focus, Delete clears.
public sealed class StarRatingControl : Component
{
    private readonly double _size;
    private readonly double _spacing;
    private readonly bool _showsValue;
    private readonly Action<int?> _onChange;
    private readonly Palette? _palette;
    private int? _halves;
    private int? _hover;

    /// `palette` draws it in one palette whatever the theme, like `.environment(\.palette, .dark)`.
    public StarRatingControl(int? halves, Action<int?> onChange, double size = 17, double spacing = 3, bool showsValue = true, Palette? palette = null)
    {
        _palette = palette;
        _halves = halves;
        _onChange = onChange;
        _size = size;
        _spacing = spacing;
        _showsValue = showsValue;
        IsTabStop = true;
        UseSystemFocusVisuals = true;
        KeyDown += OnKey;
        this.Label("Rating");
    }

    private double StarWidth => _size * 1.1 + _spacing;
    private int Shown => _hover ?? _halves ?? 0;

    public void SetHalves(int? halves)
    {
        if (_halves == halves) return;
        _halves = halves;
        Invalidate();
    }

    private void Change(int? value)
    {
        _halves = value;
        _onChange(value);
        Invalidate();
    }

    private void OnKey(object sender, KeyRoutedEventArgs e)
    {
        switch (e.Key)
        {
            case Windows.System.VirtualKey.Left: Change(Math.Max(1, (_halves ?? 1) - 1)); e.Handled = true; break;
            case Windows.System.VirtualKey.Right: Change(Math.Min(Rating.MaxHalves, (_halves ?? 0) + 1)); e.Handled = true; break;
            case Windows.System.VirtualKey.Delete or Windows.System.VirtualKey.Back: Change(null); e.Handled = true; break;
        }
    }

    /// Left half of a star is a half, right half the whole star.
    public static int HalvesAt(double x, double starWidth) => Rating.Clamp((int)Math.Ceiling(x / starWidth * 2));

    protected override UIElement Render()
    {
        var p = _palette ?? Theme.P;
        var stars = new StackPanel { Orientation = Orientation.Horizontal, Spacing = _spacing, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
        for (var star = 1; star <= 10; star++)
        {
            var element = Stars.Star(Stars.Fill(star, Shown), _size, _hover is null ? 1 : 0.8, p);
            if (_hover is not null && (Shown + 1) / 2 == star)
            {
                element.RenderTransformOrigin = new Windows.Foundation.Point(0.5, 0.5);
                element.RenderTransform = new ScaleTransform { ScaleX = 1.18, ScaleY = 1.18 };
            }
            stars.Children.Add(element);
        }
        stars.PointerMoved += (_, e) =>
        {
            var picked = HalvesAt(e.GetCurrentPoint(stars).Position.X, StarWidth);
            if (picked != _hover) { _hover = picked; Invalidate(); }
        };
        stars.PointerExited += (_, _) => { _hover = null; Invalidate(); };
        stars.Tapped += (_, e) =>
        {
            var picked = HalvesAt(e.GetPosition(stars).X, StarWidth);
            _hover = null;
            Change(picked == _halves ? null : picked);
            e.Handled = true;
        };
        Ui.Hand(stars);
        if (!_showsValue) return stars;
        var value = Ui.Line(Shown > 0 ? Rating.Text(Shown) : "–", Typeface.Bold(_size * 0.95), Shown > 0 ? p.GoldInk : p.Ink3);
        value.MinWidth = _size * 1.9;
        return Ui.HStack(10, stars, value);
    }
}

/// A thin progress line. Silver, like everything else that isn't a film.
public static class Progress
{
    public static Grid Line(double fraction, double height = 3)
    {
        var p = Theme.P;
        var track = new Border { Height = height, CornerRadius = new CornerRadius(height / 2), Background = new SolidColorBrush(p.Raised2) };
        var bar = new Border { Height = height, CornerRadius = new CornerRadius(height / 2), Background = new SolidColorBrush(p.Ink), HorizontalAlignment = HorizontalAlignment.Left };
        var grid = new Grid { Height = height, Children = { track, bar } };
        grid.SizeChanged += (_, e) => bar.Width = Math.Max(height, e.NewSize.Width * Math.Clamp(fraction, 0, 1));
        return grid.Label($"{(int)(fraction * 100)} percent");
    }
}

/// A length of vertical film: body and perforations down both edges.
public sealed class FilmStripBody : Canvas
{
    /// Perforation pitch. Everything on the timeline is a multiple of this so holes line up across rows.
    public const double Pitch = 16;

    public FilmStripBody()
    {
        SizeChanged += (_, _) => Draw();
        IsHitTestVisible = false;
    }

    private void Draw()
    {
        var p = Theme.P;
        Children.Clear();
        Background = new SolidColorBrush(p.StripBody);
        const double holeWidth = 7, holeHeight = 9, inset = 4;
        for (var y = (Pitch - holeHeight) / 2; y < ActualHeight; y += Pitch)
        {
            foreach (var x in new[] { inset, ActualWidth - inset - holeWidth })
            {
                var hole = new Rectangle { Width = holeWidth, Height = holeHeight, RadiusX = 1.8, RadiusY = 1.8, Fill = new SolidColorBrush(p.StripHole) };
                SetLeft(hole, x);
                SetTop(hole, y);
                Children.Add(hole);
            }
        }
    }
}

/// An image from a URL or file, drawn by the compositor so it can be cropped, rounded, blurred and
/// fade to black and white. Shows `placeholder` until (or unless) the image loads, then fades the
/// image in over 0.25 s; one already decoded appears at once, as the Mac's `ImagePipeline.cached`
/// does. Decoded images are shared through `ImageSurfaces`, at most `maxPixel` on their longest side.
public sealed class RemoteImage : Grid
{
    private Uri? _url;
    private readonly bool _fill;
    private readonly double _cornerRadius;
    private readonly int _maxPixel;
    private readonly double _blur;
    private readonly UIElement? _placeholder;
    private readonly Compositor _compositor;
    private readonly ContainerVisual _container;
    private SpriteVisual? _sprite;
    private CompositionSurfaceBrush? _surfaceBrush;
    private CompositionEffectBrush? _effect;
    private string? _shownKey;
    private double _saturation = 1;
    private int _request;

    public RemoteImage(Uri? url, UIElement? placeholder = null, bool fill = true, double cornerRadius = 0, int maxPixel = 600, double blur = 0)
    {
        _url = url;
        _fill = fill;
        _cornerRadius = cornerRadius;
        _maxPixel = maxPixel;
        _blur = blur;
        _placeholder = placeholder;
        if (placeholder is not null) Children.Add(placeholder);
        var host = new Border { IsHitTestVisible = false };
        Children.Add(host);
        _compositor = ElementCompositionPreview.GetElementVisual(this).Compositor;
        _container = _compositor.CreateContainerVisual();
        ElementCompositionPreview.SetElementChildVisual(host, _container);
        SizeChanged += (_, _) => Layout();
        Loaded += (_, _) => Load();
        if (url is not null && ImageSurfaces.Cached(url, maxPixel) is { } cached) Show(url, cached, fade: false);
    }

    /// How long a freshly loaded image takes to fade in.
    public double FadeSeconds { get; set; } = 0.25;

    /// The image shown. Changing it keeps the old picture until the new one is ready.
    public Uri? Url
    {
        get => _url;
        set
        {
            if (_url?.OriginalString == value?.OriginalString) return;
            _url = value;
            _request++;
            if (value is null)
            {
                Clear();
                return;
            }
            if (ImageSurfaces.Cached(value, _maxPixel) is { } cached) Show(value, cached, fade: false);
            else if (IsLoaded) Load();
        }
    }

    /// 0 is black and white, 1 full colour. Animated over `seconds`.
    public void SetSaturation(double value, double seconds = 0.35)
    {
        _saturation = value;
        if (_effect is null) return;
        if (seconds <= 0)
        {
            _effect.StopAnimation("Saturation.Saturation");
            _effect.Properties.InsertScalar("Saturation.Saturation", (float)value);
            return;
        }
        var animation = _compositor.CreateScalarKeyFrameAnimation();
        animation.InsertKeyFrame(1, (float)value, Motion.EaseInOut(_compositor));
        animation.Duration = TimeSpan.FromSeconds(seconds);
        _effect.StartAnimation("Saturation.Saturation", animation);
    }

    private async void Load()
    {
        try
        {
            if (_url is not { } url || _shownKey == ImageSurfaces.Key(url, _maxPixel)) return;
            var request = ++_request;
            var surface = await ImageSurfaces.LoadAsync(url, _maxPixel);
            // A newer address took this one's place while it loaded.
            if (request != _request || surface is null) return;
            Show(url, surface, fade: true);
        }
        catch (Exception)
        {
            // The placeholder stays.
        }
    }

    private void Show(Uri url, LoadedImageSurface surface, bool fade)
    {
        if (_surfaceBrush is null || _sprite is null)
        {
            _surfaceBrush = _compositor.CreateSurfaceBrush(surface);
            _surfaceBrush.Stretch = _fill ? CompositionStretch.UniformToFill : CompositionStretch.Uniform;
            _surfaceBrush.HorizontalAlignmentRatio = 0.5f;
            _surfaceBrush.VerticalAlignmentRatio = 0.5f;
            _effect = ImageSurfaces.EffectBrush(_compositor, _blur);
            _effect.Properties.InsertScalar("Saturation.Saturation", (float)_saturation);
            _effect.SetSourceParameter("Image", _surfaceBrush);
            _sprite = _compositor.CreateSpriteVisual();
            _sprite.Brush = _effect;
            _container.Children.InsertAtTop(_sprite);
            Layout();
        }
        else
        {
            _surfaceBrush.Surface = surface;
        }
        _shownKey = ImageSurfaces.Key(url, _maxPixel);
        if (fade && FadeSeconds > 0)
        {
            var animation = _compositor.CreateScalarKeyFrameAnimation();
            animation.InsertKeyFrame(0, 0);
            animation.InsertKeyFrame(1, 1, Motion.EaseOut(_compositor));
            animation.Duration = TimeSpan.FromSeconds(FadeSeconds);
            _sprite.StartAnimation("Opacity", animation);
        }
        else
        {
            _sprite.StopAnimation("Opacity");
            _sprite.Opacity = 1;
        }
        // A fitted image (a site icon) replaces its placeholder; a filled one covers it anyway.
        if (!_fill && _placeholder is not null) _placeholder.Opacity = 0;
    }

    private void Clear()
    {
        _shownKey = null;
        if (_sprite is not null)
        {
            _container.Children.Remove(_sprite);
            _sprite = null;
            _surfaceBrush = null;
            _effect = null;
        }
        if (_placeholder is not null) _placeholder.Opacity = 1;
    }

    private void Layout()
    {
        if (_sprite is null) return;
        var size = new System.Numerics.Vector2((float)ActualWidth, (float)ActualHeight);
        _sprite.Size = size;
        if (_cornerRadius > 0)
        {
            var clip = _compositor.CreateRectangleClip(0, 0, size.X, size.Y);
            var r = new System.Numerics.Vector2((float)_cornerRadius);
            clip.TopLeftRadius = clip.TopRightRadius = clip.BottomLeftRadius = clip.BottomRightRadius = r;
            _container.Clip = clip;
        }
    }
}

/// Decoded images, shared by every `RemoteImage` that shows the same address at the same size, and
/// kept (least recently used out first) up to `CostLimit` bytes of pixels: the Mac's ImagePipeline
/// memory cache. UI thread only.
public static class ImageSurfaces
{
    private sealed record Entry(string Key, LoadedImageSurface Surface, long Cost);

    private static readonly Dictionary<string, LinkedListNode<Entry>> Map = [];
    private static readonly LinkedList<Entry> Order = new();
    private static readonly Dictionary<string, Task<LoadedImageSurface?>> Loading = [];
    private static readonly Dictionary<double, CompositionEffectFactory> Factories = [];
    private static Compositor? _factoryCompositor;
    private static long _cost;

    public static long CostLimit { get; set; } = 256L * 1024 * 1024;

    public static string Key(Uri url, int maxPixel) => $"{maxPixel}|{url.OriginalString}";

    /// The decoded image if it's already here.
    public static LoadedImageSurface? Cached(Uri url, int maxPixel)
    {
        if (!Map.TryGetValue(Key(url, maxPixel), out var node)) return null;
        Order.Remove(node);
        Order.AddFirst(node);
        return node.Value.Surface;
    }

    /// Decodes it, once per address and size however many ask at the same time.
    public static Task<LoadedImageSurface?> LoadAsync(Uri url, int maxPixel)
    {
        if (Cached(url, maxPixel) is { } cached) return Task.FromResult<LoadedImageSurface?>(cached);
        var key = Key(url, maxPixel);
        if (Loading.TryGetValue(key, out var running)) return running;
        var task = FetchAsync(url, maxPixel, key);
        if (!task.IsCompleted) Loading[key] = task;
        return task;
    }

    /// Starts loading so the image is ready before it's shown, like scrubbing through saved frames.
    public static void Preload(Uri url, int maxPixel) => _ = LoadAsync(url, maxPixel);

    private static async Task<LoadedImageSurface?> FetchAsync(Uri url, int maxPixel, string key)
    {
        try
        {
            using var stream = await ImageBytes.StreamAsync(url);
            if (stream is null) return null;
            var surface = LoadedImageSurface.StartLoadFromStream(stream, new Windows.Foundation.Size(maxPixel, maxPixel));
            var loaded = new TaskCompletionSource<bool>();
            surface.LoadCompleted += (_, e) => loaded.TrySetResult(e.Status == LoadedImageSourceLoadStatus.Success);
            if (!await loaded.Task)
            {
                surface.Dispose();
                return null;
            }
            var size = surface.DecodedPhysicalSize;
            Add(new Entry(key, surface, (long)(size.Width * size.Height * 4)));
            return surface;
        }
        catch (Exception)
        {
            return null;
        }
        finally
        {
            Loading.Remove(key);
        }
    }

    private static void Add(Entry entry)
    {
        if (Map.Remove(entry.Key, out var old))
        {
            Order.Remove(old);
            _cost -= old.Value.Cost;
        }
        Map[entry.Key] = Order.AddFirst(entry);
        _cost += entry.Cost;
        // Images still on screen keep their surface; the cache only lets go of it.
        while (_cost > CostLimit && Order.Last is { } last && last != Order.First)
        {
            Order.RemoveLast();
            Map.Remove(last.Value.Key);
            _cost -= last.Value.Cost;
        }
    }

    /// Saturation over the image, with a Gaussian blur under it when `blur` is above 0. One factory
    /// per blur amount, since making one compiles the effect.
    internal static CompositionEffectBrush EffectBrush(Compositor compositor, double blur)
    {
        if (!ReferenceEquals(_factoryCompositor, compositor))
        {
            Factories.Clear();
            _factoryCompositor = compositor;
        }
        if (!Factories.TryGetValue(blur, out var factory))
        {
            Windows.Graphics.Effects.IGraphicsEffectSource source = new CompositionEffectSourceParameter("Image");
            if (blur > 0) source = new GaussianBlurEffect { Name = "Blur", BlurAmount = (float)blur, BorderMode = EffectBorderMode.Hard, Source = source };
            var effect = new SaturationEffect { Name = "Saturation", Saturation = 1, Source = source };
            factory = compositor.CreateEffectFactory(effect, ["Saturation.Saturation"]);
            Factories[blur] = factory;
        }
        return factory.CreateBrush();
    }
}

/// Posters: 2:3, cropped to that shape. Watched films fade to black and white, like a memory;
/// hovering brings their colour back. With no poster anywhere, a frame you actually saw beats a
/// blank card, and with neither the name becomes the poster.
public static class Posters
{
    public static FrameworkElement Image(Title title, double? width = null, double cornerRadius = 6, bool keepsColour = false, Uri? fallback = null)
    {
        var url = title.PosterUrl ?? fallback;
        var image = new RemoteImage(url, Placeholder(title.Name), fill: true, cornerRadius: cornerRadius);
        var mono = title.Status == TitleStatus.Watched && !keepsColour;
        image.SetSaturation(mono ? 0 : 1, 0);
        var frame = new Border { Child = image, CornerRadius = new CornerRadius(cornerRadius) };
        // The 2:3 shape comes first and the image is cropped to it, so an odd poster can't push out
        // of its column. Without a width it fills the width it's given.
        FrameworkElement shaped = frame;
        if (width is { } w) { frame.Width = w; frame.Height = w * 1.5; }
        else shaped = Ui.AspectRatio(frame, 1.5);
        if (mono) shaped.OnHover(on => image.SetSaturation(on ? 1 : 0));
        return shaped;
    }

    /// With no poster to show, the name becomes the poster: a title card.
    public static Grid Placeholder(string name)
    {
        var p = Theme.P;
        var text = Ui.Text(name, Typeface.Title(15), p.Ink2, maxLines: 5);
        text.VerticalAlignment = VerticalAlignment.Bottom;
        text.Margin = new Thickness(10);
        return new Grid { Background = new SolidColorBrush(p.Raised), Children = { text } };
    }

    public static FrameworkElement SiteIcon(string name, Uri? url, double size = 20)
    {
        var p = Theme.P;
        var initial = Ui.Line(name.Length > 0 ? name[..1].ToUpperInvariant() : "?", Typeface.Bold(size * 0.62), p.Ink2).Centered();
        var image = new RemoteImage(url, new Grid { Children = { initial } }, fill: false);
        return new Border { Child = image, Width = size, Height = size, CornerRadius = new CornerRadius(size * 0.22) };
    }
}

/// Dates the way the Mac's DateText writes them. `Relative` is in Formats.cs (the misc screens port).
public static partial class DateText
{
    /// "Today", "Yesterday", "Thursday, November 6", or with the year when it isn't this one.
    public static string Day(DateTimeOffset date, DateTimeOffset? now = null)
    {
        var culture = System.Globalization.CultureInfo.CurrentCulture;
        var local = date.ToLocalTime();
        var today = (now ?? DateTimeOffset.Now).ToLocalTime().Date;
        if (local.Date == today) return "Today";
        if (local.Date == today.AddDays(-1)) return "Yesterday";
        var format = culture.DateTimeFormat;
        // The Mac's localized "EEEEdMMMM" and "EEEEdMMMMyyyy" templates.
        var pattern = local.Year == today.Year
            ? "dddd, " + format.MonthDayPattern
            : format.LongDatePattern.Contains("dddd", StringComparison.Ordinal) ? format.LongDatePattern : "dddd " + format.LongDatePattern;
        return local.ToString(pattern, culture);
    }

    /// The short time, "9:41 PM" or "21:41" as Windows is set.
    public static string Time(DateTimeOffset date) =>
        date.ToLocalTime().ToString("t", System.Globalization.CultureInfo.CurrentCulture);
}
