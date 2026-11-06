using System.Numerics;
using Cineon.App.Playback;
using Cineon.Core.Data;
using Microsoft.UI.Composition;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using VirtualKey = Windows.System.VirtualKey;
using Windows.UI;

namespace Cineon.App.UI;

/// A downloaded film in the native player, filling the main card. The Mac's LocalPlayerView,
/// PlayerSurface and UpNextCard from DownloadsView.swift.
///
/// The MediaPlayerElement, the caption overlay and the frame around them are made once and kept
/// for as long as the page is on screen; each rebuild only redraws the bar and the up-next card.
/// When the next episode starts, the same element takes the new player.
public sealed class LocalPlayerView : Component
{
    private readonly AppModel _app;
    private readonly MediaPlayerElement _element;
    private readonly CaptionOverlay _captions = new();
    private readonly Border _bar = new()
    {
        VerticalAlignment = VerticalAlignment.Top,
        OpacityTransition = new ScalarTransition { Duration = TimeSpan.FromSeconds(0.25) },
    };
    private readonly Grid _upNext = new()
    {
        HorizontalAlignment = HorizontalAlignment.Right,
        VerticalAlignment = VerticalAlignment.Bottom,
        // The Mac's 28, plus the height of the transport controls, which span the bottom here.
        Margin = new Thickness(28, 28, 28, 28 + 88),
        ChildrenTransitions = new TransitionCollection { new EntranceThemeTransition { FromHorizontalOffset = 60, FromVerticalOffset = 0, IsStaggeringEnabled = false } },
    };
    private readonly Grid _surface = new() { Background = new SolidColorBrush(Microsoft.UI.Colors.Black), AllowDrop = true };
    private readonly Border _frame = new();

    private LocalPlayback? _shown;
    private UpNext? _shownUpNext;
    private TextBlock? _sleepLabel;
    private DispatcherQueueTimer? _hideTimer;
    private DispatcherQueueTimer? _clock;
    private bool _showsBar = true;
    private bool _isFullScreen;
    private AppWindowPresenter? _windowedPresenter;

    public LocalPlayerView(AppModel app)
    {
        _app = app;
        IsTabStop = true;
        UseSystemFocusVisuals = false;
        _element = new MediaPlayerElement
        {
            AreTransportControlsEnabled = true,
            AutoPlay = false,
            Stretch = Stretch.Uniform,
            // AVKit's floating controls are dark over any film.
            RequestedTheme = ElementTheme.Dark,
        };
        ConfigureControls();
        _element.Loaded += (_, _) => ConfigureControls();
        _element.RegisterPropertyChangedCallback(MediaPlayerElement.IsFullWindowProperty, (_, _) =>
        {
            if (!_element.IsFullWindow) return;
            _element.IsFullWindow = false;
            SetFullScreen(!_isFullScreen);
        });

        _surface.Children.Add(_element);
        _surface.Children.Add(_captions);
        _surface.Children.Add(_bar);
        _surface.Children.Add(_upNext);
        _frame.Child = _surface;

        // Moving the pointer over the film brings the bar back for a while.
        _surface.AddHandler(PointerMovedEvent, new PointerEventHandler((_, _) => Wake()), true);
        _surface.AddHandler(DoubleTappedEvent, new DoubleTappedEventHandler(OnDoubleTapped), true);
        _surface.DragOver += OnDragOver;
        _surface.Drop += OnDrop;
        KeyDown += OnKeyDown;

        Watch(app);
    }

    /// The Mac's AVPlayerView shows floating controls with a full-screen toggle and picture in
    /// picture. Here the transport controls play, seek and set the volume; full screen is the bar's
    /// own button (the element's full-window mode would leave the subtitles behind, so a request for
    /// it becomes the app's full screen instead).
    private void ConfigureControls()
    {
        if (_element.TransportControls is not { } controls) return;
        controls.IsZoomButtonVisible = false;
        controls.IsZoomEnabled = false;
        controls.IsCompact = false;
    }

    protected override void OnAppeared()
    {
        var queue = DispatcherQueue;
        _hideTimer ??= queue.CreateTimer();
        _hideTimer.Interval = TimeSpan.FromSeconds(2.5);
        _hideTimer.IsRepeating = false;
        _hideTimer.Tick += HideBar;
        _clock ??= queue.CreateTimer();
        _clock.Interval = TimeSpan.FromSeconds(0.5);
        _clock.Tick += TickClock;
        _clock.Start();
        Wake();
        Invalidate();
        DispatcherQueue.TryEnqueue(() => Focus(FocusState.Programmatic));
    }

    protected override void OnDisappeared()
    {
        if (_hideTimer is not null)
        {
            _hideTimer.Stop();
            _hideTimer.Tick -= HideBar;
        }
        if (_clock is not null)
        {
            _clock.Stop();
            _clock.Tick -= TickClock;
        }
        Attach(null);
        SetFullScreen(false);
    }

    protected override UIElement Render()
    {
        if (_app.LocalPlayback is not { } playback)
        {
            Attach(null);
            // Nothing to play: back to the list, like the Mac's onAppear on an empty player.
            DispatcherQueue?.TryEnqueue(() =>
            {
                if (_app.Route == Route.Player && _app.LocalPlayback is null) _app.Go(Route.Downloads);
            });
            return new Grid { Background = new SolidColorBrush(Microsoft.UI.Colors.Black) };
        }
        Attach(playback);

        // Esc leaves full screen through the app's Cinema mode.
        if (_isFullScreen && !_app.IsCinema) SetFullScreen(false);

        _bar.Child = TopBar(playback);
        _bar.Opacity = _showsBar ? 1 : 0;
        _bar.IsHitTestVisible = _showsBar;
        UpdateUpNext();
        PaintFrame();
        // Already on screen: setting the same content again keeps the video where it is.
        return ReferenceEquals(Content, _frame) ? _frame : _frame.Detached();
    }

    /// Sites and the player are a screen in a dark room (RootView's MainCard): inset, rounded,
    /// with a hairline edge. In full screen, only the film.
    private void PaintFrame()
    {
        var p = Theme.P;
        if (_isFullScreen)
        {
            _frame.Padding = new Thickness(0);
            _frame.CornerRadius = new CornerRadius(0);
            _frame.BorderThickness = new Thickness(0);
            _frame.Background = new SolidColorBrush(Microsoft.UI.Colors.Black);
            _surface.CornerRadius = new CornerRadius(0);
            return;
        }
        _frame.Padding = new Thickness(12, 10, 12, 12);
        _frame.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        _frame.CornerRadius = new CornerRadius(0);
        _frame.BorderThickness = new Thickness(0);
        _surface.CornerRadius = new CornerRadius(12);
        _surface.BorderBrush = new SolidColorBrush(p.Line);
        _surface.BorderThickness = new Thickness(p.IsDark ? 0.5 : 1);
    }

    /// Hands the element the playback's player, and lets go of the last one.
    private void Attach(LocalPlayback? playback)
    {
        if (ReferenceEquals(playback, _shown)) return;
        if (_shown is { } old)
        {
            old.Changed -= Invalidate;
            _element.SetMediaPlayer(null);
            _captions.Show(null);
            old.SetShown(false);
        }
        _shown = playback;
        if (playback is null) return;
        playback.Changed += Invalidate;
        _captions.Show(playback);
        // A stopped playback has let go of its player.
        if (playback.IsStopped) return;
        playback.SetShown(true);
        _element.SetMediaPlayer(playback.Player);
    }

    // MARK: Bar

    private void Wake()
    {
        if (!_showsBar)
        {
            _showsBar = true;
            _bar.Opacity = 1;
            _bar.IsHitTestVisible = true;
        }
        _hideTimer?.Stop();
        _hideTimer?.Start();
    }

    private void HideBar(DispatcherQueueTimer sender, object args)
    {
        _showsBar = false;
        _bar.Opacity = 0;
        _bar.IsHitTestVisible = false;
    }

    private void TickClock(DispatcherQueueTimer sender, object args)
    {
        if (_sleepLabel is not null) _sleepLabel.Text = Timecode.String(_app.SleepTimerRemaining ?? 0);
        if (_upNext.Children.Count > 0 && _upNext.Children[0] is UpNextCard card) card.Tick();
    }

    private FrameworkElement TopBar(LocalPlayback playback)
    {
        var dark = Palette.Dark;
        var white = Microsoft.UI.Colors.White;

        var back = Buttons.Hover(
            Ui.HStack(5,
                Ui.Icon(MiscGlyph.ChevronLeft, 11, white),
                Ui.Line("Downloads", Typeface.Ui(12.5, Typeface.Medium), white)),
            _app.ClosePlayer,
            padding: new Thickness(8, 5, 10, 5),
            palette: dark);

        var name = Ui.Line(playback.Name, Typeface.Title(15), white);
        UIElement? badge = playback.Badge is { } text
            ? Ui.Line(text, Typeface.Time(11.5, Typeface.Medium), Palette.Grey(1, 0.62))
            : null;

        _sleepLabel = null;
        UIElement? sleepLabel = null;
        if (_app.SleepTimer is not null)
        {
            _sleepLabel = Ui.Line(Timecode.String(_app.SleepTimerRemaining ?? 0), Typeface.Time(11.5, Typeface.Medium), Palette.Grey(1, 0.75));
            sleepLabel = Ui.HStack(4, Ui.Icon(Glyph.Moon, 11, Palette.Grey(1, 0.75)), _sleepLabel);
        }

        var hasTimer = _app.SleepTimer is not null;
        var sleep = Inputs.MenuButton(
            BarIcon(hasTimer ? MiscGlyph.MoonFilled : Glyph.Moon, hasTimer ? 1 : 0.85),
            SleepMenu,
            "Sleep timer");

        var fullScreen = Buttons.Make(BarIcon(Glyph.FullScreen, 0.85), () => SetFullScreen(!_isFullScreen),
            help: _isFullScreen ? "Exit full screen" : "Full screen");

        var hasSubtitles = playback.SelectedSubtitleId is not null;
        var subtitles = Inputs.MenuButton(
            BarIcon(hasSubtitles ? MiscGlyph.CaptionsFilled : Glyph.Subtitles, hasSubtitles ? 1 : 0.85),
            menu => SubtitleMenu(menu, playback),
            "Subtitles");

        var row = Ui.Row(10, back, Ui.Row(10, name.Fill(), badge).Leading().Fill(), sleepLabel, sleep, fullScreen, subtitles)
            .Padding(12, 9, 12, 9);
        row.Background = Palette.Vertical(Palette.Grey(0, 0.6), Palette.Grey(0, 0));
        row.RequestedTheme = ElementTheme.Dark;
        return row;
    }

    private static Border BarIcon(string glyph, double opacity) => new()
    {
        Width = 26,
        Height = 22,
        Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
        Child = Ui.Icon(glyph, 14, Palette.Grey(1, opacity)).Centered(),
    };

    private void SleepMenu(IList<MenuFlyoutItemBase> menu)
    {
        foreach (var mode in SleepTimerMode.Choices)
        {
            var chosen = mode;
            menu.Add(Inputs.Item(mode.IsEndOfItem ? "At the end of this" : mode.Label, () => _app.StartSleepTimer(chosen)));
        }
        if (_app.SleepTimer is not null)
        {
            menu.Add(Inputs.Separator());
            menu.Add(Inputs.Item("Turn off", _app.CancelSleepTimer));
        }
    }

    private void SubtitleMenu(IList<MenuFlyoutItemBase> menu, LocalPlayback playback)
    {
        menu.Add(Inputs.Header("Subtitles"));
        menu.Add(Inputs.Choice("Off", playback.SelectedSubtitleId is null, () => playback.SelectedSubtitleId = null));
        foreach (var track in playback.SubtitleTracks)
        {
            var id = track.Id;
            menu.Add(Inputs.Choice(track.Label, playback.SelectedSubtitleId == id, () => playback.SelectedSubtitleId = id));
        }
        if (playback.SubtitleTracks.Count > 1)
        {
            menu.Add(Inputs.Separator());
            menu.Add(Inputs.Header("Second line"));
            menu.Add(Inputs.Choice("None", playback.SecondSubtitleId is null, () => playback.SecondSubtitleId = null));
            foreach (var track in playback.SubtitleTracks)
            {
                var id = track.Id;
                menu.Add(Inputs.Choice(track.Label, playback.SecondSubtitleId == id, () => playback.SecondSubtitleId = id));
            }
        }
        menu.Add(Inputs.Separator());
        menu.Add(Inputs.Item("Add Subtitles from File…", () => _ = PickSubtitlesAsync(playback)));
    }

    private async Task PickSubtitlesAsync(LocalPlayback playback)
    {
        if (_app.Window is not { } window) return;
        var picker = new Windows.Storage.Pickers.FileOpenPicker();
        WinRT.Interop.InitializeWithWindow.Initialize(picker, window.Handle);
        picker.FileTypeFilter.Add(".srt");
        picker.FileTypeFilter.Add(".vtt");
        StorageFile? file;
        try
        {
            file = await picker.PickSingleFileAsync();
        }
        catch (Exception)
        {
            return;
        }
        if (file is null || !ReferenceEquals(_app.LocalPlayback, playback)) return;
        if (!playback.AddSubtitles(file.Path)) _app.Toasts.Show("That file has no subtitles Cineon can read");
    }

    // MARK: Up next

    private void UpdateUpNext()
    {
        var upNext = _app.UpNext;
        if (upNext == _shownUpNext && (upNext is null) == (_upNext.Children.Count == 0)) return;
        _shownUpNext = upNext;
        _upNext.Children.Clear();
        if (upNext is not null) _upNext.Children.Add(new UpNextCard(_app, upNext));
    }

    // MARK: Full screen

    /// The Mac's AVPlayerView goes full screen from its controls. Here the bar's button, a double
    /// click on the film or F11 put the window in full screen and hide the app's bars through
    /// Cinema mode, so Esc and Ctrl+Shift+C bring them back.
    private void SetFullScreen(bool on)
    {
        if (on == _isFullScreen) return;
        var window = _app.Window;
        _isFullScreen = on;
        if (on)
        {
            _app.IsCinema = true;
            if (window is not null)
            {
                _windowedPresenter = window.AppWindow.Presenter;
                window.AppWindow.SetPresenter(AppWindowPresenterKind.FullScreen);
            }
        }
        else
        {
            if (_app.IsCinema) _app.ExitCinema();
            if (window is not null && window.AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen)
            {
                if (_windowedPresenter is { } previous) window.AppWindow.SetPresenter(previous);
                else window.AppWindow.SetPresenter(AppWindowPresenterKind.Overlapped);
            }
            _windowedPresenter = null;
        }
        if (IsLoaded) Invalidate();
    }

    private void OnDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        // Double clicks on the transport controls are theirs.
        for (var node = e.OriginalSource as DependencyObject; node is not null && node != _surface; node = VisualTreeHelper.GetParent(node))
        {
            if (node is ButtonBase or RangeBase or MediaTransportControls) return;
        }
        e.Handled = true;
        SetFullScreen(!_isFullScreen);
    }

    private void OnKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (Shortcuts.Modifiers() is not (false, false, false) || _shown is not { } playback) return;
        switch (e.Key)
        {
            case VirtualKey.Space:
                playback.TogglePlayback();
                Wake();
                e.Handled = true;
                break;
            case VirtualKey.Left:
                playback.Skip(-10);
                e.Handled = true;
                break;
            case VirtualKey.Right:
                playback.Skip(10);
                e.Handled = true;
                break;
            case VirtualKey.F11:
                SetFullScreen(!_isFullScreen);
                e.Handled = true;
                break;
        }
    }

    // MARK: Dropping subtitles

    private void OnDragOver(object sender, DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        e.AcceptedOperation = DataPackageOperation.Copy;
    }

    /// A subtitle file dropped on the film is added to it.
    private async void OnDrop(object sender, DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems) || _shown is not { } playback) return;
        var deferral = e.GetDeferral();
        IReadOnlyList<IStorageItem> items;
        try
        {
            items = await e.DataView.GetStorageItemsAsync();
        }
        catch (Exception)
        {
            return;
        }
        finally
        {
            deferral.Complete();
        }
        if (items.FirstOrDefault() is not StorageFile file) return;
        var extension = Path.GetExtension(file.Path).ToLowerInvariant();
        if (extension is not (".srt" or ".vtt") || !ReferenceEquals(_app.LocalPlayback, playback)) return;
        if (playback.AddSubtitles(file.Path)) _app.Toasts.Show($"Added {file.Name}");
    }
}

/// Subtitle files drawn over the picture, scaled with it so full-screen captions aren't tiny. The
/// Mac's CaptionOverlay. The second line sits above the first, in a warm yellow.
public sealed class CaptionOverlay : Grid
{
    private static readonly Color SecondInk = Palette.Rgb(1, 0.91, 0.66);

    private readonly TextBlock _first = MakeText(Microsoft.UI.Colors.White);
    private readonly TextBlock _second = MakeText(SecondInk);
    private readonly Border _firstBand = new() { CornerRadius = new CornerRadius(6), HorizontalAlignment = HorizontalAlignment.Center };
    private readonly Border _secondBand = new()
    {
        CornerRadius = new CornerRadius(6),
        HorizontalAlignment = HorizontalAlignment.Center,
        Padding = new Thickness(9, 3, 9, 3),
        Background = new SolidColorBrush(Palette.Grey(0, 0.6)),
    };
    private readonly Grid _shadowed = new();
    private readonly StackPanel _lines = new() { Spacing = 6, VerticalAlignment = VerticalAlignment.Bottom };
    private SpriteVisual? _shadow;
    private LocalPlayback? _playback;

    public CaptionOverlay()
    {
        IsHitTestVisible = false;
        _secondBand.Child = _second;
        // The shadow, for captions without a band, is drawn from the text's own shape.
        var shadowHost = new Border();
        _shadowed.Children.Add(shadowHost);
        _shadowed.Children.Add(_first);
        _firstBand.Child = _shadowed;
        _lines.Children.Add(_secondBand);
        _lines.Children.Add(_firstBand);
        Children.Add(_lines);
        Loaded += (_, _) =>
        {
            if (_shadow is not null) return;
            var compositor = ElementCompositionPreview.GetElementVisual(this).Compositor;
            var shadow = compositor.CreateDropShadow();
            shadow.Color = Palette.Grey(0, 0.9);
            shadow.BlurRadius = 4;
            shadow.Offset = new Vector3(0, 1, 0);
            shadow.Mask = _first.GetAlphaMask();
            _shadow = compositor.CreateSpriteVisual();
            _shadow.Shadow = shadow;
            ElementCompositionPreview.SetElementChildVisual(shadowHost, _shadow);
            Update();
        };
        _first.SizeChanged += (_, _) =>
        {
            if (_shadow is not null) _shadow.Size = new Vector2((float)_first.ActualWidth, (float)_first.ActualHeight);
        };
        SizeChanged += (_, _) => Update();
        Update();
    }

    private static TextBlock MakeText(Color color) => new()
    {
        Foreground = new SolidColorBrush(color),
        FontFamily = Typeface.Ui(26).Family,
        FontWeight = Typeface.Medium,
        TextAlignment = TextAlignment.Center,
        TextWrapping = TextWrapping.Wrap,
        IsTextScaleFactorEnabled = false,
    };

    /// Follows this playback's captions, or none.
    public void Show(LocalPlayback? playback)
    {
        if (ReferenceEquals(playback, _playback)) return;
        if (_playback is not null) _playback.CaptionChanged -= Update;
        _playback = playback;
        if (playback is not null) playback.CaptionChanged += Update;
        Update();
    }

    private void Update()
    {
        var caption = _playback?.Caption;
        var second = _playback?.SecondCaption;
        var style = _playback?.CaptionStyle ?? CaptionStyle.Site;
        var height = ActualHeight > 0 ? ActualHeight : 720;
        var scale = Math.Max(0.6, Math.Min(2.2, height / 720));
        var site = style == CaptionStyle.Site;

        _lines.Margin = new Thickness(40, 0, 40, 0);

        _secondBand.Visibility = second is null ? Visibility.Collapsed : Visibility.Visible;
        _second.Text = second ?? "";
        _second.FontSize = style.NativeSize * 0.82 * scale;
        _secondBand.Margin = new Thickness(0, 0, 0, caption is null ? height * 0.09 : 0);

        _firstBand.Visibility = caption is null ? Visibility.Collapsed : Visibility.Visible;
        _first.Text = caption ?? "";
        _first.FontSize = style.NativeSize * scale;
        _firstBand.Padding = site ? new Thickness(0) : new Thickness(10, 4, 10, 4);
        _firstBand.Background = new SolidColorBrush(site ? Microsoft.UI.Colors.Transparent : Palette.Grey(0, 0.72));
        _firstBand.Margin = new Thickness(0, 0, 0, height * 0.09);
        if (_shadow is not null) _shadow.Opacity = site ? 1 : 0;
    }
}

/// The next downloaded episode, counting down in the corner of the player.
public sealed class UpNextCard : Grid
{
    private readonly UpNext _upNext;
    private readonly TextBlock _countdown;

    public UpNextCard(AppModel app, UpNext upNext)
    {
        _upNext = upNext;
        var dark = Palette.Dark;
        var poster = new Border
        {
            Width = 40,
            Height = 60,
            CornerRadius = new CornerRadius(4),
            Child = new RemoteImage(upNext.Item.PosterUrl, new Grid { Background = new SolidColorBrush(Palette.Grey(1, 0.1)) }, fill: true, cornerRadius: 4),
        };
        _countdown = Ui.Line(Countdown(), Typeface.Time(11.5), Palette.Grey(1, 0.6));
        var texts = Ui.VStack(3,
            Ui.Line("Up next", Typeface.Ui(11.5), Palette.Grey(1, 0.6)),
            Ui.Line(upNext.Item.EpisodeBadge ?? upNext.Item.Name, Typeface.Title(16), Microsoft.UI.Colors.White),
            _countdown);
        var buttons = Ui.VStack(6,
            Buttons.Silver("Play now", app.PlayUpNext, palette: dark),
            Buttons.Hover(Ui.Line("Not now", Typeface.Ui(13), Palette.Grey(1, 0.7)), app.CancelUpNext, palette: dark));
        foreach (var child in buttons.Children.OfType<FrameworkElement>()) child.HorizontalAlignment = HorizontalAlignment.Center;
        var row = Ui.HStack(14, poster, texts, buttons);
        var card = new Border
        {
            Child = row,
            Padding = new Thickness(14),
            CornerRadius = new CornerRadius(14),
            Background = new AcrylicBrush
            {
                TintColor = Microsoft.UI.Colors.Black,
                TintOpacity = 0.55,
                FallbackColor = Palette.Grey(0, 0.72),
            },
        };
        RequestedTheme = ElementTheme.Dark;
        Children.Add(card);
    }

    private string Countdown()
    {
        var left = Math.Max(0, (int)Math.Ceiling((_upNext.StartsAt - DateTimeOffset.Now).TotalSeconds));
        return $"Starts in {left} s";
    }

    /// Called twice a second by the player view.
    public void Tick() => _countdown.Text = Countdown();
}
