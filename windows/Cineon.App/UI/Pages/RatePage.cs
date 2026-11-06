using System.Globalization;
using System.Numerics;
using Cineon.Core.Data;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace Cineon.App.UI;

/// Rates everything you've watched, one poster at a time, as fast as you can press keys. Unrated
/// films come first, most recently watched first. Every rating saves as it's given. Ported from
/// Cineon/UI/RateModeView.swift: 1 to 0 rate (0 is ten) and move on, arrows add or take away half a
/// star, Backspace or Delete clears, Enter or Space skips, Esc goes back to the library.
public sealed class RatePage : Component
{
    private readonly AppModel _app;
    private List<long> _queue = [];
    private int _index;
    private bool _includeRated;
    private int _rated;
    private CancellationTokenSource? _advance;

    private readonly Grid _root = new();
    private readonly Grid _backdrop = new() { IsHitTestVisible = false };
    private readonly Border _shade = new() { IsHitTestVisible = false };
    private readonly Grid _stage = new();
    private long? _backdropId;
    private string? _shownKey;
    private Palette? _shownPalette;
    private RateCard? _card;
    private bool _animateNext;
    /// Bumped whenever the queue is built again, so the card shows the new count and upcoming posters.
    private int _queueVersion;
    /// Cards on their way out, left to finish their slide.
    private readonly HashSet<UIElement> _leaving = [];

    public RatePage(AppModel app)
    {
        _app = app;
        var watch = new LibraryWatch(app);
        Watch(watch.Subscribe, watch.Unsubscribe);
        IsTabStop = true;
        UseSystemFocusVisuals = false;
        // Behind, not beside: a poster filling the page mustn't push the card around.
        _root.Children.Add(_backdrop);
        _root.Children.Add(_shade);
        _root.Children.Add(_stage);
        _root.SizeChanged += (_, _) => _root.Clip = new RectangleGeometry { Rect = new Windows.Foundation.Rect(0, 0, _root.ActualWidth, _root.ActualHeight) };
        KeyDown += OnKey;
        // A click on the page (not on a button, which keeps its own press) brings the keys back here.
        PointerPressed += (_, _) => FocusPage();
    }

    private Title? Current =>
        _index >= 0 && _index < _queue.Count && _app.Library.Titles.TryGetValue(_queue[_index], out var title) ? title : null;

    protected override void OnAppeared()
    {
        BuildQueue();
        DispatcherQueue?.TryEnqueue(FocusPage);
    }

    protected override void OnDisappeared() => _advance?.Cancel();

    private void FocusPage()
    {
        if (XamlRoot is null) return;
        Focus(FocusState.Programmatic);
    }

    // MARK: Queue

    private void BuildQueue()
    {
        var candidates = _app.Library.Titles.Values.Where(title =>
            (title.Status == TitleStatus.Watched || (title.Status == TitleStatus.Watching && title.Kind == TitleKind.Series))
            && (_includeRated || title.RatingHalves is null));
        _queue = [.. candidates
            .OrderByDescending(t => t.FinishedAt ?? t.LastWatchedAt ?? t.AddedAt)
            .Select(t => t.Id)];
        _index = 0;
        _rated = 0;
        _queueVersion++;
    }

    private void SetRating(int? halves, bool andMove)
    {
        if (Current is not { } title) return;
        _app.Library.SetRating(title.Id, halves);
        if (halves is not null) _rated++;
        if (!andMove) return;
        _advance?.Cancel();
        var cts = _advance = new CancellationTokenSource();
        _ = AdvanceLaterAsync(cts.Token);
    }

    private async Task AdvanceLaterAsync(CancellationToken token)
    {
        try { await Task.Delay(380, token); }
        catch (TaskCanceledException) { return; }
        Next();
    }

    private void Nudge(int step)
    {
        if (Current is not { } title) return;
        _app.Library.SetRating(title.Id, Rating.Clamp((title.RatingHalves ?? 10) + step));
    }

    private void Next()
    {
        _advance?.Cancel();
        _index++;
        _animateNext = true;
        Invalidate();
    }

    private void Previous()
    {
        _advance?.Cancel();
        if (_index <= 0) return;
        _index--;
        _animateNext = true;
        Invalidate();
    }

    private void OnKey(object sender, KeyRoutedEventArgs e)
    {
        var (control, _, alt) = Shortcuts.Modifiers();
        if (control || alt) return;
        switch (e.Key)
        {
            case VirtualKey.Escape:
                // An overlay on top closes first; the window does that.
                if (_app.DetailTitleId is not null || _app.Sheet is not null || _app.IsCommandBarVisible || _app.IsProfilePickerVisible) return;
                _app.Go(Route.Library);
                break;
            case VirtualKey.Enter or VirtualKey.Space:
                Next();
                break;
            case VirtualKey.Left:
                Nudge(-1);
                break;
            case VirtualKey.Right:
                Nudge(1);
                break;
            case VirtualKey.Back or VirtualKey.Delete:
                SetRating(null, andMove: false);
                break;
            case >= VirtualKey.Number0 and <= VirtualKey.Number9:
                Digit((int)e.Key - (int)VirtualKey.Number0);
                break;
            case >= VirtualKey.NumberPad0 and <= VirtualKey.NumberPad9:
                Digit((int)e.Key - (int)VirtualKey.NumberPad0);
                break;
            default:
                return;
        }
        e.Handled = true;
    }

    private void Digit(int digit) => SetRating((digit == 0 ? 10 : digit) * 2, andMove: true);

    /// A button's action, then the keys come back to the page.
    private Action Then(Action action) => () =>
    {
        action();
        FocusPage();
    };

    // MARK: Rendering

    protected override UIElement Render()
    {
        var p = Theme.P;
        _root.Background = new SolidColorBrush(p.Canvas);
        var current = Current;
        ShowBackdrop(current);
        _shade.Visibility = current is null ? Visibility.Collapsed : Visibility.Visible;
        _shade.Background = Palette.Vertical(Palette.WithOpacity(p.Canvas, 0.2), Palette.WithOpacity(p.Canvas, 0.92));

        var key = current is null ? $"done:{_queueVersion}" : $"{_queueVersion}:{_index}:{current.Id}";
        var animate = _animateNext;
        _animateNext = false;
        if (key != _shownKey || !ReferenceEquals(_shownPalette, p))
        {
            var changedTitle = key != _shownKey;
            _shownKey = key;
            _shownPalette = p;
            FrameworkElement next;
            if (current is not null)
            {
                _card = new RateCard(this, current);
                next = _card;
            }
            else
            {
                _card = null;
                next = Finished();
            }
            Swap(next, animate && changedTitle);
        }
        else if (current is not null)
        {
            _card?.Update(current);
        }
        // A button that held the focus may have gone with the old card.
        if (XamlRoot is { } root && FocusManager.GetFocusedElement(root) is null)
        {
            DispatcherQueue?.TryEnqueue(FocusPage);
        }
        return _root;
    }

    /// The new card slides in from the trailing edge as the old one leaves by the leading edge,
    /// both fading, on the Mac's spring (response 0.42, damping 0.86).
    private void Swap(FrameworkElement next, bool animated)
    {
        // Cards already leaving keep going; only the one on screen (possibly still arriving) leaves now.
        var old = _stage.Children.Where(element => !_leaving.Contains(element)).ToList();
        _stage.Children.Add(next);
        if (!animated || !Motion.Enabled || old.Count == 0)
        {
            _stage.Children.Clear();
            _leaving.Clear();
            _stage.Children.Add(next);
            return;
        }
        var width = (float)Math.Max(1, _stage.ActualWidth);
        var compositor = ElementCompositionPreview.GetElementVisual(_stage).Compositor;
        SlideIn(compositor, next, width);
        var batch = compositor.CreateScopedBatch(CompositionBatchTypes.Animation);
        foreach (var element in old)
        {
            _leaving.Add(element);
            SlideOut(compositor, element, -width);
        }
        batch.End();
        batch.Completed += (_, _) =>
        {
            foreach (var element in old)
            {
                _leaving.Remove(element);
                _stage.Children.Remove(element);
            }
        };
    }

    private static SpringVector3NaturalMotionAnimation Move(Compositor compositor, Vector3 to)
    {
        var move = compositor.CreateSpringVector3Animation();
        move.FinalValue = to;
        move.DampingRatio = 0.86f;
        move.Period = Motion.Period(0.42);
        return move;
    }

    private static SpringScalarNaturalMotionAnimation Fade(Compositor compositor, float to)
    {
        var fade = compositor.CreateSpringScalarAnimation();
        fade.FinalValue = to;
        fade.DampingRatio = 0.86f;
        fade.Period = Motion.Period(0.42);
        return fade;
    }

    private static void SlideIn(Compositor compositor, UIElement element, float from)
    {
        ElementCompositionPreview.SetIsTranslationEnabled(element, true);
        var visual = ElementCompositionPreview.GetElementVisual(element);
        visual.Properties.InsertVector3("Translation", new Vector3(from, 0, 0));
        visual.Opacity = 0;
        var move = Move(compositor, Vector3.Zero);
        move.InitialValue = new Vector3(from, 0, 0);
        visual.StartAnimation("Translation", move);
        var fade = Fade(compositor, 1);
        fade.InitialValue = 0;
        visual.StartAnimation("Opacity", fade);
    }

    /// From wherever the card is now, so one still arriving turns round smoothly.
    private static void SlideOut(Compositor compositor, UIElement element, float to)
    {
        element.IsHitTestVisible = false;
        ElementCompositionPreview.SetIsTranslationEnabled(element, true);
        var visual = ElementCompositionPreview.GetElementVisual(element);
        if (visual.Properties.TryGetVector3("Translation", out _) != CompositionGetValueStatus.Succeeded)
        {
            visual.Properties.InsertVector3("Translation", Vector3.Zero);
        }
        visual.StartAnimation("Translation", Move(compositor, new Vector3(to, 0, 0)));
        visual.StartAnimation("Opacity", Fade(compositor, 0));
    }

    /// The film's backdrop, blurred far back behind the card. A new one fades in over the last.
    private void ShowBackdrop(Title? title)
    {
        if (title?.Id == _backdropId) return;
        _backdropId = title?.Id;
        if (title is null)
        {
            _backdrop.Children.Clear();
            return;
        }
        var image = new RemoteImage(title.BackdropUrl ?? title.PosterUrl, null, fill: true, maxPixel: 900, blur: 60)
        {
            FadeSeconds = 0.5,
            Opacity = 0.42,
        };
        _backdrop.Children.Add(image);
        _ = DropOlderBackdropsAsync(image);
    }

    private async Task DropOlderBackdropsAsync(UIElement newest)
    {
        try { await Task.Delay(900); }
        catch (Exception) { return; }
        var index = _backdrop.Children.IndexOf(newest);
        for (var i = index - 1; i >= 0; i--) _backdrop.Children.RemoveAt(i);
    }

    private FrameworkElement Finished()
    {
        var p = Theme.P;
        // TODO(port-screens-social): the pet, `new PixelPetView(_app.Session.Pet, 120, animated: true)`
        // from the profile port. The logo stands in until it merges.
        var pet = Images.LogoMark(120, p.Ink3);
        pet.HorizontalAlignment = HorizontalAlignment.Center;
        var heading = Ui.Line(_queue.Count == 0 ? "Nothing left to rate" : "That's all of them", Typeface.Title(30), p.Ink);
        heading.HorizontalAlignment = HorizontalAlignment.Center;
        var detail = Ui.Line(_rated > 0
            ? $"You rated {_rated} {(_rated == 1 ? "film" : "films")} just now. They're saved, in the cloud too."
            : "Everything you've watched has its stars.", Typeface.Ui(14), p.Ink2);
        detail.HorizontalAlignment = HorizontalAlignment.Center;
        var buttons = Ui.HStack(10,
            PageButtons.Outline("Go over rated ones", null, Then(() =>
            {
                _includeRated = true;
                BuildQueue();
                Invalidate();
            })),
            PageButtons.Silver("See your library", null, () => _app.Go(Route.Library)));
        buttons.HorizontalAlignment = HorizontalAlignment.Center;
        buttons.Margin = new Thickness(0, 6, 0, 0);
        var stack = Ui.VStack(16, pet, heading, detail, buttons);
        stack.HorizontalAlignment = HorizontalAlignment.Center;
        stack.VerticalAlignment = VerticalAlignment.Center;
        return stack;
    }

    /// One film's card: the header with how far along you are, the poster and its stars, and the
    /// next few posters under it.
    private sealed class RateCard : Grid
    {
        private readonly RatePage _page;
        private readonly StarRatingControl _stars;
        private readonly Button _next;

        public RateCard(RatePage page, Title title)
        {
            _page = page;
            var p = Theme.P;
            var app = page._app;
            Padding = new Thickness(0, 30, 0, 30);
            RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star), MinHeight = 20 });
            RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star), MinHeight = 20 });
            RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            Children.Add(Header().Cell(row: 0));

            var poster = Posters.Image(title, 230, cornerRadius: 10, keepsColour: true, fallback: FrameFiles.Best(app.Library, title.Id));
            poster.Shadow = new ThemeShadow();
            poster.Translation = new Vector3(0, 0, 40);

            _stars = new StarRatingControl(title.RatingHalves, value => page.SetRating(value, andMove: value is not null), size: 30, spacing: 5)
            {
                // The page takes the arrows and Delete; the stars' own keys would rate and move on.
                IsTabStop = false,
                Margin = new Thickness(0, 18, 0, 0),
                HorizontalAlignment = HorizontalAlignment.Left,
            };
            _next = PageButtons.Silver("Next", null, page.Then(page.Next));
            _next.Visibility = title.RatingHalves is null ? Visibility.Collapsed : Visibility.Visible;
            var buttons = Ui.HStack(10,
                PageButtons.Outline("Skip", null, page.Then(page.Next)),
                page._index > 0 ? Buttons.Hover(Ui.Line("Back", Typeface.Ui(13), p.Ink2), page.Then(page.Previous)) : null,
                _next);
            buttons.Margin = new Thickness(0, 8, 0, 0);
            var hint = Ui.Text("Click a star, or press 1 to 0. Arrows add or take away half a star.", Typeface.Ui(12), p.Ink3);

            var info = Ui.VStack(14,
                Ui.Text(title.Name, Typeface.Title(42), p.Ink, maxLines: 3).ShrinkToFit(0.6),
                Ui.Text(Detail(title), Typeface.Ui(14), p.Ink2),
                _stars,
                hint,
                buttons);
            info.VerticalAlignment = VerticalAlignment.Center;
            var main = Ui.HStack(46, poster, info);
            main.HorizontalAlignment = HorizontalAlignment.Center;
            main.Margin = new Thickness(60, 0, 60, 0);
            // `.frame(maxWidth: 560)`: the text column takes up to 560 of what's left beside the poster.
            SizeChanged += (_, e) => info.Width = Math.Clamp(e.NewSize.Width - 120 - 230 - 46, 0, 560);
            Children.Add(main.Cell(row: 2));

            Children.Add(Upcoming().Cell(row: 4));
        }

        public void Update(Title title)
        {
            _stars.SetHalves(title.RatingHalves);
            _next.Visibility = title.RatingHalves is null ? Visibility.Collapsed : Visibility.Visible;
        }

        private FrameworkElement Header()
        {
            var p = Theme.P;
            var page = _page;
            var heading = Ui.Line("Rate your films", Typeface.Title(22), p.Ink);
            heading.VerticalAlignment = VerticalAlignment.Bottom;
            var count = Ui.Line($"{Math.Min(page._index + 1, page._queue.Count)} of {page._queue.Count}", Typeface.Time(13), p.Ink3);
            // On the heading's baseline.
            count.VerticalAlignment = VerticalAlignment.Bottom;
            count.Margin = new Thickness(6, 0, 0, 5);
            var toggle = PageButtons.Switch("Include rated ones", page._includeRated, on =>
            {
                page._includeRated = on;
                page.BuildQueue();
                page.Invalidate();
                page.FocusPage();
            }, p.Ink2);
            toggle.VerticalAlignment = VerticalAlignment.Bottom;
            toggle.Margin = new Thickness(0, 0, 0, 4);
            var done = PageButtons.Outline("Done", null, () => page._app.Go(Route.Library));
            done.VerticalAlignment = VerticalAlignment.Bottom;
            done.Margin = new Thickness(12, 0, 0, 0);
            var row = Ui.Row(8, heading, count, Ui.Spacer(), toggle, done);
            row.Padding = new Thickness(40, 0, 40, 0);

            // How far along: a gold line 14 points under the header.
            var fraction = page._queue.Count == 0 ? 0 : (double)page._index / page._queue.Count;
            var fill = new Border { Background = p.Gold, CornerRadius = new CornerRadius(1), HorizontalAlignment = HorizontalAlignment.Left };
            var track = new Grid
            {
                Height = 2,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(40, 0, 40, 0),
                Translation = new Vector3(0, 14, 0),
                IsHitTestVisible = false,
                Children = { new Border { Background = new SolidColorBrush(p.Raised2), CornerRadius = new CornerRadius(1) }, fill },
            };
            track.SizeChanged += (_, e) => fill.Width = e.NewSize.Width * fraction;
            return Ui.ZStack(row, track);
        }

        /// The next few posters, so the end is always in sight.
        private FrameworkElement Upcoming()
        {
            var page = _page;
            var library = page._app.Library;
            var row = Ui.HStack(10);
            foreach (var id in page._queue.Skip(page._index + 1).Take(8))
            {
                if (!library.Titles.TryGetValue(id, out var title)) continue;
                row.Children.Add(Posters.Image(title, 46, cornerRadius: 4, fallback: FrameFiles.Best(library, id)).Opacity(0.55));
            }
            row.HorizontalAlignment = HorizontalAlignment.Center;
            row.VerticalAlignment = VerticalAlignment.Center;
            return new Grid { Height = 70, Children = { row } };
        }

        private static string Detail(Title title)
        {
            var parts = new List<string>();
            if (title.Year is { } year) parts.Add(year.ToString(CultureInfo.InvariantCulture));
            parts.Add(title.Kind.Label);
            if (title.Genres.Count > 0) parts.Add(string.Join(", ", title.Genres.Take(3)));
            return string.Join("   ", parts);
        }
    }
}
