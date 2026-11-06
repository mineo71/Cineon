using System.Globalization;
using Cineon.Core.Data;
using Cineon.Core.Import;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cineon.App.UI;

/// Brings in what's already in Arc, Chrome and friends. Nothing is written until you've reviewed
/// the list and pressed Import. Ported from Cineon/UI/ImportSheet.swift.
///
/// The review is built once per scan: ticking a box or changing a list updates that row in place,
/// so the long list keeps its scroll position.
public sealed class ImportSheet : Component
{
    private abstract record Stage
    {
        public sealed record Looking : Stage;
        public sealed record Choose(IReadOnlyList<ImportSource> Sources) : Stage;
        public sealed record Scanning(ImportSource Source) : Stage;
        public sealed record Review(ImportScan Scan) : Stage;
        public sealed record Importing : Stage;
        public sealed record Done(string Message) : Stage;
    }

    private static readonly IReadOnlyList<(TitleStatus, string)> Lists =
        [(TitleStatus.Watched, "Watched"), (TitleStatus.Watching, "Watching"), (TitleStatus.Backlog, "Backlog")];

    private readonly AppModel _app;
    private Stage _stage = new Stage.Looking();
    private HashSet<string> _chosenSites = [];
    private HashSet<string> _chosenTitles = [];
    private Dictionary<string, TitleStatus> _statuses = [];
    private bool _includePages = true;
    private bool _started;
    private int _generation;

    // The review's rows, to tick and untick in place.
    private readonly Dictionary<string, CheckBox> _siteBoxes = [];
    private readonly Dictionary<string, CheckBox> _titleBoxes = [];
    private readonly Dictionary<string, Border> _pickers = [];

    public ImportSheet(AppModel app)
    {
        _app = app;
    }

    protected override void OnAppeared()
    {
        if (_started) return;
        _started = true;
        _ = LookForBrowsersAsync();
    }

    private string Heading => _stage switch
    {
        Stage.Review review => $"Found in {review.Scan.SourceLabel}",
        Stage.Done => "Import finished",
        _ => "Import from another browser",
    };

    protected override UIElement Render()
    {
        var p = Theme.P;
        var heading = Ui.Line(Heading, Typeface.Title(24), p.Ink);
        var top = Ui.Row(0, heading.Fill(), Buttons.Icon(Glyph.Close, "Close", () => _app.Sheet = null));
        var content = _stage switch
        {
            Stage.Looking => Progress("Looking for browsers on this PC"),
            Stage.Choose choose => ChooseView(choose.Sources),
            Stage.Scanning scanning => Progress($"Looking for films in {scanning.Source.Label}"),
            Stage.Review review => ReviewView(review.Scan),
            Stage.Importing => Progress("Importing"),
            Stage.Done done => DoneView(done.Message),
            _ => new Grid(),
        };
        var stack = Ui.VStack(16, top, content);
        stack.Padding = new Thickness(24);
        stack.Width = 680;
        var panel = stack.GlassPanel(18);
        panel.HorizontalAlignment = HorizontalAlignment.Center;
        panel.VerticalAlignment = VerticalAlignment.Center;
        return panel;
    }

    private static FrameworkElement Progress(string text)
    {
        var row = Ui.HStack(12, Inputs.Spinner(16), Ui.Line(text, Typeface.Ui(14), Theme.P.Ink2));
        row.HorizontalAlignment = HorizontalAlignment.Center;
        row.VerticalAlignment = VerticalAlignment.Center;
        return new Grid { MinHeight = 110, Children = { row } };
    }

    private void Show(Stage stage)
    {
        _stage = stage;
        Invalidate();
    }

    // MARK: Choosing a browser

    private FrameworkElement ChooseView(IReadOnlyList<ImportSource> sources)
    {
        var p = Theme.P;
        var stack = Ui.VStack(12);
        if (sources.Count == 0)
        {
            stack.Children.Add(Ui.Text(
                "No browsers with anything to import were found. Cineon can read Arc, Chrome, Brave, Edge, Vivaldi, Dia, Opera and Yandex.",
                Typeface.Ui(14), p.Ink2));
        }
        else
        {
            stack.Children.Add(Ui.Text(
                "Cineon finds the sites and films in there. You choose what to keep on the next step, and nothing changes in the other browser.",
                Typeface.Ui(13), p.Ink2));
            var list = Ui.VStack(1);
            foreach (var source in sources)
            {
                var chosen = source;
                var row = Ui.Row(12,
                    Ui.Icon(Glyph.Globe, 16, p.Ink2).Size(width: 22),
                    Ui.VStack(1,
                        Ui.Line(source.Label, Typeface.Ui(14, Typeface.Medium), p.Ink),
                        Ui.Line(Describe(source), Typeface.Ui(12), p.Ink3)).Fill(),
                    Ui.Icon(Glyph.ChevronRight, 11, p.Ink3));
                var button = Buttons.Hover(row, () => _ = ScanAsync(chosen), padding: new Thickness(8, 9, 10, 9));
                button.HorizontalAlignment = HorizontalAlignment.Stretch;
                button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
                list.Children.Add(button);
            }
            stack.Children.Add(list);
        }
        stack.Children.Add(Ui.Text("Passwords and cookies are never read.", Typeface.Ui(12), p.Ink3));
        return stack;
    }

    private static string Describe(ImportSource source)
    {
        var parts = new List<string>();
        if (source.HistoryCount > 0) parts.Add($"{Number(source.HistoryCount)} pages");
        if (source.BookmarkCount > 0) parts.Add($"{Number(source.BookmarkCount)} bookmarks");
        if (source.PinnedCount > 0) parts.Add($"{Number(source.PinnedCount)} saved tabs");
        return string.Join(", ", parts);
    }

    /// Swift's `Int.formatted()`: grouped by the person's locale.
    private static string Number(int value) => value.ToString("N0", CultureInfo.CurrentCulture);

    // MARK: Reviewing

    private FrameworkElement ReviewView(ImportScan scan)
    {
        var p = Theme.P;
        _siteBoxes.Clear();
        _titleBoxes.Clear();
        _pickers.Clear();
        var newSites = scan.Sites.Where(s => _app.Library.SiteForHost(s.Host) is null).ToList();

        var sections = Ui.VStack(20);
        if (newSites.Count > 0) sections.Children.Add(SitesSection(newSites));
        if (scan.Titles.Count > 0) sections.Children.Add(TitlesSection(scan.Titles));
        if (newSites.Count == 0 && scan.Titles.Count == 0)
        {
            sections.Children.Add(Ui.Text("No film sites or films turned up here, but your history can still be made searchable.", Typeface.Ui(13), p.Ink2));
        }
        var scroll = Ui.Scroll(sections);
        scroll.MaxHeight = 400;

        var stack = Ui.VStack(14, scroll);
        if (scan.TotalPages > 0)
        {
            stack.Children.Add(Inputs.Checkbox(_includePages, on => _includePages = on,
                Ui.Text(PagesLabel(scan), Typeface.Ui(13), p.Ink)));
        }
        stack.Children.Add(Ui.Row(0,
            Buttons.Outline("Back", () => _ = LookForBrowsersAsync()),
            Ui.Spacer(),
            Buttons.Silver("Import", () => _ = RunImportAsync(scan))));
        return stack;
    }

    private static string PagesLabel(ImportScan scan) =>
        scan.TotalPages > scan.Pages.Count
            ? $"Make the latest {Number(scan.Pages.Count)} of {Number(scan.TotalPages)} visited pages searchable with Ctrl+T"
            : $"Make {Number(scan.Pages.Count)} visited pages searchable with Ctrl+T";

    private static FrameworkElement SectionHeader(string text, int count, Action selectAll, Action selectNone)
    {
        var p = Theme.P;
        Button Plain(string title, Action action) => Buttons.Make(Ui.Line(title, Typeface.Ui(12), p.Ink2), action);
        return Ui.Row(8,
            Ui.Line(text, Typeface.Title(17), p.Ink),
            Ui.Line(count.ToString(CultureInfo.InvariantCulture), Typeface.Time(12), p.Ink3),
            Ui.Spacer(),
            Plain("All", selectAll),
            Plain("None", selectNone));
    }

    private FrameworkElement SitesSection(IReadOnlyList<ImportSiteCandidate> sites)
    {
        var p = Theme.P;
        var stack = Ui.VStack(6, SectionHeader("Sites you watch on", sites.Count,
            () => SetSites(sites.Select(s => s.Id), true),
            () => SetSites(sites.Select(s => s.Id), false)));
        foreach (var site in sites)
        {
            var id = site.Id;
            UIElement? pages = site.FilmPages > 0
                ? Ui.Line(site.FilmPages == 1 ? "1 film page" : $"{Number(site.FilmPages)} film pages", Typeface.Ui(12), p.Ink3)
                : null;
            var label = Ui.Row(8, Ui.Line(site.Host, Typeface.Ui(13), p.Ink).Fill(), pages);
            var box = Inputs.Checkbox(_chosenSites.Contains(id), on =>
            {
                if (on) _chosenSites.Add(id); else _chosenSites.Remove(id);
            }, label);
            _siteBoxes[id] = box;
            stack.Children.Add(box);
        }
        return stack;
    }

    private void SetSites(IEnumerable<string> ids, bool on)
    {
        foreach (var id in ids)
        {
            if (on) _chosenSites.Add(id); else _chosenSites.Remove(id);
            if (_siteBoxes.TryGetValue(id, out var box)) box.IsChecked = on;
        }
    }

    private FrameworkElement TitlesSection(IReadOnlyList<ImportTitleCandidate> titles)
    {
        var stack = Ui.VStack(6, SectionHeader("Films and series", titles.Count,
            () => SetTitles(titles.Select(t => t.Id), true),
            () => SetTitles(titles.Select(t => t.Id), false)));
        var rows = Ui.VStack(2);
        foreach (var title in titles) rows.Children.Add(TitleRow(title));
        stack.Children.Add(rows);
        return stack;
    }

    private FrameworkElement TitleRow(ImportTitleCandidate title)
    {
        var p = Theme.P;
        var id = title.Id;
        var label = Ui.VStack(1,
            Ui.Line(title.Name, Typeface.Title(14), p.Ink),
            Ui.Line(Detail(title), Typeface.Ui(11.5), p.Ink3));
        var box = Inputs.Checkbox(_chosenTitles.Contains(id), on =>
        {
            if (on) _chosenTitles.Add(id); else _chosenTitles.Remove(id);
            RefreshPicker(title);
        }, label);
        _titleBoxes[id] = box;
        var picker = new Border { Margin = new Thickness(8, 0, 0, 0) };
        _pickers[id] = picker;
        RefreshPicker(title);
        return Ui.Row(0, box.Fill(), picker).Padding(0, 3);
    }

    /// The list a chosen title goes to. Greyed while it isn't chosen.
    private void RefreshPicker(ImportTitleCandidate title)
    {
        if (!_pickers.TryGetValue(title.Id, out var holder)) return;
        var status = _statuses.TryGetValue(title.Id, out var set) ? set : title.SuggestedStatus;
        holder.Child = Inputs.Picker(Lists, status, chosen =>
        {
            _statuses[title.Id] = chosen;
            RefreshPicker(title);
        }, enabled: _chosenTitles.Contains(title.Id));
    }

    private void SetTitles(IEnumerable<string> ids, bool on)
    {
        foreach (var id in ids)
        {
            if (on) _chosenTitles.Add(id); else _chosenTitles.Remove(id);
            // Checked and Unchecked refresh the row's picker.
            if (_titleBoxes.TryGetValue(id, out var box)) box.IsChecked = on;
        }
    }

    private static string Detail(ImportTitleCandidate title)
    {
        var parts = new List<string>();
        if (title.LatestRef.IsEpisode) parts.Add(title.LatestRef.ShortLabel);
        if (title.Year is int year) parts.Add(year.ToString(CultureInfo.InvariantCulture));
        parts.Add($"on {title.Host}");
        if (title.LastVisit > DateTimeOffset.MinValue) parts.Add(DateText.Relative(title.LastVisit));
        return string.Join(", ", parts);
    }

    private FrameworkElement DoneView(string message)
    {
        var p = Theme.P;
        return Ui.VStack(14,
            Ui.Text(message, Typeface.Ui(14), p.Ink2),
            Ui.Text("Posters and details are filling in. Anything can be moved or removed from your library later.", Typeface.Ui(12.5), p.Ink3),
            Ui.Row(0, Ui.Spacer(), Buttons.Silver("Open library", () =>
            {
                _app.Sheet = null;
                _app.Go(Route.Library);
            })));
    }

    // MARK: Actions

    private async Task LookForBrowsersAsync()
    {
        var generation = ++_generation;
        Show(new Stage.Looking());
        IReadOnlyList<ImportSource> sources;
        try
        {
            sources = await Task.Run(BrowserImporter.Discover);
        }
        catch (Exception error)
        {
            CrashLog.Write("import", error);
            sources = [];
        }
        if (generation != _generation) return;
        Show(new Stage.Choose(sources));
    }

    private async Task ScanAsync(ImportSource source)
    {
        var generation = ++_generation;
        Show(new Stage.Scanning(source));
        ImportScan result;
        try
        {
            result = await Task.Run(() => BrowserImporter.Scan(source, ParserRecognizer.Shared));
        }
        catch (Exception error)
        {
            CrashLog.Write("import", error);
            result = new ImportScan { SourceLabel = source.Label };
        }
        if (generation != _generation) return;
        _chosenSites = [.. result.Sites.Select(s => s.Id)];
        _chosenTitles = [.. result.Titles.Select(t => t.Id)];
        _statuses = [];
        _includePages = true;
        Show(new Stage.Review(result));
    }

    private async Task RunImportAsync(ImportScan scan)
    {
        var generation = ++_generation;
        Show(new Stage.Importing());
        // Lets the progress view draw before the write, which takes a moment on a large history.
        await Task.Delay(30);
        if (generation != _generation) return;
        var selection = new ImportSelection
        {
            Sites = [.. scan.Sites.Where(s => _chosenSites.Contains(s.Id))],
            Titles = [.. scan.Titles.Where(t => _chosenTitles.Contains(t.Id))
                .Select(t => (t, _statuses.TryGetValue(t.Id, out var status) ? status : t.SuggestedStatus))],
            Pages = _includePages && _app.Settings.SaveBrowsingHistory ? scan.Pages : [],
        };
        var result = _app.Library.ApplyImport(selection);
        foreach (var (id, altName) in result.NewTitleIds)
        {
            _app.Session.Metadata.Enrich(id, altName, inBackground: true);
        }
        Show(new Stage.Done(result.Summary));
    }
}
