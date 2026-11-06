using System.Globalization;
using Cineon.Core.Data;
using Cineon.Core.Import;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cineon.App.UI;

/// Everything you've watched, as one long strip of film. Row heights are multiples of the
/// perforation pitch, so the holes line up from row to row. Ported from
/// Cineon/UI/WatchTimelineView.swift. The rows are an ItemsRepeater, so a long history only makes
/// the rows on screen.
public sealed class TimelinePage : Component
{
    /// Wide enough for a 16:9 frame between the perforations.
    internal const double StripWidth = 190;
    internal const double StripLeading = 32;
    internal const double FrameWidth = 156;
    internal const double FrameHeight = FilmStripBody.Pitch * 6 - 8;

    private readonly AppModel _app;
    private bool _showBrowsing;
    private string _query = "";
    private Palette? _switchPalette;

    private readonly Grid _root = new();
    private readonly TextBlock _title;
    private readonly Border _switchHost = new();
    private readonly SearchField _filter;
    private readonly Border _statsHost = new();
    private readonly ScrollViewer _scroll;
    private readonly ItemsRepeater _repeater;
    private readonly Border _empty = new();
    private List<TimelineRow> _rows = [];
    private Palette? _rowsPalette;
    private readonly Dictionary<UIElement, int> _realized = [];

    public TimelinePage(AppModel app)
    {
        _app = app;
        var watch = new LibraryWatch(app);
        Watch(watch.Subscribe, watch.Unsubscribe);

        _title = Ui.Line("Timeline", Typeface.Title(30), Theme.P.Ink);
        _title.VerticalAlignment = VerticalAlignment.Bottom;
        _filter = new SearchField("Filter", 120, capsule: false, text =>
        {
            if (text == _query) return;
            _query = text;
            Invalidate();
        });
        // On the title's baseline, as `.firstTextBaseline` puts them.
        _switchHost.VerticalAlignment = VerticalAlignment.Bottom;
        _switchHost.Margin = new Thickness(0, 0, 0, 7);
        _filter.Root.VerticalAlignment = VerticalAlignment.Bottom;
        _filter.Root.Margin = new Thickness(0, 0, 0, 3);
        var titleRow = Ui.Row(8, _title, Ui.Spacer(), _switchHost, _filter.Root);
        var header = Ui.VStack(12, titleRow, _statsHost);
        header.Padding = new Thickness(32, 34, 32, 20);

        _repeater = new ItemsRepeater { Layout = new StackLayout { Spacing = 0 }, ItemTemplate = RepeaterCells.Template() };
        _repeater.ElementPrepared += (_, e) => Prepare(e.Element, e.Index);
        _repeater.ElementClearing += (_, e) =>
        {
            _realized.Remove(e.Element);
            if (e.Element is Border border) border.Child = null;
        };
        _repeater.ElementIndexChanged += (_, e) => _realized[e.Element] = e.NewIndex;
        _scroll = new ScrollViewer
        {
            Content = _repeater,
            HorizontalScrollMode = ScrollMode.Disabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            VerticalScrollMode = ScrollMode.Enabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Hidden,
        };

        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _root.Children.Add(header.Cell(row: 0));
        _root.Children.Add(Ui.ZStack(_scroll, _empty).Cell(row: 1));
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        _root.Background = new SolidColorBrush(p.CardFill);
        _title.Foreground = new SolidColorBrush(p.Ink);
        // Kept while the theme stays, so its knob slides instead of being rebuilt in place.
        if (!ReferenceEquals(_switchPalette, p))
        {
            _switchPalette = p;
            _switchHost.Child = PageButtons.Switch("Show pages I browsed", _showBrowsing, on =>
            {
                _showBrowsing = on;
                Invalidate();
            }, p.Ink2, tint: p.IsDark ? Palette.Grey(0.75) : Microsoft.UI.Colors.Black);
        }
        _filter.Text = _query;
        _statsHost.Child = Stats();

        var rows = Rows();
        var isEmpty = rows.Count == 0;
        _empty.Visibility = isEmpty ? Visibility.Visible : Visibility.Collapsed;
        _empty.Child = isEmpty
            ? TitleText.Empty("Play something on any site, and it's recorded here: what, where, and how far you got.", maxWidth: 380)
            : null;
        _scroll.Visibility = isEmpty ? Visibility.Collapsed : Visibility.Visible;
        SetRows(isEmpty ? [] : rows);
        return _root;
    }

    /// The same rows in the same order rebuild only the ones that changed, so the rest keep their
    /// hover and their pictures. Anything else starts the list over.
    private void SetRows(List<TimelineRow> next)
    {
        // Day headings, notes and the roll's end aren't components, so a new theme rebuilds them.
        var repaint = !ReferenceEquals(_rowsPalette, Theme.P);
        _rowsPalette = Theme.P;
        if (next.Count == _rows.Count && next.Select(r => r.Key).SequenceEqual(_rows.Select(r => r.Key)))
        {
            var old = _rows;
            _rows = next;
            foreach (var (element, index) in _realized.ToList())
            {
                if (index < next.Count && (repaint || next[index] != old[index])) Prepare(element, index);
            }
            return;
        }
        _rows = next;
        _realized.Clear();
        _repeater.ItemsSource = next.Count == 0 ? null : next;
    }

    private void Prepare(UIElement element, int index)
    {
        if (element is not Border border || index >= _rows.Count) return;
        _realized[element] = index;
        if (_rows[index] is TimelineRow.Session session)
        {
            // Built now, so the layout measures the real row rather than an empty one.
            var row = new TimelineSessionRow(_app, session.Value);
            row.RenderNow();
            border.Child = row;
            return;
        }
        border.Child = _rows[index] switch
        {
            TimelineRow.Day day => DayHeader(day.Date),
            TimelineRow.Note note => NoteRow(note.Time, note.Text, note.Name),
            _ => RollEnd(),
        };
    }

    // MARK: Data

    private List<TimelineRow> Rows()
    {
        var library = _app.Library;
        var needle = LibraryText.Normalize(_query);
        bool Matches(long id) => needle.Length == 0 || (library.Titles.TryGetValue(id, out var t) && t.NormName.Contains(needle, StringComparison.Ordinal));

        var entries = new List<(DateTimeOffset Date, TimelineRow Row)>();
        foreach (var session in library.Sessions)
        {
            if (Matches(session.TitleId)) entries.Add((session.StartedAt, new TimelineRow.Session(session)));
        }
        foreach (var e in library.Events)
        {
            if (e.Kind == LibraryEventKind.MarkedWatching || !Matches(e.TitleId)) continue;
            var name = library.Titles.TryGetValue(e.TitleId, out var t) ? t.Name : "";
            entries.Add((e.At, new TimelineRow.Note($"e{e.Id}", e.At, e.Kind.Label, name)));
        }
        if (_showBrowsing)
        {
            IReadOnlyList<HistoryEntry> visits;
            try { visits = _app.Session.Db.RecentHistory(limit: 300); }
            catch (Exception) { visits = []; }
            foreach (var visit in visits)
            {
                if (needle.Length > 0 && !LibraryText.Normalize(visit.Title + visit.Host).Contains(needle, StringComparison.Ordinal)) continue;
                var name = visit.Title.Length == 0 ? Uri.UnescapeDataString(visit.Url.AbsolutePath) : visit.Title;
                entries.Add((visit.VisitedAt, new TimelineRow.Note($"h{visit.Id}", visit.VisitedAt, visit.Host, name)));
            }
        }

        var rows = new List<TimelineRow>();
        foreach (var day in entries.GroupBy(entry => entry.Date.ToLocalTime().Date).OrderByDescending(group => group.Key))
        {
            rows.Add(new TimelineRow.Day(day.Key));
            rows.AddRange(day.OrderByDescending(entry => entry.Date).Select(entry => entry.Row));
        }
        // The strip runs off the end of the roll.
        if (rows.Count > 0) rows.Add(new TimelineRow.End());
        return rows;
    }

    private double Total(DateTimeOffset since) =>
        _app.Library.Sessions.Where(s => s.StartedAt >= since).Sum(s => s.WatchedSeconds);

    private FrameworkElement? Stats()
    {
        var now = DateTime.Now;
        var first = CultureInfo.CurrentCulture.DateTimeFormat.FirstDayOfWeek;
        var week = new DateTimeOffset(now.Date.AddDays(-(((int)now.DayOfWeek - (int)first + 7) % 7)));
        var month = new DateTimeOffset(new DateTime(now.Year, now.Month, 1));
        var weekTotal = Total(week);
        var monthTotal = Total(month);
        if (monthTotal <= 0 && weekTotal <= 0) return null;
        return Ui.HStack(22, Stat("This week", weekTotal), Stat("This month", monthTotal));
    }

    private static FrameworkElement Stat(string label, double seconds)
    {
        var p = Theme.P;
        return Ui.HStack(6,
            Ui.Line(label, Typeface.Ui(13), p.Ink3),
            Ui.Line(seconds > 0 ? Timecode.Spoken(seconds) : "None", Typeface.Ui(13), p.Ink));
    }

    // MARK: Rows

    internal static FilmStripBody Strip(double height) => new() { Width = StripWidth, Height = height };

    /// A day heading sits beside a clear stretch of film, like the gap between shots.
    private static FrameworkElement DayHeader(DateTime day)
    {
        var p = Theme.P;
        var date = new DateTimeOffset(day);
        var text = Ui.Line(DateText.Day(date), Typeface.Title(20), p.Ink);
        text.Margin = new Thickness(0, 14, 0, 0);
        var row = Ui.Row(22, Strip(FilmStripBody.Pitch * 4), text.Fill());
        row.Padding = new Thickness(StripLeading, 0, 0, 0);
        return row;
    }

    /// Smaller moments: added to backlog, marked as watched, a page visited.
    private static FrameworkElement NoteRow(DateTimeOffset time, string text, string name)
    {
        var p = Theme.P;
        var line = Ui.Row(6,
            Ui.Line(DateText.Time(time), Typeface.Time(12), p.Ink3),
            Ui.Line(text + ":", Typeface.Ui(12.5), p.Ink3),
            Ui.Line(name, Typeface.Ui(12.5, Typeface.Medium), p.Ink2).Fill());
        var row = Ui.Row(22, Strip(FilmStripBody.Pitch * 2), line.Fill());
        row.Padding = new Thickness(StripLeading, 0, 28, 0);
        return row;
    }

    private static FrameworkElement RollEnd()
    {
        var p = Theme.P;
        // The Mac masks the strip with a gradient; over the page's own colour, a fade to it looks the same.
        var fade = new Border
        {
            Background = Palette.Vertical(Palette.WithOpacity(p.CardFill, 0), p.CardFill),
            IsHitTestVisible = false,
        };
        var end = new Grid { Width = StripWidth, Height = FilmStripBody.Pitch * 6, Children = { Strip(FilmStripBody.Pitch * 6), fade } };
        end.HorizontalAlignment = HorizontalAlignment.Left;
        end.Margin = new Thickness(StripLeading, 0, 0, 0);
        return end;
    }
}

/// One row of the timeline.
internal abstract record TimelineRow
{
    /// What the row is, so a refresh can tell the same row with new data from a different row.
    public abstract string Key { get; }

    public sealed record Day(DateTime Date) : TimelineRow
    {
        public override string Key => $"d{Date.Ticks}";
    }

    public sealed record Session(WatchSession Value) : TimelineRow
    {
        public override string Key => $"s{Value.Id}";
    }

    public sealed record Note(string Id, DateTimeOffset Time, string Text, string Name) : TimelineRow
    {
        public override string Key => Id;
    }

    public sealed record End : TimelineRow
    {
        public override string Key => "end";
    }
}

/// A watching session: frames from it on the strip, what and where, and on hover a way back in
/// (the Mac's TimelineSessionRow). Finished ones are in black and white until the pointer is over them.
internal sealed class TimelineSessionRow : PressableComponent
{
    private readonly AppModel _app;
    private readonly WatchSession _session;
    private readonly List<FrameReel> _reels = [];
    private RemoteImage? _still;
    private FrameworkElement? _actions;

    public TimelineSessionRow(AppModel app, WatchSession session)
    {
        _app = app;
        _session = session;
        if (Title is { } title) this.Label(title.Name);
    }

    private Title? Title => _app.Library.Titles.GetValueOrDefault(_session.TitleId);

    private bool IsMono => _session.Finished && !IsHovered;

    protected override void Activate()
    {
        if (Title is { } title) _app.DetailTitleId = title.Id;
    }

    protected override MenuFlyout? ContextMenu()
    {
        var menu = new MenuFlyout();
        if (Title is { } title) TitleMenu.Add(menu, _app, title);
        menu.Items.Add(new MenuFlyoutSeparator());
        var id = _session.Id;
        menu.Items.Add(TitleMenu.Item("Remove from timeline", () => _app.Library.DeleteSession(id)));
        return menu;
    }

    protected override void OnHoverChanged(bool hovered)
    {
        _still?.SetSaturation(IsMono ? 0 : 1, 0.3);
        foreach (var reel in _reels) reel.SetMono(IsMono);
        if (_actions is not null) Motion.Reveal(_actions, hovered);
    }

    /// A still from the episode itself when there is one, else the backdrop, else the poster.
    private Uri? Still
    {
        get
        {
            var title = Title;
            if (_session.Ref.IsEpisode && title?.ImdbId is { } imdb)
            {
                return Urls.Parse($"https://episodes.metahub.space/{imdb}/{_session.Ref.Season}/{_session.Ref.Episode}/w780.jpg");
            }
            return title?.BackdropUrl ?? title?.PosterUrl;
        }
    }

    /// The more you watched, the more film: one picture per stretch, up to three, with the frames
    /// between them a hover away.
    private List<IReadOnlyList<FilmFrame>> Reels()
    {
        var frames = _app.Library.Frames(_session.Id);
        if (frames.Count == 0) return [];
        var wanted = Math.Min(Math.Min(3, frames.Count), (int)(_session.WatchedSeconds / 1500) + 1);
        var size = (double)frames.Count / wanted;
        return [.. Enumerable.Range(0, wanted).Select(i => (IReadOnlyList<FilmFrame>)frames.Skip((int)(i * size)).Take((int)((i + 1) * size) - (int)(i * size)).ToList())];
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var session = _session;
        var reels = Reels();
        _reels.Clear();
        _still = null;

        FrameworkElement film;
        if (reels.Count == 0)
        {
            _still = new RemoteImage(Still, new Border { Background = new SolidColorBrush(Palette.Grey(0.17)) }, fill: true, cornerRadius: 3, maxPixel: 320)
            {
                Width = TimelinePage.FrameWidth,
                Height = TimelinePage.FrameHeight,
            };
            _still.SetSaturation(IsMono ? 0 : 1, 0);
            film = new Grid
            {
                Width = TimelinePage.StripWidth,
                Height = FilmStripBody.Pitch * 6,
                Children = { TimelinePage.Strip(FilmStripBody.Pitch * 6), _still },
            };
        }
        else
        {
            var column = Ui.VStack(0);
            foreach (var frames in reels)
            {
                var reel = new FrameReel(_app, frames, session.Duration, session.Url, IsMono);
                _reels.Add(reel);
                column.Children.Add(reel);
            }
            film = column;
        }

        var top = reels.Count > 1 ? 12 : 0;
        var details = Details();
        details.Margin = new Thickness(0, top, 0, 0);
        _actions = Actions();
        if (_actions is not null)
        {
            _actions.Margin = new Thickness(34, top, 0, 0);
            _actions.Visibility = IsHovered ? Visibility.Visible : Visibility.Collapsed;
            Motion.Fade(_actions, IsHovered ? 1 : 0, 0);
        }
        var alignment = reels.Count > 1 ? VerticalAlignment.Top : VerticalAlignment.Center;
        film.VerticalAlignment = alignment;
        details.VerticalAlignment = alignment;
        if (_actions is not null) _actions.VerticalAlignment = alignment;

        var row = Ui.Row(22, film, details.Fill(), _actions);
        row.Padding = new Thickness(TimelinePage.StripLeading, 0, 28, 0);
        row.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        return row;
    }

    private StackPanel Details()
    {
        var p = Theme.P;
        var session = _session;
        var parts = new List<string>();
        if (session.Ref.IsEpisode)
        {
            parts.Add(session.EpisodeName is { } episode ? $"{session.Ref.ShortLabel}, {episode}" : session.Ref.LongLabel);
        }
        if (session.IsVisitOnly)
        {
            // Nothing to add: the line below says when it was opened.
        }
        else if (session.Finished)
        {
            parts.Add("Finished");
        }
        else if (session.Duration > 0)
        {
            parts.Add($"Stopped at {Timecode.String(session.EndPosition)} of {Timecode.String(session.Duration)}");
        }
        var subtitle = string.Join(". ", parts);
        var times = session.IsVisitOnly
            ? $"Opened at {DateText.Time(session.StartedAt)}"
            : $"{DateText.Time(session.StartedAt)} to {DateText.Time(session.EndedAt)}";
        var fraction = session.Duration > 0 ? Math.Min(1, session.EndPosition / session.Duration) : 0;
        return Ui.VStack(3,
            Ui.Line(Title?.Name ?? "Removed title", Typeface.Title(18), p.Ink),
            subtitle.Length > 0 ? Ui.Line(subtitle, Typeface.Ui(12.5), p.Ink2) : null,
            Ui.Line($"{times} on {DomainName.Registrable(session.Host)}", Typeface.Time(12), p.Ink3),
            session.Duration > 0 ? Progress.Line(fraction, 2).Size(width: 180).Leading().Margin(0, 4, 0, 0) : null);
    }

    private FrameworkElement? Actions()
    {
        var session = _session;
        var canResume = session.Url is not null && !session.Finished && !session.IsVisitOnly;
        if (canResume && session.Url is { } url)
        {
            return PageButtons.Silver($"Resume at {Timecode.String(session.EndPosition)}", Glyph.Play, () => _app.Resume(url, session.EndPosition));
        }
        if (session.Url is { } page)
        {
            return PageButtons.Outline("Open page", null, () => _app.Browser.Open(page));
        }
        return null;
    }
}

/// One frame in the film strip. Moving across it flips through the frames around it, and clicking
/// carries on from the second that frame shows (the Mac's FrameReel).
internal sealed class FrameReel : Grid
{
    private readonly AppModel _app;
    private readonly IReadOnlyList<FilmFrame> _frames;
    private readonly Uri? _fallbackUrl;
    private readonly FilmFrame _hero;
    private readonly RemoteImage _image;
    private readonly Border _time;
    private readonly TextBlock _timeText;
    private int? _scrubIndex;
    private bool _primed;

    public FrameReel(AppModel app, IReadOnlyList<FilmFrame> frames, double duration, Uri? fallbackUrl, bool isMono)
    {
        _app = app;
        _frames = frames;
        _fallbackUrl = fallbackUrl;
        // The most interesting frame, leaving out the end where possible: a screen full of credits
        // scores well, and tells you nothing. A moment someone saved always wins.
        var story = frames.Where(f => f.IsMoment || duration <= 0 || f.Position < duration * 0.85).ToList();
        _hero = (story.Count > 0 ? story : frames).MaxBy(f => f.Interest) ?? frames[0];

        Width = TimelinePage.StripWidth;
        Height = FilmStripBody.Pitch * 6;
        _image = new RemoteImage(FrameFiles.Url(app.Library, _hero), new Border { Background = new SolidColorBrush(Palette.Grey(0.17)) }, fill: true, cornerRadius: 3, maxPixel: 480);
        _image.SetSaturation(isMono ? 0 : 1, 0);
        _timeText = Ui.Line("", Typeface.Time(10.5), Microsoft.UI.Colors.White);
        _time = new Border
        {
            Child = _timeText,
            Padding = new Thickness(5, 2, 5, 2),
            CornerRadius = new CornerRadius(3),
            Background = new SolidColorBrush(Palette.Grey(0, 0.62)),
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Bottom,
            Margin = new Thickness(4),
            Visibility = Visibility.Collapsed,
            IsHitTestVisible = false,
        };
        var picture = new Grid
        {
            Width = TimelinePage.FrameWidth,
            Height = TimelinePage.FrameHeight,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            Children = { _image, _time },
        };
        Children.Add(TimelinePage.Strip(FilmStripBody.Pitch * 6));
        Children.Add(picture);

        Ui.Hand(picture);
        picture.PointerMoved += (_, e) =>
        {
            if (_frames.Count <= 1) return;
            Prime();
            var fraction = Math.Min(0.999, Math.Max(0, e.GetCurrentPoint(picture).Position.X / TimelinePage.FrameWidth));
            Scrub((int)(fraction * _frames.Count));
        };
        picture.PointerExited += (_, _) => Scrub(null);
        picture.PointerCanceled += (_, _) => Scrub(null);
        picture.Tapped += (_, e) =>
        {
            e.Handled = true;
            var frame = Shown;
            if ((frame.Url ?? _fallbackUrl) is { } url) _app.Resume(url, frame.Position);
        };
        UpdateHelp(picture);
        _picture = picture;
    }

    private readonly Grid _picture;

    private FilmFrame Shown => _scrubIndex is int index ? _frames[Math.Min(index, _frames.Count - 1)] : _hero;

    public void SetMono(bool mono) => _image.SetSaturation(mono ? 0 : 1, 0.3);

    /// Loaded the moment the pointer arrives, so scrubbing never shows an empty frame, and not
    /// before, so a long timeline stays light.
    private void Prime()
    {
        if (_primed) return;
        _primed = true;
        foreach (var frame in _frames)
        {
            if (FrameFiles.Url(_app.Library, frame) is { } url) ImageSurfaces.Preload(url, 480);
        }
    }

    private void Scrub(int? index)
    {
        if (_scrubIndex == index) return;
        _scrubIndex = index;
        var shown = Shown;
        _image.Url = FrameFiles.Url(_app.Library, shown);
        _timeText.Text = Timecode.String(shown.Position);
        _time.Visibility = index is null ? Visibility.Collapsed : Visibility.Visible;
        UpdateHelp(_picture);
    }

    private void UpdateHelp(FrameworkElement picture)
    {
        var position = Timecode.String(Shown.Position);
        ToolTipService.SetToolTip(picture, $"Carry on from {position}");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(picture, $"Frame at {position}");
    }
}
