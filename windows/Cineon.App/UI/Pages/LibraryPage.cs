using System.Globalization;
using Cineon.Core.Data;
using Cineon.Core.Import;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cineon.App.UI;

/// Library: the status tabs, kinds and filters, find and sort, and everything as a poster grid or,
/// for the backlog, a checklist. Ported from Cineon/UI/LibraryView.swift.
///
/// The page is built once and its parts are refreshed in place, so the search box keeps its focus
/// while you type and the grid keeps its scroll position. Posters are an ItemsRepeater with a
/// virtualizing layout: only the rows on screen exist.
public sealed class LibraryPage : Component
{
    private enum Layout { Grid, Checklist }

    private const string SortKey = "library.sort";

    private readonly AppModel _app;
    private LibraryQuery _query = new();
    private Layout _layout = Layout.Grid;
    private LibrarySort _sort = LibrarySort.FromRaw(UiDefaults.Get(SortKey)) ?? LibrarySort.Recent;

    private readonly Grid _root = new();
    private readonly Border _titleHost = new();
    private readonly Border _filtersHost = new();
    private readonly Border _sortHost = new();
    private readonly Border _layoutHost = new();
    private readonly SearchField _find;
    private readonly TextBlock _summary;
    private readonly Border _empty = new();

    private readonly ScrollViewer _gridScroll;
    private readonly ItemsRepeater _grid;
    private readonly AdaptiveGridLayout _gridLayout = new();
    private readonly ScrollViewer _listScroll;
    private readonly ItemsRepeater _list;

    private List<Title> _gridItems = [];
    private List<Title> _listItems = [];
    private readonly Dictionary<UIElement, int> _realizedGrid = [];
    private readonly Dictionary<UIElement, int> _realizedList = [];

    public LibraryPage(AppModel app)
    {
        _app = app;
        var watch = new LibraryWatch(app);
        Watch(watch.Subscribe, watch.Unsubscribe);

        _find = new SearchField("Find in library", 130, capsule: true, text =>
        {
            if (text == _query.Text) return;
            _query = _query with { Text = text };
            Invalidate();
        });
        var findAndSort = Ui.HStack(6, _find.Root, _sortHost, _layoutHost);
        // The filters and the search share a row while they fit, and take two when they don't.
        var filterRow = new FitRow { MinGap = 6 + 8 + 6, LineSpacing = 10, Children = { _filtersHost, findAndSort } };
        _summary = Ui.Line("", Typeface.Ui(11.5), Theme.P.Ink3);
        var header = Ui.VStack(14, _titleHost, filterRow, _summary);
        header.Padding = new Thickness(32, 26, 32, 16);

        _gridLayout.HasProgress = index => index < _gridItems.Count && ShowsProgress(_gridItems[index]);
        _grid = new ItemsRepeater { Layout = _gridLayout, ItemTemplate = RepeaterCells.Template() };
        _grid.ElementPrepared += (_, e) => PrepareGridCell(e.Element, e.Index);
        _grid.ElementClearing += (_, e) => _realizedGrid.Remove(e.Element);
        _grid.ElementIndexChanged += (_, e) => _realizedGrid[e.Element] = e.NewIndex;
        _gridScroll = Scroller(new Border { Child = _grid, Padding = new Thickness(32, 0, 32, 40) });

        _list = new ItemsRepeater { Layout = new StackLayout { Spacing = 0 }, ItemTemplate = RepeaterCells.Template() };
        _list.ElementPrepared += (_, e) => PrepareListRow(e.Element, e.Index);
        _list.ElementClearing += (_, e) => _realizedList.Remove(e.Element);
        _list.ElementIndexChanged += (_, e) => _realizedList[e.Element] = e.NewIndex;
        _listScroll = Scroller(new Border { Child = _list, Padding = new Thickness(24, 0, 24, 40) });

        var content = Ui.ZStack(_gridScroll, _listScroll, _empty);
        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _root.Children.Add(header.Cell(row: 0));
        _root.Children.Add(content.Cell(row: 1));
    }

    private static ScrollViewer Scroller(UIElement content) => new()
    {
        Content = content,
        HorizontalScrollMode = ScrollMode.Disabled,
        HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        VerticalScrollMode = ScrollMode.Enabled,
        VerticalScrollBarVisibility = ScrollBarVisibility.Hidden,
    };

    private bool ShowsProgress(Title title) =>
        title.Status == TitleStatus.Watching && _app.Library.LatestProgress(title.Id) is { IsVisitOnly: false };

    private IEnumerable<Title> Filed => _app.Library.Titles.Values.Where(t => t.Status != TitleStatus.None);

    private int Count(LibraryList list) => list == LibraryList.All ? Filed.Count() : _app.Library.Titles.Values.Count(t => list.Matches(t));

    protected override UIElement Render()
    {
        var p = Theme.P;
        _root.Background = new SolidColorBrush(p.CardFill);
        var downloaded = _query.OnThisMac ? LocalCopies.TitleIds(_app) : null;
        var shown = (_query with { Sort = _sort }).Apply(Filed, downloaded).ToList();

        _titleHost.Child = TitleRow();
        _filtersHost.Child = KindsAndFilters();
        _sortHost.Child = SortMenu();
        _layoutHost.Child = Buttons.Icon(
            _layout == Layout.Grid ? PageGlyph.Checklist : Glyph.Grid,
            _layout == Layout.Grid ? "Show as checklist" : "Show as posters",
            () => { _layout = _layout == Layout.Grid ? Layout.Checklist : Layout.Grid; Invalidate(); });
        _find.Text = _query.Text;

        _summary.Text = Summary(shown);
        _summary.Foreground = new SolidColorBrush(p.Ink3);

        var isEmpty = shown.Count == 0;
        _empty.Visibility = isEmpty ? Visibility.Visible : Visibility.Collapsed;
        _empty.Child = isEmpty ? EmptyState() : null;
        _gridScroll.Visibility = !isEmpty && _layout == Layout.Grid ? Visibility.Visible : Visibility.Collapsed;
        _listScroll.Visibility = !isEmpty && _layout == Layout.Checklist ? Visibility.Visible : Visibility.Collapsed;
        // The hidden one lets go of its items, so it doesn't keep cells it isn't showing.
        if (_layout == Layout.Grid) { SetItems(_grid, ref _gridItems, shown, _realizedGrid); SetItems(_list, ref _listItems, [], _realizedList); }
        else { SetItems(_list, ref _listItems, shown, _realizedList); SetItems(_grid, ref _gridItems, [], _realizedGrid); }
        return _root;
    }

    /// The same titles in the same order refresh the cells on screen; anything else starts the list over.
    private void SetItems(ItemsRepeater repeater, ref List<Title> current, List<Title> next, Dictionary<UIElement, int> realized)
    {
        if (current.Count == next.Count && current.Select(t => t.Id).SequenceEqual(next.Select(t => t.Id)))
        {
            current = next;
            var items = next;
            foreach (var (element, index) in realized.ToList())
            {
                if (index >= items.Count || element is not Border { Child: { } cell }) continue;
                if (cell is LibraryGridCell grid) grid.SetTitle(items[index]);
                else if (cell is ChecklistRow row) row.SetTitle(items[index]);
            }
            if (repeater.ItemsSource is null && next.Count > 0) repeater.ItemsSource = next;
            return;
        }
        current = next;
        realized.Clear();
        repeater.ItemsSource = next.Count == 0 ? null : next;
    }

    private void PrepareGridCell(UIElement element, int index)
    {
        if (element is not Border border || index >= _gridItems.Count) return;
        _realizedGrid[element] = index;
        var title = _gridItems[index];
        if (border.Child is LibraryGridCell cell)
        {
            cell.SetTitle(title, force: true);
            return;
        }
        // Built now, so the layout measures the real cell rather than an empty one.
        var fresh = new LibraryGridCell(_app, title);
        fresh.RenderNow();
        border.Child = fresh;
    }

    private void PrepareListRow(UIElement element, int index)
    {
        if (element is not Border border || index >= _listItems.Count) return;
        _realizedList[element] = index;
        var title = _listItems[index];
        if (border.Child is ChecklistRow row)
        {
            row.SetTitle(title, force: true);
            return;
        }
        var fresh = new ChecklistRow(_app, title);
        fresh.RenderNow();
        border.Child = fresh;
    }

    // MARK: Header

    /// A narrow window first shortens the buttons, then lets the lists scroll sideways.
    private FrameworkElement TitleRow()
    {
        var fits = new ViewThatFits();
        fits.Children.Add(Variant(StatusRow(spacing: 26, minGap: 16, compact: false)));
        fits.Children.Add(Variant(StatusRow(spacing: 20, minGap: 12, compact: true)));

        var tabs = Ui.HStack(20, [.. StatusTabs()]);
        var scroller = new ScrollViewer
        {
            Content = tabs,
            HorizontalScrollMode = ScrollMode.Enabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden,
            VerticalScrollMode = ScrollMode.Disabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
        };
        var (rate, add) = Actions(compact: true);
        var narrow = new Grid { ColumnSpacing = 12 };
        narrow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        narrow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        narrow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        narrow.Children.Add(scroller.Cell(column: 0));
        narrow.Children.Add(rate.Align(vertical: VerticalAlignment.Center).Cell(column: 1));
        narrow.Children.Add(add.Align(vertical: VerticalAlignment.Center).Cell(column: 2));
        fits.Children.Add(Variant(narrow));
        return fits;
    }

    /// Each layout in its own switchable box, so the ones not on screen take no clicks or focus.
    private static ContentControl Variant(UIElement content) => new()
    {
        Content = content,
        IsTabStop = false,
        HorizontalContentAlignment = HorizontalAlignment.Stretch,
        VerticalContentAlignment = VerticalAlignment.Stretch,
    };

    private Grid StatusRow(double spacing, double minGap, bool compact)
    {
        var (rate, add) = Actions(compact);
        // On the tabs' baseline, as `.firstTextBaseline` puts them.
        rate.VerticalAlignment = VerticalAlignment.Bottom;
        rate.Margin = new Thickness(0, 0, 0, 2);
        add.VerticalAlignment = VerticalAlignment.Bottom;
        add.Margin = new Thickness(0, 0, 0, 1);
        var gap = Ui.Spacer();
        gap.MinWidth = minGap;
        var children = new List<UIElement?>(StatusTabs()) { gap, rate, add };
        return Ui.Flex(Orientation.Horizontal, spacing, children);
    }

    private IEnumerable<UIElement> StatusTabs()
    {
        var p = Theme.P;
        foreach (var list in LibraryList.AllCases)
        {
            var selected = _query.List == list;
            var label = Ui.Line(list.Label, Typeface.Title(30), selected ? p.Ink : p.Ink3);
            label.VerticalAlignment = VerticalAlignment.Bottom;
            var count = Ui.Line(Count(list).ToString(CultureInfo.InvariantCulture), Typeface.Time(13), p.Ink3);
            count.VerticalAlignment = VerticalAlignment.Bottom;
            // Futura's 30 pt descends further below the baseline than the count's 13.
            count.Margin = new Thickness(0, 0, 0, 8);
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { label, count } };
            var button = Buttons.Make(row, () =>
            {
                _query = _query with { List = list };
                _layout = list == LibraryList.Backlog ? Layout.Checklist : Layout.Grid;
                Invalidate();
            });
            button.VerticalAlignment = VerticalAlignment.Bottom;
            button.Label($"{list.Label}, {Count(list)}");
            yield return button;
        }
    }

    private (Button Rate, Button Add) Actions(bool compact)
    {
        var p = Theme.P;
        Button rate = compact
            ? PageButtons.OutlineIcon(PageGlyph.HalfStar(12, p.Ink), "Rate films", () => _app.Go(Route.Rate))
            : PageButtons.Outline("Rate films", null, () => _app.Go(Route.Rate));
        if (!compact)
        {
            rate.Content = Ui.HStack(6, PageGlyph.HalfStar(11, p.Ink), Ui.Line("Rate films", Typeface.Ui(13, Typeface.Medium), p.Ink));
            rate.Tooltip("Rate films");
        }
        Button add = compact
            ? PageButtons.SilverIcon(Ui.Icon(Glyph.Add, 12, p.OnSilver), "Add a film", () => _app.Sheet = new AppSheet.AddTitle(null))
            : PageButtons.Silver("Add a film", Glyph.Add, () => _app.Sheet = new AppSheet.AddTitle(null));
        if (!compact) add.Tooltip("Add a film");
        return (rate, add);
    }

    private FrameworkElement KindsAndFilters()
    {
        var p = Theme.P;
        var row = Ui.HStack(6);
        foreach (var kind in LibraryKind.AllCases)
        {
            var selected = _query.Kind == kind;
            row.Children.Add(Buttons.Hover(
                Ui.Line(kind.Label, Typeface.Ui(12.5, selected ? Typeface.Medium : null), selected ? p.Ink : p.Ink2),
                () => { _query = _query with { Kind = kind }; Invalidate(); },
                selected: selected, padding: new Thickness(10, 4, 10, 4)));
        }
        row.Children.Add(new Border { Width = 0.5, Height = 16, Background = new SolidColorBrush(p.Line), Margin = new Thickness(6, 0, 6, 0) });
        row.Children.Add(GenreMenu());
        row.Children.Add(FilterMenu.Make(
            _query.Rating == RatingFilter.Any ? "Rating" : _query.Rating.Label,
            _query.Rating != RatingFilter.Any,
            () =>
            {
                var menu = new MenuFlyout();
                foreach (var choice in RatingFilter.Choices)
                {
                    menu.Items.Add(TitleMenu.Toggle(choice.Label, _query.Rating == choice, on =>
                    {
                        if (!on) return;
                        _query = _query with { Rating = choice };
                        Invalidate();
                    }));
                }
                return menu;
            }));
        row.Children.Add(FilterMenu.Make(
            _query.Decade is int chosen ? $"{chosen}s" : "Decade",
            _query.Decade is not null,
            () =>
            {
                var menu = new MenuFlyout();
                menu.Items.Add(TitleMenu.Toggle("Any decade", _query.Decade is null, on =>
                {
                    if (!on) return;
                    _query = _query with { Decade = null };
                    Invalidate();
                }));
                menu.Items.Add(new MenuFlyoutSeparator());
                foreach (var decade in LibraryQuery.DecadesIn(_app.Library.Titles.Values))
                {
                    menu.Items.Add(TitleMenu.Toggle($"{decade.ToString(CultureInfo.InvariantCulture)}s", _query.Decade == decade, on =>
                    {
                        _query = _query with { Decade = on ? decade : null };
                        Invalidate();
                    }));
                }
                return menu;
            }));

        var onThisPc = _query.OnThisMac;
        var ink = onThisPc ? p.Ink : p.Ink2;
        row.Children.Add(Buttons.Hover(
            // The Mac says "On this Mac".
            Ui.HStack(5, Ui.Icon(Glyph.Download, 11, ink), Ui.Line("On this PC", Typeface.Ui(12.5, onThisPc ? Typeface.Medium : null), ink)),
            () => { _query = _query with { OnThisMac = !_query.OnThisMac }; Invalidate(); },
            selected: onThisPc, padding: new Thickness(9, 4, 10, 4)));

        if (_query.HasFilters)
        {
            row.Children.Add(Buttons.Hover(
                Ui.Line("Clear", Typeface.Ui(12), p.Ink3),
                () =>
                {
                    _query = new LibraryQuery { List = _query.List, Kind = _query.Kind };
                    Invalidate();
                },
                padding: new Thickness(8, 4, 8, 4)));
        }
        return row;
    }

    private Button GenreMenu()
    {
        var genres = LibraryQuery.GenresIn(Filed);
        var chosen = _query.Genres;
        var label = chosen.Count == 0 ? "Genre" : chosen.Count == 1 ? chosen.First() : $"{chosen.Count} genres";
        return FilterMenu.Make(label, chosen.Count > 0, () =>
        {
            var menu = new MenuFlyout();
            if (_query.Genres.Count > 0)
            {
                menu.Items.Add(TitleMenu.Item("Any genre", () =>
                {
                    _query = _query with { Genres = new HashSet<string>() };
                    Invalidate();
                }));
                menu.Items.Add(new MenuFlyoutSeparator());
            }
            foreach (var genre in genres)
            {
                menu.Items.Add(TitleMenu.Toggle($"{genre.Name}  {genre.Count}", _query.Genres.Contains(genre.Name), on =>
                {
                    var next = new HashSet<string>(_query.Genres);
                    if (on) next.Add(genre.Name); else next.Remove(genre.Name);
                    _query = _query with { Genres = next };
                    Invalidate();
                }));
            }
            return menu;
        });
    }

    private Button SortMenu() => FilterMenu.Make(_sort.Label, isActive: false, glyph: Glyph.Sort, menu: () =>
    {
        var menu = new MenuFlyout();
        foreach (var sort in LibrarySort.AllCases)
        {
            menu.Items.Add(TitleMenu.Toggle(sort.Label, _sort == sort, on =>
            {
                if (!on) return;
                _sort = sort;
                UiDefaults.Set(SortKey, sort.ToRaw());
                Invalidate();
            }));
        }
        return menu;
    });

    private static string Summary(IReadOnlyList<Title> shown)
    {
        var rated = shown.Where(t => t.Rating is not null).Select(t => t.Rating!.Value).ToList();
        var text = $"{shown.Count} {(shown.Count == 1 ? "title" : "titles")}";
        if (rated.Count > 0)
        {
            text += $", {rated.Count} rated, averaging {(rated.Sum() / rated.Count).ToString("F1", CultureInfo.InvariantCulture)}";
        }
        return text;
    }

    // MARK: Empty

    private FrameworkElement EmptyState()
    {
        Button? button = null;
        if (_query.HasFilters)
        {
            button = PageButtons.Outline("Clear filters", null, () => { _query = new LibraryQuery(); Invalidate(); });
        }
        else if (_query.List is LibraryList.Backlog or LibraryList.All)
        {
            button = PageButtons.Outline("Add a film", null, () => _app.Sheet = new AppSheet.AddTitle(null));
        }
        return TitleText.Empty(EmptyText, button);
    }

    private string EmptyText
    {
        get
        {
            if (_query.HasFilters) return "Nothing matches these filters.";
            return _query.List switch
            {
                // The Mac says ⌘D.
                LibraryList.Backlog => "Films you want to see go here. Press Ctrl+D on any film's page to add it.",
                LibraryList.Watching => "Start playing something, and it appears here on its own.",
                LibraryList.Watched => "Films you finish move here on their own.",
                _ => "Your library is empty. Add a film, or import your history in Settings.",
            };
        }
    }
}

/// SwiftUI's `LazyVGrid(columns: [GridItem(.adaptive(minimum: 138, maximum: 190), spacing: 18)], spacing: 24)`
/// for ItemsRepeater: as many columns as fit, sharing the width, and only the rows near the screen
/// exist. A cell is a 2:3 poster over two lines of text, and a progress line for what you're
/// watching, so every row's height is known before its cells are made.
internal sealed class AdaptiveGridLayout : VirtualizingLayout
{
    private const double ProgressHeight = 2 + 7;

    public double MinItemWidth { get; set; } = 138;
    public double MaxItemWidth { get; set; } = 190;
    public double ColumnSpacing { get; set; } = 18;
    public double RowSpacing { get; set; } = 24;

    /// Whether the item at an index shows a progress line, which makes its row taller.
    public Func<int, bool>? HasProgress { get; set; }

    /// The name, the year and the spacing under the poster, learnt from the first cell measured.
    private double _textHeight = 7 + 17 + 7 + 15;
    private bool _learnt;

    private int _columns = 1;
    private double _itemWidth;
    private double[] _tops = [];
    private double[] _heights = [];
    private int _firstRow;
    private int _lastRow = -1;

    protected override Windows.Foundation.Size MeasureOverride(VirtualizingLayoutContext context, Windows.Foundation.Size availableSize)
    {
        var count = context.ItemCount;
        var width = double.IsInfinity(availableSize.Width) ? MinItemWidth : availableSize.Width;
        _columns = Math.Max(1, (int)Math.Floor((width + ColumnSpacing) / (MinItemWidth + ColumnSpacing)));
        _itemWidth = Math.Clamp((width - ColumnSpacing * (_columns - 1)) / _columns, 1, MaxItemWidth);
        if (count == 0)
        {
            _tops = [];
            _heights = [];
            _lastRow = -1;
            return new(width, 0);
        }
        var rows = (count + _columns - 1) / _columns;
        PlaceRows(count, rows);

        var window = context.RealizationRect;
        _firstRow = 0;
        while (_firstRow < rows - 1 && _tops[_firstRow] + _heights[_firstRow] < window.Y) _firstRow++;
        _lastRow = _firstRow;
        while (_lastRow < rows - 1 && _tops[_lastRow + 1] <= window.Y + window.Height) _lastRow++;

        for (var row = _firstRow; row <= _lastRow; row++)
        {
            for (var index = row * _columns; index < Math.Min(count, (row + 1) * _columns); index++)
            {
                var element = context.GetOrCreateElementAt(index);
                element.Measure(new Windows.Foundation.Size(_itemWidth, double.PositiveInfinity));
                if (!_learnt && element.DesiredSize.Height > _itemWidth * 1.5)
                {
                    _learnt = true;
                    _textHeight = element.DesiredSize.Height - _itemWidth * 1.5 - (HasProgress?.Invoke(index) == true ? ProgressHeight : 0);
                    PlaceRows(count, rows);
                }
            }
        }
        // Cells not asked for in this pass go back to the repeater's pool on their own.
        return new(width, _tops[^1] + _heights[^1]);
    }

    private void PlaceRows(int count, int rows)
    {
        _tops = new double[rows];
        _heights = new double[rows];
        var y = 0.0;
        for (var row = 0; row < rows; row++)
        {
            var progress = false;
            for (var index = row * _columns; index < Math.Min(count, (row + 1) * _columns) && !progress; index++)
            {
                progress = HasProgress?.Invoke(index) == true;
            }
            _tops[row] = y;
            _heights[row] = _itemWidth * 1.5 + _textHeight + (progress ? ProgressHeight : 0);
            y += _heights[row] + RowSpacing;
        }
    }

    protected override Windows.Foundation.Size ArrangeOverride(VirtualizingLayoutContext context, Windows.Foundation.Size finalSize)
    {
        var count = context.ItemCount;
        for (var row = _firstRow; row <= _lastRow && row < _tops.Length; row++)
        {
            for (var index = row * _columns; index < Math.Min(count, (row + 1) * _columns); index++)
            {
                var column = index - row * _columns;
                var element = context.GetOrCreateElementAt(index);
                element.Arrange(new(column * (_itemWidth + ColumnSpacing), _tops[row], _itemWidth, _heights[row]));
            }
        }
        return finalSize;
    }
}

/// A poster that fills whatever width the grid gives it (the Mac's AdaptivePosterCell). It lifts
/// under the pointer, and watched or watching films show stars across the bottom to rate them there.
internal sealed class LibraryGridCell : PressableComponent
{
    private readonly AppModel _app;
    private Title _title;
    private string _progressKey = "";
    private FrameworkElement? _lift;
    private Grid? _overlay;
    private FrameworkElement? _quick;

    public LibraryGridCell(AppModel app, Title title)
    {
        _app = app;
        _title = title;
        _progressKey = ProgressKey(title);
        VerticalAlignment = VerticalAlignment.Top;
        this.Label(title.Name);
    }

    private string ProgressKey(Title title) =>
        title.Status == TitleStatus.Watching && _app.Library.LatestProgress(title.Id) is { IsVisitOnly: false } progress
            ? progress.Fraction.ToString("R", CultureInfo.InvariantCulture)
            : "";

    /// Shows another title, or the same one after it changed. `force` rebuilds even when nothing did.
    public void SetTitle(Title title, bool force = false)
    {
        var key = ProgressKey(title);
        if (!force && title == _title && key == _progressKey) return;
        if (title.Id != _title.Id) ResetHover();
        _title = title;
        _progressKey = key;
        this.Label(title.Name);
        RenderNow();
    }

    private bool CanQuickRate => _title.Status is TitleStatus.Watched or TitleStatus.Watching;

    protected override void Activate() => _app.DetailTitleId = _title.Id;

    protected override MenuFlyout? ContextMenu() => TitleMenu.Build(_app, _title);

    protected override void OnHoverChanged(bool hovered)
    {
        if (_lift is not null) Motion.Scale(_lift, hovered ? 1.02 : 1, response: 0.3, damping: 0.75);
        ShowQuickRate(hovered, animated: true);
    }

    private void ShowQuickRate(bool shown, bool animated)
    {
        if (_overlay is null) return;
        if (shown && CanQuickRate && _quick is null)
        {
            _quick = QuickRate.Make(_app, _title);
            _quick.Opacity = 0;
            _overlay.Children.Add(_quick);
        }
        if (_quick is not null) Motion.Fade(_quick, shown && CanQuickRate ? 1 : 0, animated ? 0.12 : 0);
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var title = _title;
        var library = _app.Library;
        _quick = null;
        _overlay = Ui.ZStack(Posters.Image(title, fallback: FrameFiles.Best(library, title.Id)));
        if (title.RatingHalves is { } halves) _overlay.Children.Add(Stars.Badge(halves).Align(HorizontalAlignment.Left, VerticalAlignment.Top).Margin(7));
        var poster = new Border { Child = _overlay, CornerRadius = new CornerRadius(6) };
        _lift = poster;
        Motion.Scale(poster, IsHovered ? 1.02 : 1, animated: false);
        if (IsHovered) ShowQuickRate(true, animated: false);

        var progress = title.Status == TitleStatus.Watching ? library.LatestProgress(title.Id) : null;
        var stack = Ui.VStack(7,
            poster,
            progress is { IsVisitOnly: false } ? Progress.Line(progress.Fraction, 2) : null,
            Ui.Line(title.Name, Typeface.Ui(12.5, Typeface.Medium), p.Ink),
            Ui.Line(title.Year?.ToString(CultureInfo.InvariantCulture) ?? title.Kind.Label, Typeface.Ui(11.5), p.Ink3));
        return new Grid { Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), Children = { stack } };
    }
}

/// Stars across the bottom of a poster, to rate it without opening it (the Mac's QuickRate). Always
/// in the dark palette, over a shade.
internal static class QuickRate
{
    public static FrameworkElement Make(AppModel app, Title title)
    {
        var id = title.Id;
        var stars = new StarRatingControl(title.RatingHalves, value => app.Library.SetRating(id, value),
            size: 9.5, spacing: 1.5, showsValue: false, palette: Palette.Dark)
        {
            IsTabStop = false,
            HorizontalAlignment = HorizontalAlignment.Center,
        };
        return new Border
        {
            Child = stars,
            Padding = new Thickness(0, 8, 0, 8),
            VerticalAlignment = VerticalAlignment.Bottom,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Background = Palette.Vertical(Microsoft.UI.Colors.Transparent, Palette.Grey(0, 0.85)),
        };
    }
}

/// Backlog as a real checklist. Ticking a film marks it watched, and it moves across (the Mac's
/// ChecklistRow).
internal sealed class ChecklistRow : Component
{
    private readonly AppModel _app;
    private Title _title;
    private bool _hovered;
    private Border? _background;
    private Button? _find;

    public ChecklistRow(AppModel app, Title title)
    {
        _app = app;
        _title = title;
        PointerEntered += (_, _) => SetHovered(true);
        PointerExited += (_, _) => SetHovered(false);
        PointerCanceled += (_, _) => SetHovered(false);
        ContextRequested += (_, e) => TitleMenu.Show(TitleMenu.Build(_app, _title), this, e);
    }

    public void SetTitle(Title title, bool force = false)
    {
        if (!force && title == _title) return;
        _title = title;
        RenderNow();
    }

    private void SetHovered(bool hovered)
    {
        if (_hovered == hovered) return;
        _hovered = hovered;
        Paint(animated: true);
    }

    private void Paint(bool animated)
    {
        var p = Theme.P;
        if (_background is not null)
        {
            _background.BackgroundTransition = animated ? new BrushTransition { Duration = TimeSpan.FromSeconds(0.12) } : null;
            _background.Background = new SolidColorBrush(_hovered ? p.Raised : Palette.WithOpacity(p.Raised, 0));
        }
        if (_find is not null)
        {
            _find.Visibility = _hovered ? Visibility.Visible : Visibility.Collapsed;
            Motion.Fade(_find, _hovered ? 1 : 0, animated ? 0.12 : 0);
        }
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var title = _title;
        var library = _app.Library;
        var isDone = title.Status == TitleStatus.Watched;

        var check = Buttons.Make(
            new Border { Width = 26, Height = 26, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), Child = PageGlyph.Circle(isDone ? 1 : 0, 19, isDone ? p.Ink : p.Ink3).Centered() },
            () =>
            {
                library.SetStatus(title.Id, isDone ? TitleStatus.Backlog : TitleStatus.Watched);
                if (!isDone) _app.Toasts.Show($"Marked {title.Name} as watched");
            },
            help: isDone ? $"Mark {title.Name} as not watched" : $"Mark {title.Name} as watched");
        check.Margin = new Thickness(0, 0, 14, 0);

        var parts = new List<string> { title.Kind.Label };
        if (title.Year is { } year) parts.Insert(0, year.ToString(CultureInfo.InvariantCulture));
        if (title.RuntimeMinutes is { } runtime) parts.Add(TitleText.Runtime(runtime));

        var texts = Ui.VStack(2,
            Ui.Line(title.Name, Typeface.Title(16), p.Ink),
            Ui.Line(string.Join(", ", parts), Typeface.Ui(12), p.Ink3));
        var main = Ui.Row(14,
            Posters.Image(title, 34, cornerRadius: 3, fallback: FrameFiles.Best(library, title.Id)),
            texts.Fill(),
            title.RatingHalves is { } halves ? Stars.Badge(halves) : null);
        var open = Buttons.Make(main, () => _app.DetailTitleId = title.Id);
        open.HorizontalAlignment = HorizontalAlignment.Stretch;
        open.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        open.Label(title.Name);

        _find = PageButtons.Outline("Find on my sites", null, () => _app.Browser.SearchEverywhere(title.Name, titleId: title.Id));
        _find.Margin = new Thickness(14, 0, 0, 0);

        var row = Ui.Row(0, check, open.Fill(), _find);
        _background = new Border { Child = row, Padding = new Thickness(8, 7, 8, 7), CornerRadius = new CornerRadius(9) };
        Paint(animated: false);
        return _background;
    }
}
