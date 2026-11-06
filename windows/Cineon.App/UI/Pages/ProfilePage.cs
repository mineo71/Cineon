using System.Globalization;
using Cineon.Core.Data;
using Cineon.Core.Profile;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace Cineon.App.UI;

/// Who you are as a watcher: your pet, what you watch, how you watch it. ProfileView.swift.
public sealed class ProfilePage : UserControl
{
    public ProfilePage(AppModel app)
    {
        IsTabStop = false;
        var body = new ProfileBody(app);
        Content = new PageScroll(body, 1180, new Thickness(44, 34, 44, 60), centred: true, padInside: true);
    }
}

/// Everything on the page, rebuilt when the numbers or the pet change (the session caches the stats,
/// so the same library gives the same object and nothing is redrawn).
internal sealed class ProfileBody : KeyedComponent
{
    private readonly AppModel _app;

    public ProfileBody(AppModel app)
    {
        _app = app;
        WatchKeyed(Changes.Of(app.Library));
        WatchKeyed(Changes.Of(app));
    }

    protected override object? Key()
    {
        var session = _app.Session;
        // By reference: ProfileStats' own Equals looks at a few totals only, and a changed rating keeps them.
        return (new Identity(session.Stats), session.Pet, session.Profile.Name);
    }

    protected override UIElement Render()
    {
        Rendered();
        var stats = _app.Session.Stats;
        var pet = _app.Session.Pet;
        var charts = new Grid
        {
            ColumnSpacing = 40,
            ColumnDefinitions =
            {
                new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) },
                new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) },
            },
        };
        var genres = ProfileCharts.GenreBars(stats.Genres);
        genres.VerticalAlignment = VerticalAlignment.Top;
        var right = Ui.VStack(36, ProfileCharts.RatingHistogram(stats.RatingCounts), ProfileCharts.DecadeBars(stats.Decades));
        right.VerticalAlignment = VerticalAlignment.Top;
        charts.Children.Add(genres);
        charts.Children.Add(right.Cell(column: 1));
        return Ui.VStack(44,
            Hero(stats, pet),
            StatTiles(stats),
            charts,
            ProfileCharts.Heatmap(stats),
            stats.TopTitles.Count > 0 ? TopTitles(stats.TopTitles) : null,
            Extras(stats));
    }

    // MARK: Hero

    /// Your pet in a spotlight, and who you are next to it.
    private FrameworkElement Hero(ProfileStats stats, PixelPet pet)
    {
        var p = Theme.P;
        var spot = Palette.WithOpacity(p.Ink, p.IsDark ? 0.16 : 0.08);
        var glow = new Border
        {
            Background = new RadialGradientBrush
            {
                MappingMode = BrushMappingMode.Absolute,
                Center = new Windows.Foundation.Point(120, 115),
                GradientOrigin = new Windows.Foundation.Point(120, 115),
                RadiusX = 130,
                RadiusY = 130,
                GradientStops =
                {
                    new GradientStop { Color = spot, Offset = 0 },
                    new GradientStop { Color = spot, Offset = 4.0 / 130 },
                    new GradientStop { Color = Palette.WithOpacity(spot, 0), Offset = 1 },
                },
            },
        };
        // The Mac's 120 × 16 ellipse blurred by 6: a soft pool of shade under the pet.
        var shade = Palette.WithOpacity(p.Ink, 0.075);
        var floor = new Ellipse
        {
            Width = 156,
            Height = 44,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            RenderTransform = new TranslateTransform { Y = 84 },
            Fill = new RadialGradientBrush
            {
                GradientStops =
                {
                    new GradientStop { Color = shade, Offset = 0 },
                    new GradientStop { Color = Palette.WithOpacity(shade, 0.8), Offset = 0.45 },
                    new GradientStop { Color = Palette.WithOpacity(shade, 0), Offset = 1 },
                },
            },
        };
        var petView = new PixelPetView(pet, 168).Centered();
        var stage = new Grid { Width = 240, Height = 230, Children = { glow, floor, petView } };
        stage.Label($"{pet.Name}, your pet: a {pet.StageLabel.ToLowerInvariant()} {pet.SpeciesLabel.ToLowerInvariant()}, feeling {pet.MoodLabel.ToLowerInvariant()}");

        var mood = Ui.Line(pet.MoodLabel, Typeface.Ui(11, Typeface.Medium), p.Ink2).Padding(8, 2).Capsule(Microsoft.UI.Colors.Transparent, p.Line);
        var info = Ui.VStack(10,
            Ui.Text(_app.Session.Profile.Name, Typeface.Title(44), p.Ink),
            Ui.HStack(8,
                Ui.Line(pet.Name, Typeface.Bold(17), p.Ink),
                Ui.Line($"{pet.StageLabel} {pet.SpeciesLabel.ToLowerInvariant()}, level {pet.Level}", Typeface.Ui(14), p.Ink2),
                mood),
            Ui.Text(pet.Blurb, Typeface.Ui(14), p.Ink2).MaxSize(width: 460).Leading());
        if (stats.FavouriteGenre is { } genre)
        {
            var second = stats.Genres.Count > 1 ? $" and {stats.Genres[1].Name.ToLowerInvariant()}" : "";
            info.Children.Add(Ui.Text($"Raised on {genre.ToLowerInvariant()}{second}. Watch more and {pet.Name} grows up.", Typeface.Ui(12.5), p.Ink3));
        }
        var name = _app.Session.Profile.Name;
        info.Children.Add(Ui.HStack(10,
            Buttons.Silver("Save a share card", () => _ = ShareCard.ExportAsync(_app, stats, pet, name)).WithIcon(Glyph.Share),
            Buttons.Outline("Rate films", () => _app.Go(Route.Rate)).WithIcon(SocialKit.HalfStar))
            .Margin(0, 8, 0, 0));
        return Ui.Row(40, stage, info.Fill());
    }

    // MARK: Numbers

    private static FrameworkElement StatTiles(ProfileStats stats)
    {
        var p = Theme.P;
        var grid = new Grid();
        void Add(FrameworkElement element, bool tile)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = tile ? new GridLength(1, GridUnitType.Star) : GridLength.Auto });
            element.VerticalAlignment = VerticalAlignment.Top;
            grid.Children.Add(element.Cell(column: grid.ColumnDefinitions.Count - 1));
        }
        FrameworkElement Divider() => SocialKit.Hairline(vertical: true, length: 46).Margin(18, 0, 18, 0);

        string? hoursNote = stats.EstimatedHours > stats.TrackedHours + 1
            ? (stats.TrackedHours < 1 ? "worked out from the runtimes of what you finished" : $"{Hours(stats.TrackedHours)} timed by Cineon, the rest from runtimes")
            : null;
        Add(Tile(Hours(stats.EstimatedHours), "hours watched", hoursNote), true);
        Add(Divider(), false);
        Add(Tile($"{stats.FilmsWatched}", stats.FilmsWatched == 1 ? "film" : "films", stats.SeriesFinished > 0 ? $"and {stats.SeriesFinished} series finished" : null), true);
        Add(Divider(), false);
        Add(Tile($"{stats.EpisodesFinished}", stats.EpisodesFinished == 1 ? "episode" : "episodes", null), true);
        Add(Divider(), false);
        Add(Tile($"{stats.CurrentStreak}", stats.CurrentStreak == 1 ? "day in a row" : "days in a row", $"longest {stats.LongestStreak}"), true);
        Add(Divider(), false);

        // Gold only for ratings.
        var star = Ui.Icon(Glyph.StarFilled, 20);
        star.Foreground = p.Gold;
        star.VerticalAlignment = VerticalAlignment.Bottom;
        star.Margin = new Thickness(0, 0, 0, 3);
        var average = Ui.Line(stats.AverageRating is { } value ? value.ToString("0.0", CultureInfo.InvariantCulture) : "–", Typeface.Bold(34), p.Ink).OnBaseline();
        average.TextTrimming = TextTrimming.None;
        Add(Ui.VStack(4,
            Ui.HStack(6, star, average),
            Ui.Line($"average of {stats.Rated} rated", Typeface.Ui(12), p.Ink3)), true);

        grid.Padding = new Thickness(0, 18, 0, 18);
        var top = SocialKit.Hairline();
        top.VerticalAlignment = VerticalAlignment.Top;
        var bottom = SocialKit.Hairline();
        bottom.VerticalAlignment = VerticalAlignment.Bottom;
        return new Grid { Children = { grid, top, bottom } };
    }

    private static FrameworkElement Tile(string value, string label, string? note)
    {
        var p = Theme.P;
        var number = Ui.Line(value, Typeface.Bold(34), p.Ink);
        number.TextTrimming = TextTrimming.None;
        return Ui.VStack(4,
            number,
            Ui.Line(label, Typeface.Ui(12), p.Ink2),
            note is null ? null : Ui.Text(note, Typeface.Ui(10.5), p.Ink3, maxLines: 2));
    }

    /// Whole hours, rounded half away from zero like Swift's `.rounded()`.
    public static string Hours(double value) => Math.Round(value, MidpointRounding.AwayFromZero).ToString("0", CultureInfo.InvariantCulture);

    // MARK: Most watched and extras

    private FrameworkElement TopTitles(IReadOnlyList<ProfileStats.TopTitle> titles)
    {
        var p = Theme.P;
        var row = Ui.HStack(18);
        foreach (var item in titles)
        {
            var column = Ui.VStack(6);
            if (_app.Library.Titles.TryGetValue(item.Id, out var title)) column.Children.Add(Posters.Image(title, width: 120, keepsColour: true));
            column.Children.Add(Ui.Line(item.Name, Typeface.Ui(12.5, Typeface.Medium), p.Ink));
            var detail = item.Hours >= 0.5 ? Timecode.Spoken(item.Hours * 3600) : $"{item.Sessions} {(item.Sessions == 1 ? "visit" : "visits")}";
            column.Children.Add(Ui.Line(detail, Typeface.Ui(11.5), p.Ink3));
            column.Width = 120;
            column.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            var id = item.Id;
            var button = Buttons.Make(column, () => _app.OpenTitle(id));
            button.VerticalAlignment = VerticalAlignment.Top;
            row.Children.Add(button);
        }
        return Ui.VStack(14, ProfileCharts.SectionTitle("Most watched", null), row);
    }

    private FrameworkElement Extras(ProfileStats stats)
    {
        var p = Theme.P;
        FrameworkElement Extra(string glyph, string value, string label) => Ui.HStack(8,
            Ui.Icon(glyph, 13, p.Ink3),
            Ui.Line(value, Typeface.Time(13, Typeface.Semibold), p.Ink),
            Ui.Line(label, Typeface.Ui(12.5), p.Ink2));
        var row = Ui.Row(28,
            Extra(Glyph.Camera, $"{stats.Moments}", stats.Moments == 1 ? "moment saved" : "moments saved"),
            Extra(Glyph.Shield, stats.AdsBlocked.ToString("N0", CultureInfo.CurrentCulture), "ads kept off your films"),
            Extra(Glyph.Download, $"{stats.Downloads}", "on this PC"),
            Extra(SocialKit.Stack, $"{stats.Backlog}", "in your backlog"),
            Ui.Spacer(),
            CloudStatusLine.Make(_app));
        row.Margin = new Thickness(0, 6, 0, 0);
        return row;
    }
}

/// Whether ratings and lists are safe in the cloud (the Mac's CloudStatus), on the profile page and in
/// Settings.
internal static class CloudStatusLine
{
    public static FrameworkElement Make(AppModel app)
    {
        var cloud = app.Session.Cloud;
        return new KeyedView(
            () => (app.Settings.CloudBackup, cloud.LastError, cloud.LastSync),
            () => Render(app),
            Changes.Of(cloud), Changes.Of(app));
    }

    private static UIElement Render(AppModel app)
    {
        var p = Theme.P;
        var cloud = app.Session.Cloud;
        // TODO: Segoe has no cloud with a slash, a tick or a mark; the Mac's icloud.slash, checkmark.icloud
        // and exclamationmark.icloud all show the plain cloud here, except the error's warning sign.
        var (glyph, text) = !app.Settings.CloudBackup
            ? (SocialKit.Cloud, "Cloud backup is off")
            : cloud.LastError is { } error
                ? (Glyph.Warning, $"Backup waiting: {error}")
                : cloud.LastSync is { } last
                    ? (SocialKit.Cloud, $"Ratings backed up {SocialKit.Relative(last, named: true)}")
                    : (SocialKit.Cloud, "Backing up your ratings…");
        var row = Ui.HStack(6, Ui.Icon(glyph, 11.5, p.Ink3), Ui.Line(text, Typeface.Ui(11.5), p.Ink3));
        row.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        return row.Tooltip("Ratings and lists are kept in the cloud, so they come back if you clear the library or move to another PC.");
    }
}

/// The charts on the profile page, each one series so the title names it and no legend is needed.
internal static class ProfileCharts
{
    private static readonly string[] Days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    private static readonly string[] DayNames = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

    public static FrameworkElement SectionTitle(string text, string? detail)
    {
        var p = Theme.P;
        var title = Ui.Line(text, Typeface.Title(22), p.Ink).OnBaseline();
        title.TextTrimming = TextTrimming.None;
        if (detail is null) return Ui.HStack(10, title);
        return Ui.HStack(10, title, Ui.Line(detail, Typeface.Ui(12.5), p.Ink3).OnBaseline());
    }

    private static Grid Hoverable(Grid grid)
    {
        grid.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        return grid;
    }

    /// Share of your watching by genre.
    public static FrameworkElement GenreBars(IReadOnlyList<GenreWeight> genres)
    {
        var p = Theme.P;
        var stack = Ui.VStack(16, SectionTitle("Your taste", genres.Count > 0 ? $"mostly {genres[0].Name.ToLowerInvariant()}" : null));
        if (genres.Count == 0) stack.Children.Add(Ui.Text("Genres appear once Cineon has found your films' details.", Typeface.Ui(12.5), p.Ink3));
        var top = genres.Take(9).ToList();
        var most = top.Count > 0 && top[0].Weight > 0 ? top[0].Weight : 1;
        var rows = Ui.VStack(9);
        foreach (var genre in top)
        {
            var percent = (int)Math.Round(genre.Weight * 100, MidpointRounding.AwayFromZero);
            var name = Ui.Line(genre.Name, Typeface.Ui(12.5), p.Ink2);
            name.Width = 92;
            var bar = new Border
            {
                Height = 10,
                CornerRadius = new CornerRadius(0, 4, 4, 0),
                Background = genre.Name == top[0].Name ? p.Silver : new SolidColorBrush(Palette.WithOpacity(p.Ink, 0.32)),
                HorizontalAlignment = HorizontalAlignment.Left,
                Width = 3,
            };
            var track = new Grid { Height = 10, Children = { bar } };
            var weight = genre.Weight;
            track.SizeChanged += (_, e) => bar.Width = Math.Max(3, e.NewSize.Width * weight / most);
            var value = Ui.Line($"{percent}%", Typeface.Time(11.5), p.Ink3);
            value.Width = 34;
            value.TextAlignment = TextAlignment.Right;
            rows.Children.Add(Hoverable(Ui.Row(12, name, track.Fill(), value)).Tooltip($"{genre.Name}: {percent}% of your watching"));
        }
        stack.Children.Add(rows);
        return stack;
    }

    /// How your ratings spread from 1 to 10, in gold since these are your stars.
    public static FrameworkElement RatingHistogram(int[] counts)
    {
        var p = Theme.P;
        var total = counts.Sum();
        var most = Math.Max(1, counts.Max());
        var grid = new Grid { Height = 110, ColumnSpacing = 2 };
        for (var index = 0; index < 10; index++)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var count = counts[index];
            var bar = new Border
            {
                Height = count > 0 ? Math.Max(4, 86.0 * count / most) : 2,
                CornerRadius = new CornerRadius(4, 4, 0, 0),
                Background = count > 0 ? p.Gold : new SolidColorBrush(p.Raised2),
                VerticalAlignment = VerticalAlignment.Bottom,
            };
            grid.Children.Add(Column(bar, $"{index + 1}").Cell(column: index).Tooltip($"{count} rated {index + 1}"));
        }
        return Ui.VStack(14, SectionTitle("Your stars", total == 0 ? "nothing rated yet" : $"{total} rated"), grid);
    }

    public static FrameworkElement DecadeBars(IReadOnlyList<(int Decade, int Count)> decades)
    {
        var p = Theme.P;
        // Swift's max(by:) keeps the first of equals.
        (int Decade, int Count)? favourite = null;
        foreach (var item in decades) if (favourite is null || item.Count > favourite.Value.Count) favourite = item;
        var shown = decades.Skip(Math.Max(0, decades.Count - 9)).ToList();
        var most = Math.Max(1, shown.Select(d => d.Count).DefaultIfEmpty(1).Max());
        var grid = new Grid { Height = 86, ColumnSpacing = 2 };
        foreach (var item in shown)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var bar = new Border
            {
                Height = Math.Max(3, 64.0 * item.Count / most),
                CornerRadius = new CornerRadius(4, 4, 0, 0),
                Background = item.Decade == favourite?.Decade ? p.Silver : new SolidColorBrush(Palette.WithOpacity(p.Ink, 0.3)),
                VerticalAlignment = VerticalAlignment.Bottom,
            };
            var decade = item.Decade.ToString(CultureInfo.InvariantCulture);
            grid.Children.Add(Column(bar, decade).Cell(column: grid.ColumnDefinitions.Count - 1).Tooltip($"{item.Count} from the {decade}s"));
        }
        var detail = favourite is { } f ? $"the {f.Decade.ToString(CultureInfo.InvariantCulture)}s most" : null;
        return Ui.VStack(14, SectionTitle("Decades", detail), grid);
    }

    /// A bar standing on its label.
    private static Grid Column(FrameworkElement bar, string label)
    {
        var p = Theme.P;
        var text = Ui.Line(label, Typeface.Time(10.5), p.Ink3);
        text.HorizontalAlignment = HorizontalAlignment.Center;
        text.TextTrimming = TextTrimming.None;
        var column = new Grid
        {
            RowSpacing = 5,
            RowDefinitions = { new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }, new RowDefinition { Height = GridLength.Auto } },
            Children = { bar, text.Cell(row: 1) },
        };
        return Hoverable(column);
    }

    public static string HourLabel(int hour) => $"{hour:00}:00";

    /// When you watch: weekdays down, hours across, brighter for more sessions.
    public static FrameworkElement Heatmap(ProfileStats stats)
    {
        var p = Theme.P;
        string? detail = stats.BusiestWeekday is int day && stats.BusiestHour is int hour
            ? $"mostly {DayNames[day]}, around {HourLabel(hour)}"
            : null;
        var most = Math.Max(1, stats.Heatmap.SelectMany(row => row).DefaultIfEmpty(0).Max());
        var grid = new Grid { ColumnSpacing = 2, RowSpacing = 2 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(34) });
        for (var h = 0; h < 24; h++) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        for (var d = 0; d < 7; d++)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            grid.Children.Add(Ui.Line(Days[d], Typeface.Ui(11), p.Ink3).Align(vertical: VerticalAlignment.Center).Cell(row: d, column: 0));
            for (var h = 0; h < 24; h++)
            {
                var count = stats.Heatmap[d][h];
                var cell = new Border
                {
                    Height = 18,
                    CornerRadius = new CornerRadius(3),
                    Background = new SolidColorBrush(count == 0 ? p.Raised : Palette.WithOpacity(p.Ink, 0.14 + 0.78 * Math.Sqrt((double)count / most))),
                };
                grid.Children.Add(cell.Cell(row: d, column: h + 1).Tooltip($"{Days[d]} {HourLabel(h)}: {count} {(count == 1 ? "session" : "sessions")}"));
            }
        }
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        for (var h = 0; h < 24; h += 6)
        {
            var label = Ui.Line(HourLabel(h), Typeface.Time(9.5), p.Ink3);
            label.TextTrimming = TextTrimming.None;
            label.Margin = new Thickness(0, 4, 0, 0);
            // The Mac's fixedSize lets the label run past its hour, so it spans a few.
            grid.Children.Add(label.Cell(row: 7, column: h + 1, columnSpan: 6));
        }
        var stack = Ui.VStack(14, SectionTitle("When you watch", detail), grid);
        if (stats.Binge is { } binge)
        {
            stack.Children.Add(Ui.Text(BingeText(binge), Typeface.Ui(12.5), p.Ink2).Margin(0, 4, 0, 0));
        }
        return stack;
    }

    private static string BingeText(ProfileStats.BingeDay binge)
    {
        var day = DayMonthYear(binge.Day);
        if (binge.Seconds > 1800) return $"Your biggest day: {Timecode.Spoken(binge.Seconds)} on {day}.";
        return $"Your biggest day: {binge.Sessions} things opened on {day}.";
    }

    /// `.dateTime.day().month(.wide).year()`: the long date without the weekday, in the person's order.
    public static string DayMonthYear(DateOnly day)
    {
        var culture = CultureInfo.CurrentCulture;
        var pattern = culture.DateTimeFormat.LongDatePattern;
        pattern = System.Text.RegularExpressions.Regex.Replace(pattern, @"d{4}[,،]?\s*", "");
        pattern = System.Text.RegularExpressions.Regex.Replace(pattern, @"(?<!d)dd(?!d)", "d");
        return day.ToDateTime(TimeOnly.MinValue).ToString(pattern.Trim(), culture);
    }
}
