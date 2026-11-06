using System.Globalization;
using Cineon.Core.Data;
using Cineon.Core.Import;
using Cineon.Core.Metadata;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace Cineon.App.UI;

/// Ctrl+T (Ctrl+K too). Type a film, a site or an address. The first thing you reach for in
/// Cineon. Ported from Cineon/UI/CommandBar.swift.
///
/// The field is made once; the results below it are rebuilt as you type, as the selection moves
/// and as the catalogue answers.
public sealed class CommandBarView : Component
{
    private sealed record Item(string Id, string? Symbol, Uri? ImageUrl, string Primary, string? Secondary, Action Run);

    private readonly AppModel _app;
    private readonly TextBox _query;
    private readonly StackPanel _rows = new() { Spacing = 1, Padding = new Thickness(7) };
    private readonly ScrollViewer _scroll;
    private readonly Border _divider = new() { Height = 0.5 };
    private readonly DebouncedSearch _search = new();
    private IReadOnlyList<MetadataHit> _hits = [];
    private IReadOnlyList<Item> _shown = [];
    private int _selection;
    private string _trimmed = "";

    public CommandBarView(AppModel app)
    {
        _app = app;
        // It places itself at the top; around it, clicks reach the dimmed backdrop.
        HorizontalAlignment = HorizontalAlignment.Center;
        VerticalAlignment = VerticalAlignment.Top;
        Margin = new Thickness(0, 88, 0, 0);
        _scroll = Ui.Scroll(_rows);
        _scroll.VerticalScrollBarVisibility = ScrollBarVisibility.Hidden;
        _query = Inputs.Field("Search your sites, your library or the web", app.CommandBarSeed, changed: TextChanged, size: 18, focus: true);
        _query.Padding = new Thickness(0, 0, 0, 0);
        _query.MinHeight = 0;
        _query.PreviewKeyDown += OnKey;
        _trimmed = app.CommandBarSeed.Trim();
        SearchMetadata();
    }

    protected override void OnDisappeared() => _search.Cancel();

    protected override UIElement Render()
    {
        var p = Theme.P;
        Inputs.Paint(_query, plain: true);
        _query.Foreground = new SolidColorBrush(p.Ink);
        _divider.Background = new SolidColorBrush(p.Line);
        var field = Ui.Row(12, Ui.Icon(Glyph.Search, 16, p.Ink3), _query.Detached().Fill()).Padding(18, 0);
        field.Height = 56;
        var stack = Ui.VStack(0, field, _divider.Detached(), _scroll.Detached());
        stack.Width = 640;
        RefreshList();
        return stack.GlassPanel(18);
    }

    private void TextChanged(string text)
    {
        var trimmed = text.Trim();
        // Swift's onChange(of: query) resets the selection on any edit.
        _selection = 0;
        if (trimmed != _trimmed)
        {
            _trimmed = trimmed;
            SearchMetadata();
        }
        RefreshList();
    }

    // MARK: Items

    private IReadOnlyList<Item> Items() => _trimmed.Length == 0 ? IdleItems() : SearchItems(_trimmed);

    private List<Item> IdleItems()
    {
        var app = _app;
        var items = new List<Item>();
        foreach (var (title, progress) in app.Library.ContinueWatching.Take(3))
        {
            var chosen = title;
            items.Add(new Item($"continue{title.Id}", null, title.PosterUrl, title.Name,
                progress.IsVisitOnly ? $"Open on {DomainName.Registrable(progress.Host)}" : $"Resume at {Timecode.String(progress.Position)}",
                () => app.Resume(chosen)));
        }
        foreach (var tab in app.Browser.ListedTabs.Take(4))
        {
            var chosen = tab;
            items.Add(new Item($"tab{tab.Id}", MiscGlyph.Window, tab.FaviconUrl, tab.DisplayTitle, "Switch to tab", () => app.Browser.Select(chosen)));
        }
        foreach (var site in app.Library.Sites.Take(4))
        {
            var chosen = site;
            items.Add(new Item($"site{site.Id}", Glyph.Globe, site.IconUrl, site.Name, site.Host, () => app.OpenSite(chosen)));
        }
        return items;
    }

    private List<Item> SearchItems(string text)
    {
        var app = _app;
        var items = new List<Item>();

        if (DirectUrl(text) is { } url)
        {
            items.Add(new Item("url", MiscGlyph.GoTo, null, $"Go to {(url.Host.Length > 0 ? url.Host : text)}", null, () => OpenInTab(url)));
        }

        var searchable = app.Library.Sites.Count(s => s.SearchTemplate is not null);
        items.Add(new Item("everywhere", MiscGlyph.Stack, null, $"Search “{text}” on all my sites", $"{searchable} sites",
            () => app.Browser.SearchEverywhere(text)));

        foreach (var title in app.Library.Search(text, 5))
        {
            var id = title.Id;
            items.Add(new Item($"title{title.Id}", null, title.PosterUrl, title.Name,
                title.Status == TitleStatus.None ? null : title.Status.Label,
                () => app.DetailTitleId = id));
        }

        var compare = CultureInfo.CurrentCulture.CompareInfo;
        foreach (var site in app.Library.Sites)
        {
            if (compare.IndexOf(site.Name, text, CompareOptions.IgnoreCase) < 0 && compare.IndexOf(site.Host, text, CompareOptions.IgnoreCase) < 0) continue;
            var chosen = site;
            items.Add(new Item($"site{site.Id}", Glyph.Globe, site.IconUrl, site.Name, site.Host, () => app.OpenSite(chosen)));
        }

        var known = app.Library.Titles.Values.Select(t => t.ImdbId).OfType<string>().ToHashSet();
        foreach (var hit in _hits.Take(5))
        {
            if (known.Contains(hit.Id)) continue;
            var chosen = hit;
            var subtitle = string.Join(", ", new[] { "Add to backlog", hit.Year?.ToString(CultureInfo.InvariantCulture), hit.Kind == TitleKind.Series ? "Series" : null }.OfType<string>());
            items.Add(new Item($"hit{hit.Id}", null, hit.PosterUrl, hit.Name, subtitle, () => app.AddToBacklog(chosen)));
        }

        IReadOnlyList<HistoryEntry> history;
        try
        {
            history = app.Session.Db.SearchHistory(text, 5);
        }
        catch (Exception)
        {
            history = [];
        }
        foreach (var entry in history)
        {
            var page = entry.Url;
            items.Add(new Item($"history{entry.Id}", Glyph.Clock, null, entry.Title.Length == 0 ? entry.Url.OriginalString : entry.Title, entry.Host,
                () => OpenInTab(page)));
        }

        var lower = text.ToLowerInvariant();
        if ("import".StartsWith(lower, StringComparison.Ordinal) || lower.Contains("import", StringComparison.Ordinal))
        {
            items.Add(new Item("import", MiscGlyph.Import, null, "Import from another browser", "Arc, Chrome and others",
                () => app.Sheet = new AppSheet.ImportBrowser()));
        }

        var engine = app.Settings.SearchEngine;
        if (engine.Url(text) is { } web)
        {
            items.Add(new Item("web", Glyph.Search, null, $"Search the web for “{text}”", engine.Label, () => OpenInTab(web)));
        }
        return items;
    }

    private void OpenInTab(Uri url)
    {
        _app.Browser.EndSearch(keeping: null);
        _app.Browser.OpenTab(url);
    }

    /// Recognises addresses typed without a scheme, like "site.to/film".
    public static Uri? DirectUrl(string text)
    {
        if (text.Contains(' ')) return null;
        if (text.StartsWith("http://", StringComparison.Ordinal) || text.StartsWith("https://", StringComparison.Ordinal)) return Urls.Parse(text);
        if (text.StartsWith("localhost", StringComparison.Ordinal) || text.StartsWith("127.0.0.1", StringComparison.Ordinal)) return Urls.Parse($"http://{text}");
        var hostPart = text.Split('/', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? text;
        var labels = hostPart.Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (labels.Length < 2 || labels[^1] is not { Length: >= 2 } last || !last.All(char.IsLetter)) return null;
        return Urls.Parse($"https://{text}");
    }

    // MARK: List

    private void RefreshList()
    {
        var p = Theme.P;
        _shown = Items();
        _rows.Children.Clear();
        var selected = Math.Min(_selection, _shown.Count - 1);
        FrameworkElement? selectedRow = null;
        for (var index = 0; index < _shown.Count; index++)
        {
            var row = Row(_shown[index], index == selected);
            var chosen = index;
            row.Tapped += (_, e) =>
            {
                e.Handled = true;
                _selection = chosen;
                Run();
            };
            Ui.Hand(row);
            if (index == selected) selectedRow = row;
            _rows.Children.Add(row);
        }
        var visible = _shown.Count > 0;
        _divider.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        _scroll.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        // A scroll view takes all the height it's offered, so size it to its rows.
        _scroll.Height = Math.Min(420, _shown.Count * 39 + 14);
        if (selectedRow is not null)
        {
            void Reveal(object sender, RoutedEventArgs e)
            {
                selectedRow.Loaded -= Reveal;
                selectedRow.StartBringIntoView(new BringIntoViewOptions { AnimationDesired = false });
            }
            selectedRow.Loaded += Reveal;
        }
    }

    private static Border Row(Item item, bool isSelected)
    {
        var p = Theme.P;
        FrameworkElement leading;
        if (item.ImageUrl is { } url)
        {
            var placeholder = Ui.Icon(item.Symbol ?? Glyph.Films, 13, p.Ink2).Centered();
            var height = item.Symbol is null ? 34 : 24;
            leading = new Border
            {
                Width = 24,
                Height = height,
                CornerRadius = new CornerRadius(3),
                Child = new RemoteImage(url, new Grid { Children = { placeholder } }, fill: true, cornerRadius: 3),
            };
        }
        else
        {
            leading = Ui.Icon(item.Symbol ?? Glyph.Films, 13, p.Ink2).Centered();
        }
        var slot = new Border { Width = 24, Child = leading };
        var primary = Ui.Line(item.Primary, Typeface.Ui(14, isSelected ? Typeface.Medium : null), p.Ink);
        var secondary = item.Secondary is { } text ? Ui.Line(text, Typeface.Ui(12), p.Ink3) : null;
        if (secondary is not null) secondary.Margin = new Thickness(8, 0, 0, 0);
        var content = Ui.Row(12, slot, Ui.Row(0, primary.Fill(), secondary).Fill());
        return new Border
        {
            Child = content,
            Padding = new Thickness(11, 2, 11, 2),
            MinHeight = 38,
            CornerRadius = new CornerRadius(9),
            Background = new SolidColorBrush(isSelected ? p.Raised2 : Microsoft.UI.Colors.Transparent),
        };
    }

    private void Run()
    {
        var index = Math.Min(_selection, _shown.Count - 1);
        if (index < 0 || index >= _shown.Count) return;
        var item = _shown[index];
        _app.CloseCommandBar();
        item.Run();
    }

    private void OnKey(object sender, KeyRoutedEventArgs e)
    {
        switch (e.Key)
        {
            case VirtualKey.Escape:
                _app.CloseCommandBar();
                e.Handled = true;
                break;
            case VirtualKey.Down:
                _selection = Math.Max(0, Math.Min(_selection + 1, _shown.Count - 1));
                RefreshList();
                e.Handled = true;
                break;
            case VirtualKey.Up:
                _selection = Math.Max(_selection - 1, 0);
                RefreshList();
                e.Handled = true;
                break;
            case VirtualKey.Enter:
                Run();
                e.Handled = true;
                break;
        }
    }

    // MARK: Catalogue

    private void SearchMetadata()
    {
        var text = _trimmed;
        if (!_app.Settings.FetchMetadata || Sheets.Characters(text) < 2 || DirectUrl(text) is not null)
        {
            _search.Cancel();
            SetHits([]);
            return;
        }
        // Waits for a pause in typing, so each keystroke doesn't become a network request.
        _search.Run(text, SetHits, clearsOnCancel: false);
    }

    private void SetHits(IReadOnlyList<MetadataHit> hits)
    {
        if (hits.Count == 0 && _hits.Count == 0) return;
        _hits = hits;
        RefreshList();
    }
}
