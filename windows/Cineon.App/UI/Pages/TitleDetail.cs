using System.Globalization;
using Cineon.Core.Data;
using Cineon.Core.Import;
using Cineon.Core.Metadata;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cineon.App.UI;

/// The title card over the app: a backdrop with the poster, name and what you can do, then the
/// overview, saved moments, where you watched it, episodes, history, what Cineon skips and your
/// rating. Ported from Cineon/UI/TitleDetailView.swift. Esc and a click outside close it (AppModel
/// and the overlay host do that).
public sealed class TitleDetailCard : Component
{
    private readonly AppModel _app;
    private readonly long _id;
    private Title _title;
    private IReadOnlyList<EpisodeInfo> _episodes = [];
    private int _selectedSeason = 1;
    private List<SkipRule> _skipRules = [];
    private string? _episodesFor;
    private bool _episodesRequested;

    private readonly StackPanel _content = new();
    private readonly ScrollViewer _scroll;
    private readonly Border _card;
    private readonly Border _closeBacking;

    public TitleDetailCard(AppModel app, Title title)
    {
        _app = app;
        _id = title.Id;
        _title = title;
        var watch = new LibraryWatch(app);
        Watch(watch.Subscribe, watch.Unsubscribe);
        try { _skipRules = app.Session.Db.SkipRules(title.Id); }
        catch (Exception) { _skipRules = []; }

        _scroll = new ScrollViewer
        {
            Content = _content,
            HorizontalScrollMode = ScrollMode.Disabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            VerticalScrollMode = ScrollMode.Enabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Hidden,
        };
        _closeBacking = new Border
        {
            CornerRadius = new CornerRadius(14),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(14),
        };
        _card = new Border
        {
            Child = Ui.ZStack(_scroll, _closeBacking),
            CornerRadius = new CornerRadius(18),
            BorderThickness = new Thickness(1),
            MaxWidth = 840,
            MaxHeight = 700,
            Margin = new Thickness(30),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
            Shadow = new ThemeShadow(),
            Translation = new System.Numerics.Vector3(0, 0, 48),
        };
        // Clicks on the card stay on the card; the dimmed backdrop around it closes it.
        _card.Tapped += (_, e) => e.Handled = true;
    }

    private LibraryStore Library => _app.Library;

    private IReadOnlyList<WatchProgress> ProgressList => Library.ProgressList(_id);

    protected override UIElement Render()
    {
        var p = Theme.P;
        _card.Background = new SolidColorBrush(p.CardFill);
        _card.BorderBrush = new SolidColorBrush(p.Line);
        _closeBacking.Child = Buttons.Icon(Glyph.Close, "Close", () => _app.DetailTitleId = null);
        _closeBacking.Background = new AcrylicBrush
        {
            TintColor = p.IsDark ? Microsoft.UI.Colors.Black : Microsoft.UI.Colors.White,
            TintOpacity = 0.35,
            FallbackColor = p.Raised2,
        };
        if (!Library.Titles.TryGetValue(_id, out var current)) return _card;
        _title = current;
        LoadEpisodesIfNeeded();

        var title = _title;
        _content.Children.Clear();
        _content.Children.Add(Hero(title));

        var sections = new StackPanel { Spacing = 26, Padding = new Thickness(30, 18, 30, 26) };
        if (title.Overview is { Length: > 0 } overview)
        {
            var text = Ui.Text(overview, Typeface.Ui(14), p.Ink2);
            text.LineHeight = 14 * 1.33 + 3;
            text.MaxWidth = 620;
            text.HorizontalAlignment = HorizontalAlignment.Left;
            sections.Children.Add(text);
        }
        var moments = Library.Moments(_id);
        if (moments.Count > 0) sections.Children.Add(MomentsSection(moments));
        var places = Places();
        if (places.Count > 0) sections.Children.Add(WhereSection(places));
        if (_episodes.Count > 0) sections.Children.Add(EpisodesSection());
        var sessions = Library.SessionsForTitle(_id);
        if (sessions.Count > 0) sections.Children.Add(HistorySection(sessions));
        if (_skipRules.Count > 0) sections.Children.Add(SkipsSection());
        sections.Children.Add(Footer(title));
        _content.Children.Add(sections);
        return _card;
    }

    private void LoadEpisodesIfNeeded()
    {
        if (_episodesRequested && _episodesFor == _title.ImdbId) return;
        _episodesRequested = true;
        _episodesFor = _title.ImdbId;
        _ = LoadEpisodesAsync(_title);
    }

    private async Task LoadEpisodesAsync(Title title)
    {
        var found = await EpisodeSource.ForAsync(_app, title);
        if (_episodesFor != title.ImdbId) return;
        _episodes = found;
        var seasons = Seasons;
        if (ProgressList.FirstOrDefault() is { Ref.Season: > 0 } latest) _selectedSeason = latest.Ref.Season;
        else if (seasons.Count > 0) _selectedSeason = seasons[0];
        Invalidate();
    }

    private IReadOnlyList<int> Seasons => [.. _episodes.Select(e => e.Season).Distinct().Order()];

    /// Each site you've watched this on, latest first.
    private List<WatchProgress> Places()
    {
        var seen = new HashSet<string>();
        return [.. ProgressList.Where(progress => progress.Url is not null && seen.Add(progress.Host))];
    }

    // MARK: Hero

    private FrameworkElement Hero(Title title)
    {
        var p = Theme.P;
        var image = new RemoteImage(title.BackdropUrl ?? FrameFiles.Best(Library, _id), new Border { Background = new SolidColorBrush(p.Raised) }, fill: true, maxPixel: 1400)
        {
            Height = 280,
            VerticalAlignment = VerticalAlignment.Bottom,
        };
        image.SetSaturation(title.Status == TitleStatus.Watched ? 0 : 1, 0);
        var shade = new Border
        {
            Height = 280,
            VerticalAlignment = VerticalAlignment.Bottom,
            IsHitTestVisible = false,
            Background = new LinearGradientBrush
            {
                StartPoint = new Windows.Foundation.Point(0.5, 0),
                EndPoint = new Windows.Foundation.Point(0.5, 1),
                GradientStops =
                {
                    new GradientStop { Color = Palette.WithOpacity(p.CardFill, 0), Offset = 0.25 },
                    new GradientStop { Color = p.CardFill, Offset = 1 },
                },
            },
        };

        var facts = new List<string>();
        if (title.Year is { } year) facts.Add(year.ToString(CultureInfo.InvariantCulture));
        facts.Add(title.Kind.Label);
        if (title.RuntimeMinutes is { } runtime) facts.Add(TitleText.Runtime(runtime));
        facts.AddRange(title.Genres.Take(3));

        var text = Ui.VStack(8,
            Ui.Text(title.Name, Typeface.Title(34), p.Ink, maxLines: 2).ShrinkToFit(0.7),
            Ui.Line(string.Join(", ", facts), Typeface.Ui(12.5), p.Ink2),
            ActionRow(title));
        text.VerticalAlignment = VerticalAlignment.Bottom;
        var poster = Posters.Image(title, 118, fallback: FrameFiles.Best(Library, _id));
        poster.VerticalAlignment = VerticalAlignment.Bottom;
        var row = Ui.Row(20, poster, text.Fill());
        row.Padding = new Thickness(30, 0, 30, 0);
        row.VerticalAlignment = VerticalAlignment.Bottom;
        return Ui.ZStack(image, shade, row);
    }

    private FrameworkElement ActionRow(Title title)
    {
        var app = _app;
        var row = Ui.HStack(8);
        if (ProgressList.FirstOrDefault() is { Url: not null, Finished: false } latest)
        {
            row.Children.Add(PageButtons.Silver(
                latest.IsVisitOnly ? $"Open on {DomainName.Registrable(latest.Host)}" : $"Resume at {Timecode.String(latest.Position)}",
                Glyph.Play, () => app.Resume(title)));
        }
        else
        {
            row.Children.Add(PageButtons.Silver("Find on my sites", Glyph.Search, () =>
            {
                app.DetailTitleId = null;
                app.Browser.SearchEverywhere(title.Name, titleId: title.Id);
            }));
        }
        if (LocalCopies.Done(app).FirstOrDefault(d => d.TitleId == title.Id) is { } copy)
        {
            // The Mac says "on this Mac".
            row.Children.Add(PageButtons.Outline(
                copy.EpisodeBadge is { } badge ? $"Play {badge} on this PC" : "Play the copy on this PC",
                Glyph.Download, () => app.PlayDownload(copy)));
        }
        row.Children.Add(StatusPicker(title));
        // TODO(port-together): when `app.Session.Together.IsAvailable`, a person.2 menu button (28×28,
        // 13 pt ink2, help "Together") with "Challenge friends to finish it" (app.DetailTitleId = null;
        // app.Session.Together.CreateChallenge(title)) and "Share it as a code" (app.Session.Together.Share(title)).
        // The app's TogetherModel stand-in has neither yet.
        row.Margin = new Thickness(0, 4, 0, 0);
        return row;
    }

    private Button StatusPicker(Title title)
    {
        var p = Theme.P;
        var library = Library;
        var label = Ui.HStack(5,
            Ui.Line(title.Status == TitleStatus.None ? "Add to a list" : title.Status.Label, Typeface.Ui(13, Typeface.Medium), p.Ink),
            Ui.Icon(Glyph.ChevronDown, 9, p.Ink));
        Button? button = null;
        button = Buttons.Make(label, () =>
        {
            if (button is null) return;
            var menu = new MenuFlyout();
            foreach (var status in new[] { TitleStatus.Backlog, TitleStatus.Watching, TitleStatus.Watched })
            {
                menu.Items.Add(TitleMenu.Toggle(status.Label, title.Status == status, _ => library.SetStatus(title.Id, status)));
            }
            menu.ShowAt(button, new Microsoft.UI.Xaml.Controls.Primitives.FlyoutShowOptions { Placement = Microsoft.UI.Xaml.Controls.Primitives.FlyoutPlacementMode.BottomEdgeAlignedLeft });
        }, (b, _, _) => b.BorderBrush = new SolidColorBrush(p.Line));
        button.Padding = new Thickness(13, 6, 13, 6);
        button.BorderThickness = new Thickness(1);
        button.SizeChanged += (_, e) => button.CornerRadius = new CornerRadius(e.NewSize.Height / 2);
        return button;
    }

    // MARK: Sections

    private static TextBlock Heading(string text) => Ui.Line(text, Typeface.Title(17), Theme.P.Ink);

    private FrameworkElement MomentsSection(IReadOnlyList<FilmFrame> moments)
    {
        var grid = new AdaptiveColumns { MinItemWidth = 172, ColumnSpacing = 8, RowSpacing = 8 };
        foreach (var moment in moments) grid.Children.Add(new MomentCell(_app, moment));
        return Ui.VStack(10, Heading("Moments"), grid);
    }

    private FrameworkElement WhereSection(IReadOnlyList<WatchProgress> places)
    {
        var p = Theme.P;
        var stack = Ui.VStack(8, Heading("Where you watched it"));
        foreach (var place in places)
        {
            var state = place.IsVisitOnly ? "Opened" : place.Finished ? "Finished" : $"Stopped at {Timecode.String(place.Position)}";
            var row = Ui.Row(10,
                Posters.SiteIcon(place.Host, Library.SiteForHost(place.Host)?.IconUrl, 18),
                Ui.Line(DomainName.Registrable(place.Host), Typeface.Ui(13, Typeface.Medium), p.Ink),
                place.Ref.IsEpisode ? Ui.Line(place.Ref.ShortLabel, Typeface.Ui(12), p.Ink2) : null,
                Ui.Spacer(),
                Ui.Line(state, Typeface.Time(12), p.Ink2),
                Ui.Line(RelativeDate.Text(place.UpdatedAt), Typeface.Ui(12), p.Ink3));
            var button = Buttons.Hover(row, () => { if (place.Url is { } url) _app.Resume(url, place.Position); });
            button.HorizontalAlignment = HorizontalAlignment.Stretch;
            button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
            stack.Children.Add(button);
        }
        return stack;
    }

    private FrameworkElement EpisodesSection()
    {
        var p = Theme.P;
        var seasonRow = Ui.HStack(2);
        foreach (var season in Seasons)
        {
            var selected = _selectedSeason == season;
            seasonRow.Children.Add(Buttons.Hover(
                Ui.Line($"Season {season}", Typeface.Ui(12, selected ? Typeface.Medium : null), selected ? p.Ink : p.Ink2),
                () => { _selectedSeason = season; Invalidate(); },
                selected: selected, padding: new Thickness(8, 3, 8, 3)));
        }
        var seasons = new ScrollViewer
        {
            Content = seasonRow,
            HorizontalScrollMode = ScrollMode.Enabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden,
            VerticalScrollMode = ScrollMode.Disabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
        };
        var header = Ui.Row(14, Heading("Episodes"), seasons.Fill());

        var done = new Dictionary<EpisodeRef, WatchProgress>();
        foreach (var progress in ProgressList) done.TryAdd(progress.Ref, progress);
        var list = Ui.VStack(1);
        foreach (var episode in _episodes.Where(e => e.Season == _selectedSeason))
        {
            list.Children.Add(EpisodeRow(episode, done.GetValueOrDefault(new EpisodeRef(episode.Season, episode.Episode))));
        }
        return Ui.VStack(10, header, list);
    }

    private Button EpisodeRow(EpisodeInfo episode, WatchProgress? progress)
    {
        var p = Theme.P;
        var title = _title;
        var fill = progress is null ? 0 : progress.Finished ? 1 : 0.5;
        var icon = PageGlyph.Circle(fill, 13, progress is not null ? p.Ink : p.Ink3);
        icon.Width = 18;
        var number = Ui.Line(episode.Episode.ToString(CultureInfo.InvariantCulture), Typeface.Time(12.5), p.Ink3);
        number.Width = 22;
        number.TextAlignment = TextAlignment.Right;
        var name = Ui.Line(episode.Name ?? $"Episode {episode.Episode}", Typeface.Ui(13), p.Ink);
        var row = Ui.Row(10,
            icon,
            number,
            name.Fill(),
            progress is { Finished: false, IsVisitOnly: false } ? Ui.Line(Timecode.String(progress.Position), Typeface.Time(12), p.Ink2) : null);
        var button = Buttons.Hover(row, () =>
        {
            if (progress?.Url is { } url)
            {
                _app.Resume(url, progress.Position);
            }
            else
            {
                _app.DetailTitleId = null;
                _app.Browser.SearchEverywhere($"{title.Name} season {episode.Season} episode {episode.Episode}", titleId: title.Id);
            }
        });
        button.HorizontalAlignment = HorizontalAlignment.Stretch;
        button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        return button;
    }

    private static FrameworkElement HistorySection(IReadOnlyList<WatchSession> sessions)
    {
        var p = Theme.P;
        var font = Typeface.Time(12.5);
        var stack = Ui.VStack(6, Heading("History"));
        foreach (var session in sessions.Take(12))
        {
            var row = Ui.Row(10,
                Ui.Line(DateText.Day(session.StartedAt), font, p.Ink2),
                session.Ref.IsEpisode ? Ui.Line(session.Ref.ShortLabel, font, p.Ink2) : null,
                Ui.Line(session.IsVisitOnly ? "Opened" : Timecode.Spoken(session.WatchedSeconds), font, p.Ink3),
                Ui.Spacer(),
                Ui.Line(DomainName.Registrable(session.Host), font, p.Ink3));
            row.Padding = new Thickness(8, 3, 8, 3);
            stack.Children.Add(row);
        }
        return stack;
    }

    private FrameworkElement SkipsSection()
    {
        var p = Theme.P;
        var font = Typeface.Ui(12.5);
        var stack = Ui.VStack(6, Heading("What Cineon skips"));
        foreach (var rule in _skipRules)
        {
            var text = rule.Kind == SkipRuleKind.Intro
                ? $"Intro, {Timecode.String(rule.Start)} to {Timecode.String(rule.End)}"
                : $"Credits, last {Timecode.Spoken(rule.Start)}";
            var id = rule.Id;
            var row = Ui.Row(10,
                Ui.Line(text, font, p.Ink2),
                Ui.Line(rule.Site, font, p.Ink3),
                Ui.Spacer(),
                PageButtons.Plain("Forget", font, p.Ink2, () =>
                {
                    try { _app.Session.Db.DeleteSkipRule(id); }
                    catch (Exception) { }
                    _skipRules.RemoveAll(r => r.Id == id);
                    Invalidate();
                }));
            row.Padding = new Thickness(8, 3, 8, 3);
            stack.Children.Add(row);
        }
        return stack;
    }

    private FrameworkElement Footer(Title title)
    {
        var p = Theme.P;
        var library = Library;
        var id = title.Id;
        var stars = new StarRatingControl(title.RatingHalves, value => library.SetRating(id, value), size: 15);
        var remove = PageButtons.Plain("Remove from library", Typeface.Ui(12.5), p.Ink3, () =>
        {
            _app.DetailTitleId = null;
            library.Delete(id);
        });
        return Ui.Row(10, stars, Ui.Spacer(), remove);
    }
}

/// A saved frame. Click to carry on from it; right-click for more (the Mac's MomentCell).
internal sealed class MomentCell : Component
{
    private readonly AppModel _app;
    private readonly FilmFrame _moment;
    private FrameworkElement? _label;

    public MomentCell(AppModel app, FilmFrame moment)
    {
        _app = app;
        _moment = moment;
        Ui.Hand(this);
        PointerEntered += (_, _) => { if (_label is not null) Motion.Fade(_label, 1); };
        PointerExited += (_, _) => { if (_label is not null) Motion.Fade(_label, 0); };
        Tapped += (_, e) =>
        {
            e.Handled = true;
            if (moment.Url is { } url) app.Resume(url, moment.Position);
        };
        ContextRequested += (_, e) => TitleMenu.Show(Menu(), this, e);
        this.Label(Timecode.String(moment.Position));
    }

    private string Path => _app.Library.FramePath(_moment);

    protected override UIElement Render()
    {
        var p = Theme.P;
        var image = new RemoteImage(FrameFiles.Url(_app.Library, _moment), new Border { Background = new SolidColorBrush(p.Raised) }, fill: true, cornerRadius: 6, maxPixel: 900);
        var text = _moment.Ref.IsEpisode
            ? $"{_moment.Ref.ShortLabel}, {Timecode.String(_moment.Position)}"
            : Timecode.String(_moment.Position);
        _label = new Border
        {
            Child = Ui.Line(text, Typeface.Time(11), Microsoft.UI.Colors.White),
            Padding = new Thickness(6, 3, 6, 3),
            CornerRadius = new CornerRadius(4),
            Background = new SolidColorBrush(Palette.Grey(0, 0.62)),
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Bottom,
            Margin = new Thickness(6),
            Opacity = 0,
            IsHitTestVisible = false,
        };
        return Ui.AspectRatio(new Grid { Children = { image, _label }, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) }, 9.0 / 16.0);
    }

    private MenuFlyout Menu()
    {
        var menu = new MenuFlyout();
        if (_moment.Url is { } url) menu.Items.Add(TitleMenu.Item("Carry on from here", () => _app.Resume(url, _moment.Position)));
        menu.Items.Add(TitleMenu.Item("Copy image", () => _ = CopyAsync()));
        // The Mac says "Show in Finder".
        menu.Items.Add(TitleMenu.Item("Show in File Explorer", () =>
        {
            try { System.Diagnostics.Process.Start("explorer.exe", $"/select,\"{Path}\""); }
            catch (Exception) { }
        }));
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(TitleMenu.Item("Delete moment", () => _app.Library.DeleteFrame(_moment)));
        return menu;
    }

    private async Task CopyAsync()
    {
        try
        {
            var file = await Windows.Storage.StorageFile.GetFileFromPathAsync(Path);
            var data = new Windows.ApplicationModel.DataTransfer.DataPackage();
            data.SetBitmap(Windows.Storage.Streams.RandomAccessStreamReference.CreateFromFile(file));
            Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(data);
        }
        catch (Exception)
        {
            // Nothing to copy if the file has gone.
        }
    }
}
