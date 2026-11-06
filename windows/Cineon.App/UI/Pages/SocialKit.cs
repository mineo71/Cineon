using System.ComponentModel;
using System.Globalization;
using Cineon.Core.Data;
using Cineon.Core.Shields;
using Cineon.Core.Together;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Cineon.App.UI;

// Pieces the Together, Profile, profile picker and Settings screens share. A few stand in for kit
// helpers other ports add on their branches; each says which one to switch to after the merge.

internal static class SocialKit
{
    // Segoe Fluent Icons for the SF Symbols these screens use that `Glyph` doesn't name.
    public const string Copy = "";          // doc.on.doc
    public const string ArrowUp = "";       // arrow.up
    public const string Flag = "";          // flag.checkered
    public const string Cloud = "";         // icloud
    public const string HalfStar = "";      // star.leadinghalf.filled
    public const string Stack = "";         // square.stack
    public const string Video = "";         // play.rectangle.on.rectangle

    private static Windows.UI.ViewManagement.UISettings? _settings;

    /// Windows' "Animation effects" switch, the Mac's Reduce Motion turned around.
    public static bool AnimationsEnabled
    {
        get
        {
            try { return (_settings ??= new Windows.UI.ViewManagement.UISettings()).AnimationsEnabled; }
            catch (Exception) { return true; }
        }
    }

    /// Puts text on the clipboard, replacing what's there (the Mac's NSPasteboard clearContents + setString).
    public static void CopyText(string text)
    {
        try
        {
            var package = new Windows.ApplicationModel.DataTransfer.DataPackage();
            package.SetText(text);
            Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
            Windows.ApplicationModel.DataTransfer.Clipboard.Flush();
        }
        catch (Exception)
        {
            // Another app holding the clipboard: nothing to do but leave it.
        }
    }

    /// Takes an element out of whatever holds it, so it can join a new tree. An element has one parent.
    public static void Detach(FrameworkElement element)
    {
        switch (element.Parent ?? VisualTreeHelper.GetParent(element))
        {
            case Panel panel: panel.Children.Remove(element); break;
            case Border border when ReferenceEquals(border.Child, element): border.Child = null; break;
            case ContentControl control when ReferenceEquals(control.Content, element): control.Content = null; break;
            case ContentPresenter presenter when ReferenceEquals(presenter.Content, element): presenter.Content = null; break;
            case Viewbox box when ReferenceEquals(box.Child, element): box.Child = null; break;
            case ScrollViewer scroll when ReferenceEquals(scroll.Content, element): scroll.Content = null; break;
        }
    }

    /// The Mac's plain TextField on a raised fill: no border, no accent underline.
    // TODO(after merge): Inputs.Field from the misc-screens port (UI/Inputs.cs) where it fits.
    public static TextBox Field(string placeholder, Typeface.Font font, Color? fill, double radius, double height, Thickness padding)
    {
        var p = Theme.P;
        var box = new TextBox
        {
            PlaceholderText = placeholder,
            FontFamily = font.Family,
            FontSize = font.Size,
            FontWeight = font.Weight,
            IsTextScaleFactorEnabled = false,
            BorderThickness = new Thickness(0),
            CornerRadius = new CornerRadius(radius),
            Padding = padding,
            MinHeight = 0,
            MinWidth = 0,
            VerticalContentAlignment = VerticalAlignment.Center,
            SelectionHighlightColor = new SolidColorBrush(Palette.WithOpacity(p.Ink, 0.3)),
            Foreground = new SolidColorBrush(p.Ink),
            IsSpellCheckEnabled = false,
        };
        if (height > 0) box.Height = height;
        var background = new SolidColorBrush(fill ?? Microsoft.UI.Colors.Transparent);
        var clear = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        var ink = new SolidColorBrush(p.Ink);
        var placeholderInk = new SolidColorBrush(p.Ink3);
        foreach (var state in new[] { "", "PointerOver", "Focused", "Disabled" })
        {
            box.Resources["TextControlBackground" + state] = background;
            box.Resources["TextControlBorderBrush" + state] = clear;
            box.Resources["TextControlForeground" + state] = ink;
            box.Resources["TextControlPlaceholderForeground" + state] = placeholderInk;
        }
        box.Resources["TextControlBorderThemeThickness"] = new Thickness(0);
        box.Resources["TextControlBorderThemeThicknessFocused"] = new Thickness(0);
        box.Resources["TextControlButtonForeground"] = placeholderInk;
        box.Resources["TextControlButtonForegroundPointerOver"] = ink;
        box.Resources["TextControlButtonForegroundPressed"] = ink;
        box.Resources["TextControlButtonBackgroundPointerOver"] = clear;
        box.Resources["TextControlButtonBackgroundPressed"] = clear;
        return box;
    }

    /// The Mac's ProgressView().controlSize(.small), in the ink colour instead of the system accent.
    // TODO(after merge): Inputs.Spinner from the misc-screens port.
    public static ProgressRing Spinner(double size = 16) => new()
    {
        IsActive = true,
        Width = size,
        Height = size,
        MinWidth = 0,
        MinHeight = 0,
        Foreground = new SolidColorBrush(Theme.P.Ink2),
        Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
        VerticalAlignment = VerticalAlignment.Center,
    };

    /// A Silver or Outline button with an icon before its title, the way the Mac's `Label(title,
    /// systemImage:)` sits in those styles.
    // TODO(after merge): Buttons.Silver(title, glyph, ...) and Buttons.Outline(title, glyph, ...) from the
    // misc-screens port.
    public static Button WithIcon(this Button button, string glyph)
    {
        if (button.Content is not TextBlock text) return button;
        button.Content = null;
        var icon = Ui.Icon(glyph, Math.Round(text.FontSize * 0.95), (text.Foreground as SolidColorBrush)?.Color);
        button.Content = Ui.HStack(7, icon, text);
        return button;
    }

    /// Clips an element to a rounded rectangle (a circle when the radius is half its size), children
    /// included. A Border's corner radius only rounds its own fill.
    public static T ClipRounded<T>(this T element, double radius) where T : FrameworkElement
    {
        var visual = ElementCompositionPreview.GetElementVisual(element);
        var compositor = visual.Compositor;
        var geometry = compositor.CreateRoundedRectangleGeometry();
        geometry.CornerRadius = new System.Numerics.Vector2((float)radius);
        visual.Clip = compositor.CreateGeometricClip(geometry);
        void Fit()
        {
            geometry.Size = new System.Numerics.Vector2((float)element.ActualWidth, (float)element.ActualHeight);
            var r = (float)Math.Min(radius, Math.Min(element.ActualWidth, element.ActualHeight) / 2);
            geometry.CornerRadius = new System.Numerics.Vector2(r);
        }
        element.SizeChanged += (_, _) => Fit();
        if (element.ActualWidth > 0) Fit();
        else if (element.Width > 0 && element.Height > 0)
        {
            geometry.Size = new System.Numerics.Vector2((float)element.Width, (float)element.Height);
        }
        return element;
    }

    /// SwiftUI's `.tracking(points)` as WinUI character spacing (thousandths of an em).
    public static TextBlock Tracking(this TextBlock text, double points)
    {
        text.CharacterSpacing = (int)Math.Round(points / text.FontSize * 1000);
        return text;
    }

    /// Text set on its baseline, for rows aligned with `.firstTextBaseline`: the line box ends at the
    /// baseline, so bottoms line up.
    public static TextBlock OnBaseline(this TextBlock text)
    {
        text.TextLineBounds = TextLineBounds.TrimToBaseline;
        text.VerticalAlignment = VerticalAlignment.Bottom;
        return text;
    }

    /// The first character, upper-cased, the way Swift's `String(name.prefix(1)).uppercased()` reads it.
    public static string Initial(string name)
    {
        if (string.IsNullOrEmpty(name)) return "";
        return StringInfo.GetNextTextElement(name).ToUpperInvariant();
    }

    /// Swift's RelativeDateTimeFormatter: `.named` says "yesterday" and "last week" where numbers would.
    // TODO(after merge): the unnamed form is DateText.Relative from the misc-screens port (UI/Formats.cs).
    public static string Relative(DateTimeOffset date, bool named = false, DateTimeOffset? now = null)
    {
        var reference = (now ?? DateTimeOffset.Now).ToLocalTime();
        var local = date.ToLocalTime();
        var past = local <= reference;
        var (from, to) = past ? (local, reference) : (reference, local);
        var span = to - from;
        var months = (to.Year - from.Year) * 12 + to.Month - from.Month;
        if (to.Day < from.Day || (to.Day == from.Day && to.TimeOfDay < from.TimeOfDay)) months--;
        string Phrase(long count, string unit, string? lastName, string? nextName)
        {
            if (named && count == 1 && (past ? lastName : nextName) is { } word) return word;
            var units = count == 1 ? unit : unit + "s";
            return past ? $"{count} {units} ago" : $"in {count} {units}";
        }
        if (months >= 12) return Phrase(months / 12, "year", "last year", "next year");
        if (months >= 1) return Phrase(months, "month", "last month", "next month");
        if (span.TotalDays >= 7) return Phrase((long)(span.TotalDays / 7), "week", "last week", "next week");
        if (span.TotalDays >= 1) return Phrase((long)span.TotalDays, "day", "yesterday", "tomorrow");
        if (span.TotalHours >= 1) return Phrase((long)span.TotalHours, "hour", null, null);
        if (span.TotalMinutes >= 1) return Phrase((long)span.TotalMinutes, "minute", null, null);
        var seconds = (long)span.TotalSeconds;
        if (named && seconds == 0) return "now";
        return Phrase(seconds, "second", null, null);
    }

    /// ByteCountFormatter with `.file`: decimal units, "Zero KB", whole KB, one decimal for MB, two for GB.
    // TODO(after merge): ByteCount.File from the misc-screens port (UI/Formats.cs).
    public static string Bytes(long bytes)
    {
        var culture = CultureInfo.CurrentCulture;
        if (bytes == 0) return "Zero KB";
        if (bytes == 1) return "1 byte";
        if (bytes < 1000) return $"{bytes} bytes";
        if (bytes < 1_000_000) return $"{Math.Round(bytes / 1000.0, MidpointRounding.AwayFromZero).ToString("0", culture)} KB";
        if (bytes < 1_000_000_000) return $"{(bytes / 1_000_000.0).ToString("0.#", culture)} MB";
        return $"{(bytes / 1_000_000_000.0).ToString("0.##", culture)} GB";
    }

    /// A short confirmation, like the Mac's confirmationDialog: the destructive action, or Cancel.
    public static async Task<bool> ConfirmAsync(FrameworkElement anchor, string title, string message, string action)
    {
        if (anchor.XamlRoot is not { } root) return false;
        var p = Theme.P;
        var dialog = new ContentDialog
        {
            XamlRoot = root,
            RequestedTheme = p.IsDark ? ElementTheme.Dark : ElementTheme.Light,
            Title = title,
            Content = Ui.Text(message, Typeface.Ui(13), p.Ink2),
            PrimaryButtonText = action,
            CloseButtonText = "Cancel",
            // No default button: a default one takes the system accent colour.
            DefaultButton = ContentDialogButton.None,
        };
        try { return await dialog.ShowAsync() == ContentDialogResult.Primary; }
        catch (Exception) { return false; } // Another dialog is already open.
    }

    /// The Mac's 0.5 pt lines: one device pixel, and never thinner than half a view pixel.
    public static double Hair
    {
        get
        {
            var scale = AppModel.Shared?.Window?.Content?.XamlRoot?.RasterizationScale ?? 1;
            return Math.Max(0.5, 1 / Math.Max(1, scale));
        }
    }

    public static Border Hairline(bool vertical = false, double length = double.NaN)
    {
        var line = new Border { Background = new SolidColorBrush(Theme.P.Line) };
        if (vertical) { line.Width = Hair; if (!double.IsNaN(length)) line.Height = length; else line.VerticalAlignment = VerticalAlignment.Stretch; }
        else { line.Height = Hair; line.HorizontalAlignment = HorizontalAlignment.Stretch; }
        return line;
    }
}

/// Compares by reference, for keys holding objects whose Equals means something looser.
internal readonly struct Identity(object? value) : IEquatable<Identity>
{
    private readonly object? _value = value;
    public bool Equals(Identity other) => ReferenceEquals(_value, other._value);
    public override bool Equals(object? obj) => obj is Identity other && Equals(other);
    public override int GetHashCode() => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(_value);
}

/// Where a view hears about changes: subscribe with a handler, dispose to stop.
internal static class Changes
{
    private sealed class Off(Action off) : IDisposable { public void Dispose() => off(); }

    public static Func<Action, IDisposable> Of(IChangeNotifier source) =>
        handler => { source.Changed += handler; return new Off(() => source.Changed -= handler); };

    public static Func<Action, IDisposable> Of(LibraryStore source) => handler =>
    {
        EventHandler h = (_, _) => handler();
        source.Changed += h;
        return new Off(() => source.Changed -= h);
    };

    public static Func<Action, IDisposable> Of(TogetherModel source) => handler =>
    {
        EventHandler h = (_, _) => handler();
        source.Changed += h;
        return new Off(() => source.Changed -= h);
    };

    public static Func<Action, IDisposable> Of(CloudLibrary source) => handler =>
    {
        EventHandler h = (_, _) => handler();
        source.Changed += h;
        return new Off(() => source.Changed -= h);
    };

    public static Func<Action, IDisposable> Of(ProfileStore source) => handler =>
    {
        EventHandler h = (_, _) => handler();
        source.Changed += h;
        return new Off(() => source.Changed -= h);
    };

    public static Func<Action, IDisposable> Of(ShieldState source) =>
        handler => { source.Changed += handler; return new Off(() => source.Changed -= handler); };

    public static Func<Action, IDisposable> Of(INotifyPropertyChanged source) => handler =>
    {
        PropertyChangedEventHandler h = (_, _) => handler();
        source.PropertyChanged += h;
        return new Off(() => source.PropertyChanged -= h);
    };
}

/// A component that rebuilds only when what it shows changes: `Key` is compared after every change
/// it hears about, and a different key rebuilds it. With the same key it calls `OnSame`, for views
/// that update parts in place (text that ticks, a switch someone flipped elsewhere). Keeps posters
/// from reloading and text boxes from losing focus when unrelated state moves.
internal abstract class KeyedComponent : Component
{
    private object? _last;
    private bool _hasKey;

    protected abstract object? Key();

    protected virtual void OnSame() { }

    protected void WatchKeyed(Func<Action, IDisposable> source)
    {
        IDisposable? token = null;
        Watch(_ => token = source(Check), _ => { token?.Dispose(); token = null; });
    }

    /// Call at the start of Render.
    protected void Rendered() { _last = Key(); _hasKey = true; }

    protected void Check()
    {
        if (DispatcherQueue is { HasThreadAccess: false } queue) { queue.TryEnqueue(Check); return; }
        if (!_hasKey) { Invalidate(); return; }
        if (!Equals(Key(), _last)) Invalidate();
        else OnSame();
    }

    protected override void OnAppeared()
    {
        if (_hasKey) Check();
    }
}

/// `KeyedComponent` from functions.
internal sealed class KeyedView : KeyedComponent
{
    private readonly Func<object?> _key;
    private readonly Func<UIElement> _render;

    public KeyedView(Func<object?> key, Func<UIElement> render, params Func<Action, IDisposable>[] sources)
    {
        _key = key;
        _render = render;
        foreach (var source in sources) WatchKeyed(source);
    }

    public Action? Same { get; init; }

    protected override object? Key() => _key();
    protected override void OnSame() => Same?.Invoke();

    protected override UIElement Render()
    {
        Rendered();
        return _render();
    }
}

/// A page that scrolls: one column, as wide as the window up to `maxWidth`, on the card colour.
/// The scroll view stays put while the sections inside rebuild, so the place is kept.
internal sealed class PageScroll : UserControl
{
    private readonly ScrollViewer _scroll;

    public PageScroll(UIElement column, double maxWidth, Thickness padding, bool centred, bool padInside)
    {
        IsTabStop = false;
        FrameworkElement content = padInside
            ? new MaxWidthColumn(maxWidth, centred) { Children = { new Border { Padding = padding, Child = column } } }
            : new Border { Padding = padding, Child = new MaxWidthColumn(maxWidth, centred) { Children = { column } } };
        _scroll = new ScrollViewer
        {
            Content = content,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollMode = ScrollMode.Disabled,
            // The Mac's `.scrollIndicators(.never)`.
            VerticalScrollBarVisibility = ScrollBarVisibility.Hidden,
            VerticalScrollMode = ScrollMode.Enabled,
            IsTabStop = false,
        };
        Content = _scroll;
        Paint();
        Loaded += (_, _) => { Theme.Changed += Paint; Paint(); };
        Unloaded += (_, _) => Theme.Changed -= Paint;
    }

    private void Paint() => _scroll.Background = new SolidColorBrush(Theme.P.CardFill);
}

/// Lays out one child at the available width, capped at `max`: SwiftUI's `.frame(maxWidth:alignment:)`.
/// (A stretched element with a MaxWidth would be centred instead.)
internal sealed class MaxWidthColumn(double max, bool centred) : Panel
{
    protected override Windows.Foundation.Size MeasureOverride(Windows.Foundation.Size available)
    {
        var width = Math.Min(available.Width, max);
        var height = 0.0;
        foreach (var child in Children)
        {
            child.Measure(new Windows.Foundation.Size(width, available.Height));
            height = Math.Max(height, child.DesiredSize.Height);
        }
        return new(double.IsInfinity(width) ? Children.Select(c => c.DesiredSize.Width).DefaultIfEmpty(0).Max() : width, height);
    }

    protected override Windows.Foundation.Size ArrangeOverride(Windows.Foundation.Size final)
    {
        var width = Math.Min(final.Width, max);
        var x = centred ? Math.Max(0, (final.Width - width) / 2) : 0;
        foreach (var child in Children) child.Arrange(new Windows.Foundation.Rect(x, 0, width, final.Height));
        return final;
    }
}
