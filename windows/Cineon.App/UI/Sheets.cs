using System.Globalization;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Cineon.Core.Metadata;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace Cineon.App.UI;

/// The sheets, ported from Cineon/UI/Sheets.swift: SheetHost picks one for `app.Sheet`.
///
/// A sheet builds its frame and text fields once. What changes while you type (search results, a
/// button that names what you typed) lives in its own small view and rebuilds alone, so the field
/// being typed in never leaves the screen and keeps its focus.
public static class Sheets
{
    public static UIElement For(AppModel app, AppSheet sheet)
    {
        var view = Make(app, sheet);
        // Only the panel takes clicks; around it, they reach the dimmed backdrop.
        view.HorizontalAlignment = HorizontalAlignment.Center;
        view.VerticalAlignment = VerticalAlignment.Center;
        return view;
    }

    private static FrameworkElement Make(AppModel app, AppSheet sheet) => sheet switch
    {
        AppSheet.AddSite add => new AddSiteSheet(app, add.Prefill),
        AppSheet.EditSite edit when app.Library.Sites.FirstOrDefault(s => s.Id == edit.SiteId) is { } site => new EditSiteSheet(app, site),
        AppSheet.AddTitle add => new AddTitleSheet(app, add.Query),
        AppSheet.Relink => new RelinkSheet(app),
        AppSheet.ImportBrowser => new ImportSheet(app),
        AppSheet.NewChallenge => new NewChallengeSheet(app),
        // A site removed in the meantime: like the Mac, nothing over the dimmed backdrop.
        _ => new Grid(),
    };

    /// The Mac's SheetFrame: a heading with a close button, the content, on glass.
    public static Border Frame(string heading, double width, Action close, params UIElement?[] content)
    {
        var p = Theme.P;
        var top = Ui.Row(0, Ui.Line(heading, Typeface.Title(24), p.Ink).Fill(), Buttons.Icon(Glyph.Close, "Close", close));
        var stack = Ui.VStack(16, [top, .. content]);
        stack.Padding = new Thickness(24);
        stack.Width = width;
        var panel = stack.GlassPanel(18);
        panel.HorizontalAlignment = HorizontalAlignment.Center;
        panel.VerticalAlignment = VerticalAlignment.Center;
        return panel;
    }

    /// The Mac's FieldLabel.
    public static TextBlock FieldLabel(string text) => Ui.Line(text, Typeface.Ui(12, Typeface.Medium), Theme.P.Ink2);

    /// Swift's `String.count`: characters as people see them.
    public static int Characters(string text) => new StringInfo(text).LengthInTextElements;
}

/// The catalogue search behind the sheets and the command bar: waits for a pause in typing (220 ms)
/// and drops answers to anything typed before.
public sealed class DebouncedSearch
{
    private CancellationTokenSource? _current;
    private bool _inFlight;

    /// `clearsOnCancel`: the sheets' search empties the results when a newer one starts while it
    /// runs; the command bar's keeps them until the new answer comes.
    public async void Run(string text, Action<IReadOnlyList<MetadataHit>> found, Action<bool>? searching = null, bool clearsOnCancel = true)
    {
        _current?.Cancel();
        if (_inFlight && clearsOnCancel) found([]);
        var cancel = _current = new CancellationTokenSource();
        if (Sheets.Characters(text) < 2)
        {
            _inFlight = false;
            found([]);
            return;
        }
        _inFlight = true;
        try
        {
            await Task.Delay(220, cancel.Token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        searching?.Invoke(true);
        IReadOnlyList<MetadataHit> hits;
        try
        {
            hits = await MetadataClient.Shared.SearchAsync(text, cancel.Token);
        }
        catch (Exception)
        {
            hits = [];
        }
        searching?.Invoke(false);
        if (cancel.IsCancellationRequested) return;
        _inFlight = false;
        found(hits);
    }

    public void Cancel()
    {
        _current?.Cancel();
        _inFlight = false;
    }
}

// MARK: Sites

public sealed class AddSiteSheet : Component
{
    private readonly AppModel _app;
    private readonly TextBox _address;
    private readonly Live _problem;
    private string? _problemText;

    public AddSiteSheet(AppModel app, string? prefill)
    {
        _app = app;
        _address = Inputs.Field("example.com", prefill ?? "", submit: Add, focus: true);
        _problem = new Live(() => _problemText is { } text
            ? Ui.Text(text, Typeface.Ui(12), Theme.P.Ink2)
            : new Grid());
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        Inputs.Paint(_address);
        var hint = Ui.Text("Cineon learns how the site searches the first time you open it.", Typeface.Ui(12), p.Ink3);
        hint.Margin = new Thickness(0, 2, 0, 0);
        return Sheets.Frame("Add a site", 480, () => _app.Sheet = null,
            Ui.VStack(6, Sheets.FieldLabel("Address"), _address.Detached(), _problem.Detached(), hint),
            Ui.Row(0, Ui.Spacer(), Buttons.Silver("Add site", Add)));
    }

    private void Add()
    {
        var text = _address.Text.Trim();
        if (CommandBarView.DirectUrl(text) is not { } url)
        {
            ShowProblem("That doesn't look like a web address. Try something like example.com.");
            return;
        }
        if (_app.Library.AddSite(url) is not { } site)
        {
            ShowProblem("Couldn't add that site.");
            return;
        }
        _app.Sheet = null;
        _app.OpenSite(site);
    }

    private void ShowProblem(string text)
    {
        _problemText = text;
        _problem.Invalidate();
    }
}

public sealed class EditSiteSheet : Component
{
    private readonly AppModel _app;
    private readonly Site _site;
    private readonly TextBox _name;
    private readonly TextBox _address;
    private readonly TextBox _search;

    public EditSiteSheet(AppModel app, Site site)
    {
        _app = app;
        _site = site;
        _name = Inputs.Field("Name", site.Name, submit: Save);
        _address = Inputs.Field("https://example.com", site.HomeUrl.OriginalString, submit: Save);
        _search = Inputs.Field("https://example.com/search?q=%s", site.SearchTemplate ?? "", submit: Save);
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        foreach (var box in new[] { _name, _address, _search }) Inputs.Paint(box);
        return Sheets.Frame("Edit site", 480, () => _app.Sheet = null,
            Ui.VStack(6, Sheets.FieldLabel("Name"), _name.Detached()),
            Ui.VStack(6, Sheets.FieldLabel("Address"), _address.Detached()),
            Ui.VStack(6,
                Sheets.FieldLabel("Search address"),
                _search.Detached(),
                Ui.Text("Use %s where the search words go. Leave it empty, and Cineon learns it from the site.", Typeface.Ui(12), p.Ink3)),
            Ui.Row(0,
                Buttons.Outline("Remove site", () =>
                {
                    _app.Library.RemoveSite(_site.Id);
                    _app.Sheet = null;
                }),
                Ui.Spacer(),
                Buttons.Silver("Save", Save)));
    }

    private void Save()
    {
        var updated = _site with { Name = _name.Text.Length == 0 ? _site.Name : _name.Text };
        if (CommandBarView.DirectUrl(_address.Text.Trim(' ', '\t')) is { } url && url.Host.Length > 0)
        {
            var host = url.Host;
            updated = updated with { HomeUrl = url, Host = host.StartsWith("www.", StringComparison.Ordinal) ? host[4..] : host };
        }
        var template = _search.Text.Trim();
        updated = updated with { SearchTemplate = template.Length == 0 ? null : template };
        _app.Library.UpdateSite(updated);
        _app.Sheet = null;
    }
}

// MARK: Titles

/// Search IMDb's catalogue and add, or just type a name and add it by hand.
public sealed class AddTitleSheet : Component
{
    private readonly AppModel _app;
    private readonly TextBox _query;
    private readonly MetadataResults _results;
    private readonly Live _footer;
    private readonly DebouncedSearch _search = new();
    private string _trimmed = "";

    public AddTitleSheet(AppModel app, string? initial)
    {
        _app = app;
        _results = new MetadataResults(hit =>
        {
            _app.AddToBacklog(hit);
            _app.Sheet = null;
        });
        _footer = new Live(() => Ui.Row(0,
            Ui.Spacer(),
            _trimmed.Length > 0 ? Buttons.Outline($"Add “{_trimmed}” by name", AddManually) : null));
        _query = Inputs.Field("Film or series name", initial ?? "", changed: TextChanged, submit: AddFirst, focus: true);
        TextChanged(_query.Text);
    }

    protected override UIElement Render()
    {
        Inputs.Paint(_query);
        return Sheets.Frame("Add to backlog", 620, () => _app.Sheet = null,
            _query.Detached(), _results.Detached(), _footer.Detached());
    }

    private void TextChanged(string text)
    {
        var trimmed = text.Trim();
        if (trimmed == _trimmed && _results.Query == trimmed) return;
        _trimmed = trimmed;
        _footer.Invalidate();
        _results.SetQuery(trimmed);
        _search.Run(trimmed, _results.SetHits, _results.SetSearching);
    }

    protected override void OnDisappeared() => _search.Cancel();

    private void AddFirst()
    {
        if (_results.Hits.FirstOrDefault() is { } hit)
        {
            _app.AddToBacklog(hit);
            _app.Sheet = null;
        }
        else if (_trimmed.Length > 0)
        {
            AddManually();
        }
    }

    private void AddManually()
    {
        if (_app.Library.AddTitle(_trimmed, status: TitleStatus.Backlog) is not { } title) return;
        _app.Session.Metadata.Enrich(title.Id);
        _app.Toasts.Show($"Added {title.Name} to backlog");
        _app.Sheet = null;
    }
}

/// "That's not what this page is showing." Corrects the recognised title.
public sealed class RelinkSheet : Component
{
    private readonly AppModel _app;
    private readonly TextBox _query;
    private readonly TextBox _season;
    private readonly TextBox _episode;
    private readonly MetadataResults _results;
    private readonly Live _library;
    private readonly Live _footer;
    private readonly DebouncedSearch _search = new();
    private string _trimmed = "";

    public RelinkSheet(AppModel app)
    {
        _app = app;
        var parsed = app.Browser.Selected?.Parsed;
        _season = Inputs.Field("Season", parsed is { Ref.IsEpisode: true } ? parsed.Ref.Season.ToString(CultureInfo.InvariantCulture) : "");
        _episode = Inputs.Field("Episode", parsed is { Ref.IsEpisode: true } ? parsed.Ref.Episode.ToString(CultureInfo.InvariantCulture) : "");
        _season.Width = 84;
        _episode.Width = 84;
        _results = new MetadataResults(hit =>
        {
            if (_app.Library.AddTitle(hit.Name, hit.Year, hit.Kind, TitleStatus.Watching, imdbId: hit.Id, posterUrl: hit.PosterUrl) is not { } title) return;
            _ = _app.Session.Metadata.ApplyAsync(hit, title.Id);
            Link(title.Id);
        });
        _library = new Live(LibraryMatches);
        _footer = new Live(Footer);
        _query = Inputs.Field("Film or series name", parsed?.Name ?? "", changed: TextChanged, focus: true);
        TextChanged(_query.Text);
    }

    private Browser.BrowserTab? Tab => _app.Browser.Selected;

    private EpisodeRef Ref => new(
        int.TryParse(_season.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var season) ? season : 0,
        int.TryParse(_episode.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var episode) ? episode : 0);

    protected override UIElement Render()
    {
        foreach (var box in new[] { _query, _season, _episode }) Inputs.Paint(box);
        return Sheets.Frame("What's playing here?", 620, () => _app.Sheet = null,
            _query.Detached(),
            Ui.HStack(10, Sheets.FieldLabel("For a series"), _season.Detached(), _episode.Detached()),
            _library.Detached(),
            _results.Detached(),
            _footer.Detached());
    }

    protected override void OnDisappeared() => _search.Cancel();

    private void TextChanged(string text)
    {
        var trimmed = text.Trim();
        if (trimmed == _trimmed && _results.Query == trimmed) return;
        _trimmed = trimmed;
        _library.Invalidate();
        _footer.Invalidate();
        _results.SetQuery(trimmed);
        _search.Run(trimmed, _results.SetHits, _results.SetSearching);
    }

    private UIElement LibraryMatches()
    {
        var p = Theme.P;
        var matches = _app.Library.Search(_trimmed, 4);
        if (matches.Count == 0) return new Grid();
        var list = Ui.VStack(2, Sheets.FieldLabel("In your library"));
        foreach (var title in matches)
        {
            var id = title.Id;
            var row = Ui.Row(10, Posters.Image(title, width: 22, cornerRadius: 2), Ui.Line(title.Name, Typeface.Ui(13), p.Ink).Fill());
            var button = Buttons.Hover(row, () => Link(id));
            button.HorizontalAlignment = HorizontalAlignment.Stretch;
            button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
            list.Children.Add(button);
        }
        return list;
    }

    private UIElement Footer()
    {
        var children = new List<UIElement?>();
        if (Tab is { } tab)
        {
            children.Add(Buttons.Outline("This isn't a film", () =>
            {
                _app.Session.Tracker.Ignore(tab);
                _app.Sheet = null;
            }));
        }
        children.Add(Ui.Spacer());
        if (_trimmed.Length > 0)
        {
            var name = _trimmed;
            children.Add(Buttons.Outline($"Use “{name}”", () =>
            {
                if (_app.Library.AddTitle(name, status: TitleStatus.Watching) is not { } title) return;
                Link(title.Id);
            }));
        }
        return Ui.Row(0, [.. children]);
    }

    private void Link(long id)
    {
        if (Tab is not { } tab) return;
        _app.Session.Tracker.Relink(tab, id, Ref);
        _app.Toasts.Show($"Now tracking {_app.Library.Titles.GetValueOrDefault(id)?.Name ?? "this title"}");
        _app.Sheet = null;
    }
}

/// The catalogue's answers as a row of posters. The Mac's MetadataResults.
public sealed class MetadataResults : Component
{
    private readonly Action<MetadataHit> _pick;
    private IReadOnlyList<MetadataHit> _hits = [];
    private bool _isSearching;

    public MetadataResults(Action<MetadataHit> pick) { _pick = pick; }

    public IReadOnlyList<MetadataHit> Hits => _hits;
    public string Query { get; private set; } = "";

    public void SetQuery(string query)
    {
        if (Query == query) return;
        Query = query;
        Invalidate();
    }

    public void SetHits(IReadOnlyList<MetadataHit> hits)
    {
        if (hits.Count == 0 && _hits.Count == 0) return;
        _hits = hits;
        Invalidate();
    }

    public void SetSearching(bool searching)
    {
        if (_isSearching == searching) return;
        _isSearching = searching;
        Invalidate();
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        if (_hits.Count == 0)
        {
            if (Sheets.Characters(Query) < 2 || _isSearching) return new Grid();
            var empty = Ui.Text("No matches yet. You can still add it by name.", Typeface.Ui(12.5), p.Ink3);
            empty.HorizontalAlignment = HorizontalAlignment.Center;
            empty.VerticalAlignment = VerticalAlignment.Center;
            return new Grid { MinHeight = 60, Children = { empty } };
        }
        var row = Ui.HStack(12);
        foreach (var hit in _hits)
        {
            var poster = new Border
            {
                Width = 94,
                Height = 141,
                CornerRadius = new CornerRadius(5),
                Child = new RemoteImage(hit.PosterUrl, Posters.Placeholder(hit.Name), fill: true, cornerRadius: 5),
            };
            var name = Ui.Text(hit.Name, Typeface.Ui(11.5, Typeface.Medium), p.Ink, maxLines: 2);
            name.Width = 94;
            var subtitle = Ui.Line(Subtitle(hit), Typeface.Ui(11), p.Ink3);
            subtitle.Width = 94;
            var card = Ui.VStack(5, poster, name, subtitle);
            card.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            var chosen = hit;
            var button = Buttons.Make(card, () => _pick(chosen));
            button.VerticalAlignment = VerticalAlignment.Top;
            row.Children.Add(button);
        }
        return Ui.Scroll(row, horizontal: true);
    }

    private static string Subtitle(MetadataHit hit)
    {
        var year = hit.Year?.ToString(CultureInfo.InvariantCulture) ?? "";
        return hit.Kind == TitleKind.Series ? (year.Length == 0 ? "Series" : $"{year}, series") : year;
    }
}

// MARK: Challenges

/// Picks the film or series to race friends through.
public sealed class NewChallengeSheet : Component
{
    private readonly AppModel _app;
    private readonly TextBox _filter;
    private readonly Live _list;

    public NewChallengeSheet(AppModel app)
    {
        _app = app;
        _list = new Live(List);
        _filter = Inputs.Field("Filter", "", changed: _ => _list.Invalidate(), submit: () =>
        {
            if (Candidates().FirstOrDefault() is { } first) Start(first);
        }, focus: true);
    }

    private IReadOnlyList<Title> Candidates()
    {
        var library = _app.Library;
        var needle = LibraryText.Normalize(_filter.Text);
        return [.. library.Watching.Concat(library.Backlog)
            .Where(t => needle.Length == 0 || t.NormName.Contains(needle, StringComparison.Ordinal))
            .Take(40)];
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        Inputs.Paint(_filter);
        return Sheets.Frame("Who finishes first?", 560, () => _app.Sheet = null,
            Ui.Text("Choose something from Watching or your backlog. Everyone who joins races from where they are now.", Typeface.Ui(13), p.Ink2),
            _filter.Detached(),
            _list.Detached());
    }

    private UIElement List()
    {
        var p = Theme.P;
        var stack = Ui.VStack(2);
        var candidates = Candidates();
        foreach (var title in candidates)
        {
            var chosen = title;
            var details = string.Join(", ", new[] { title.Kind.Label, title.Year?.ToString(CultureInfo.InvariantCulture) }.OfType<string>());
            var row = Ui.Row(12,
                Posters.Image(title, width: 30, cornerRadius: 3),
                Ui.VStack(2,
                    Ui.Line(title.Name, Typeface.Ui(13.5, Typeface.Medium), p.Ink),
                    Ui.Line(details, Typeface.Ui(11.5), p.Ink3)).Fill(),
                Ui.Line(title.Status.Label, Typeface.Ui(11.5), p.Ink3));
            var button = Buttons.Hover(row, () => Start(chosen));
            button.HorizontalAlignment = HorizontalAlignment.Stretch;
            button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
            stack.Children.Add(button);
        }
        if (candidates.Count == 0)
        {
            var empty = Ui.Text("Nothing here yet. Add something to your backlog first.", Typeface.Ui(12.5), p.Ink3);
            empty.Margin = new Thickness(0, 20, 0, 20);
            stack.Children.Add(empty);
        }
        var scroll = Ui.Scroll(stack);
        scroll.VerticalScrollBarVisibility = ScrollBarVisibility.Hidden;
        scroll.Height = 320;
        return scroll;
    }

    private void Start(Title title)
    {
        _app.Sheet = null;
        _ = _app.Session.Together.CreateChallenge(title);
    }
}

// MARK: Series downloads

/// Asks before getting a whole series, which can run to tens of gigabytes: how many seasons and
/// episodes, about how big, and how much room there is. Shown while `Seasons.PendingProposal` is set.
public sealed class SeriesDownloadSheet : Component
{
    private readonly AppModel _app;
    private readonly SeasonGrabber.Proposal _proposal;
    private Button? _confirm;

    public SeriesDownloadSheet(AppModel app, SeasonGrabber.Proposal proposal)
    {
        _app = app;
        _proposal = proposal;
        IsTabStop = false;
        KeyDown += (_, e) =>
        {
            if (e.Key != Windows.System.VirtualKey.Escape) return;
            e.Handled = true;
            Decline();
        };
    }

    private SeasonGrabber Seasons => _app.Session.Seasons;
    private int Episodes => _proposal.Job.Episodes.Count;

    private void Decline() => Seasons.Decline();

    private string CountLine
    {
        get
        {
            var seasons = _proposal.SeasonCounts.Count;
            return $"{seasons} season{(seasons == 1 ? "" : "s")}, {Episodes} episode{(Episodes == 1 ? "" : "s")} not on this PC yet";
        }
    }

    private string SizeLine
    {
        get
        {
            var text = $"About {ByteCount.File(_proposal.TotalBytes)}";
            if (!_proposal.IsMeasured) text += ", guessing a gigabyte an episode";
            if (_proposal.FreeBytes is { } free) text += $". {ByteCount.File(free)} free on this PC";
            return text;
        }
    }

    protected override void OnAppeared()
    {
        // The default button, as `.keyboardShortcut(.defaultAction)`: Enter downloads, Esc declines.
        DispatcherQueue?.TryEnqueue(() => _confirm?.Focus(FocusState.Programmatic));
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        const double width = 500, padding = 24;

        var placeholder = new Grid
        {
            Background = new SolidColorBrush(p.Raised2),
            Children = { Ui.Icon(Glyph.Films, 16, p.Ink3).Centered() },
        };
        var poster = new Border
        {
            Width = 64,
            Height = 96,
            CornerRadius = new CornerRadius(6),
            Child = new RemoteImage(_proposal.Job.PosterUrl, placeholder, fill: true, cornerRadius: 6),
            VerticalAlignment = VerticalAlignment.Top,
        };
        var texts = Ui.VStack(6,
            Ui.Text($"Download all of {_proposal.Job.Name}?", Typeface.Title(22), p.Ink),
            Ui.Text(CountLine, Typeface.Ui(13), p.Ink2),
            Ui.Text(SizeLine, Typeface.Ui(13), p.Ink2));
        texts.VerticalAlignment = VerticalAlignment.Top;
        var close = Buttons.Icon(Glyph.Close, "Close", Decline);
        close.VerticalAlignment = VerticalAlignment.Top;
        var top = Ui.Row(16, poster, texts.Fill(), close);

        // LazyVGrid(.adaptive(minimum: 92), spacing: 6) across the sheet's width.
        var inner = width - 2 * padding;
        var columns = Math.Max(1, (int)((inner + 6) / (92 + 6)));
        var grid = new Grid { ColumnSpacing = 6, RowSpacing = 6 };
        for (var c = 0; c < columns; c++) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var counts = _proposal.SeasonCounts;
        for (var r = 0; r < (counts.Count + columns - 1) / columns; r++) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        for (var i = 0; i < counts.Count; i++)
        {
            var (season, count) = counts[i];
            var chip = Ui.HStack(6,
                    Ui.Line($"Season {season}", Typeface.Ui(12, Typeface.Medium), p.Ink),
                    Ui.Line(count.ToString(CultureInfo.InvariantCulture), Typeface.Time(11), p.Ink3))
                .Padding(10, 6)
                .Background(p.Raised, 8);
            chip.HorizontalAlignment = HorizontalAlignment.Stretch;
            grid.Children.Add(chip.Cell(row: i / columns, column: i % columns));
        }

        UIElement? warning = null;
        if (!_proposal.Fits)
        {
            warning = Ui.Row(8,
                Ui.Icon(Glyph.Warning, 13, p.Ink).Align(vertical: VerticalAlignment.Top),
                Ui.Text("That's more than the free space on this PC. Downloads that don't fit will stop with an error.", Typeface.Ui(12.5, Typeface.Medium), p.Ink).Fill());
        }

        _confirm = Buttons.Silver($"Download {Episodes} episode{(Episodes == 1 ? "" : "s")}", () => Seasons.Confirm());
        var buttons = Ui.Row(10, Ui.Spacer(), Buttons.Outline("Not now", Decline), _confirm);

        var stack = Ui.VStack(18,
            top,
            grid,
            warning,
            Ui.Text("Season by season, two at a time. Stop whenever you like in Downloads. If Cineon closes, it carries on from there next time.", Typeface.Ui(12), p.Ink3),
            buttons);
        stack.Padding = new Thickness(padding);
        stack.Width = width;
        var panel = stack.GlassPanel(18);
        panel.HorizontalAlignment = HorizontalAlignment.Center;
        panel.VerticalAlignment = VerticalAlignment.Center;
        return panel;
    }
}
