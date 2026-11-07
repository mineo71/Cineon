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
