using System.Runtime.CompilerServices;
using System.Text.Json;
using Cineon.Core.Data;
using Cineon.Core.Metadata;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Cineon.App.UI;

// Pieces the library screens share: Home, Library, the title card, Timeline and Rate mode.

/// Rebuilds a component when the current profile's library changes, and keeps following it when
/// someone else starts watching (a profile switch makes a new session and library). Pass it to
/// `Component.Watch(watch.Subscribe, watch.Unsubscribe)`.
internal sealed class LibraryWatch
{
    private readonly AppModel _app;
    private readonly bool _alerts;
    private Action? _handler;
    private ProfileSession? _hooked;

    public LibraryWatch(AppModel app, bool alerts = false)
    {
        _app = app;
        _alerts = alerts;
    }

    public void Subscribe(Action handler)
    {
        _handler = handler;
        _app.Changed += AppChanged;
        Hook();
    }

    public void Unsubscribe(Action handler)
    {
        _app.Changed -= AppChanged;
        Unhook();
        _handler = null;
    }

    private void AppChanged()
    {
        if (_handler is null || ReferenceEquals(_hooked, _app.Session)) return;
        Unhook();
        Hook();
        _handler();
    }

    private void Hook()
    {
        _hooked = _app.Session;
        _hooked.Library.Changed += LibraryChanged;
        if (_alerts) _hooked.Alerts.Changed += AlertsChanged;
    }

    private void Unhook()
    {
        if (_hooked is null) return;
        _hooked.Library.Changed -= LibraryChanged;
        if (_alerts) _hooked.Alerts.Changed -= AlertsChanged;
        _hooked = null;
    }

    private void LibraryChanged(object? sender, EventArgs e) => _handler?.Invoke();
    private void AlertsChanged() => _handler?.Invoke();
}

/// Segoe Fluent glyphs for the SF Symbols these screens use that the kit's `Glyph` doesn't have.
internal static class PageGlyph
{
    public const string CircleRing = "";
    public const string CircleFill = "";
    public const string CheckCircleFill = "";
    public const string Checklist = "";
    public const string HalfStarLeft = "";

    /// `circle`, `circle.lefthalf.filled` or `checkmark.circle.fill`.
    public static FrameworkElement Circle(double fill, double size, Color color)
    {
        if (fill >= 1) return Ui.Icon(CheckCircleFill, size, color);
        var grid = new Grid { Width = size * 1.1, Height = size * 1.1 };
        grid.Children.Add(Ui.Icon(CircleRing, size, color).Centered());
        if (fill > 0)
        {
            var half = Ui.Icon(CircleFill, size, color).Centered();
            half.Clip = new RectangleGeometry { Rect = new Windows.Foundation.Rect(0, 0, size * 0.55, size * 1.2) };
            grid.Children.Add(half);
        }
        return grid;
    }

    /// `star.leadinghalf.filled`.
    public static FrameworkElement HalfStar(double size, Color color) => new Grid
    {
        Children = { Ui.Icon(Glyph.Star, size, color), Ui.Icon(HalfStarLeft, size, color) },
    };
}

/// The Mac's button styles with an SF Symbol beside the title, like `Label(title, systemImage:)`.
/// Silver brightens on hover the way SwiftUI's `.brightness` does.
internal static class PageButtons
{
    public static Button Silver(string title, string? glyph, Action action, bool large = false, bool enabled = true) =>
        SilverButton(Content(title, glyph, large ? 15 : 13, Typeface.Semibold, Theme.P.OnSilver), action, large, enabled);

    public static Button SilverIcon(UIElement icon, string help, Action action)
    {
        var button = SilverButton(icon, action, large: false, enabled: true);
        button.Tooltip(help).Label(help);
        return button;
    }

    private static Button SilverButton(UIElement content, Action action, bool large, bool enabled)
    {
        var p = Theme.P;
        var amount = p.IsDark ? 0.06 : 0.14;
        var bright = Palette.Vertical(Brighten(p.SilverTop, amount), Brighten(p.SilverBottom, amount));
        var button = Buttons.Make(content, action, (b, hovered, _) => b.Background = hovered ? bright : p.Silver, enabled);
        button.Padding = large ? new Thickness(22, 11, 22, 11) : new Thickness(14, 7, 14, 7);
        button.SizeChanged += (_, e) => button.CornerRadius = new CornerRadius(e.NewSize.Height / 2);
        return button;
    }

    public static Button Outline(string title, string? glyph, Action action, bool large = false, bool enabled = true) =>
        OutlineButton(Content(title, glyph, large ? 15 : 13, Typeface.Medium, Theme.P.Ink), action, large, enabled);

    public static Button OutlineIcon(UIElement icon, string help, Action action)
    {
        var button = OutlineButton(icon, action, large: false, enabled: true);
        button.Tooltip(help).Label(help);
        return button;
    }

    private static Button OutlineButton(UIElement content, Action action, bool large, bool enabled)
    {
        var p = Theme.P;
        var button = Buttons.Make(content, action, (b, hovered, pressed) =>
        {
            b.Background = new SolidColorBrush(hovered || pressed ? p.Raised : Microsoft.UI.Colors.Transparent);
            b.BorderBrush = new SolidColorBrush(p.Line);
        }, enabled);
        button.Padding = large ? new Thickness(20, 10, 20, 10) : new Thickness(13, 6, 13, 6);
        button.BorderThickness = new Thickness(1);
        button.SizeChanged += (_, e) => button.CornerRadius = new CornerRadius(e.NewSize.Height / 2);
        return button;
    }

    private static UIElement Content(string title, string? glyph, double size, Windows.UI.Text.FontWeight weight, Color ink)
    {
        var text = Ui.Line(title, Typeface.Ui(size, weight), ink);
        return glyph is null ? text : Ui.HStack(size >= 15 ? 7 : 6, Ui.Icon(glyph, size * 0.85, ink), text);
    }

    /// A button that's just its text, like SwiftUI's `.buttonStyle(.plain)`.
    public static Button Plain(string title, Typeface.Font font, Color color, Action action, string? help = null) =>
        Buttons.Make(Ui.Line(title, font, color), action, help: help);

    private static Color Brighten(Color color, double amount)
    {
        byte Up(byte c) => (byte)Math.Round(Math.Clamp(c / 255.0 + amount, 0, 1) * 255);
        return Color.FromArgb(color.A, Up(color.R), Up(color.G), Up(color.B));
    }

    /// A small switch with its label in front, like `Toggle(...).toggleStyle(.switch).controlSize(.mini)`.
    /// `tint` is the "on" colour; none means the system's accent colour, as an untinted Mac switch.
    public static Button Switch(string label, bool isOn, Action<bool> changed, Color labelColor, Color? tint = null)
    {
        var p = Theme.P;
        var on = tint ?? Accent();
        var track = new Border
        {
            Width = 26, Height = 15, CornerRadius = new CornerRadius(7.5),
            Background = new SolidColorBrush(isOn ? on : (p.IsDark ? Palette.Grey(1, 0.22) : Palette.Grey(0, 0.12))),
            BorderBrush = new SolidColorBrush(p.IsDark ? Palette.Grey(1, 0.08) : Palette.Grey(0, 0.08)),
            BorderThickness = new Thickness(0.5),
        };
        var knob = new Microsoft.UI.Xaml.Shapes.Ellipse
        {
            Width = 13, Height = 13, Fill = new SolidColorBrush(Microsoft.UI.Colors.White),
            HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(1, 0, 0, 0),
            Translation = new System.Numerics.Vector3(isOn ? 11 : 0, 0, 0),
        };
        var control = new Grid { Width = 26, Height = 15, Children = { track, knob } };
        var state = isOn;
        Button? button = null;
        button = Buttons.Make(Ui.HStack(8, Ui.Line(label, Typeface.Ui(12), labelColor), control), () =>
        {
            state = !state;
            if (Motion.Enabled) knob.TranslationTransition ??= new Vector3Transition { Duration = TimeSpan.FromSeconds(0.15) };
            knob.Translation = new System.Numerics.Vector3(state ? 11 : 0, 0, 0);
            track.Background = new SolidColorBrush(state ? on : (Theme.P.IsDark ? Palette.Grey(1, 0.22) : Palette.Grey(0, 0.12)));
            if (button is not null) Microsoft.UI.Xaml.Automation.AutomationProperties.SetItemStatus(button, state ? "On" : "Off");
            changed(state);
        });
        button.Label(label);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetItemStatus(button, isOn ? "On" : "Off");
        return button;
    }

    private static Color Accent()
    {
        try { return new Windows.UI.ViewManagement.UISettings().GetColorValue(Windows.UI.ViewManagement.UIColorType.Accent); }
        catch (Exception) { return Palette.Rgb(0, 0.48, 1); }
    }
}

/// A search field that outlives the views around it, so typing never loses focus when they rebuild:
/// a magnifier and a borderless text box on a raised fill, like the Mac's plain TextFields.
internal sealed class SearchField
{
    private readonly Microsoft.UI.Xaml.Controls.FontIcon _icon;

    public Border Root { get; }
    public TextBox Box { get; }

    public SearchField(string placeholder, double width, bool capsule, Action<string> changed)
    {
        Box = new TextBox
        {
            PlaceholderText = placeholder,
            FontFamily = Typeface.Ui(12.5).Family,
            FontSize = 12.5,
            Width = width,
            MinWidth = 0,
            MinHeight = 0,
            Padding = new Thickness(0),
            BorderThickness = new Thickness(0),
            VerticalAlignment = VerticalAlignment.Center,
            IsSpellCheckEnabled = false,
            IsTextPredictionEnabled = false,
            IsTextScaleFactorEnabled = false,
        };
        Plain(Box);
        Box.TextChanged += (_, _) => changed(Box.Text);
        _icon = Ui.Icon(Glyph.Search, 11, Theme.P.Ink3);
        Root = new Border
        {
            Child = Ui.HStack(6, _icon, Box),
            Padding = new Thickness(10, 5, 10, 5),
            VerticalAlignment = VerticalAlignment.Center,
        };
        if (capsule) Root.SizeChanged += (_, e) => Root.CornerRadius = new CornerRadius(e.NewSize.Height / 2);
        else Root.CornerRadius = new CornerRadius(8);
        Paint();
        Root.Loaded += (_, _) => Theme.Changed += Paint;
        Root.Unloaded += (_, _) => Theme.Changed -= Paint;
    }

    public string Text
    {
        get => Box.Text;
        set { if (Box.Text != value) Box.Text = value; }
    }

    private void Paint()
    {
        Root.Background = new SolidColorBrush(Theme.P.Raised);
        _icon.Foreground = new SolidColorBrush(Theme.P.Ink3);
    }

    /// The text box without its own chrome, in both themes: its look comes from theme resources, so
    /// they're overridden per theme and follow the window's theme when it changes.
    private static void Plain(TextBox box)
    {
        foreach (var (theme, palette) in new[] { ("Dark", Palette.Dark), ("Light", Palette.White), ("Default", Palette.Dark) })
        {
            var resources = new ResourceDictionary();
            var clear = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            foreach (var key in new[]
            {
                "TextControlBackground", "TextControlBackgroundPointerOver", "TextControlBackgroundFocused", "TextControlBackgroundDisabled",
                "TextControlBorderBrush", "TextControlBorderBrushPointerOver", "TextControlBorderBrushFocused", "TextControlBorderBrushDisabled",
            }) resources[key] = clear;
            var ink = new SolidColorBrush(palette.Ink);
            foreach (var key in new[] { "TextControlForeground", "TextControlForegroundPointerOver", "TextControlForegroundFocused" }) resources[key] = ink;
            var ink3 = new SolidColorBrush(palette.Ink3);
            foreach (var key in new[] { "TextControlPlaceholderForeground", "TextControlPlaceholderForegroundPointerOver", "TextControlPlaceholderForegroundFocused" }) resources[key] = ink3;
            resources["TextControlButtonForeground"] = new SolidColorBrush(palette.Ink3);
            resources["TextControlButtonForegroundPointerOver"] = new SolidColorBrush(palette.Ink2);
            resources["TextControlButtonBackgroundPointerOver"] = clear;
            resources["TextControlButtonBackgroundPressed"] = clear;
            box.Resources.ThemeDictionaries[theme] = resources;
        }
        box.Resources["TextControlBorderThemeThicknessFocused"] = new Thickness(0);
        box.Resources["TextControlThemeMinHeight"] = 0.0;
        box.Resources["TextControlThemePadding"] = new Thickness(0);
    }
}

/// The same set of actions wherever a title appears (the Mac's TitleMenu, a context menu).
internal static class TitleMenu
{
    public static MenuFlyout Build(AppModel app, Title title)
    {
        var menu = new MenuFlyout();
        Add(menu, app, title);
        return menu;
    }

    public static void Add(MenuFlyout menu, AppModel app, Title title)
    {
        var library = app.Library;
        var id = title.Id;
        if (library.LatestProgress(id)?.Url is not null) menu.Items.Add(Item("Resume", () => app.Resume(title)));
        menu.Items.Add(Item("Find on my sites", () => app.Browser.SearchEverywhere(title.Name, titleId: id)));
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(Item("Move to backlog", () => library.SetStatus(id, TitleStatus.Backlog), title.Status != TitleStatus.Backlog));
        menu.Items.Add(Item("Move to watching", () => library.SetStatus(id, TitleStatus.Watching), title.Status != TitleStatus.Watching));
        menu.Items.Add(Item("Mark as watched", () => library.SetStatus(id, TitleStatus.Watched), title.Status != TitleStatus.Watched));
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(Item("Remove from library", () => library.Delete(id)));
    }

    public static MenuFlyoutItem Item(string text, Action action, bool enabled = true)
    {
        var item = new MenuFlyoutItem { Text = text, IsEnabled = enabled };
        item.Click += (_, _) => action();
        return item;
    }

    public static ToggleMenuFlyoutItem Toggle(string text, bool isOn, Action<bool> changed)
    {
        var item = new ToggleMenuFlyoutItem { Text = text, IsChecked = isOn };
        item.Click += (_, _) => changed(item.IsChecked);
        return item;
    }

    /// Opens a context menu where it was asked for: at the pointer, or under the element from the keyboard.
    public static void Show(MenuFlyout menu, UIElement target, ContextRequestedEventArgs e)
    {
        e.Handled = true;
        if (menu.Items.Count == 0) return;
        if (e.TryGetPosition(target, out var point)) menu.ShowAt(target, new FlyoutShowOptions { Position = point });
        else menu.ShowAt(target, new FlyoutShowOptions { Placement = FlyoutPlacementMode.BottomEdgeAlignedLeft });
    }
}

/// A quiet menu button for one filter, lit while it's narrowing the list (the Mac's FilterMenu).
/// The menu is built when it opens, so it shows what's chosen then.
internal static class FilterMenu
{
    public static Button Make(string label, bool isActive, Func<MenuFlyout> menu, string? glyph = null, string? help = null)
    {
        var p = Theme.P;
        var ink = isActive ? p.Ink : p.Ink2;
        var text = Ui.Line(label, Typeface.Ui(12.5, isActive ? Typeface.Medium : null), ink);
        var row = glyph is null
            ? Ui.HStack(5, text, Ui.Icon(Glyph.ChevronDown, 8, ink))
            : Ui.HStack(5, Ui.Icon(glyph, 10, ink), text);
        Button? button = null;
        button = Buttons.Make(row, () =>
        {
            if (button is null) return;
            menu().ShowAt(button, new FlyoutShowOptions { Placement = FlyoutPlacementMode.BottomEdgeAlignedLeft });
        }, (b, _, _) =>
        {
            b.Background = new SolidColorBrush(isActive ? p.Raised2 : Microsoft.UI.Colors.Transparent);
            b.BorderBrush = new SolidColorBrush(isActive ? Microsoft.UI.Colors.Transparent : p.Line);
        }, help: help);
        button.Padding = new Thickness(10, 4, 10, 4);
        button.BorderThickness = new Thickness(0.5);
        button.SizeChanged += (_, e) => button.CornerRadius = new CornerRadius(e.NewSize.Height / 2);
        return button;
    }
}

/// A view that takes clicks and the keyboard like a plain SwiftUI Button with a context menu: Enter
/// or Space activate it, a right click or the menu key asks for its menu, and it knows when the
/// pointer is over it. Clicks on buttons inside it stay theirs.
public abstract class PressableComponent : Component
{
    protected PressableComponent()
    {
        IsTabStop = true;
        UseSystemFocusVisuals = true;
        Ui.Hand(this);
        Tapped += (_, e) =>
        {
            if (e.Handled || IsInsideButton(e.OriginalSource as DependencyObject)) return;
            e.Handled = true;
            Activate();
        };
        KeyDown += (_, e) =>
        {
            if (e.Key is not (Windows.System.VirtualKey.Enter or Windows.System.VirtualKey.Space)) return;
            if (IsInsideButton(e.OriginalSource as DependencyObject)) return;
            e.Handled = true;
            Activate();
        };
        PointerEntered += (_, _) => SetHovered(true);
        PointerExited += (_, _) => SetHovered(false);
        PointerCanceled += (_, _) => SetHovered(false);
        ContextRequested += (_, e) =>
        {
            if (ContextMenu() is { } menu) TitleMenu.Show(menu, this, e);
        };
    }

    public bool IsHovered { get; private set; }

    /// Forgets the pointer, for a cell a list reuses for another item: it isn't under the pointer
    /// just because the last one was.
    protected void ResetHover() => IsHovered = false;

    protected abstract void Activate();
    protected virtual void OnHoverChanged(bool hovered) { }
    protected virtual MenuFlyout? ContextMenu() => null;

    private void SetHovered(bool hovered)
    {
        if (IsHovered == hovered) return;
        IsHovered = hovered;
        OnHoverChanged(hovered);
    }

    private bool IsInsideButton(DependencyObject? source)
    {
        for (var node = source; node is not null && !ReferenceEquals(node, this); node = VisualTreeHelper.GetParent(node))
        {
            if (node is ButtonBase) return true;
        }
        return false;
    }
}

/// A grid whose columns are as many as fit at `MinItemWidth` and share the width: SwiftUI's
/// `LazyVGrid(columns: [GridItem(.adaptive(minimum:), spacing:)])` for short lists.
public sealed class AdaptiveColumns : Panel
{
    private int _columns = 1;
    private double _itemWidth;
    private readonly List<double> _rowHeights = [];

    public double MinItemWidth { get; set; } = 172;
    public double ColumnSpacing { get; set; } = 8;
    public double RowSpacing { get; set; } = 8;

    protected override Windows.Foundation.Size MeasureOverride(Windows.Foundation.Size availableSize)
    {
        var width = double.IsInfinity(availableSize.Width) ? MinItemWidth : availableSize.Width;
        _columns = Math.Max(1, (int)Math.Floor((width + ColumnSpacing) / (MinItemWidth + ColumnSpacing)));
        _itemWidth = Math.Max(0, (width - ColumnSpacing * (_columns - 1)) / _columns);
        _rowHeights.Clear();
        for (var i = 0; i < Children.Count; i++)
        {
            Children[i].Measure(new Windows.Foundation.Size(_itemWidth, double.PositiveInfinity));
            var row = i / _columns;
            if (row == _rowHeights.Count) _rowHeights.Add(0);
            _rowHeights[row] = Math.Max(_rowHeights[row], Children[i].DesiredSize.Height);
        }
        var height = _rowHeights.Sum() + RowSpacing * Math.Max(0, _rowHeights.Count - 1);
        return new(width, height);
    }

    protected override Windows.Foundation.Size ArrangeOverride(Windows.Foundation.Size finalSize)
    {
        var y = 0.0;
        for (var row = 0; row < _rowHeights.Count; row++)
        {
            for (var column = 0; column < _columns; column++)
            {
                var index = row * _columns + column;
                if (index >= Children.Count) break;
                Children[index].Arrange(new(column * (_itemWidth + ColumnSpacing), y, _itemWidth, _rowHeights[row]));
            }
            y += _rowHeights[row] + RowSpacing;
        }
        return finalSize;
    }
}

/// Saved frames as addresses images can load (the Mac's `frameURL` and `bestFrameURL`).
internal static class FrameFiles
{
    public static Uri? Url(LibraryStore library, FilmFrame frame)
    {
        try { return new Uri(library.FramePath(frame)); }
        catch (Exception) { return null; }
    }

    public static Uri? Best(LibraryStore library, long titleId)
    {
        if (library.BestFramePath(titleId) is not { } path) return null;
        try { return new Uri(path); }
        catch (Exception) { return null; }
    }
}

/// A series' episodes for the title card.
internal static class EpisodeSource
{
    private static readonly ConditionalWeakTable<ProfileSession, MetadataService> Services = new();

    public static async Task<IReadOnlyList<EpisodeInfo>> ForAsync(AppModel app, Title title)
    {
        // TODO(after core merge): `app.Session.Metadata.EpisodesAsync(title)`, the session's own
        // MetadataService, as the Mac's TitleDetailView does. Until ProfileSession has one, each
        // session gets one here (same library, same "Fetch metadata" switch).
        var session = app.Session;
        var service = Services.GetValue(session, s => new MetadataService(s.Library, () => s.Settings.FetchMetadata));
        try { return await service.EpisodesAsync(title); }
        catch (Exception) { return []; }
    }
}

/// Finished downloads, for "On this PC" and the title card's play button.
internal static class LocalCopies
{
    // TODO(after core merge): `app.Session.Downloads.Items` once ProfileSession has its DownloadCenter;
    // until then the downloads table is read directly, as ProfileSession.Stats does.
    public static IReadOnlyList<DownloadItem> Done(AppModel app)
    {
        try { return [.. app.Session.Db.AllDownloads().Where(d => d.Status == DownloadStatus.Done)]; }
        catch (Exception) { return []; }
    }

    public static IReadOnlySet<long> TitleIds(AppModel app) =>
        Done(app).Where(d => d.TitleId is not null).Select(d => d.TitleId!.Value).ToHashSet();
}

/// The Mac's `DateText.relative`: "3 hours ago", "in 2 days".
// TODO(port-screens-misc): use `DateText.Relative` from UI/Formats.cs once it merges, and delete this.
internal static class RelativeDate
{
    public static string Text(DateTimeOffset date, DateTimeOffset? now = null)
    {
        var seconds = ((now ?? DateTimeOffset.Now) - date).TotalSeconds;
        var past = seconds >= 0;
        var s = Math.Abs(seconds);
        (double size, string unit)[] units = [(31_536_000, "year"), (2_592_000, "month"), (604_800, "week"), (86_400, "day"), (3_600, "hour"), (60, "minute")];
        var (count, name) = ((long)Math.Floor(s), "second");
        foreach (var (size, unit) in units)
        {
            if (s < size) continue;
            (count, name) = ((long)Math.Floor(s / size), unit);
            break;
        }
        var text = $"{count} {name}{(count == 1 ? "" : "s")}";
        return past && count > 0 ? $"{text} ago" : $"in {text}";
    }
}

/// Small choices the Mac keeps in UserDefaults through @AppStorage, such as the library's sort. One
/// JSON file in the data folder, for every profile, like the Mac's app-wide defaults.
internal static class UiDefaults
{
    private static Dictionary<string, string>? _values;
    private static string FilePath => Path.Combine(AppPaths.Root, "ui-defaults.json");

    private static Dictionary<string, string> Values
    {
        get
        {
            if (_values is not null) return _values;
            try { _values = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(FilePath)) ?? []; }
            catch (Exception) { _values = []; }
            return _values;
        }
    }

    public static string? Get(string key) => Values.GetValueOrDefault(key);

    public static void Set(string key, string value)
    {
        if (Values.TryGetValue(key, out var old) && old == value) return;
        Values[key] = value;
        try
        {
            Directory.CreateDirectory(AppPaths.Root);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(Values));
        }
        catch (Exception)
        {
            // Remembering the choice is a nicety.
        }
    }
}

/// Templates for ItemsRepeater: an empty Border each, filled in from code when the repeater prepares it.
internal static class RepeaterCells
{
    public static DataTemplate Template() => (DataTemplate)XamlReader.Load(
        "<DataTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><Border/></DataTemplate>");
}

/// Facts about a title the screens put in a line.
internal static class TitleText
{
    /// "3 h 2 min" for a runtime in minutes.
    public static string Runtime(int minutes) => Timecode.Spoken(minutes * 60.0);

    /// The empty state's logo and sentence (and a button), centred in what's left of the page.
    public static FrameworkElement Empty(string text, Button? button = null, double? maxWidth = null)
    {
        var p = Theme.P;
        var sentence = Ui.Text(text, Typeface.Ui(14), p.Ink2);
        sentence.TextAlignment = TextAlignment.Center;
        sentence.HorizontalAlignment = HorizontalAlignment.Center;
        if (maxWidth is { } w) sentence.MaxWidth = w;
        var logo = Images.LogoMark(52, p.Ink3);
        logo.HorizontalAlignment = HorizontalAlignment.Center;
        var stack = Ui.VStack(12, logo, sentence);
        if (button is not null)
        {
            button.HorizontalAlignment = HorizontalAlignment.Center;
            button.Margin = new Thickness(0, 4, 0, 0);
            stack.Children.Add(button);
        }
        stack.HorizontalAlignment = HorizontalAlignment.Center;
        stack.VerticalAlignment = VerticalAlignment.Center;
        return stack;
    }
}
