using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;

namespace Cineon.App.UI;

/// The one window. The top bar runs under the system's caption buttons, the way the Mac bar runs
/// under the traffic lights, and doubles as the title bar for dragging.
public sealed class MainWindow : Window
{
    private readonly AppModel _app;
    private readonly Grid _root = new();
    private readonly TopBar _topBar;
    private readonly PageHost _pages;

    public MainWindow(AppModel app)
    {
        _app = app;
        Title = "Cineon";
        ExtendsContentIntoTitleBar = true;
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "Cineon.ico");
        if (File.Exists(icon)) AppWindow.SetIcon(icon);

        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = 860;
            presenter.PreferredMinimumHeight = 540;
        }
        var scale = (double)(Microsoft.UI.Windowing.DisplayArea.Primary?.WorkArea.Height ?? 900) >= 1000 ? 1.0 : 0.9;
        AppWindow.Resize(new SizeInt32((int)(1360 * scale), (int)(860 * scale)));

        _topBar = new TopBar(app, this);
        _pages = new PageHost(app);

        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(TopBar.Height) });
        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _pages.Cell(row: 0, rowSpan: 2);
        _topBar.Cell(row: 0);
        _root.Children.Add(_pages);
        _root.Children.Add(_topBar);
        Content = _root;

        _topBar.DragArea.Loaded += (_, _) => SetTitleBar(_topBar.DragArea);
        Paint();
        Theme.Changed += Paint;
        app.Changed += () => _pages.SetTopInset(app.Route == Route.Home ? 0 : TopBar.Height);
        _pages.SetTopInset(app.Route == Route.Home ? 0 : TopBar.Height);
        _topBar.LayoutUpdated += (_, _) => UpdateTitleBarRegions();
        _root.SizeChanged += (_, _) => UpdateTitleBarRegions();
    }

    /// Space the system's minimize, maximize and close buttons take on the right, in view pixels.
    public double CaptionButtonsWidth
    {
        get
        {
            var scale = Content?.XamlRoot?.RasterizationScale ?? 1;
            return AppWindow.TitleBar.RightInset / scale;
        }
    }

    private void Paint()
    {
        var p = Theme.P;
        _root.Background = new SolidColorBrush(p.Canvas);
        if (_root is FrameworkElement fe) fe.RequestedTheme = p.IsDark ? ElementTheme.Dark : ElementTheme.Light;
        var bar = AppWindow.TitleBar;
        bar.ButtonBackgroundColor = Colors.Transparent;
        bar.ButtonInactiveBackgroundColor = Colors.Transparent;
        bar.ButtonForegroundColor = p.Ink;
        bar.ButtonInactiveForegroundColor = p.Ink3;
        bar.ButtonHoverBackgroundColor = p.Raised2;
        bar.ButtonHoverForegroundColor = p.Ink;
        bar.ButtonPressedBackgroundColor = p.Raised;
        bar.ButtonPressedForegroundColor = p.Ink;
    }

    private RectInt32[] _lastRegions = [];

    /// Buttons in the bar must receive clicks instead of starting a window drag.
    private void UpdateTitleBarRegions()
    {
        var root = Content?.XamlRoot;
        if (root is null) return;
        var scale = root.RasterizationScale;
        var rects = new List<RectInt32>();
        foreach (var element in _topBar.Interactive())
        {
            if (element.Visibility != Visibility.Visible || element.ActualWidth <= 0) continue;
            var box = element.TransformToVisual(null).TransformBounds(new Windows.Foundation.Rect(0, 0, element.ActualWidth, element.ActualHeight));
            rects.Add(new RectInt32((int)(box.X * scale), (int)(box.Y * scale), (int)Math.Ceiling(box.Width * scale), (int)Math.Ceiling(box.Height * scale)));
        }
        var array = rects.ToArray();
        if (array.SequenceEqual(_lastRegions)) return;
        _lastRegions = array;
        InputNonClientPointerSource.GetForWindowId(AppWindow.Id).SetRegionRects(NonClientRegionKind.Passthrough, array);
    }
}

/// Shows the page for the current route. Home runs under the top bar, like the Mac's hero.
public sealed class PageHost : Component
{
    private readonly AppModel _app;
    private Route? _shown;
    private UIElement? _page;
    private double _topInset;

    public PageHost(AppModel app)
    {
        _app = app;
        Watch(app);
    }

    public void SetTopInset(double inset)
    {
        if (_topInset == inset) return;
        _topInset = inset;
        Padding = new Thickness(0, inset, 0, 0);
    }

    protected override UIElement Render()
    {
        if (_page is null || _shown != _app.Route)
        {
            _shown = _app.Route;
            _page = Pages.For(_app);
        }
        return _page;
    }
}
