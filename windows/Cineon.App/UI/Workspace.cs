using System.Numerics;
using Cineon.App.Browser;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Windows.UI;

namespace Cineon.App.UI;

/// Everything under the top bar: the film's light, then the page. Sites and the player sit in a
/// framed screen with the light spilling around it; Cineon's own pages run edge to edge. The
/// Mac's WorkspaceLayout and MainCard from RootView.swift. The tabs' web views stay in place
/// behind native pages, so coming back to a film never reloads it.
public sealed class Workspace : Grid
{
    private readonly AppModel _app;
    private readonly PageHost _pages;
    private readonly AmbientLight _light;
    private readonly Border _card = new();
    private readonly Grid _cardContent = new();
    private readonly Border _webSlot = new();
    private readonly Border _peek;
    private readonly Border _barSlot = new() { VerticalAlignment = VerticalAlignment.Top };
    private ProfileSession? _session;
    private BrowserModel? _browser;
    private CompositionRoundedRectangleGeometry? _clipShape;
    private double _radius = -1;

    public Workspace(AppModel app, PageHost pages)
    {
        _app = app;
        _pages = pages;
        _pages.SetTopInset(0);
        _light = new AmbientLight(app);

        _cardContent.Children.Add(_webSlot);
        _cardContent.Children.Add(_pages);
        _card.Child = _cardContent;
        _cardContent.SizeChanged += (_, _) => UpdateClip();

        // On a site with the bars tucked away, they come back while the pointer is at the top.
        _peek = new Border
        {
            Height = 8,
            VerticalAlignment = VerticalAlignment.Top,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
        };
        _peek.PointerEntered += (_, _) => { if (!_app.IsSidebarPeeking) _app.IsSidebarPeeking = true; };
        _barSlot.Margin = new Thickness(0, TopBar.Height, 0, 0);

        Children.Add(_light);
        Children.Add(_card);
        Children.Add(_peek);
        Children.Add(_barSlot);

        // Leaving the bars puts them away again.
        AddHandler(PointerMovedEvent, new PointerEventHandler((_, e) =>
        {
            if (!_app.IsSidebarPeeking || !_app.Settings.SidebarHidden) return;
            var y = e.GetCurrentPoint(this).Position.Y;
            if (y > TopBar.Height + BrowserBar.Height + 4) _app.IsSidebarPeeking = false;
        }), handledEventsToo: true);

        app.Changed += Update;
        Theme.Changed += Update;
        Loaded += (_, _) => Update();
    }

    private void Update()
    {
        if (!ReferenceEquals(_session, _app.Session))
        {
            if (_browser is not null) _browser.Changed -= Update;
            _session = _app.Session;
            _browser = _app.Browser;
            _browser.Changed += Update;
            // The new profile's web views and bar. The old ones were torn down with their session.
            if (_browser.Views.Parent is Border previous && !ReferenceEquals(previous, _webSlot)) previous.Child = null;
            _webSlot.Child = _browser.Views;
            _barSlot.Child = new BrowserBar(_app);
        }

        var p = Theme.P;
        var app = _app;
        var isWeb = app.Route == Route.Web;
        var pageFullscreen = app.Browser.IsPageFullscreen;
        var isScreen = app.IsScreen && !pageFullscreen;

        // The page: below the bars, and in a frame on a screen route.
        Thickness padding;
        double radius;
        if (pageFullscreen) { padding = new Thickness(0); radius = 0; }
        else if (app.IsCinema) { padding = new Thickness(44); radius = 16; }
        else if (isScreen) { padding = new Thickness(12, 10, 12, 12); radius = 12; }
        else { padding = new Thickness(0); radius = 0; }
        var top = app.ContentTop;
        _card.Margin = new Thickness(padding.Left, top + padding.Top, padding.Right, padding.Bottom);
        _card.CornerRadius = new CornerRadius(radius);
        _card.Background = isScreen || app.IsCinema ? new SolidColorBrush(p.CardFill) : null;
        _card.BorderBrush = isScreen || app.IsCinema ? new SolidColorBrush(p.Line) : null;
        _card.BorderThickness = new Thickness(isScreen || app.IsCinema ? (p.IsDark ? 0.5 : 1) : 0);
        var shadow = (isScreen || app.IsCinema) && p.IsDark;
        if (shadow && _card.Shadow is null) _card.Shadow = new ThemeShadow();
        else if (!shadow && _card.Shadow is not null) _card.Shadow = null;
        _card.Translation = new Vector3(0, 0, shadow ? 16 : 0);
        if (radius != _radius)
        {
            _radius = radius;
            UpdateClip();
        }

        // Sites stay where they are, only out of sight, while another page is on.
        _webSlot.Opacity = isWeb ? 1 : 0;
        _webSlot.IsHitTestVisible = isWeb;
        _webSlot.Margin = new Thickness(0, isWeb && app.Browser.Search is not null ? WebOverlays.DeckHeight : 0, 0, 0);
        if (isWeb && app.Browser.Selected is { Url: not null, HasWebView: false } selected) selected.EnsureWebView();

        _peek.Visibility = isWeb && app.Settings.SidebarHidden && !app.IsCinema && !pageFullscreen && !app.IsSidebarPeeking
            ? Visibility.Visible
            : Visibility.Collapsed;
        _barSlot.Visibility = isWeb && app.ShowsBars ? Visibility.Visible : Visibility.Collapsed;
        _light.Visibility = pageFullscreen ? Visibility.Collapsed : Visibility.Visible;
    }

    /// Rounds the corners of everything in the card, the web views' own visuals included.
    private void UpdateClip()
    {
        var visual = ElementCompositionPreview.GetElementVisual(_cardContent);
        var compositor = visual.Compositor;
        var size = new Vector2((float)_cardContent.ActualWidth, (float)_cardContent.ActualHeight);
        if (_radius <= 0)
        {
            visual.Clip = null;
            _clipShape = null;
            return;
        }
        if (_clipShape is null)
        {
            _clipShape = compositor.CreateRoundedRectangleGeometry();
            visual.Clip = compositor.CreateGeometricClip(_clipShape);
        }
        _clipShape.Size = size;
        _clipShape.CornerRadius = new Vector2((float)Math.Max(0, _radius - 0.5));
    }
}

/// Light from the film spilling onto the room, the way a TV lights the wall behind it. The Mac
/// draws a 3×3 mesh gradient: the outer ring carries the six sampled colours and the centre stays
/// dark, under the card. WinUI has no mesh gradient, so each point is a soft radial glow.
public sealed class AmbientLight : Grid
{
    private readonly AppModel _app;
    private readonly (GradientStop Inner, GradientStop Outer, int Zone, double Strength)[] _glows;
    private double _shownLevel = -1;

    /// The mesh's points (x, y) and which zone colours each, as on the Mac.
    private static readonly (double X, double Y, int Zone, double Strength)[] Points =
    [
        (0.5, 0.5, 1, 0.7),
        (0, 0, 0, 1), (0.5, 0, 1, 1), (1, 0, 2, 1),
        (0, 0.5, 3, 1), (1, 0.5, 5, 1),
        (0, 1, 3, 1), (0.5, 1, 4, 1), (1, 1, 5, 1),
    ];

    public AmbientLight(AppModel app)
    {
        _app = app;
        IsHitTestVisible = false;
        Opacity = 0;
        _glows = new (GradientStop, GradientStop, int, double)[Points.Length];
        for (var i = 0; i < Points.Length; i++)
        {
            var (x, y, zone, strength) = Points[i];
            var inner = new GradientStop { Color = Microsoft.UI.Colors.Black, Offset = 0 };
            var outer = new GradientStop { Color = Color.FromArgb(0, 0, 0, 0), Offset = 1 };
            var brush = new RadialGradientBrush
            {
                MappingMode = BrushMappingMode.RelativeToBoundingBox,
                Center = new Windows.Foundation.Point(x, y),
                GradientOrigin = new Windows.Foundation.Point(x, y),
                RadiusX = 0.62,
                RadiusY = 0.75,
                GradientStops = { inner, outer },
            };
            Children.Add(new Microsoft.UI.Xaml.Shapes.Rectangle { Fill = brush });
            _glows[i] = (inner, outer, zone, strength);
        }
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAccessibilityView(this, Microsoft.UI.Xaml.Automation.Peers.AccessibilityView.Raw);
        Action update = Update;
        Loaded += (_, _) =>
        {
            app.Ambient.Changed += update;
            Theme.Changed += update;
            Update();
        };
        Unloaded += (_, _) =>
        {
            app.Ambient.Changed -= update;
            Theme.Changed -= update;
        };
    }

    private void Update()
    {
        var ambient = _app.Ambient;
        var story = new Storyboard();
        var zones = ambient.Zones;
        foreach (var (inner, outer, zone, strength) in _glows)
        {
            var colour = zone < zones.Count ? zones[zone].Color : Microsoft.UI.Colors.Black;
            var lit = Color.FromArgb((byte)Math.Round(255 * strength), colour.R, colour.G, colour.B);
            story.Children.Add(Animate(inner, lit));
            story.Children.Add(Animate(outer, Color.FromArgb(0, colour.R, colour.G, colour.B)));
        }
        // Light reads stronger on black; on white it's a tint, as the Mac multiplies it.
        var level = ambient.Level * (Theme.P.IsDark ? 1 : 0.55);
        if (Math.Abs(level - _shownLevel) > 0.001)
        {
            _shownLevel = level;
            var fade = new DoubleAnimation
            {
                To = level,
                Duration = new Duration(TimeSpan.FromSeconds(1.2)),
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
            };
            Storyboard.SetTarget(fade, this);
            Storyboard.SetTargetProperty(fade, "Opacity");
            story.Children.Add(fade);
        }
        story.Begin();
    }

    private static ColorAnimation Animate(GradientStop stop, Color to)
    {
        var animation = new ColorAnimation
        {
            To = to,
            Duration = new Duration(TimeSpan.FromSeconds(1.4)),
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
            EnableDependentAnimation = true,
        };
        Storyboard.SetTarget(animation, stop);
        Storyboard.SetTargetProperty(animation, "Color");
        return animation;
    }
}
