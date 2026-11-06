using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Cineon.App.UI;

/// The bar across the top: the logo on the left, the sections in one capsule in the middle like a
/// TV app's, and what's playing, the tools and you on the right. On Windows the system's caption
/// buttons sit at the far right, where the Mac has its traffic lights on the left.
public sealed class TopBar : Component
{
    public const double Height = 56;

    private readonly AppModel _app;
    private readonly MainWindow _window;
    private double _width = 1400;

    /// The bar's empty background, which drags the window.
    public Border DragArea { get; } = new() { Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };

    /// The button at the end of the tools that opens the app menu, as last rendered.
    public Button? MoreButton { get; private set; }

    public TopBar(AppModel app, MainWindow window)
    {
        _app = app;
        _window = window;
        Watch(app);
        SizeChanged += (_, e) =>
        {
            var before = Style(_width);
            _width = e.NewSize.Width;
            if (Style(_width) != before || (_width < 1360) != (e.PreviousSize.Width < 1360)) Invalidate();
        };
    }

    private bool OnHero => _app.Route == Route.Home;

    /// Narrow windows first lose the playing title, then tighten the sections, then show only their icons.
    private static SectionTabs.Look Style(double width) => width >= 1200 ? SectionTabs.Look.Regular : width >= 1100 ? SectionTabs.Look.Compact : SectionTabs.Look.Icons;

    /// Everything in the bar that takes clicks, for the window's title-bar regions.
    public IEnumerable<FrameworkElement> Interactive()
    {
        if (Content is not DependencyObject root) yield break;
        var stack = new Stack<DependencyObject>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            if (node is Microsoft.UI.Xaml.Controls.Primitives.ButtonBase or TextBox or AutoSuggestBox) { yield return (FrameworkElement)node; continue; }
            var count = VisualTreeHelper.GetChildrenCount(node);
            for (var i = 0; i < count; i++) stack.Push(VisualTreeHelper.GetChild(node, i));
        }
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var logo = Buttons.Make(
            Ui.HStack(8,
                Images.LogoMark(22),
                Ui.Line("Cineon", Typeface.Bold(17), p.Ink)),
            () => _app.Go(Route.Home), help: "Home");

        // Windows has no menu bar: the Mac's menus open from here, and with Alt or F10.
        Button? more = null;
        more = Buttons.Icon(Glyph.More, "More (Alt)", () => { if (more is not null) AppMenu.Show(_app, more); });
        MoreButton = more;
        var tools = Ui.HStack(0,
                Buttons.Icon(Glyph.Search, "Search films and sites (Ctrl+K)", () => _app.OpenCommandBar()),
                Buttons.Icon(Glyph.Globe, "Sites", () => _app.Go(Route.Web)),
                Buttons.Icon(Glyph.Star, "Rate my films", () => _app.Go(Route.Rate)),
                more)
            .Padding(3, 0);
        var toolsCapsule = BarCapsule(tools.Size(height: 34), OnHero);

        var avatar = AvatarButton(p);

        var leading = Ui.HStack(0, logo).Padding(16, 0, 0, 0);
        var middle = new SectionTabs(_app, Style(_width), OnHero);
        var trailing = Ui.HStack(10, new NowPlayingPill(_app, compact: _width < 1360, onHero: OnHero), toolsCapsule, avatar)
            .Padding(0, 0, Math.Max(16, _window.CaptionButtonsWidth + 12), 0);

        var bar = new CentredBar(14) { Children = { leading, middle, trailing } };
        bar.Height = Height;

        DragArea.Background = Background(p);
        // The drag area outlives each render, so it leaves the old layout before joining the new one.
        if (VisualTreeHelper.GetParent(DragArea) is Panel previous) previous.Children.Remove(DragArea);
        return Ui.ZStack(DragArea, bar);
    }

    /// Your pet, which is you (the Mac's AvatarButton). Click for your profile; right-click has the rest.
    private Button AvatarButton(Palette p)
    {
        var pet = new PixelPetView(_app.Session.Pet, 28, animated: false)
        {
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var fill = OnHero ? Palette.WithOpacity(p.Canvas, p.IsDark ? 0.55 : 0.5) : p.Raised2;
        var face = new Grid { Width = 34, Height = 34, Background = new SolidColorBrush(fill), Children = { pet } }.ClipRounded(17);
        var ring = new Microsoft.UI.Xaml.Shapes.Ellipse
        {
            Width = 34,
            Height = 34,
            Stroke = _app.Route == Route.Profile ? p.Gold : new SolidColorBrush(OnHero && p.IsDark ? Palette.Grey(1, 0.16) : p.Line),
            StrokeThickness = 1,
            IsHitTestVisible = false,
        };
        var button = Buttons.Make(new Grid { Width = 34, Height = 34, Children = { face, ring } },
            () => _app.Go(Route.Profile), help: $"{_app.Session.Profile.Name}: profile");

        var menu = new MenuFlyout();
        void Item(string text, Action action)
        {
            var item = new MenuFlyoutItem { Text = text };
            item.Click += (_, _) => action();
            menu.Items.Add(item);
        }
        Item("Profile", () => _app.Go(Route.Profile));
        Item("Who's watching…", () => _app.IsProfilePickerVisible = true);
        menu.Items.Add(new MenuFlyoutSeparator());
        Item(p.IsDark ? "Light theme" : "Dark theme", _app.ToggleTheme);
        Item("Settings…", () => _app.Go(Route.Settings));
        button.ContextFlyout = menu;
        return button;
    }

    /// Over a film the bar is a shadow falling from the top. Elsewhere it's the room's black.
    private Brush Background(Palette p)
    {
        if (OnHero)
        {
            return new LinearGradientBrush
            {
                StartPoint = new Windows.Foundation.Point(0.5, 0),
                EndPoint = new Windows.Foundation.Point(0.5, 1),
                GradientStops =
                {
                    new GradientStop { Color = Palette.WithOpacity(p.Canvas, 0.78), Offset = 0 },
                    new GradientStop { Color = Palette.WithOpacity(p.Canvas, 0.4), Offset = 0.65 },
                    new GradientStop { Color = Palette.WithOpacity(p.Canvas, 0), Offset = 1 },
                },
            };
        }
        return new SolidColorBrush(p.Canvas);
    }

    /// What the bar's capsules are made of: smoked glass over a film, a faint raise elsewhere.
    public static Border BarCapsule(FrameworkElement content, bool onHero)
    {
        var p = Theme.P;
        var fill = onHero ? Palette.WithOpacity(p.Canvas, p.IsDark ? 0.55 : 0.5) : p.Raised;
        var stroke = onHero && p.IsDark ? Palette.Grey(1, 0.14) : p.Line;
        return content.Capsule(fill, stroke);
    }
}

/// The sections in one capsule. The selected one sits on a silver capsule.
public sealed class SectionTabs : Component
{
    public enum Look { Regular, Compact, Icons }

    private readonly AppModel _app;
    private readonly Look _look;
    private readonly bool _onHero;

    public SectionTabs(AppModel app, Look look, bool onHero)
    {
        _app = app;
        _look = look;
        _onHero = onHero;
    }

    private sealed record Item(string Label, string Glyph, Route Route, Route[] Also);

    private IEnumerable<Item> Items()
    {
        yield return new("Home", Glyph.House, Route.Home, []);
        yield return new("Library", Glyph.Films, Route.Library, []);
        yield return new("Timeline", Glyph.Clock, Route.Timeline, []);
        yield return new("Downloads", Glyph.Download, Route.Downloads, [Route.Player]);
        yield return new("Together", Glyph.People, Route.Together, []);
        if (_app.HasTabs) yield return new("Browse", Glyph.Globe, Route.Web, []);
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var row = Ui.HStack(2);
        foreach (var item in Items())
        {
            var selected = _app.Route == item.Route || item.Also.Contains(_app.Route);
            var ink = selected ? p.OnSilver : p.Ink2;
            var icon = Ui.Icon(item.Glyph, 13, ink);
            UIElement label = _look == Look.Icons
                ? icon
                : Ui.HStack(6, icon, Ui.Line(item.Label, Typeface.Ui(13, Typeface.Medium), ink));
            var button = Buttons.Make(label, () =>
            {
                // Browse with nothing chosen opens the first tab, as the Mac does.
                if (item.Route == Route.Web && _app.Browser.Selected is null && _app.Browser.ListedTabs is [var first, ..]) _app.Browser.Select(first);
                _app.Go(item.Route);
            }, (b, hovered, _) =>
            {
                b.Background = selected ? p.Silver : new SolidColorBrush(hovered ? p.Raised2 : Microsoft.UI.Colors.Transparent);
            }, help: _look == Look.Icons ? item.Label : null);
            button.Padding = _look == Look.Regular ? new Thickness(14, 6, 14, 6) : new Thickness(10, 6, 10, 6);
            button.CornerRadius = new CornerRadius(15);
            row.Children.Add(button);
        }
        return TopBar.BarCapsule(row.Padding(4), _onHero);
    }
}

/// Three groups in a bar: one at each end, and one in the middle of the whole width. The middle
/// one only moves off centre when it would run into either end, and is offered what's left.
public sealed class CentredBar : Panel
{
    private readonly double _gap;

    public CentredBar(double gap) { _gap = gap; }

    protected override Windows.Foundation.Size MeasureOverride(Windows.Foundation.Size available)
    {
        if (Children.Count != 3) return new(0, 0);
        var infinite = new Windows.Foundation.Size(double.PositiveInfinity, available.Height);
        Children[0].Measure(infinite);
        Children[2].Measure(infinite);
        var left = Children[0].DesiredSize.Width;
        var right = Children[2].DesiredSize.Width;
        var room = Math.Max(0, available.Width - left - right - 2 * _gap);
        Children[1].Measure(new Windows.Foundation.Size(room, available.Height));
        var height = Math.Max(Children[0].DesiredSize.Height, Math.Max(Children[1].DesiredSize.Height, Children[2].DesiredSize.Height));
        return new(double.IsInfinity(available.Width) ? left + right + Children[1].DesiredSize.Width + 2 * _gap : available.Width, height);
    }

    protected override Windows.Foundation.Size ArrangeOverride(Windows.Foundation.Size final)
    {
        if (Children.Count != 3) return final;
        var left = Children[0].DesiredSize;
        var middle = Children[1].DesiredSize;
        var right = Children[2].DesiredSize;
        Children[0].Arrange(new(0, (final.Height - left.Height) / 2, left.Width, left.Height));
        Children[2].Arrange(new(final.Width - right.Width, (final.Height - right.Height) / 2, right.Width, right.Height));
        var minX = left.Width + _gap;
        var maxX = final.Width - right.Width - _gap - middle.Width;
        var x = Math.Clamp((final.Width - middle.Width) / 2, minX, Math.Max(minX, maxX));
        Children[1].Arrange(new(x, (final.Height - middle.Height) / 2, middle.Width, middle.Height));
        return final;
    }
}
