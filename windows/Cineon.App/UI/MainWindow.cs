using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;
using Windows.System;

namespace Cineon.App.UI;

/// The one window. The top bar runs under the system's caption buttons, the way the Mac bar runs
/// under the traffic lights, and doubles as the title bar for dragging.
public sealed class MainWindow : Window
{
    private readonly AppModel _app;
    private readonly Grid _root = new();
    private readonly TopBar _topBar;
    private readonly PageHost _pages;
    private readonly OverlayHost _overlays;
    /// Alt went down with nothing else pressed since, so letting go of it opens the menu.
    private bool _altAlone;

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
        WindowPlacement.Restore(AppWindow, 1360, 860);
        WindowPlacement.Track(AppWindow);

        _topBar = new TopBar(app, this);
        _pages = new PageHost(app);
        _overlays = new OverlayHost(app);

        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(TopBar.Height) });
        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _pages.Cell(row: 0, rowSpan: 2);
        _topBar.Cell(row: 0);
        _overlays.Cell(row: 0, rowSpan: 2);
        _root.Children.Add(_pages);
        _root.Children.Add(_topBar);
        _root.Children.Add(_overlays);
        Content = _root;

        _topBar.DragArea.Loaded += (_, _) => SetTitleBar(_topBar.DragArea);
        Paint();
        Theme.Changed += Paint;
        app.Changed += Layout;
        Layout();
        _topBar.LayoutUpdated += (_, _) => UpdateTitleBarRegions();
        _root.SizeChanged += (_, _) => UpdateTitleBarRegions();

        // The menus' shortcuts, for keys the focused view didn't use.
        _root.KeyDown += (_, e) =>
        {
            var (control, shift, alt) = Shortcuts.Modifiers();
            if (Shortcuts.Handle(app, e.Key, control, shift, alt)) e.Handled = true;
        };
        // Ctrl+Tab before focus navigation takes the Tab key.
        _root.PreviewKeyDown += (_, e) =>
        {
            if (e.Key != VirtualKey.Tab) return;
            var (control, shift, alt) = Shortcuts.Modifiers();
            if (control && Shortcuts.Handle(app, e.Key, control, shift, alt)) e.Handled = true;
        };
        // Alt on its own, or F10, opens the menu, as a menu bar would.
        _root.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler((_, e) =>
        {
            _altAlone = e.Key is VirtualKey.Menu or VirtualKey.LeftMenu or VirtualKey.RightMenu && !Shortcuts.Modifiers().Control;
            if (e.Key == VirtualKey.F10 && Shortcuts.Modifiers() is (false, false, false))
            {
                e.Handled = true;
                ShowMenu();
            }
        }), handledEventsToo: true);
        _root.AddHandler(UIElement.KeyUpEvent, new KeyEventHandler((_, e) =>
        {
            if (e.Key is not (VirtualKey.Menu or VirtualKey.LeftMenu or VirtualKey.RightMenu) || !_altAlone) return;
            _altAlone = false;
            e.Handled = true;
            ShowMenu();
        }), handledEventsToo: true);
        _root.PointerPressed += (_, _) => _altAlone = false;
        Activated += (_, _) => _altAlone = false;
    }

    private void Layout()
    {
        _pages.SetTopInset(_app.Route == Route.Home || _app.IsCinema ? 0 : TopBar.Height);
        // Cinema mode leaves only the film.
        _topBar.Visibility = _app.IsCinema ? Visibility.Collapsed : Visibility.Visible;
    }

    /// The window's handle, for the Windows APIs that want one.
    public IntPtr Handle => WinRT.Interop.WindowNative.GetWindowHandle(this);

    /// On screen and not minimised. The Mac's occlusion check for ambient light.
    public bool IsShowing =>
        AppWindow.IsVisible && (AppWindow.Presenter as OverlappedPresenter)?.State != OverlappedPresenterState.Minimized;

    /// Opens the app menu under the More button, or at the top right when the bar is hidden.
    public void ShowMenu()
    {
        if (_topBar.Visibility == Visibility.Visible && _topBar.MoreButton is { XamlRoot: not null } more)
        {
            AppMenu.Show(_app, more);
            return;
        }
        var x = Math.Max(0, _root.ActualWidth - 24);
        AppMenu.Show(_app, _root, new Windows.Foundation.Point(x, 12));
    }

    /// Cinema mode hides the minimise, maximise and close buttons, like the Mac's traffic lights.
    public void SetCaptionButtonsHidden(bool hidden)
    {
        if (AppWindow.Presenter is not OverlappedPresenter presenter) return;
        try { presenter.SetBorderAndTitleBar(true, !hidden); }
        catch (Exception) { }
    }

    /// Restores the window if it's minimised and brings it in front, for a second launch or a
    /// clicked notification.
    public void BringToFront()
    {
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } presenter) presenter.Restore();
        Activate();
        SetForegroundWindow(Handle);
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

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
