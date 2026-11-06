using Cineon.App.Browser;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Cineon.App.UI;

/// Only when on a site: back and forward and the open tabs, the address in the middle under the
/// sections, then downloading. The Mac's BrowserBar from TopBar.swift.
public sealed class BrowserBar : Component
{
    public new const double Height = 44;

    /// Back, forward, reload and the bar's padding on one side; download and new tab on the other.
    private const double SideControls = 116;

    private readonly AppModel _app;
    private double _width = 1400;

    public BrowserBar(AppModel app)
    {
        _app = app;
        // This profile's: the workspace makes a new bar when the profile changes.
        var browser = app.Browser;
        var grabber = app.Session.Seasons;
        Watch(app);
        Watch(a => browser.Changed += a, a => browser.Changed -= a);
        Watch(a => browser.TabChanged += a, a => browser.TabChanged -= a);
        EventHandler? seasons = null;
        Watch(a => { seasons = (_, _) => a(); grabber.Changed += seasons; }, _ => grabber.Changed -= seasons);
        SizeChanged += (_, e) =>
        {
            if (Math.Abs(e.NewSize.Width - _width) < 1) return;
            _width = e.NewSize.Width;
            Invalidate();
        };
    }

    private double AddressWidth => Math.Min(520, Math.Max(240, _width - 2 * SideControls - 2 * 160));
    /// The tabs get what's left beside the address, so the address stays centred under the sections.
    private double TabsWidth => Math.Max(0, _width / 2 - AddressWidth / 2 - SideControls - 12);

    protected override UIElement Render()
    {
        var p = Theme.P;
        var tab = _app.Browser.Selected;
        var loading = tab?.IsLoading == true;
        var strip = new TabStrip(_app, showsNewTab: false).MaxSize(width: TabsWidth);
        strip.HorizontalAlignment = HorizontalAlignment.Left;
        strip.Margin = new Thickness(8, 0, 0, 0);
        var leading = Ui.HStack(2,
            Buttons.Icon(Glyph.Back, "Back (Ctrl+[)", () => tab?.GoBack(), enabled: tab?.CanGoBack == true),
            Buttons.Icon(Glyph.Forward, "Forward (Ctrl+])", () => tab?.GoForward(), enabled: tab?.CanGoForward == true),
            Buttons.Icon(loading ? Glyph.Close : Glyph.Reload, loading ? "Stop" : "Reload (Ctrl+R)", () =>
            {
                if (tab?.IsLoading == true) tab.Stop();
                else tab?.Reload();
            }, enabled: tab is not null),
            strip);
        var address = new AddressPill(_app).Size(width: AddressWidth);
        var trailing = Ui.HStack(2,
            tab is null ? null : DownloadMenu.Button(_app, tab),
            Buttons.Icon(Glyph.Add, "New tab (Ctrl+T)", () => _app.OpenCommandBar(), size: 12));
        var bar = new CentredBar(12) { Children = { leading, address, trailing } };
        bar.Height = Height;
        bar.Margin = new Thickness(16, 0, 14, 0);
        var hairline = new Rectangle { Height = 0.5, Fill = new SolidColorBrush(p.Line), VerticalAlignment = VerticalAlignment.Top };
        return new Grid { Background = new SolidColorBrush(p.Canvas), Height = Height, Children = { bar, hairline } };
    }
}

/// Download this, the rest of the season, or all of it. A click downloads; a right-click (the
/// Mac's long press) opens the menu.
public static class DownloadMenu
{
    public static Button Button(AppModel app, BrowserTab tab)
    {
        var p = Theme.P;
        var isEpisode = (tab.Track?.Ref ?? tab.Parsed?.Ref)?.IsEpisode == true;
        var seasons = app.Session.Seasons;
        var hasSource = tab.BestSource is not null;
        var icon = Ui.Icon(seasons.IsBusy ? "" : Glyph.Download, 13, hasSource ? p.Ink2 : p.Ink3);
        var box = new Border { Width = 26, Height = 26, Child = icon.Centered(), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
        var help = isEpisode ? "Download (right-click for the whole season)" : "Download this video";
        var button = Buttons.Make(box, () => app.Session.Downloads.Download(tab), help: help);
        void Open()
        {
            var menu = new MenuFlyout();
            menu.Items.Add(Item("Download this video", () => app.Session.Downloads.Download(tab), hasSource));
            if (isEpisode)
            {
                menu.Items.Add(new MenuFlyoutSeparator());
                menu.Items.Add(Item("Download the rest of this season", () => seasons.Start(tab, fromCurrent: true)));
                menu.Items.Add(Item("Download the whole season", () => seasons.Start(tab, fromCurrent: false), !seasons.IsBusy));
                menu.Items.Add(Item("Download the whole series…", () => seasons.StartSeries(tab), !seasons.IsBusy));
            }
            menu.Items.Add(new MenuFlyoutSeparator());
            menu.Items.Add(Item("Show downloads", () => app.Go(Route.Downloads)));
            menu.ShowAt(button, new FlyoutShowOptions { Placement = FlyoutPlacementMode.BottomEdgeAlignedRight });
        }
        button.RightTapped += (_, e) => { e.Handled = true; Open(); };
        button.Holding += (_, e) =>
        {
            if (e.HoldingState != Microsoft.UI.Input.HoldingState.Started) return;
            e.Handled = true;
            Open();
        };
        return button;
    }

    internal static MenuFlyoutItem Item(string title, Action run, bool enabled = true)
    {
        var item = new MenuFlyoutItem { Text = title, IsEnabled = enabled };
        item.Click += (_, _) => run();
        return item;
    }
}

/// Open tabs as chips. The one playing shows its equaliser.
public sealed class TabStrip : Component
{
    private readonly AppModel _app;
    private readonly bool _showsNewTab;

    public TabStrip(AppModel app, bool showsNewTab = true)
    {
        _app = app;
        _showsNewTab = showsNewTab;
    }

    protected override UIElement Render()
    {
        var row = Ui.HStack(4);
        var listed = _app.Browser.ListedTabs;
        for (var index = 0; index < listed.Count; index++) row.Children.Add(Chip(listed[index], index));
        if (_showsNewTab) row.Children.Add(Buttons.Icon(Glyph.Add, "New tab (Ctrl+T)", () => _app.OpenCommandBar(), size: 11));
        return Ui.Scroll(row, horizontal: true);
    }

    private FrameworkElement Chip(BrowserTab tab, int index)
    {
        var p = Theme.P;
        var browser = _app.Browser;
        var isSelected = _app.Route == Route.Web && browser.SelectedId == tab.Id && browser.Search is null;
        UIElement icon = tab.Media?.IsPlaying == true
            ? new PlayingIndicator().Size(width: 14)
            : Posters.SiteIcon(tab.DisplayTitle, tab.FaviconUrl, 13).Opacity(tab.IsHibernated ? 0.55 : 1);
        var name = Ui.Line(tab.Parsed?.Name ?? tab.DisplayTitle, Typeface.Ui(12, isSelected ? Typeface.Medium : null), isSelected ? p.Ink : p.Ink2);
        name.MaxWidth = 150;
        var close = Buttons.Make(
            new Border { Width = 14, Height = 14, Child = Ui.Icon(Glyph.Close, 8, p.Ink3).Centered() },
            () => browser.Close(tab), help: "Close tab");
        close.Opacity = isSelected ? 1 : 0;
        var content = Ui.HStack(7, icon, name, close);
        Button? chip = null;
        chip = Buttons.Make(content, () => { browser.Select(tab); _app.Go(Route.Web); }, (b, hovered, _) =>
        {
            b.Background = new SolidColorBrush(isSelected ? p.Raised2 : hovered ? p.Raised : Microsoft.UI.Colors.Transparent);
            close.Opacity = hovered || isSelected ? 1 : 0;
        }, help: tab.Url?.OriginalString);
        chip.Padding = new Thickness(9, 0, 5, 0);
        chip.Height = 28;
        chip.CornerRadius = new CornerRadius(8);
        chip.ContextFlyout = Menu(tab);

        // Drag a chip onto another to move it there.
        chip.CanDrag = true;
        chip.AllowDrop = true;
        chip.DragStarting += (_, e) => e.Data.SetText($"cineon-tab:{index}");
        chip.DragOver += (_, e) => e.AcceptedOperation = Windows.ApplicationModel.DataTransfer.DataPackageOperation.Move;
        chip.Drop += async (_, e) =>
        {
            try
            {
                if (!e.DataView.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Text)) return;
                var text = await e.DataView.GetTextAsync();
                if (!text.StartsWith("cineon-tab:", StringComparison.Ordinal) || !int.TryParse(text[11..], out var from)) return;
                browser.Move(from, index > from ? index + 1 : index);
            }
            catch (Exception error)
            {
                CrashLog.Write("tab drop", error);
            }
        };
        return chip;
    }

    private MenuFlyout Menu(BrowserTab tab)
    {
        var menu = new MenuFlyout();
        menu.Items.Add(DownloadMenu.Item("Reload", tab.Reload));
        menu.Items.Add(DownloadMenu.Item("Close", () => _app.Browser.Close(tab)));
        return menu;
    }
}

/// Small equaliser bars, shown on the tab whose film is running.
public sealed class PlayingIndicator : Grid
{
    private readonly Rectangle[] _bars = new Rectangle[3];
    private DispatcherQueueTimer? _timer;

    public PlayingIndicator()
    {
        Height = 12;
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 1.5, VerticalAlignment = VerticalAlignment.Bottom, HorizontalAlignment = HorizontalAlignment.Center };
        for (var i = 0; i < 3; i++)
        {
            _bars[i] = new Rectangle { Width = 2, Height = 7, RadiusX = 1, RadiusY = 1, Fill = new SolidColorBrush(Theme.P.Ink), VerticalAlignment = VerticalAlignment.Bottom };
            row.Children.Add(_bars[i]);
        }
        Children.Add(row);
        this.Label("Playing");
        Loaded += (_, _) =>
        {
            if (!new Windows.UI.ViewManagement.UISettings().AnimationsEnabled || DispatcherQueue is null) return;
            _timer = DispatcherQueue.CreateTimer();
            _timer.Interval = TimeSpan.FromSeconds(0.18);
            _timer.Tick += (_, _) => Step();
            _timer.Start();
            Step();
        };
        Unloaded += (_, _) => _timer?.Stop();
    }

    private void Step()
    {
        var t = DateTimeOffset.Now.ToUnixTimeMilliseconds() / 1000.0;
        for (var i = 0; i < 3; i++) _bars[i].Height = 4 + 7 * Math.Abs(Math.Sin(t * 2.3 + i * 1.4));
    }
}

/// The address of the page, the shield and add-to-backlog. A click opens the command bar on it.
/// The Mac's AddressPill from Sidebar.swift.
public sealed class AddressPill : Component
{
    private readonly AppModel _app;

    public AddressPill(AppModel app)
    {
        _app = app;
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var tab = _app.Route == Route.Web ? _app.Browser.Selected : null;
        var url = tab?.Url;
        var host = url is null ? null : WatchTracker.Host(url) is { } h ? (h.StartsWith("www.", StringComparison.Ordinal) ? h[4..] : h) : null;
        // The rest of the address, quieter than the site's name.
        var path = url is { IsAbsoluteUri: true } && url.AbsolutePath != "/" ? url.AbsolutePath + (url.Query.Length > 1 ? url.Query : "") : "";
        var font = Typeface.Ui(12.5);
        Grid text;
        if (host is not null)
        {
            var pathText = Ui.Line(Uri.UnescapeDataString(path), font, p.Ink3);
            text = Ui.Row(0, Ui.Line(host, font, p.Ink), pathText.Fill());
        }
        else
        {
            text = Ui.Row(0, Ui.Icon(Glyph.Search, 11, p.Ink3).Margin(0, 0, 8, 0), Ui.Line("Search or enter address", font, p.Ink3).Fill());
        }
        text.Height = 30;
        text.Padding(tab is null ? 12 : 4, 0, 0, 0);
        var open = Buttons.Make(text, () => _app.OpenCommandBar(url?.OriginalString ?? ""),
            help: url?.OriginalString ?? "Search or enter address (Ctrl+L)");
        open.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        open.HorizontalAlignment = HorizontalAlignment.Stretch;
        var row = Ui.Row(0,
            tab is null ? null : new ShieldButton(_app, tab).Margin(3, 0, 0, 0),
            open.Fill(),
            tab is null ? null : Buttons.Icon(Glyph.Add, "Add to backlog (Ctrl+D)", _app.AddCurrentPageToBacklog, size: 11).Margin(0, 0, 2, 0));
        return row.Capsule(p.Raised, p.Line);
    }
}

/// The shield in the address, with the page's blocked count, and its panel of per-site switches.
/// Counts change with every blocked request, so they're updated in place.
public sealed class ShieldButton : Grid
{
    private readonly AppModel _app;
    private readonly BrowserTab _tab;
    private readonly TextBlock _count;
    private readonly FontIcon _icon;
    private readonly Action _update;

    public ShieldButton(AppModel app, BrowserTab tab)
    {
        _app = app;
        _tab = tab;
        var p = Theme.P;
        _icon = Ui.Icon(Glyph.Shield, 11, p.Ink2);
        _count = Ui.Line("", Typeface.Time(10.5, Typeface.Medium), p.Ink2);
        var button = Buttons.Hover(Ui.HStack(3, _icon, _count), () => { }, radius: 7, padding: new Thickness(5), help: "Shields");
        button.Flyout = new Flyout
        {
            Content = new ShieldPanel(app, tab),
            Placement = FlyoutPlacementMode.Bottom,
            FlyoutPresenterStyle = Popovers.PresenterStyle(),
        };
        Children.Add(button);
        _update = Update;
        var shields = app.Session.Shields;
        Loaded += (_, _) =>
        {
            tab.BlockedSignal.Changed += _update;
            shields.Changed += _update;
            Update();
        };
        Unloaded += (_, _) =>
        {
            tab.BlockedSignal.Changed -= _update;
            shields.Changed -= _update;
        };
        Update();
    }

    private void Update()
    {
        var host = _tab.Url is { } url ? WatchTracker.Host(url) : null;
        var isOff = _app.Session.Shields.ShieldsOff(host);
        var total = _tab.Blocked.Total;
        _icon.Glyph = isOff ? "" : Glyph.Shield;
        _count.Text = total > 0 && !isOff ? total.ToString(System.Globalization.CultureInfo.InvariantCulture) : "";
        _count.Visibility = _count.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        this.Label($"Shields, {total} blocked");
    }
}

/// The shield's panel: what was blocked on this page, and the switches for this site.
public sealed class ShieldPanel : Grid
{
    private readonly AppModel _app;
    private readonly BrowserTab _tab;
    private readonly TextBlock[] _counts = new TextBlock[4];
    private readonly Action _update;

    public ShieldPanel(AppModel app, BrowserTab tab)
    {
        _app = app;
        _tab = tab;
        var p = Theme.P;
        var host = tab.Url is { } url ? WatchTracker.Host(url) : null;
        var prefs = app.Session.Shields.PrefsFor(host);
        var rows = Ui.VStack(6);
        var labels = new[] { "Ads and trackers", "Pop-ups", "Redirects", "Click traps" };
        for (var i = 0; i < 4; i++)
        {
            _counts[i] = Ui.Line("0", Typeface.Time(12.5, Typeface.Medium), p.Ink);
            rows.Children.Add(Ui.Row(8, Ui.Line(labels[i], Typeface.Ui(12.5), p.Ink2), Ui.Spacer(), _counts[i]));
        }
        var content = Ui.VStack(10,
            Ui.Line(host is null ? "This page" : DomainName.Registrable(host), Typeface.Title(16), p.Ink),
            rows,
            Ui.Divider(),
            Switch("Turn shields off for this site", prefs.ShieldsOff, on =>
            {
                app.Session.Shields.Update(host, shieldsOff: on);
                tab.Reload();
            }),
            Switch("Allow pop-ups", prefs.AllowPopups, on => app.Session.Shields.Update(host, allowPopups: on)),
            Switch("Allow redirects", prefs.AllowRedirects, on => app.Session.Shields.Update(host, allowRedirects: on)),
            Switch("Don't track films on this site", prefs.TrackingOff, on => app.Session.Shields.Update(host, trackingOff: on)));
        content.Padding = new Thickness(14);
        content.Width = 260;
        Children.Add(content);
        _update = Update;
        Loaded += (_, _) => { tab.BlockedSignal.Changed += _update; Update(); };
        Unloaded += (_, _) => tab.BlockedSignal.Changed -= _update;
        Update();
    }

    private void Update()
    {
        var blocked = _tab.Blocked;
        int[] values = [blocked.Ads, blocked.Popups, blocked.Redirects, blocked.Overlays];
        for (var i = 0; i < 4; i++) _counts[i].Text = values[i].ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static FrameworkElement Switch(string label, bool on, Action<bool> changed)
    {
        var toggle = new ToggleSwitch { IsOn = on, OnContent = "", OffContent = "", MinWidth = 0, HorizontalAlignment = HorizontalAlignment.Right };
        toggle.Toggled += (_, _) => changed(toggle.IsOn);
        return Ui.Row(8, Ui.Text(label, Typeface.Ui(12.5), Theme.P.Ink).Fill(), toggle);
    }
}

/// How floating panels look, the Mac's popovers: the card colour, no extra padding.
public static class Popovers
{
    public static Style PresenterStyle()
    {
        var p = Theme.P;
        var style = new Style(typeof(FlyoutPresenter));
        style.Setters.Add(new Setter(Control.PaddingProperty, new Thickness(0)));
        style.Setters.Add(new Setter(Control.BackgroundProperty, new SolidColorBrush(Palette.WithOpacity(p.CardFill, 0.97))));
        style.Setters.Add(new Setter(Control.BorderBrushProperty, new SolidColorBrush(p.Line)));
        style.Setters.Add(new Setter(Control.CornerRadiusProperty, new CornerRadius(12)));
        style.Setters.Add(new Setter(FrameworkElement.MaxWidthProperty, 480.0));
        style.Setters.Add(new Setter(ScrollViewer.VerticalScrollBarVisibilityProperty, ScrollBarVisibility.Disabled));
        return style;
    }
}
