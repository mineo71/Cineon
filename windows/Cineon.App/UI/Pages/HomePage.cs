using Cineon.Core.Data;
using Cineon.Core.Import;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cineon.App.UI;

/// Home: the film you were in the middle of, set like an opening title, under the top bar, then
/// shelves of new episodes, what else you're watching, the backlog and what you've watched.
/// Ported from Cineon/UI/HomeView.swift.
public sealed class HomePage : Component
{
    private readonly AppModel _app;
    private readonly StackPanel _stack = new() { Spacing = 34 };
    private readonly ScrollViewer _scroll;

    public HomePage(AppModel app)
    {
        _app = app;
        var watch = new LibraryWatch(app, alerts: true);
        Watch(watch.Subscribe, watch.Unsubscribe);
        // One scroller for the page's life, so a rebuild (a progress save, say) keeps your place.
        _scroll = new ScrollViewer
        {
            Content = _stack,
            HorizontalScrollMode = ScrollMode.Disabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            VerticalScrollMode = ScrollMode.Enabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Hidden,
        };
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var library = _app.Library;
        var resuming = library.ContinueWatching;
        _scroll.Background = new SolidColorBrush(p.CardFill);
        _stack.Children.Clear();
        _stack.Children.Add(resuming.Count > 0 ? HomeHero(resuming[0].Title, resuming[0].Progress) : WelcomeHero());

        var shelves = new StackPanel { Spacing = 34, Padding = new Thickness(32, 0, 32, 40) };
        var fresh = _app.Session.Alerts.Fresh;
        if (fresh.Count > 0)
        {
            var badges = fresh.ToDictionary(
                entry => entry.Title.Id,
                entry => entry.Alert.NewCount == 1 ? (entry.Alert.Newest?.ShortLabel ?? "New") : $"{entry.Alert.NewCount} new");
            shelves.Children.Add(PosterShelf.Make(_app, "New episodes", [.. fresh.Select(entry => entry.Title)], badges: badges));
        }
        if (resuming.Count > 1)
        {
            shelves.Children.Add(PosterShelf.Make(_app, "Continue watching", [.. resuming.Skip(1).Select(entry => entry.Title)], showProgress: true));
        }
        if (library.Backlog is { Count: > 0 } backlog)
        {
            shelves.Children.Add(PosterShelf.Make(_app, "Backlog", [.. backlog.Take(14)], destination: Route.Library));
        }
        if (library.Watched is { Count: > 0 } watched)
        {
            shelves.Children.Add(PosterShelf.Make(_app, "Watched", [.. watched.Take(14)], destination: Route.Library));
        }
        _stack.Children.Add(shelves);
        return _scroll;
    }

    /// The film you were in the middle of, set like an opening title.
    private FrameworkElement HomeHero(Title title, WatchProgress progress)
    {
        var p = Theme.P;
        var app = _app;
        var host = DomainName.Registrable(progress.Host);

        var parts = new List<string>();
        if (progress.Ref.IsEpisode) parts.Add(progress.Ref.LongLabel);
        parts.Add(progress.IsVisitOnly
            ? $"Last opened on {host} {RelativeDate.Text(progress.UpdatedAt)}"
            : $"{Timecode.Spoken(progress.Remaining)} left on {host}");

        var picture = title.BackdropUrl ?? FrameFiles.Best(app.Library, title.Id) ?? title.PosterUrl;
        var image = new RemoteImage(picture, new Border { Background = new SolidColorBrush(p.Raised) }, fill: true, maxPixel: 1800)
        {
            Height = 440,
            VerticalAlignment = VerticalAlignment.Bottom,
        };
        var shade = new Border
        {
            Height = 440,
            VerticalAlignment = VerticalAlignment.Bottom,
            IsHitTestVisible = false,
            Background = new LinearGradientBrush
            {
                StartPoint = new Windows.Foundation.Point(0.5, 0),
                EndPoint = new Windows.Foundation.Point(0.5, 1),
                GradientStops =
                {
                    new GradientStop { Color = Palette.WithOpacity(p.CardFill, 0), Offset = 0.3 },
                    new GradientStop { Color = Palette.WithOpacity(p.CardFill, 0.75), Offset = 0.72 },
                    new GradientStop { Color = p.CardFill, Offset = 1 },
                },
            },
        };

        var text = Ui.VStack(10,
            Ui.Text(title.Name, Typeface.Title(52), p.Ink, maxLines: 2).ShrinkToFit(0.6),
            Ui.Text(string.Join(". ", parts), Typeface.Ui(14), p.Ink2),
            progress.IsVisitOnly ? null : Progress.Line(progress.Fraction, 3).Size(width: 280).Leading().Margin(0, 4, 0, 4),
            Ui.HStack(10,
                PageButtons.Silver(
                    progress.IsVisitOnly ? $"Open on {host}" : $"Resume at {Timecode.String(progress.Position)}",
                    Glyph.Play, () => app.Resume(title), large: true),
                PageButtons.Outline("Details", null, () => app.DetailTitleId = title.Id, large: true))
            .Margin(0, 4, 0, 0));
        text.Padding = new Thickness(32, 0, 32, 8);
        text.VerticalAlignment = VerticalAlignment.Bottom;

        return Ui.ZStack(image, shade, text);
    }

    /// First run, or nothing in progress: go straight to choosing something.
    private FrameworkElement WelcomeHero()
    {
        var p = Theme.P;
        var app = _app;
        var logo = Images.LogoMark(96);
        logo.HorizontalAlignment = HorizontalAlignment.Center;

        var searchRow = Ui.Row(10,
            Ui.Icon(Glyph.Search, 14, p.Ink2),
            Ui.Line("Search your sites, or add a film to the backlog", Typeface.Ui(14), p.Ink2),
            Ui.Spacer(),
            // The Mac says ⌘T.
            Ui.Line("Ctrl+T", Typeface.Ui(12), p.Ink3));
        searchRow.Padding = new Thickness(16, 0, 16, 0);
        var searchBox = new Border
        {
            Child = searchRow,
            Width = 460,
            Height = 44,
            CornerRadius = new CornerRadius(12),
            Background = new SolidColorBrush(p.Raised),
        };
        var search = Buttons.Make(searchBox, () => app.OpenCommandBar(), help: "Search your sites, or add a film to the backlog");
        search.HorizontalAlignment = HorizontalAlignment.Center;

        var stack = Ui.VStack(22,
            logo,
            Ui.Line("What are we watching?", Typeface.Title(38), p.Ink).Centered(),
            search,
            SitesRow().Margin(0, 10, 0, 0));
        if (app.Library.Titles.Count == 0)
        {
            var import = PageButtons.Outline("Import from Arc, Chrome or another browser", null, () => app.Sheet = new AppSheet.ImportBrowser());
            import.HorizontalAlignment = HorizontalAlignment.Center;
            import.Margin = new Thickness(0, 6, 0, 0);
            stack.Children.Add(import);
        }
        stack.HorizontalAlignment = HorizontalAlignment.Stretch;
        stack.Padding = new Thickness(0, 90, 0, 10);
        return stack;
    }

    private FrameworkElement SitesRow()
    {
        var p = Theme.P;
        var app = _app;
        var row = Ui.HStack(14);
        foreach (var site in app.Library.Sites.Take(6))
        {
            var icon = new Border
            {
                Width = 54, Height = 54, CornerRadius = new CornerRadius(13),
                Background = new SolidColorBrush(p.Raised),
                Child = Posters.SiteIcon(site.Name, site.IconUrl, 28).Centered(),
            };
            row.Children.Add(SiteButton(icon, site.Name, () => app.OpenSite(site)));
        }
        var add = new Border
        {
            Width = 54, Height = 54, CornerRadius = new CornerRadius(13),
            BorderBrush = new SolidColorBrush(p.Line), BorderThickness = new Thickness(1),
            Child = Ui.Icon(Glyph.Add, 16, p.Ink2).Centered(),
        };
        row.Children.Add(SiteButton(add, "Add site", () => app.Sheet = new AppSheet.AddSite(null)));
        row.HorizontalAlignment = HorizontalAlignment.Center;
        return row;
    }

    private static Button SiteButton(FrameworkElement icon, string name, Action action)
    {
        var label = Ui.Line(name, Typeface.Ui(11.5), Theme.P.Ink2);
        label.TextAlignment = TextAlignment.Center;
        label.HorizontalAlignment = HorizontalAlignment.Center;
        icon.HorizontalAlignment = HorizontalAlignment.Center;
        var content = Ui.VStack(7, icon, label).Size(width: 78);
        return Buttons.Hover(content, action, radius: 12, padding: new Thickness(4, 8, 4, 6), help: name);
    }
}

/// A named row of posters that scrolls sideways (the Mac's PosterShelf).
internal static class PosterShelf
{
    public static FrameworkElement Make(AppModel app, string name, IReadOnlyList<Title> titles, bool showProgress = false,
        Route? destination = null, IReadOnlyDictionary<long, string>? badges = null)
    {
        var p = Theme.P;
        var title = Ui.Line(name, Typeface.Title(21), p.Ink);
        title.VerticalAlignment = VerticalAlignment.Bottom;
        Button? showAll = null;
        if (destination is { } route)
        {
            showAll = PageButtons.Plain("Show all", Typeface.Ui(12.5), p.Ink2, () => app.Go(route));
            // On the title's baseline.
            showAll.VerticalAlignment = VerticalAlignment.Bottom;
            showAll.Margin = new Thickness(0, 0, 0, 5);
        }
        var header = Ui.Row(0, title, Ui.Spacer(), showAll);

        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 14, Padding = new Thickness(32, 4, 32, 4) };
        foreach (var item in titles)
        {
            row.Children.Add(new PosterCell(app, item, 138, showProgress, badges?.GetValueOrDefault(item.Id)) { VerticalAlignment = VerticalAlignment.Top });
        }
        // Edge to edge, so posters scroll out under the page's margins the way they do with
        // `.scrollClipDisabled()`, and the hover lift isn't cut.
        var scroller = new ScrollViewer
        {
            Content = row,
            HorizontalScrollMode = ScrollMode.Enabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden,
            VerticalScrollMode = ScrollMode.Disabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Margin = new Thickness(-32, -4, -32, -4),
        };
        return Ui.VStack(12, header, scroller);
    }
}

/// A poster with its name under it, on Home's shelves (the Mac's PosterCell). It lifts a little under
/// the pointer, and right-click has the title's menu.
public sealed class PosterCell : PressableComponent
{
    private readonly AppModel _app;
    private readonly Title _title;
    private readonly double _width;
    private readonly bool _showProgress;
    private readonly string? _badge;
    private FrameworkElement? _lift;

    public PosterCell(AppModel app, Title title, double width = 150, bool showProgress = false, string? badge = null)
    {
        _app = app;
        _title = title;
        _width = width;
        _showProgress = showProgress;
        _badge = badge;
        this.Label(title.Name);
    }

    protected override void Activate() => _app.DetailTitleId = _title.Id;

    protected override MenuFlyout? ContextMenu() =>
        TitleMenu.Build(_app, _app.Library.Titles.GetValueOrDefault(_title.Id) ?? _title);

    protected override void OnHoverChanged(bool hovered)
    {
        if (_lift is not null) Motion.Scale(_lift, hovered ? 1.025 : 1, response: 0.3, damping: 0.75);
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var title = _title;
        var library = _app.Library;
        var progress = _showProgress || title.Status == TitleStatus.Watching ? library.LatestProgress(title.Id) : null;

        var poster = Ui.ZStack(Posters.Image(title, _width, keepsColour: _badge is not null, fallback: FrameFiles.Best(library, title.Id)));
        if (title.RatingHalves is { } halves) poster.Children.Add(Stars.Badge(halves).Align(HorizontalAlignment.Left, VerticalAlignment.Top).Margin(7));
        if (_badge is { } badge)
        {
            var note = new Border
            {
                Child = Ui.Line(badge, Typeface.Ui(11, Typeface.Semibold), p.OnSilver),
                Padding = new Thickness(7, 3, 7, 3),
                Background = p.Silver,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(7),
            };
            note.SizeChanged += (_, e) => note.CornerRadius = new CornerRadius(e.NewSize.Height / 2);
            poster.Children.Add(note);
        }
        poster.Width = _width;
        _lift = poster;
        Motion.Scale(poster, IsHovered ? 1.025 : 1, animated: false);

        string subtitle;
        if (progress is { Ref.IsEpisode: true }) subtitle = progress.Ref.ShortLabel;
        else if (title.Year is { } year) subtitle = year.ToString(System.Globalization.CultureInfo.InvariantCulture);
        else subtitle = title.Kind.Label;

        var stack = Ui.VStack(7,
            poster,
            progress is { IsVisitOnly: false } ? Progress.Line(progress.Fraction, 2).Size(width: _width) : null,
            Ui.Line(title.Name, Typeface.Ui(12.5, Typeface.Medium), p.Ink).Size(width: _width),
            Ui.Line(subtitle, Typeface.Ui(11.5), p.Ink3).Size(width: _width));
        stack.Width = _width;
        return new Grid { Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), Children = { stack } };
    }
}
