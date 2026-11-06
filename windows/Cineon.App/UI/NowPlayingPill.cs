using Cineon.App.Browser;
using Cineon.App.Playback;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Cineon.App.UI;

/// What's playing, from any page: poster, name, episode, play/pause and a hairline of how far
/// you are. Its arrow opens every control. Narrow windows keep just the poster and the buttons.
/// The Mac's NowPlayingPill from TopBar.swift. It checks the player twice a second and changes
/// only the parts that moved, so the popover stays open while the film plays.
public sealed class NowPlayingPill : Grid
{
    private const double PillHeight = 34;

    private readonly AppModel _app;
    private readonly bool _compact;
    private readonly bool _onHero;
    private DispatcherQueueTimer? _timer;
    private string? _shownKey;
    private FontIcon? _playIcon;
    private Button? _playButton;
    private TextBlock? _detail;
    private Border? _progress;
    private Flyout? _controls;

    public NowPlayingPill(AppModel app, bool compact, bool onHero)
    {
        _app = app;
        _compact = compact;
        _onHero = onHero;
        VerticalAlignment = VerticalAlignment.Center;
        Loaded += (_, _) =>
        {
            Refresh();
            if (DispatcherQueue is null) return;
            _timer = DispatcherQueue.CreateTimer();
            _timer.Interval = TimeSpan.FromSeconds(0.5);
            _timer.Tick += (_, _) => Safe.Run("now playing pill", Refresh);
            _timer.Start();
        };
        Unloaded += (_, _) => _timer?.Stop();
    }

    private void Refresh()
    {
        var player = _app.ActivePlayer;
        if (player is null || player.Duration <= 0)
        {
            if (_shownKey is null) return;
            _shownKey = null;
            Children.Clear();
            _controls?.Hide();
            return;
        }
        var title = player.TitleId is long id ? _app.Library.Titles.GetValueOrDefault(id) : null;
        var key = $"{player.Identity}|{title?.Id}|{title?.Name}|{title?.PosterUrl?.OriginalString}|{Theme.P.IsDark}";
        if (key != _shownKey)
        {
            _shownKey = key;
            Build(player, title);
        }
        Update(player);
    }

    private void Build(ActivePlayer player, Title? title)
    {
        var p = Theme.P;
        Children.Clear();
        var name = title?.Name ?? NameOf(player);

        var label = Ui.HStack(9, Thumbnail(title?.PosterUrl));
        if (!_compact)
        {
            var nameText = Ui.Line(name, Typeface.Title(13.5), p.Ink);
            nameText.MaxWidth = 120;
            _detail = Ui.Line("", Typeface.Time(11.5), p.Ink2);
            label.Children.Add(nameText);
            label.Children.Add(_detail);
        }
        else
        {
            _detail = null;
        }
        label.Height = PillHeight;
        label.Padding = new Thickness(4, 0, _compact ? 0 : 4, 0);
        var open = Buttons.Make(label, () =>
        {
            switch (_app.ActivePlayer)
            {
                case ActivePlayer.Local:
                    _app.Go(Route.Player);
                    break;
                case ActivePlayer.Web web:
                    _app.Browser.Select(web.Tab);
                    _app.Go(Route.Web);
                    break;
            }
        }, help: _compact ? name : "Go to what's playing");

        _playIcon = Ui.Icon(player.IsPlaying ? Glyph.Pause : Glyph.Play, 10.5, p.Ink2);
        _playButton = Buttons.Hover(new Border { Width = 16, Height = 16, Child = _playIcon }, () => _app.ActivePlayer?.Toggle(),
            radius: 7, padding: new Thickness(5), help: player.IsPlaying ? "Pause" : "Play");
        var chevron = Buttons.Icon(Glyph.ChevronDown, "Player controls", () => { }, size: 8.5);
        _controls = new Flyout
        {
            Content = new PlayerControlsPanel(_app),
            Placement = FlyoutPlacementMode.Bottom,
            FlyoutPresenterStyle = Popovers.PresenterStyle(),
        };
        chevron.Flyout = _controls;

        var row = Ui.HStack(0, open, _playButton, chevron);
        row.Padding = new Thickness(0, 0, 2, 0);
        row.Height = PillHeight;
        _progress = new Border
        {
            Height = 2,
            Background = new SolidColorBrush(Palette.WithOpacity(p.Ink, 0.8)),
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Bottom,
            IsHitTestVisible = false,
        };
        var stack = new Grid { Children = { row, _progress } };
        var capsule = TopBar.BarCapsule(stack, _onHero);
        capsule.SizeChanged += (_, _) => { if (_app.ActivePlayer is { } now) Update(now); };
        Children.Add(capsule);
    }

    private void Update(ActivePlayer player)
    {
        var p = Theme.P;
        if (_playIcon is not null)
        {
            var glyph = player.IsPlaying ? Glyph.Pause : Glyph.Play;
            if (_playIcon.Glyph != glyph)
            {
                _playIcon.Glyph = glyph;
                _playButton?.Tooltip(player.IsPlaying ? "Pause" : "Play");
            }
        }
        if (_detail is not null)
        {
            // The episode, the sleep timer, or how much is left.
            string text;
            if (_app.SleepTimer is not null && _app.SleepTimerRemaining is { } timer)
            {
                text = $"☾ {Timecode.String(timer)}";
                _detail.Tooltip("Sleep timer");
            }
            else if (player.Ref is { } episode)
            {
                text = episode.ShortLabel;
            }
            else
            {
                text = "−" + Timecode.String(Math.Max(0, player.Duration - player.Position));
                _detail.Tooltip("Time left");
            }
            if (_detail.Text != text) _detail.Text = text;
        }
        if (_progress is not null && Children.FirstOrDefault() is FrameworkElement capsule)
        {
            var fraction = Math.Clamp(player.Position / player.Duration, 0, 1);
            _progress.Width = Math.Max(0, capsule.ActualWidth * fraction);
        }
    }

    /// The poster, its left edge following the capsule's curve, or a film frame when there's none.
    private static FrameworkElement Thumbnail(Uri? url)
    {
        var p = Theme.P;
        var placeholder = new Grid
        {
            Background = new SolidColorBrush(p.Raised2),
            Children = { Ui.Icon("", 8, p.Ink3).Centered() },
        };
        var image = new RemoteImage(url, placeholder, fill: true);
        return new Border
        {
            Width = 18,
            Height = 26,
            CornerRadius = new CornerRadius(13, 4, 4, 13),
            Child = image,
        };
    }

    private static string NameOf(ActivePlayer player) => player switch
    {
        ActivePlayer.Local local => local.Playback.Name,
        ActivePlayer.Web web => web.Tab.Parsed?.Name ?? web.Tab.DisplayTitle,
        _ => "",
    };
}

/// Everything you can do to what's playing, wherever it plays: the site's player or this PC's.
/// The Mac's PlayerControlsPanel from PlayerControls.swift.
public sealed class PlayerControlsPanel : Component
{
    private readonly AppModel _app;

    public PlayerControlsPanel(AppModel app)
    {
        _app = app;
        var browser = app.Browser;
        Watch(app);
        Watch(a => browser.TabChanged += a, a => browser.TabChanged -= a);
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var content = Ui.VStack(14);
        content.Padding = new Thickness(16);
        content.Width = 320;
        if (_app.ActivePlayer is not { } player)
        {
            content.Children.Add(Ui.Line("Nothing is playing", Typeface.Ui(12.5), p.Ink3));
            return content;
        }
        content.Children.Add(Header(player));
        content.Children.Add(Ui.Divider().Opacity(0.5));
        content.Children.Add(SleepTimerRow());
        if (player is ActivePlayer.Web web)
        {
            var tab = web.Tab;
            content.Children.Add(VoiceBoostRow(tab));
            content.Children.Add(new SecondSubtitlesRow(_app, tab));
            content.Children.Add(SpeedRow(player.Rate, tab.SetRate));
            content.Children.Add(Ui.Divider().Opacity(0.5));
            content.Children.Add(WebActions(tab));
        }
        // TODO(port-player): the native player's speed (the Mac's SpeedRow on player.defaultRate),
        // once LocalPlayback can set its rate.
        return content;
    }

    private FrameworkElement Header(ActivePlayer player)
    {
        var p = Theme.P;
        var title = player.TitleId is long id ? _app.Library.Titles.GetValueOrDefault(id) : null;
        var poster = new Border
        {
            Width = 40,
            Height = 60,
            CornerRadius = new CornerRadius(4),
            Child = new RemoteImage(title?.PosterUrl, new Grid { Background = new SolidColorBrush(p.Raised2) }, fill: true),
        };
        var words = Ui.VStack(4, Ui.Text(title?.Name ?? "Now playing", Typeface.Title(16), p.Ink, maxLines: 2));
        if (player.Ref is { } episode) words.Children.Add(Ui.Line(episode.LongLabel, Typeface.Ui(11.5), p.Ink3));
        if (title is not null)
        {
            var library = _app.Library;
            var titleId = title.Id;
            words.Children.Add(new StarRatingControl(title.RatingHalves, halves => library.SetRating(titleId, halves), size: 11, spacing: 2, showsValue: false));
        }
        var top = Ui.Row(11, poster.Align(vertical: VerticalAlignment.Top), words.Fill());
        return Ui.VStack(10, top, new Live(() => Transport(), new Ticker()));
    }

    /// The progress line, the time and the buttons, redrawn every second.
    private UIElement Transport()
    {
        var p = Theme.P;
        if (_app.ActivePlayer is not { } player) return new Grid();
        var time = Ui.HStack(0,
            Ui.Line(Timecode.String(player.Position), Typeface.Time(10.5), p.Ink2),
            Ui.Line(" / " + Timecode.String(player.Duration), Typeface.Time(10.5), p.Ink3));
        var row = Ui.Row(0,
            time,
            Ui.Spacer(),
            Buttons.Icon(Glyph.Rewind10, "Back 10 seconds", () => _app.ActivePlayer?.Skip(-10), size: 11),
            Buttons.Icon(player.IsPlaying ? Glyph.Pause : Glyph.Play, player.IsPlaying ? "Pause" : "Play", () => _app.ActivePlayer?.Toggle(), size: 12),
            Buttons.Icon(Glyph.Forward10, "Forward 10 seconds", () => _app.ActivePlayer?.Skip(10), size: 11),
            player.Ref is null ? null : Buttons.Icon(Glyph.Next, "Next episode", _app.PlayNextEpisode, size: 10));
        return Ui.VStack(10, Progress.Line(player.Duration > 0 ? player.Position / player.Duration : 0, 2), row);
    }

    /// Ticks once a second while the panel is open.
    private sealed class Ticker : IChangeNotifier
    {
        private readonly DispatcherQueueTimer? _timer;
        private Action? _changed;

        public Ticker()
        {
            if (DispatcherQueue.GetForCurrentThread() is not { } queue) return;
            _timer = queue.CreateTimer();
            _timer.Interval = TimeSpan.FromSeconds(1);
            _timer.Tick += (_, _) => _changed?.Invoke();
        }

        public event Action? Changed
        {
            add { _changed += value; _timer?.Start(); }
            remove { _changed -= value; if (_changed is null) _timer?.Stop(); }
        }
    }

    // MARK: Rows

    /// A row with a name on the left and its control on the right.
    private static FrameworkElement ControlRow(string glyph, string label, string? note, UIElement control)
    {
        var p = Theme.P;
        var words = Ui.VStack(2, Ui.Line(label, Typeface.Ui(12.5, Typeface.Medium), p.Ink));
        if (note is not null) words.Children.Add(Ui.Text(note, Typeface.Ui(11), p.Ink3));
        var icon = new Border { Width = 16, Child = Ui.Icon(glyph, 12, p.Ink3), VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 2, 0, 0) };
        return Ui.Row(10, icon, words.Fill(), control);
    }

    private static DropDownButton Menu(string text, bool isSet, MenuFlyout flyout)
    {
        var p = Theme.P;
        var label = Ui.Line(text, Typeface.Ui(12, Typeface.Medium), isSet ? p.Ink : p.Ink2);
        label.MaxWidth = 90;
        return new DropDownButton { Content = label, Flyout = flyout, Padding = new Thickness(8, 3, 6, 3), MinHeight = 0 };
    }

    private FrameworkElement SleepTimerRow()
    {
        var timer = _app.SleepTimer;
        var note = timer is null ? null
            : timer.Mode.IsEndOfItem ? "Stops when this ends" : $"Stops in {Timecode.String(_app.SleepTimerRemaining ?? 0)}";
        var flyout = new MenuFlyout();
        foreach (var mode in SleepTimerMode.Choices)
        {
            flyout.Items.Add(DownloadMenu.Item(mode.IsEndOfItem ? "At the end of this" : mode.Label, () => _app.StartSleepTimer(mode)));
        }
        if (timer is not null)
        {
            flyout.Items.Add(new MenuFlyoutSeparator());
            flyout.Items.Add(DownloadMenu.Item("Turn off", _app.CancelSleepTimer));
        }
        return ControlRow("", "Sleep timer", note, Menu(timer?.Mode.Label ?? "Off", timer is not null, flyout));
    }

    private FrameworkElement VoiceBoostRow(BrowserTab tab)
    {
        var on = _app.Settings.VoiceBoost;
        var note = on ? tab.BoostState.Note ?? "Dialogue up, explosions down" : "Clearer dialogue at night";
        var toggle = new ToggleSwitch { IsOn = on, OnContent = "", OffContent = "", MinWidth = 0 };
        toggle.Toggled += (_, _) =>
        {
            if (_app.Settings.VoiceBoost != toggle.IsOn) _app.Settings = _app.Settings with { VoiceBoost = toggle.IsOn };
        };
        return ControlRow(Glyph.Volume, "Voice boost", note, toggle);
    }

    private static FrameworkElement SpeedRow(double rate, Action<double> set)
    {
        var box = new ComboBox { MinWidth = 0, Padding = new Thickness(8, 3, 6, 3) };
        double[] values = [0.75, 1, 1.25, 1.5, 2];
        foreach (var value in values) box.Items.Add(value == 1 ? "1×" : $"{value.ToString(System.Globalization.CultureInfo.InvariantCulture)}×");
        var selected = Array.FindIndex(values, v => Math.Abs(v - rate) < 0.01);
        box.SelectedIndex = selected;
        box.SelectionChanged += (_, _) =>
        {
            if (box.SelectedIndex >= 0 && box.SelectedIndex < values.Length) set(values[box.SelectedIndex]);
        };
        return ControlRow("", "Speed", null, box);
    }

    private FrameworkElement WebActions(BrowserTab tab)
    {
        var browser = _app.Browser;
        var tracking = new MenuFlyout();
        tracking.Items.Add(DownloadMenu.Item("Fix title…", () => { browser.Select(tab); _app.Sheet = new AppSheet.Relink(); }));
        tracking.Items.Add(DownloadMenu.Item("This isn't a film", () => _app.Session.Tracker.Ignore(tab)));
        tracking.Items.Add(DownloadMenu.Item("Don't track this site", () =>
        {
            _app.Session.Tracker.StopTrackingSite(tab);
            var host = tab.Url is { } url ? WatchTracker.Host(url) : null;
            _app.Toasts.Show($"{(host is null ? "This site" : Cineon.Core.Data.DomainName.Registrable(host))} won't appear on your timeline");
        }));
        var trackingButton = ActionRow("", "Tracking", () => { });
        trackingButton.Flyout = tracking;
        trackingButton.HorizontalAlignment = HorizontalAlignment.Left;
        return Ui.VStack(2,
            ActionRow(Glyph.PictureInPicture, "Picture in Picture", tab.TogglePictureInPicture),
            ActionRow("", "Cinema mode", () => { browser.Select(tab); _app.ToggleCinema(); }),
            ActionRow(Glyph.Camera, "Save this moment", () => _app.Session.Frames.SaveMoment(tab)),
            ActionRow("", "Find on another site", () =>
            {
                browser.Select(tab);
                _app.Session.Rescue.FindElsewhere(tab);
            }),
            trackingButton);
    }

    private static Button ActionRow(string glyph, string label, Action action)
    {
        var p = Theme.P;
        var row = Ui.HStack(8, Ui.Icon(glyph, 12.5, p.Ink2), Ui.Line(label, Typeface.Ui(12.5), p.Ink2));
        var button = Buttons.Hover(row, action);
        button.HorizontalAlignment = HorizontalAlignment.Stretch;
        button.HorizontalContentAlignment = HorizontalAlignment.Left;
        return button;
    }
}

/// The second line of subtitles: off, one of the player's own files, or a file from this PC.
public sealed class SecondSubtitlesRow : Grid
{
    public SecondSubtitlesRow(AppModel app, BrowserTab tab)
    {
        var p = Theme.P;
        var flyout = new MenuFlyout();
        flyout.Items.Add(DownloadMenu.Item("Off", tab.ClearSecondSubtitles));
        var choices = tab.SubtitleChoices;
        if (choices.Count > 0)
        {
            var section = new MenuFlyoutSubItem { Text = "From this player" };
            foreach (var (url, name) in choices)
            {
                section.Items.Add(DownloadMenu.Item(name, () => Safe.Fire("second subtitles", async () => await tab.ShowSecondSubtitlesAsync(url))));
            }
            flyout.Items.Add(section);
        }
        flyout.Items.Add(new MenuFlyoutSeparator());
        flyout.Items.Add(DownloadMenu.Item("From a file…", () => Safe.Fire("subtitle file", async () =>
        {
            if (await SubtitleFilePicker.PickAsync() is not { } path || SubtitleTrack.Load(path) is not { } track) return;
            tab.ShowSecondSubtitles(track);
        })));
        var current = tab.SecondSubtitles;
        var label = Ui.Line(current?.Label ?? "Off", Typeface.Ui(12, Typeface.Medium), current is null ? p.Ink2 : p.Ink);
        label.MaxWidth = 90;
        var button = new DropDownButton { Content = label, Flyout = flyout, Padding = new Thickness(8, 3, 6, 3), MinHeight = 0 };
        var words = Ui.VStack(2,
            Ui.Line("Second subtitles", Typeface.Ui(12.5, Typeface.Medium), p.Ink),
            Ui.Text(current is null ? "A second language above the picture" : "Showing above the picture", Typeface.Ui(11), p.Ink3));
        var icon = new Border { Width = 16, Child = Ui.Icon(Glyph.Subtitles, 12, p.Ink3), VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 2, 0, 0) };
        Children.Add(Ui.Row(10, icon, words.Fill(), button));
    }
}

/// Chooses a subtitle file (.srt or .vtt) from this PC.
public static class SubtitleFilePicker
{
    public static async Task<string?> PickAsync()
    {
        if (AppModel.Shared?.Window?.Handle is not { } window || window == IntPtr.Zero) return null;
        var picker = new Windows.Storage.Pickers.FileOpenPicker();
        WinRT.Interop.InitializeWithWindow.Initialize(picker, window);
        picker.FileTypeFilter.Add(".srt");
        picker.FileTypeFilter.Add(".vtt");
        var file = await picker.PickSingleFileAsync();
        return file?.Path;
    }
}
