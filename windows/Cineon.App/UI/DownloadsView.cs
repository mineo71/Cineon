using System.ComponentModel;
using System.Diagnostics;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cineon.App.UI;

/// Everything saved to this PC, ready to watch without the site, its player or its ads. Ported from
/// Cineon/UI/DownloadsView.swift (DownloadsView, DownloadRow, SeasonJobCard).
///
/// Progress arrives several times a second, so the page doesn't rebuild for it: rows update their
/// progress in place, and are rebuilt only when what they show changes. A button being clicked is
/// never swapped out from under the pointer.
public sealed class DownloadsPage : Component
{
    private readonly AppModel _app;
    private readonly ProfileSession _session;
    private readonly Dictionary<long, DownloadRow> _rows = [];
    private readonly StackPanel _list = new() { Padding = new Thickness(24, 0, 24, 40) };
    private readonly ScrollViewer _scroll;
    private readonly SeasonJobCard _jobCard;
    private TextBlock? _summary;
    private bool _wasEmpty;
    private bool _hadJob;

    public DownloadsPage(AppModel app)
    {
        _app = app;
        _session = app.Session;
        _scroll = Ui.Scroll(_list);
        // The Mac hides the scroll indicators here.
        _scroll.VerticalScrollBarVisibility = ScrollBarVisibility.Hidden;
        _jobCard = new SeasonJobCard(app, _session);
        WatchHandler(h => _session.Downloads.Changed += h, h => _session.Downloads.Changed -= h, Refresh);
        WatchHandler(h => _session.Seasons.Changed += h, h => _session.Seasons.Changed -= h, () =>
        {
            if ((_session.Seasons.CurrentJob is not null) != _hadJob) Invalidate();
        });
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var downloads = _session.Downloads;
        var items = downloads.Items;
        var job = _session.Seasons.CurrentJob;
        _wasEmpty = items.Count == 0;
        _hadJob = job is not null;
        SyncRows(downloads, items);

        var header = Header(downloads, items);
        UIElement? card = job is null ? null : _jobCard.Detached().Margin(32, 0, 32, 16);
        FrameworkElement body = items.Count == 0 && job is null ? EmptyState() : _scroll.Detached();
        var page = Ui.Column(0, header, card, body.Fill());
        page.Background = new SolidColorBrush(p.CardFill);
        return page;
    }

    /// Progress and new rows, without rebuilding the page.
    private void Refresh()
    {
        var downloads = _session.Downloads;
        var items = downloads.Items;
        if ((items.Count == 0) != _wasEmpty)
        {
            Invalidate();
            return;
        }
        SyncRows(downloads, items);
        if (_summary is not null) _summary.Text = Summary(downloads, items);
    }

    private void SyncRows(DownloadCenter downloads, IReadOnlyList<DownloadItem> items)
    {
        var order = new List<DownloadRow>(items.Count);
        foreach (var item in items)
        {
            if (!_rows.TryGetValue(item.Id, out var row))
            {
                row = new DownloadRow(_app, _session, item, downloads.Fraction(item));
                _rows[item.Id] = row;
            }
            else
            {
                row.Update(item, downloads.Fraction(item));
            }
            order.Add(row);
        }
        foreach (var gone in _rows.Keys.Except(items.Select(i => i.Id)).ToList()) _rows.Remove(gone);
        if (!_list.Children.SequenceEqual(order))
        {
            _list.Children.Clear();
            foreach (var row in order) _list.Children.Add(row);
        }
    }

    private static string Summary(DownloadCenter downloads, IReadOnlyList<DownloadItem> items)
    {
        var done = items.Where(i => i.Status == DownloadStatus.Done).ToList();
        var bytes = done.Sum(i => i.Bytes);
        var folder = downloads.Folder;
        return done.Count == 0 ? $"Saved to {folder}" : $"{done.Count} saved, {ByteCount.File(bytes)} in {folder}";
    }

    private FrameworkElement Header(DownloadCenter downloads, IReadOnlyList<DownloadItem> items)
    {
        var p = Theme.P;
        _summary = Ui.Line(Summary(downloads, items), Typeface.Ui(12.5), p.Ink3);
        var titles = Ui.VStack(6, Ui.Line("Downloads", Typeface.Title(30), p.Ink), _summary);
        var show = Buttons.Outline("Show in File Explorer", () =>
        {
            var folder = _session.Downloads.Folder;
            try
            {
                Directory.CreateDirectory(folder);
                Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { folder }, UseShellExecute = false });
            }
            catch (Exception)
            {
                // Like the Mac's `try?`: nothing to show.
            }
        });
        // Sits on the title's first baseline, as the Mac aligns them.
        show.VerticalAlignment = VerticalAlignment.Top;
        show.Margin = new Thickness(0, 7, 0, 0);
        titles.VerticalAlignment = VerticalAlignment.Top;
        return Ui.Row(0, titles.Fill(), show).Padding(32, 34, 32, 18);
    }

    private static FrameworkElement EmptyState()
    {
        var p = Theme.P;
        var icon = Ui.Icon(Glyph.Download, 40, p.Ink3);
        icon.HorizontalAlignment = HorizontalAlignment.Center;
        var heading = Ui.Line("Nothing downloaded yet", Typeface.Title(22), p.Ink);
        heading.HorizontalAlignment = HorizontalAlignment.Center;
        var body = Ui.Text(
            "Start a film on any site, then press Download in the player's corner, or Ctrl+Shift+S. Cineon saves the file the player streams, so it plays here without the site.",
            Typeface.Ui(13), p.Ink2);
        body.TextAlignment = TextAlignment.Center;
        body.HorizontalAlignment = HorizontalAlignment.Center;
        body.MaxWidth = 420;
        var stack = Ui.VStack(14, icon, heading, body);
        stack.HorizontalAlignment = HorizontalAlignment.Center;
        stack.VerticalAlignment = VerticalAlignment.Center;
        stack.Margin = new Thickness(0, 0, 0, 60);
        return stack;
    }
}

/// One download: its poster, what it is, how far along, and what can be done with it.
public sealed class DownloadRow : Component
{
    private readonly AppModel _app;
    private readonly ProfileSession _session;
    private readonly Border _root = new()
    {
        Padding = new Thickness(10),
        CornerRadius = new CornerRadius(10),
        Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
        BackgroundTransition = new BrushTransition { Duration = TimeSpan.FromSeconds(0.12) },
    };
    private DownloadItem _item;
    private double _fraction;
    private bool _hovered;
    private (string? Url, bool HasTitle) _libraryShape;

    // Kept between rebuilds: the poster (so it doesn't load again) and the live progress.
    private FrameworkElement? _poster;
    private string? _posterKey;
    private ProgressLine? _progress;
    private TextBlock? _progressText;

    public DownloadRow(AppModel app, ProfileSession session, DownloadItem item, double fraction)
    {
        _app = app;
        _session = session;
        _item = item;
        _fraction = fraction;
        PointerEntered += (_, _) => SetHovered(true);
        PointerExited += (_, _) => SetHovered(false);
        PointerCanceled += (_, _) => SetHovered(false);
        DoubleTapped += (_, e) =>
        {
            if (_item.Status != DownloadStatus.Done) return;
            e.Handled = true;
            _app.PlayDownload(_item);
        };
        RightTapped += (_, e) =>
        {
            e.Handled = true;
            Inputs.ShowMenu(this, MenuItems, e.GetPosition(this));
        };
    }

    private DownloadCenter Downloads => _session.Downloads;

    private Title? LibraryTitle => _item.TitleId is long id ? _session.Library.Titles.GetValueOrDefault(id) : null;

    private Uri? PosterUrl =>
        LibraryTitle?.PosterUrl ?? _item.PosterUrl
        ?? (_item.TitleId is long id && _session.Library.BestFramePath(id) is { } frame ? new Uri(frame) : null);

    protected override void OnAppeared()
    {
        _session.Library.PropertyChanged += LibraryChanged;
        // The library may have changed while the row was off screen.
        if (LibraryShape() != _libraryShape) Invalidate();
    }

    protected override void OnDisappeared() => _session.Library.PropertyChanged -= LibraryChanged;

    /// Only a new poster or a title coming or going changes the row.
    private void LibraryChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (LibraryShape() != _libraryShape) Invalidate();
    }

    private (string?, bool) LibraryShape() => (PosterUrl?.OriginalString, LibraryTitle is not null);

    /// What the rebuilt parts show. Bytes only show once a download is done; until then they're
    /// progress, which updates in place.
    private static DownloadItem Shape(DownloadItem item) =>
        item.Status.IsActive ? item with { Bytes = 0, TotalBytes = 0 } : item;

    public void Update(DownloadItem item, double fraction)
    {
        var rebuild = Shape(item) != Shape(_item);
        _item = item;
        _fraction = fraction;
        if (rebuild)
        {
            Invalidate();
            return;
        }
        if (_progress is not null) _progress.Fraction = fraction;
        if (_progressText is not null) _progressText.Text = ProgressText(fraction);
    }

    private void SetHovered(bool hovered)
    {
        _hovered = hovered;
        _root.Background = new SolidColorBrush(hovered ? Theme.P.Raised : Microsoft.UI.Colors.Transparent);
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        _libraryShape = LibraryShape();
        _root.Background = new SolidColorBrush(_hovered ? p.Raised : Microsoft.UI.Colors.Transparent);

        var name = Ui.Line(_item.Name, Typeface.Title(17), p.Ink);
        UIElement? badge = null;
        if (_item.EpisodeBadge is { } text)
        {
            badge = Ui.Line(text, Typeface.Time(11, Typeface.Medium), p.Ink2)
                .Padding(6, 2)
                .Background(p.Raised2, 4);
        }
        var nameRow = Ui.Row(8, name.Fill(), badge).Leading();
        var texts = Ui.VStack(5, nameRow, Ui.Line(DetailLine(), Typeface.Ui(12), p.Ink3), Status());
        texts.VerticalAlignment = VerticalAlignment.Center;

        var actions = Actions();
        actions.Margin = new Thickness(12, 0, 0, 0);
        _root.Child = Ui.Row(16, Poster(), texts.Fill(), actions);
        return _root;
    }

    private FrameworkElement Poster()
    {
        var url = PosterUrl;
        var key = $"{url?.OriginalString}|{Theme.P.IsDark}";
        if (_poster is null || key != _posterKey)
        {
            _posterKey = key;
            var image = new RemoteImage(url, Posters.Placeholder(_item.Name), fill: true, cornerRadius: 5);
            _poster = new Border { Width = 54, Height = 81, CornerRadius = new CornerRadius(5), Child = image };
        }
        return _poster.Detached();
    }

    private string DetailLine()
    {
        var item = _item;
        var parts = new List<string> { DomainName.Registrable(item.Host) };
        if (item.Quality is { } quality) parts.Add(quality);
        if (item.Kind == MediaSourceKind.Hls) parts.Add("stream");
        if (item.Status == DownloadStatus.Done && item.Bytes > 0) parts.Add(ByteCount.File(item.Bytes));
        if (item.Duration > 0) parts.Add(Timecode.Spoken(item.Duration));
        if (item.Subtitles.Count > 0) parts.Add(item.Subtitles.Count == 1 ? "subtitles" : $"{item.Subtitles.Count} subtitles");
        return string.Join(" · ", parts);
    }

    private UIElement? Status()
    {
        var p = Theme.P;
        _progress = null;
        _progressText = null;
        switch (_item.Status)
        {
            case DownloadStatus.Queued or DownloadStatus.Downloading:
                _progress = new ProgressLine(_fraction, 3) { Width = 260 };
                _progressText = Ui.Line(ProgressText(_fraction), Typeface.Time(11.5), p.Ink2);
                return Ui.HStack(10, _progress, _progressText).Margin(0, 2, 0, 0);
            case DownloadStatus.Failed:
                return Ui.Text(_item.Error ?? "Didn't finish", Typeface.Ui(12), p.Ink2, maxLines: 2);
            default:
                if (_item.Position > 5 && _item.Duration > 0)
                {
                    return Ui.HStack(10,
                            new ProgressLine(_item.WatchedFraction, 2) { Width = 160 },
                            Ui.Line($"{Timecode.Spoken(Math.Max(0, _item.Duration - _item.Position))} left", Typeface.Ui(11.5), p.Ink3))
                        .Margin(0, 2, 0, 0);
                }
                return null;
        }
    }

    private string ProgressText(double fraction)
    {
        var item = _item;
        if (item.Status != DownloadStatus.Downloading || fraction <= 0) return "Starting…";
        var percent = (int)(fraction * 100);
        if (item.TotalBytes > 0) return $"{percent}%  {ByteCount.File(item.Bytes)} of {ByteCount.File(item.TotalBytes)}";
        return $"{percent}%";
    }

    private FrameworkElement Actions()
    {
        var p = Theme.P;
        var item = _item;
        Button main = item.Status switch
        {
            DownloadStatus.Done => Buttons.Silver(item.Position > 5 ? $"Resume at {Timecode.String(item.Position)}" : "Play", Glyph.Play, () => _app.PlayDownload(_item)),
            DownloadStatus.Failed => Buttons.Outline("Try again", () => Downloads.Retry(_item.Id)),
            _ => Buttons.Icon(Glyph.Close, "Stop downloading", () => Downloads.Cancel(_item.Id)),
        };
        var dots = new Border { Width = 26, Height = 26, Child = Ui.Icon(Glyph.More, 13, p.Ink2).Centered() };
        var more = Inputs.MenuButton(dots, MenuItems, "More");
        return Ui.HStack(6, main, more);
    }

    private void MenuItems(IList<MenuFlyoutItemBase> menu)
    {
        var item = _item;
        if (item.Status == DownloadStatus.Done) menu.Add(Inputs.Item("Play", () => _app.PlayDownload(_item)));
        menu.Add(Inputs.Item("Show in File Explorer", () => Downloads.ShowInFileExplorer(_item)));
        if (item.PageUrl is { } page)
        {
            menu.Add(Inputs.Item("Open the Page", () =>
            {
                _app.Browser.OpenTab(page, select: true);
                _app.Go(Route.Web);
            }));
        }
        if (LibraryTitle is { } title) menu.Add(Inputs.Item("Details", () => _app.DetailTitleId = title.Id));
        menu.Add(Inputs.Separator());
        menu.Add(Inputs.Item(item.Status == DownloadStatus.Done ? "Move to Recycle Bin" : "Remove", () => Downloads.Remove(_item.Id)));
    }
}

/// A season being fetched: which episode the helper is on, and what's queued.
public sealed class SeasonJobCard : Component
{
    private readonly AppModel _app;
    private readonly ProfileSession _session;
    /// Kept between rebuilds, so it keeps turning.
    private ProgressRing? _spinner;

    public SeasonJobCard(AppModel app, ProfileSession session)
    {
        _app = app;
        _session = session;
        WatchHandler(h => session.Seasons.Changed += h, h => session.Seasons.Changed -= h);
    }

    private SeasonGrabber Seasons => _session.Seasons;

    protected override UIElement Render()
    {
        var p = Theme.P;
        if (Seasons.CurrentJob is not { } job) return new Grid();

        FrameworkElement state;
        if (job.IsFinished)
        {
            state = Ui.Icon(job.Missed.Count == 0 ? MiscGlyph.CheckCircle : MiscGlyph.ExclamationCircle, 18, p.Ink2);
        }
        else if (job.IsPaused)
        {
            state = Ui.Icon(Glyph.Pause, 18, p.Ink2);
        }
        else
        {
            if (_spinner is null || _spinner.Tag as Palette != p) _spinner = Inputs.Spinner(16);
            _spinner.Tag = p;
            state = _spinner.Detached();
        }

        var texts = Ui.VStack(3,
            Ui.Line(Heading(job), Typeface.Title(15), p.Ink),
            Ui.Text(Detail(job), Typeface.Ui(12), p.Ink3, maxLines: 2));

        var count = job.Episodes.Count;
        var progress = new ProgressLine(count == 0 ? 0 : (double)job.Handled / count, 3) { Width = 140 };
        var tally = Ui.Line($"{job.Handled} of {count}", Typeface.Time(10.5), p.Ink3);
        tally.HorizontalAlignment = HorizontalAlignment.Right;
        var measure = Ui.VStack(5, progress, tally);

        var buttons = Ui.HStack(14);
        if (job.IsPaused) buttons.Children.Add(Buttons.Silver("Carry on", () => Seasons.Resume()));
        buttons.Children.Add(Buttons.Outline(job.IsFinished ? "Dismiss" : "Stop", () =>
        {
            if (Seasons.CurrentJob?.IsFinished == true) Seasons.Dismiss();
            else Seasons.Cancel();
        }));
        var row = Ui.Row(14, state, texts.Fill(), measure, buttons);
        return row.Padding(14).Background(p.Raised, 12);
    }

    private static string Heading(SeasonGrabber.Job job)
    {
        if (job.IsFinished) return $"{job.Label}: {job.Queued.Count} of {job.Episodes.Count} queued";
        if (job.IsPaused) return $"{job.Label}, paused";
        return $"Getting {job.Label}";
    }

    private static string Detail(SeasonGrabber.Job job)
    {
        if (job.IsPaused) return $"Stopped when Cineon closed, with {job.Remaining.Count} episodes to go. Carry on picks up where it left off.";
        if (job.Current is { } current) return $"Opening {current.ShortLabel} to find its file. Two download at a time, the rest wait their turn.";
        if (job.Missed.Count > 0) return $"Couldn't find the file for {string.Join(", ", job.Missed.Select(e => e.ShortLabel))}. Open those episodes and download them by hand.";
        return "Each episode's link is fetched right before its turn, so none expire while waiting.";
    }
}

/// Segoe Fluent Icons for SF Symbols these screens use that the shared `Glyph` table doesn't have.
internal static class MiscGlyph
{
    /// checkmark.circle
    public const string CheckCircle = "";
    /// exclamationmark.circle
    public const string ExclamationCircle = "";
    /// chevron.left
    public const string ChevronLeft = "";
    /// macwindow
    public const string Window = "";
    /// square.stack.3d.up
    public const string Stack = "";
    /// square.and.arrow.down
    public const string Import = "";
    /// arrow.up.forward
    public const string GoTo = "";
    /// moon.zzz.fill
    public const string MoonFilled = "";
    /// captions.bubble.fill
    public const string CaptionsFilled = "";
}
