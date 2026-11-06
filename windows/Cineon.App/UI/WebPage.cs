using Cineon.App.Browser;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Shapes;

namespace Cineon.App.UI;

/// The page for `Route.Web`: what the Mac's MainCard draws over a site. The site itself is in the
/// workspace's web layer underneath; this layer only has the search deck, the loading sweep, a
/// failure or a rescue, the blank tab and the find bar. Its empty parts let clicks through.
/// Each piece is rebuilt only when what it shows changes, so typing in the find bar survives the
/// page loading underneath.
public sealed class WebOverlays : Grid
{
    public const double DeckHeight = 44;

    private readonly AppModel _app;
    private readonly BrowserModel _browser;
    private readonly Slot _deck = new();
    private readonly Slot _sweep = new();
    private readonly Slot _trouble = new();
    private readonly Slot _blank = new();
    private readonly Slot _find = new();
    private readonly Action _update;

    public WebOverlays(AppModel app)
    {
        _app = app;
        _browser = app.Browser;
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _deck.Root.Cell(row: 0);
        var below = new Grid { Children = { _sweep.Root, _trouble.Root, _blank.Root, _find.Root } }.Cell(row: 1);
        _sweep.Root.VerticalAlignment = VerticalAlignment.Top;
        Children.Add(_deck.Root);
        Children.Add(below);
        _update = Update;
        Loaded += (_, _) =>
        {
            app.Changed += _update;
            _browser.Changed += _update;
            _browser.TabChanged += _update;
            Theme.Changed += Rebuild;
            Update();
        };
        Unloaded += (_, _) =>
        {
            app.Changed -= _update;
            _browser.Changed -= _update;
            _browser.TabChanged -= _update;
            Theme.Changed -= Rebuild;
        };
    }

    private void Rebuild()
    {
        foreach (var slot in new[] { _deck, _sweep, _trouble, _blank, _find }) slot.Show(null, null);
        Update();
    }

    private void Update()
    {
        var tab = _browser.Selected;
        var search = _browser.Search;
        _deck.Show(search is null ? null : (search, search.SelectedResultId), () => new SearchDeckBar(_app, search!));
        _sweep.Show(tab, () => new LoadingSweep(tab!));

        if (tab?.Failure is { } failure)
        {
            _trouble.Show((tab, failure, tab.Rescue), () => new LoadFailureView(_app, failure, tab));
        }
        else if (tab?.Rescue is { } rescue)
        {
            _trouble.Show((tab, rescue), () =>
            {
                var panel = new RescuePanel(_app, rescue, tab);
                panel.Margin = new Thickness(14);
                panel.HorizontalAlignment = HorizontalAlignment.Right;
                panel.VerticalAlignment = VerticalAlignment.Top;
                return panel;
            });
        }
        else
        {
            _trouble.Show(null, null);
        }

        _blank.Show(tab is null || tab.Url is null ? true : null, () => BlankTab(_app));
        _find.Show(_app.IsFindVisible && tab is not null ? tab : null, () => new FindBar(_app, tab!));
    }

    /// An empty tab: the logo and a way to go somewhere.
    private static UIElement BlankTab(AppModel app)
    {
        var p = Theme.P;
        var content = Ui.VStack(18,
            Images.LogoMark(64, p.Ink3).Centered(),
            Buttons.Outline("Search or enter an address", () => app.OpenCommandBar()).Centered());
        content.HorizontalAlignment = HorizontalAlignment.Center;
        content.VerticalAlignment = VerticalAlignment.Center;
        return new Grid { Background = new SolidColorBrush(p.CardFill), Children = { content } };
    }

    /// One piece of the overlay: built when its key changes, kept while the key stays.
    private sealed class Slot
    {
        private object? _key;
        public Grid Root { get; } = new() { Visibility = Visibility.Collapsed };

        public void Show(object? key, Func<UIElement>? build)
        {
            if (key is null || build is null)
            {
                if (_key is null) return;
                _key = null;
                Root.Children.Clear();
                Root.Visibility = Visibility.Collapsed;
                return;
            }
            if (Equals(key, _key)) return;
            _key = key;
            Root.Children.Clear();
            Root.Children.Add(build());
            Root.Visibility = Visibility.Visible;
        }
    }
}

/// The thin line across the top while a page loads.
public sealed class LoadingSweep : Grid
{
    private readonly BrowserTab _tab;
    private readonly Rectangle _line;
    private readonly ScaleTransform _scale = new() { ScaleX = 0.04 };
    private readonly Action _update;

    public LoadingSweep(BrowserTab tab)
    {
        _tab = tab;
        Height = 2;
        VerticalAlignment = VerticalAlignment.Top;
        IsHitTestVisible = false;
        _line = new Rectangle
        {
            Fill = new SolidColorBrush(Theme.P.IsDark ? Microsoft.UI.Colors.White : Microsoft.UI.Colors.Black),
            Height = 2,
            RenderTransform = _scale,
            RenderTransformOrigin = new Windows.Foundation.Point(0, 0.5),
            Opacity = 0,
        };
        Children.Add(_line);
        _update = Update;
        Loaded += (_, _) => { tab.ProgressSignal.Changed += _update; Update(); };
        Unloaded += (_, _) => tab.ProgressSignal.Changed -= _update;
    }

    private void Update()
    {
        var story = new Storyboard();
        var grow = new DoubleAnimation
        {
            To = Math.Max(0.04, _tab.Progress),
            Duration = new Duration(TimeSpan.FromSeconds(0.25)),
            EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(grow, _scale);
        Storyboard.SetTargetProperty(grow, "ScaleX");
        var fade = new DoubleAnimation
        {
            To = _tab.IsLoading ? 0.85 : 0,
            Duration = new Duration(TimeSpan.FromSeconds(0.3)),
            EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(fade, _line);
        Storyboard.SetTargetProperty(fade, "Opacity");
        story.Children.Add(grow);
        story.Children.Add(fade);
        story.Begin();
    }
}

/// Covers a page that didn't load, with what went wrong and what to do about it.
public sealed class LoadFailureView : Component
{
    private readonly AppModel _app;
    private readonly LoadFailure _failure;
    private readonly BrowserTab _tab;

    public LoadFailureView(AppModel app, LoadFailure failure, BrowserTab tab)
    {
        _app = app;
        _failure = failure;
        _tab = tab;
        if (tab.Rescue is { } rescue) Watch(rescue);
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var message = Ui.Text(_failure.Message, Typeface.Ui(14), p.Ink2);
        message.MaxWidth = 440;
        message.HorizontalAlignment = HorizontalAlignment.Left;
        var content = Ui.VStack(14, Ui.Text($"{_failure.Host} didn't load", Typeface.Title(30), p.Ink), message);
        if (_tab.Rescue is { } rescue)
        {
            var body = RescueSearchBody.Build(_app, rescue, _tab);
            body.MaxWidth = 520;
            body.HorizontalAlignment = HorizontalAlignment.Left;
            body.Margin = new Thickness(0, 6, 0, 0);
            content.Children.Add(body);
        }
        else
        {
            var engine = _app.Session.Rescue;
            var actions = Ui.HStack(10,
                engine.CanSearch(_tab, _failure.Url) ? Buttons.Silver("Find it on my other sites", () => engine.TryFailedPageSearch(_tab, _failure.Url)) : null,
                Buttons.Outline("Try again", _tab.Reload));
            actions.Margin = new Thickness(0, 6, 0, 0);
            content.Children.Add(actions);
        }
        content.Padding = new Thickness(40);
        content.VerticalAlignment = VerticalAlignment.Center;
        content.HorizontalAlignment = HorizontalAlignment.Left;
        return new Grid { Background = new SolidColorBrush(p.CardFill), Children = { content } };
    }
}

/// Find in page, floating at the top right.
public sealed class FindBar : Grid
{
    private readonly AppModel _app;
    private readonly BrowserTab _tab;
    private readonly TextBox _field;
    private readonly TextBlock _notFound;

    public FindBar(AppModel app, BrowserTab tab)
    {
        _app = app;
        _tab = tab;
        var p = Theme.P;
        _field = new TextBox
        {
            PlaceholderText = "Find in page",
            Width = 180,
            FontFamily = Typeface.Ui(13).Family,
            FontSize = 13,
            BorderThickness = new Thickness(0),
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            Padding = new Thickness(0, 4, 0, 4),
            MinHeight = 0,
        };
        _field.KeyDown += (_, e) =>
        {
            if (e.Key != Windows.System.VirtualKey.Enter) return;
            e.Handled = true;
            Find(backwards: Shortcuts.Modifiers().Shift);
        };
        _notFound = Ui.Line("Not found", Typeface.Ui(12), p.Ink3);
        _notFound.Visibility = Visibility.Collapsed;
        var row = Ui.HStack(8,
            Ui.Icon(Glyph.Search, 12, p.Ink3),
            _field,
            _notFound,
            Buttons.Icon(Glyph.ChevronUp, "Previous match", () => Find(backwards: true), size: 11),
            Buttons.Icon(Glyph.ChevronDown, "Next match", () => Find(backwards: false), size: 11),
            Buttons.Icon(Glyph.Close, "Close", () => app.IsFindVisible = false, size: 11));
        row.Padding = new Thickness(12, 6, 12, 6);
        var panel = row.GlassPanel(14);
        panel.Margin = new Thickness(12);
        panel.HorizontalAlignment = HorizontalAlignment.Right;
        panel.VerticalAlignment = VerticalAlignment.Top;
        Children.Add(panel);
        Loaded += (_, _) => _field.Focus(FocusState.Programmatic);
        Unloaded += (_, _) => _tab.StopFind();
    }

    private void Find(bool backwards)
    {
        var text = _field.Text;
        if (text.Length == 0) return;
        Safe.Fire("find", async () =>
        {
            var found = await _tab.FindAsync(text, backwards);
            _notFound.Visibility = found ? Visibility.Collapsed : Visibility.Visible;
        });
    }
}

/// The query running on every site, a button per site, and keeping the one you want.
public sealed class SearchDeckBar : Component
{
    private readonly AppModel _app;
    private readonly SearchSession _search;

    public SearchDeckBar(AppModel app, SearchSession search)
    {
        _app = app;
        _search = search;
        Watch(search);
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var results = Ui.HStack(2);
        foreach (var result in _search.Results)
        {
            var selected = _search.SelectedResultId == result.Id;
            results.Children.Add(Buttons.Hover(
                Ui.HStack(6,
                    Posters.SiteIcon(result.Site.Name, result.Site.IconUrl, 14),
                    Ui.Line(result.Site.Name, Typeface.Ui(12, Typeface.Medium), selected ? p.Ink : p.Ink2)),
                () => _search.Select(result.Id), selected: selected));
        }
        var query = Ui.Line(_search.Query, Typeface.Title(15), p.Ink);
        query.Margin = new Thickness(0, 0, 8, 0);
        query.MaxWidth = 260;
        var row = Ui.Row(6,
            query,
            Ui.Scroll(results, horizontal: true).Fill(),
            Buttons.Outline("Keep tab", () => { if (_search.SelectedTab is { } tab) _app.Browser.EndSearch(tab); }),
            Buttons.Icon(Glyph.Close, "Close search", () =>
            {
                _app.Browser.EndSearch(null);
                _app.Go(Route.Home);
            }));
        row.Padding = new Thickness(12, 0, 12, 0);
        var hairline = new Rectangle { Height = 0.5, Fill = new SolidColorBrush(p.Line), VerticalAlignment = VerticalAlignment.Bottom };
        return new Grid { Height = WebOverlays.DeckHeight, Background = new SolidColorBrush(p.CardFill), Children = { row, hairline } };
    }
}
