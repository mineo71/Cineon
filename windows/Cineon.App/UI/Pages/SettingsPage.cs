using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using Cineon.App.Services;
using Cineon.Core.Data;
using Cineon.Core.Shields;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;
using VirtualKey = Windows.System.VirtualKey;

namespace Cineon.App.UI;

/// Settings: every section of the Mac's SettingsView.swift, Mac words swapped for Windows ones.
public sealed class SettingsPage : UserControl
{
    public SettingsPage(AppModel app)
    {
        IsTabStop = false;
        var column = Ui.VStack(38,
            new Live(() => Ui.Line("Settings", Typeface.Title(30), Theme.P.Ink)),
            AppearanceSection(app),
            new CloudSettings(app).Section,
            new ShieldSettings(app).Section,
            WatchingSection(app),
            DownloadsSection(app),
            SitesSection(app),
            new ProfileSettings(app).Section,
            new PrivacySettings(app).Section,
            UpdatesSection(),
            ShortcutsSection());
        Content = new PageScroll(column, 660, new Thickness(32, 34, 32, 60), centred: false, padInside: false);
    }

    private static AppSettings Get(AppModel app) => app.Settings;

    // MARK: Appearance

    private static SettingsSection AppearanceSection(AppModel app) => new("Appearance",
        () => app.Settings.AmbientLight,
        content =>
        {
            content.Add(Ui.HStack(14, ThemeCard(app, AppTheme.Dark), ThemeCard(app, AppTheme.White)));
            content.Toggle("Ambient light", "The film's colours spill onto the window around it while it plays.",
                () => app.Settings.AmbientLight, on => app.Settings = app.Settings with { AmbientLight = on });
            if (app.Settings.AmbientLight)
            {
                content.Slider("Strength", v => $"{(int)(v * 100 + 1e-9)}%",
                    () => app.Settings.AmbientStrength, v => app.Settings = app.Settings with { AmbientStrength = v }, 0.15, 1, null);
            }
            content.Toggle("Logo animation on launch", null,
                () => app.Settings.LaunchAnimation, on => app.Settings = app.Settings with { LaunchAnimation = on });
        },
        Changes.Of(app));

    private static Button ThemeCard(AppModel app, AppTheme theme)
    {
        var p = Theme.P;
        var selected = app.Settings.Theme == theme;
        var sample = theme == AppTheme.Dark ? Palette.Dark : Palette.White;
        var logo = Images.LogoMark(52, sample.Ink);
        logo.HorizontalAlignment = HorizontalAlignment.Center;
        logo.VerticalAlignment = VerticalAlignment.Center;
        var swatch = new Grid
        {
            Width = 180,
            Height = 104,
            Background = new SolidColorBrush(sample.Canvas),
            Children =
            {
                logo,
                new Border
                {
                    CornerRadius = new CornerRadius(9),
                    BorderBrush = new SolidColorBrush(selected ? p.Ink : p.Line),
                    BorderThickness = new Thickness(selected ? 2 : 1),
                    IsHitTestVisible = false,
                },
            },
        }.ClipRounded(9);
        var label = Ui.Line(theme.Label, Typeface.Ui(13, selected ? Typeface.Medium : Microsoft.UI.Text.FontWeights.Normal), selected ? p.Ink : p.Ink2);
        var button = Buttons.Make(Ui.VStack(8, swatch, label), () => app.Settings = app.Settings with { Theme = theme });
        return button.Label(selected ? $"{theme.Label}, selected" : theme.Label);
    }

    // MARK: Watching

    private static SettingsSection WatchingSection(AppModel app) => new("Watching",
        () => null,
        content =>
        {
            content.Toggle("Resume where I stopped", "Jumps to your place as soon as the video loads, with a way to start over.",
                () => Get(app).AutoResume, on => app.Settings = Get(app) with { AutoResume = on });
            content.Toggle("Only one film at a time", "Starting a video pauses any other tab that's playing.",
                () => Get(app).PauseOtherTabs, on => app.Settings = Get(app) with { PauseOtherTabs = on });
            content.Toggle("Rescue films from dead sites", "When a site or video stops working, looks at the site's other addresses and then your other sites, and carries on from the same second.",
                () => Get(app).AutoRescue, on => app.Settings = Get(app) with { AutoRescue = on });
            content.Toggle("Learn what I skip", "Skip an intro once, and Cineon offers to skip it in every episode of that series. Each skip can be undone.",
                () => Get(app).LearnSkips, on => app.Settings = Get(app) with { LearnSkips = on });
            content.Toggle("Play the next episode", "Offers it when the credits start, and plays it when the episode ends.",
                () => Get(app).AutoNextEpisode, on => app.Settings = Get(app) with { AutoNextEpisode = on });
            content.Toggle("Keep frames from what I watch", "Saves a few small images from each session for your timeline. They stay on this PC.",
                () => Get(app).KeepFrames, on => app.Settings = Get(app) with { KeepFrames = on });
            content.Toggle("Voice boost", "Dialogue louder, rumble and explosions softer. Works in players that let Cineon change their sound; others are left as they are.",
                () => Get(app).VoiceBoost, on => app.Settings = Get(app) with { VoiceBoost = on });
            content.Toggle("Tell me about new episodes", "Checks the series you're watching every few hours and sends a notification when a new episode is out.",
                () => Get(app).NewEpisodeAlerts, on => app.Settings = Get(app) with { NewEpisodeAlerts = on });
            content.Slider("Count as finished at", v => $"{(int)(v * 100 + 1e-9)}%",
                () => Get(app).FinishThreshold, v => app.Settings = Get(app) with { FinishThreshold = v }, 0.7, 1, 0.01);
            content.Slider("Start tracking after", v => $"{(int)(v + 1e-9)} s",
                () => Get(app).MinimumSecondsToTrack, v => app.Settings = Get(app) with { MinimumSecondsToTrack = v }, 5, 120, 5);
            content.Slider("Free memory of idle tabs after", v => v == 0 ? "Never" : $"{(int)(v + 1e-9)} min",
                () => Get(app).HibernateMinutes, v => app.Settings = Get(app) with { HibernateMinutes = v }, 0, 120, 5);
        },
        Changes.Of(app));

    // MARK: Downloads and captions

    private static SettingsSection DownloadsSection(AppModel app) => new("Downloads and captions",
        () => app.Settings.DownloadsFolder,
        content =>
        {
            var p = Theme.P;
            content.Toggle("Show a download button on players", "Appears in the player's corner when you move the mouse. Ctrl+Shift+S works either way.",
                () => Get(app).ShowDownloadButton, on => app.Settings = Get(app) with { ShowDownloadButton = on });
            content.Toggle("Play the next downloaded episode", "When an episode ends in the player on this PC, the next one on this PC starts after a short countdown.",
                () => Get(app).PlayNextDownload, on => app.Settings = Get(app) with { PlayNextDownload = on });
            content.Toggle("Bin episodes once watched", "A downloaded episode you watched to the end goes to the Recycle Bin when you move on, to save space. You can put it back from there.",
                () => Get(app).BinWatchedDownloads, on => app.Settings = Get(app) with { BinWatchedDownloads = on });

            // TODO(after core merge): DownloadCenter's folder, which is this same setting.
            var folder = AppPaths.DownloadsFolder(app.Settings);
            var where = Ui.VStack(1,
                Ui.Line("Save downloads to", Typeface.Ui(13), p.Ink),
                Ui.Line(folder, Typeface.Ui(11.5), p.Ink3).Tooltip(folder));
            content.Add(Ui.Row(10,
                where.Fill(),
                Buttons.Outline("Change…", () => _ = ChooseFolder(app)),
                app.Settings.DownloadsFolder.Length > 0 ? Buttons.Outline("Use Videos", () => app.Settings = Get(app) with { DownloadsFolder = "" }) : null));

            var styles = CaptionStyle.AllCases;
            content.Picker("Captions", styles.Select(s => s.Label).ToList(),
                () => Math.Max(0, styles.ToList().IndexOf(Get(app).CaptionStyle)),
                index => app.Settings = Get(app) with { CaptionStyle = styles[index] }, 360);
            content.Add(Ui.Text("Larger captions apply to players that use the browser's own subtitles, and to downloads.", Typeface.Ui(11.5), p.Ink3));
        },
        Changes.Of(app));

    private static async Task ChooseFolder(AppModel app)
    {
        if (app.Window is not { } window) return;
        try
        {
            var picker = new Microsoft.Windows.Storage.Pickers.FolderPicker(window.AppWindow.Id)
            {
                CommitButtonText = "Use This Folder",
            };
            var result = await picker.PickSingleFolderAsync();
            if (result is null || string.IsNullOrEmpty(result.Path)) return;
            app.Settings = app.Settings with { DownloadsFolder = result.Path };
        }
        catch (Exception error)
        {
            CrashLog.Write("folder picker", error);
        }
    }

    // MARK: Sites

    private static SettingsSection SitesSection(AppModel app) => new("Sites",
        () => string.Join("\n", app.Library.Sites.Select(s => $"{s.Id}\t{s.Name}\t{s.Host}\t{s.IconUrl?.OriginalString}\t{s.SearchTemplate is null}")),
        content =>
        {
            var p = Theme.P;
            foreach (var site in app.Library.Sites)
            {
                var id = site.Id;
                var text = Ui.VStack(1,
                    Ui.Line(site.Name, Typeface.Ui(13), p.Ink),
                    Ui.Line(site.SearchTemplate is null ? $"{site.Host}. Search not learned yet." : site.Host, Typeface.Ui(12), p.Ink3));
                content.Add(Ui.Row(10,
                    Posters.SiteIcon(site.Name, site.IconUrl, 20),
                    text.Fill(),
                    Buttons.Outline("Edit", () => app.Sheet = new AppSheet.EditSite(id))));
            }
            content.Add(Ui.HStack(10,
                Buttons.Outline("Add a site", () => app.Sheet = new AppSheet.AddSite(null)),
                Buttons.Outline("Import from another browser", () => app.Sheet = new AppSheet.ImportBrowser())));
        },
        Changes.Of(app.Library));

    // MARK: Updates

    private static SettingsSection UpdatesSection()
    {
        var updater = Updater.Shared;
        return new SettingsSection("Updates",
            () => (updater.IsRunning, updater.CanCheck, updater.Version),
            content =>
            {
                var p = Theme.P;
                var about = Ui.VStack(1,
                    Ui.Line($"Cineon {updater.Version}", Typeface.Ui(13), p.Ink),
                    Ui.Line(updater.IsRunning ? "New versions come from Cineon's page on GitHub." : "This build doesn't update itself.", Typeface.Ui(12), p.Ink3));
                content.Add(Ui.Row(12, about.Fill(), Buttons.Outline("Check Now", updater.CheckForUpdates, enabled: updater.CanCheck)));
                if (!updater.IsRunning) return;
                content.Toggle("Check for updates every day", null,
                    () => updater.ChecksAutomatically, on => updater.ChecksAutomatically = on);
                content.Toggle("Install updates automatically", "Downloads new versions quietly and puts them in place the next time you quit Cineon.",
                    () => updater.InstallsAutomatically, on => updater.InstallsAutomatically = on);
            },
            Changes.Of(updater));
    }

    // MARK: Shortcuts

    /// The Mac's list with Windows keys (UI/Commands.cs), and the two keys only Windows has.
    private static readonly (string Name, string Keys)[] Shortcuts =
    [
        ("New tab or search", "Ctrl+T"),
        ("Edit the address", "Ctrl+L"),
        ("Close tab", "Ctrl+W"),
        ("Reopen closed tab", "Ctrl+Shift+T"),
        ("Jump to tab 1 to 9", "Ctrl+1 to Ctrl+9"),
        ("Hide or show toolbars on sites", "Ctrl+S"),
        ("Add to backlog", "Ctrl+D"),
        ("Cinema mode", "Ctrl+Shift+C"),
        ("Play or pause", "Ctrl+Shift+P"),
        ("Back or forward 10 seconds", "Ctrl+Shift+← Ctrl+Shift+→"),
        ("Picture in picture", "Ctrl+Shift+I"),
        ("Save this moment", "Ctrl+Shift+M"),
        ("Find this on another site", "Ctrl+Shift+E"),
        ("Home", "Ctrl+Shift+H"),
        ("Library", "Ctrl+Shift+L"),
        ("Timeline", "Ctrl+Y"),
        ("Who's watching", "Ctrl+Shift+U"),
        ("Switch theme", "Ctrl+Shift+D"),
        ("Search films and sites", "Ctrl+K"),
        ("Open the menu", "Alt or F10"),
    ];

    private static SettingsSection ShortcutsSection() => new("Keyboard shortcuts",
        () => null,
        content =>
        {
            var p = Theme.P;
            var grid = new Grid
            {
                ColumnSpacing = 28,
                RowSpacing = 6,
                ColumnDefinitions = { new ColumnDefinition { Width = GridLength.Auto }, new ColumnDefinition { Width = GridLength.Auto } },
                HorizontalAlignment = HorizontalAlignment.Left,
            };
            for (var i = 0; i < Shortcuts.Length; i++)
            {
                grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                grid.Children.Add(Ui.Line(Shortcuts[i].Name, Typeface.Ui(13), p.Ink2).Cell(row: i));
                grid.Children.Add(Ui.Line(Shortcuts[i].Keys, Typeface.Ui(13), p.Ink).Cell(row: i, column: 1));
            }
            content.Add(grid);
        });
}

/// One section: its name over its rows. Rebuilt only when `key` changes (a row appears or goes);
/// otherwise its switches and sliders follow the settings in place, so a switch keeps its slide
/// and a slider isn't replaced under the pointer.
internal sealed class SettingsSection : KeyedComponent
{
    private readonly string _name;
    private readonly Func<object?> _key;
    private readonly Action<SectionContent> _build;
    private List<Action> _refreshers = [];

    public SettingsSection(string name, Func<object?> key, Action<SectionContent> build, params Func<Action, IDisposable>[] sources)
    {
        _name = name;
        _key = key;
        _build = build;
        foreach (var source in sources) WatchKeyed(source);
    }

    /// Rebuilds now, for state kept outside the settings (a code shown, a restore running).
    public void Refresh() => Check();

    protected override object? Key() => _key();

    protected override void OnSame()
    {
        foreach (var refresh in _refreshers) refresh();
    }

    protected override UIElement Render()
    {
        Rendered();
        var content = new SectionContent();
        _build(content);
        _refreshers = content.Refreshers;
        return Ui.VStack(14,
            Ui.Line(_name, Typeface.Title(20), Theme.P.Ink),
            Ui.Stack(Orientation.Vertical, 12, content.Items));
    }
}

/// What a section's builder adds to, and the Mac's SettingToggle, SettingSlider and Picker.
internal sealed class SectionContent
{
    public List<UIElement> Items { get; } = [];
    public List<Action> Refreshers { get; } = [];

    public void Add(UIElement? element)
    {
        if (element is not null) Items.Add(element);
    }

    public void OnRefresh(Action refresh) => Refreshers.Add(refresh);

    /// Switches are tinted like the Mac's `.tint(palette.isDark ? Color(white: 0.78) : .black)`, never
    /// the system accent colour.
    public static ToggleSwitch Switch(bool isOn, Action<bool> changed)
    {
        var p = Theme.P;
        var on = p.IsDark ? Palette.Grey(0.78) : Microsoft.UI.Colors.Black;
        var offFill = p.IsDark ? Palette.Grey(1, 0.16) : Palette.Grey(0, 0.12);
        var offKnob = p.IsDark ? Palette.Grey(1, 0.85) : Microsoft.UI.Colors.White;
        var toggle = new ToggleSwitch
        {
            IsOn = isOn,
            OnContent = null,
            OffContent = null,
            Header = null,
            MinWidth = 0,
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Left,
            IsTextScaleFactorEnabled = false,
        };
        void Set(string key, Color color) => toggle.Resources[key] = new SolidColorBrush(color);
        foreach (var state in new[] { "", "PointerOver", "Pressed", "Disabled" })
        {
            Set("ToggleSwitchFillOn" + state, on);
            Set("ToggleSwitchStrokeOn" + state, on);
            Set("ToggleSwitchKnobFillOn" + state, p.Canvas);
            Set("ToggleSwitchKnobStrokeOn" + state, Microsoft.UI.Colors.Transparent);
            Set("ToggleSwitchFillOff" + state, offFill);
            Set("ToggleSwitchStrokeOff" + state, p.Line);
            Set("ToggleSwitchKnobFillOff" + state, offKnob);
            Set("ToggleSwitchKnobStrokeOff" + state, Microsoft.UI.Colors.Transparent);
            Set("ToggleSwitchContainerBackground" + state, Microsoft.UI.Colors.Transparent);
        }
        toggle.Resources["ToggleSwitchPreContentMargin"] = 0.0;
        toggle.Resources["ToggleSwitchPostContentMargin"] = 0.0;
        toggle.Toggled += (_, _) => changed(toggle.IsOn);
        return toggle;
    }

    public void Toggle(string label, string? detail, Func<bool> get, Action<bool> set)
    {
        var p = Theme.P;
        var text = Ui.VStack(1, Ui.Text(label, Typeface.Ui(13), p.Ink), detail is null ? null : Ui.Text(detail, Typeface.Ui(12), p.Ink3));
        text.VerticalAlignment = VerticalAlignment.Center;
        var toggle = Switch(get(), on => { if (on != get()) set(on); });
        toggle.Label(label);
        // The switch area is 40 wide; the empty On/Off text after it stays out of the row.
        var holder = new Border { Width = 40, Child = toggle, VerticalAlignment = VerticalAlignment.Center };
        // Clicking the words flips it too, as with the Mac's Toggle label.
        text.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        text.Tapped += (_, e) =>
        {
            e.Handled = true;
            toggle.IsOn = !toggle.IsOn;
        };
        Add(Ui.Row(12, text.Fill(), holder));
        OnRefresh(() =>
        {
            var now = get();
            if (toggle.IsOn != now) toggle.IsOn = now;
        });
    }

    public void Slider(string label, Func<double, string> valueText, Func<double> get, Action<double> set, double min, double max, double? step)
    {
        var p = Theme.P;
        var tint = p.IsDark ? Palette.Grey(0.78) : Microsoft.UI.Colors.Black;
        var value = Ui.Line(valueText(get()), Typeface.Time(12), p.Ink2);
        value.Width = 58;
        value.TextAlignment = TextAlignment.Right;
        // The slider snaps to its steps; a stored value within half a step of where it sits is the same
        // value, so showing it never writes the setting back.
        var tolerance = (step ?? (max - min) / 1000) / 2;
        var slider = new Slider
        {
            Minimum = min,
            Maximum = max,
            StepFrequency = step ?? (max - min) / 1000,
            SnapsTo = Microsoft.UI.Xaml.Controls.Primitives.SliderSnapsTo.StepValues,
            Value = get(),
            Width = 180,
            IsThumbToolTipEnabled = false,
            VerticalAlignment = VerticalAlignment.Center,
            IsTextScaleFactorEnabled = false,
        };
        void Set(string key, Color color) => slider.Resources[key] = new SolidColorBrush(color);
        foreach (var state in new[] { "", "PointerOver", "Pressed", "Disabled" })
        {
            Set("SliderTrackValueFill" + state, tint);
            Set("SliderThumbBackground" + state, tint);
            Set("SliderTrackFill" + state, p.Raised2);
        }
        Set("SliderOuterThumbBackground", p.IsDark ? Palette.Grey(0.25) : Microsoft.UI.Colors.White);
        Set("SliderThumbBorderBrush", p.Line);
        slider.ValueChanged += (_, e) =>
        {
            value.Text = valueText(e.NewValue);
            if (Math.Abs(e.NewValue - get()) > tolerance) set(e.NewValue);
        };
        slider.Label(label);
        Add(Ui.Row(12, Ui.Line(label, Typeface.Ui(13), p.Ink), Ui.Spacer(), slider, value));
        OnRefresh(() =>
        {
            var now = get();
            if (Math.Abs(slider.Value - now) > tolerance) slider.Value = now;
        });
    }

    /// The Mac's Picker in a settings list: its label, then a pop-up menu filling up to `maxWidth`.
    public void Picker(string label, IReadOnlyList<string> items, Func<int> get, Action<int> set, double maxWidth)
    {
        var p = Theme.P;
        var combo = new ComboBox
        {
            FontFamily = Typeface.Ui(13).Family,
            FontSize = 13,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            IsTextScaleFactorEnabled = false,
        };
        foreach (var item in items) combo.Items.Add(item);
        combo.SelectedIndex = get();
        combo.Resources["ComboBoxItemPillFillBrush"] = new SolidColorBrush(p.Ink);
        combo.SelectionChanged += (_, _) =>
        {
            if (combo.SelectedIndex >= 0 && combo.SelectedIndex != get()) set(combo.SelectedIndex);
        };
        combo.Label(label);
        var row = Ui.Row(12, Ui.Line(label, Typeface.Ui(13), p.Ink), combo.Fill());
        row.MaxWidth = maxWidth;
        row.HorizontalAlignment = HorizontalAlignment.Left;
        row.Width = maxWidth;
        Add(row);
        OnRefresh(() =>
        {
            var now = get();
            if (combo.SelectedIndex != now) combo.SelectedIndex = now;
        });
    }
}

// MARK: Sections with state of their own

/// Ratings in the cloud, and the recovery code that brings them back.
internal sealed class CloudSettings
{
    private readonly AppModel _app;
    private bool _showsCode;
    private bool _isRestoring;
    private TextBox? _entered;
    private Palette? _enteredPalette;
    private Button? _restore;

    public SettingsSection Section { get; }

    public CloudSettings(AppModel app)
    {
        _app = app;
        var together = app.Session.Together;
        Section = new SettingsSection("Ratings in the cloud",
            () => (_showsCode, _isRestoring, together.RecoveryCode),
            Build,
            Changes.Of(app), Changes.Of(together));
    }

    private bool CanRestore => (_entered?.Text.Length ?? 0) >= 32 && !_isRestoring;

    private void Build(SectionContent content)
    {
        var p = Theme.P;
        var app = _app;
        content.Toggle("Back up ratings and lists",
            "Your stars and which list each film is in are kept on Cineon's server, so they come back after you clear the library, import again or use another PC. Watch history stays here.",
            () => app.Settings.CloudBackup, on => app.Settings = app.Settings with { CloudBackup = on });
        content.Toggle("Show my pet to friends", "Your pixel pet is your picture in parties and challenges.",
            () => app.Settings.SharePet, on => app.Settings = app.Settings with { SharePet = on });
        content.Add(CloudStatusLine.Make(app));

        var together = app.Session.Together;
        var code = Ui.Line(_showsCode ? together.RecoveryCode : new string('•', 24), Typeface.Time(12), p.Ink2);
        code.IsTextSelectionEnabled = true;
        code.SelectionHighlightColor = new SolidColorBrush(Palette.WithOpacity(p.Ink, 0.3));
        var shown = Ui.Row(8,
            code.Fill(),
            Buttons.Outline(_showsCode ? "Hide" : "Show", () => { _showsCode = !_showsCode; Section.Refresh(); }),
            Buttons.Outline("Copy", () =>
            {
                SocialKit.CopyText(together.RecoveryCode);
                app.Toasts.Show("Recovery code copied");
            }));
        var field = EnteredField();
        _restore = Buttons.Silver(_isRestoring ? "Restoring…" : "Restore", () => _ = Restore(), enabled: CanRestore);
        var restore = Ui.Row(8, field.Fill(), _restore);
        content.Add(Ui.VStack(8,
            Ui.Text("Recovery code", Typeface.Ui(13), p.Ink),
            Ui.Text("Enter it on another PC or a new profile to bring back your ratings, lists and challenges. Keep it to yourself: anyone with it can change them.",
                Typeface.Ui(12), p.Ink3),
            shown,
            restore));
    }

    private TextBox EnteredField()
    {
        if (_entered is not null && ReferenceEquals(_enteredPalette, Theme.P))
        {
            SocialKit.Detach(_entered);
            return _entered;
        }
        var box = SocialKit.Field("Paste a recovery code", Typeface.Time(12), Theme.P.Raised, 8, 0, new Thickness(10, 6, 10, 6));
        box.Text = _entered?.Text ?? "";
        box.TextChanged += (_, _) => { if (_restore is not null) _restore.IsEnabled = CanRestore; };
        _entered = box;
        _enteredPalette = Theme.P;
        return box;
    }

    private async Task Restore()
    {
        if (_entered is null || !CanRestore) return;
        var app = _app;
        var session = app.Session;
        _isRestoring = true;
        Section.Refresh();
        var ok = await session.Together.AdoptAsync(_entered.Text);
        if (ok) await session.Cloud.SyncAsync();
        _isRestoring = false;
        _entered.Text = "";
        app.Toasts.Show(ok ? "Restored. Ratings and lists from that code are back" : "That code didn't work");
        Section.Refresh();
    }
}

/// Shields: what's been blocked, the switches, and the filter lists.
internal sealed class ShieldSettings
{
    private readonly AppModel _app;
    private bool _isUpdating;
    private TextBlock? _status;
    private DispatcherQueueTimer? _timer;

    public SettingsSection Section { get; }

    public ShieldSettings(AppModel app)
    {
        _app = app;
        Section = new SettingsSection("Shields",
            () => (app.Settings.NetworkBlocking, _isUpdating),
            Build,
            Changes.Of(app), Changes.Of(app.Session.Shields));
    }

    private string Totals()
    {
        var total = _app.Session.Shields.Total;
        return $"Blocked so far: {total.Ads} ads and trackers, {total.Popups} pop-ups, {total.Redirects} redirects, {total.Overlays} click traps.";
    }

    private string StatusText()
    {
        var filters = _app.Filters;
        switch (filters.Status.Kind)
        {
            case FilterStatusKind.Preparing: return filters.Status.Text;
            case FilterStatusKind.Failed: return $"Couldn't compile {filters.Status.Text}";
        }
        // TODO(after merge): DateText.Relative from the misc-screens port.
        return filters.LastUpdated is { } date ? $"Updated {SocialKit.Relative(date)}" : "Using the lists built into the app";
    }

    private void Build(SectionContent content)
    {
        var p = Theme.P;
        var app = _app;
        var totals = Ui.Text(Totals(), Typeface.Ui(13), p.Ink2);
        content.Add(totals);
        content.OnRefresh(() => totals.Text = Totals());

        content.Toggle("Block ads and trackers", "Compiled into the page engine, so it adds almost nothing to load time.",
            () => app.Settings.NetworkBlocking, on => app.Settings = app.Settings with { NetworkBlocking = on });
        content.Toggle("Block pop-ups", "Stops windows that open to other sites when you click.",
            () => app.Settings.PopupShield, on => app.Settings = app.Settings with { PopupShield = on });
        content.Toggle("Block redirects", "Stops scripts sending the whole page to another site.",
            () => app.Settings.RedirectShield, on => app.Settings = app.Settings with { RedirectShield = on });
        content.Toggle("Remove click traps", "Clears invisible layers placed over the player to steal your first click.",
            () => app.Settings.OverlaySweeper, on => app.Settings = app.Settings with { OverlaySweeper = on });
        content.Toggle("Block downloads", "Stops the fake player and codec downloads streaming sites push.",
            () => app.Settings.DownloadShield, on => app.Settings = app.Settings with { DownloadShield = on });

        if (!app.Settings.NetworkBlocking) return;
        content.Add(SocialKit.Hairline());
        foreach (var info in FilterEngine.Catalog)
        {
            var id = info.Id;
            var detail = app.Filters.RuleCounts.TryGetValue(id, out var count)
                ? $"{info.Summary}. {count.ToString("N0", CultureInfo.CurrentCulture)} rules."
                : info.Summary;
            content.Toggle(info.Name, detail,
                () => app.Settings.EnabledLists.Contains(id),
                on =>
                {
                    var lists = new HashSet<string>(app.Settings.EnabledLists);
                    if (on) lists.Add(id); else lists.Remove(id);
                    app.Settings = app.Settings with { EnabledLists = lists };
                });
        }
        _status = Ui.Line(StatusText(), Typeface.Ui(12), p.Ink3);
        content.Add(Ui.HStack(12,
            Buttons.Outline(_isUpdating ? "Updating…" : "Update lists now", () => _ = Update(), enabled: !_isUpdating),
            _status));
    }

    private async Task Update()
    {
        if (_isUpdating) return;
        var app = _app;
        _isUpdating = true;
        Section.Refresh();
        // The engine's status line has no event of its own: read it while the update runs.
        if (Section.DispatcherQueue is { } queue)
        {
            _timer ??= queue.CreateTimer();
            _timer.Interval = TimeSpan.FromSeconds(0.3);
            _timer.Tick -= OnTick;
            _timer.Tick += OnTick;
            _timer.Start();
        }
        bool changed;
        try { changed = await app.Filters.UpdateAsync(); }
        catch (Exception) { changed = false; }
        _timer?.Stop();
        _isUpdating = false;
        Section.Refresh();
        app.Toasts.Show(changed ? "Filter lists updated" : "Couldn't update the lists. Check your connection.");
    }

    private void OnTick(DispatcherQueueTimer sender, object args)
    {
        if (_status is not null) _status.Text = StatusText();
    }
}

/// Profiles: rename this one, open the picker, ask on launch.
internal sealed class ProfileSettings
{
    private readonly AppModel _app;
    private TextBox? _name;
    private Palette? _namePalette;

    public SettingsSection Section { get; }

    public ProfileSettings(AppModel app)
    {
        _app = app;
        Section = new SettingsSection("Profiles", () => null, Build, Changes.Of(app), Changes.Of(app.Profiles));
    }

    private void Build(SectionContent content)
    {
        var p = Theme.P;
        var app = _app;
        content.Add(Ui.Text("Each profile has its own library, timeline, settings and site logins.", Typeface.Ui(12.5), p.Ink2));
        content.Add(Ui.HStack(10,
            NameField(),
            Buttons.Outline("Rename", Rename),
            Buttons.Outline("Who's watching…", () => app.IsProfilePickerVisible = true)));
        content.Toggle("Ask who's watching on launch", null, () => app.Profiles.AskOnLaunch, on => app.Profiles.AskOnLaunch = on);
    }

    private TextBox NameField()
    {
        if (_name is not null && ReferenceEquals(_namePalette, Theme.P))
        {
            SocialKit.Detach(_name);
            return _name;
        }
        var box = SocialKit.Field("Name", Typeface.Ui(13), Theme.P.Raised, 8, 30, new Thickness(10, 6, 10, 6));
        box.Width = 180;
        // The Mac fills it in when it appears.
        box.Text = _name?.Text ?? _app.Session.Profile.Name;
        box.KeyDown += (_, e) =>
        {
            if (e.Key != VirtualKey.Enter) return;
            e.Handled = true;
            Rename();
        };
        _name = box;
        _namePalette = Theme.P;
        return box;
    }

    private void Rename()
    {
        var trimmed = (_name?.Text ?? "").Trim();
        if (trimmed.Length == 0) return;
        _app.Profiles.Rename(_app.Session.Profile.Id, trimmed);
        _app.Toasts.Show($"Renamed to {trimmed}. The sidebar updates next launch.");
    }
}

/// Privacy and data: what leaves this PC, history, frames, cookies, and the export.
internal sealed class PrivacySettings
{
    private readonly AppModel _app;
    private long _framesSize;

    public SettingsSection Section { get; }

    public PrivacySettings(AppModel app)
    {
        _app = app;
        Section = new SettingsSection("Privacy and data", () => _framesSize, Build, Changes.Of(app));
        Section.Loaded += async (_, _) =>
        {
            try { _framesSize = await app.Library.FramesSizeAsync(); }
            catch (Exception) { _framesSize = 0; }
            Section.Refresh();
        };
    }

    private void Build(SectionContent content)
    {
        var app = _app;
        content.Toggle("Fetch posters and details", "Sends film names to IMDb and Cinemeta. Without it, Cineon uses each page's own image and title.",
            () => app.Settings.FetchMetadata, on => app.Settings = app.Settings with { FetchMetadata = on });
        content.Toggle("Save browsing history", "Pages for the command bar. Your film timeline is saved either way.",
            () => app.Settings.SaveBrowsingHistory, on => app.Settings = app.Settings with { SaveBrowsingHistory = on });
        var engines = SearchEngine.AllCases;
        content.Picker("Web search", engines.Select(e => e.Label).ToList(),
            () => Math.Max(0, engines.ToList().IndexOf(app.Settings.SearchEngine)),
            index => app.Settings = app.Settings with { SearchEngine = engines[index] }, 300);

        Button? frames = null;
        Button? history = null;
        Button? cookies = null;
        frames = Buttons.Outline(_framesSize > 0 ? $"Delete frames ({SocialKit.Bytes(_framesSize)})" : "Delete frames", () => _ = DeleteFrames(frames!));
        history = Buttons.Outline("Clear browsing history", () => _ = ClearHistory(history!));
        cookies = Buttons.Outline("Clear cookies and logins", () => _ = ClearCookies(cookies!));
        content.Add(Ui.HStack(10, Buttons.Outline("Export library", () => _ = Export()), frames, history, cookies));
    }

    private async Task DeleteFrames(FrameworkElement anchor)
    {
        if (!await SocialKit.ConfirmAsync(anchor, "Delete all saved frames?", "This includes moments you saved. Your library and timeline stay.", "Delete frames and moments")) return;
        _app.Library.DeleteAllFrames();
        _framesSize = 0;
        _app.Toasts.Show("Frames deleted");
        Section.Refresh();
    }

    private async Task ClearHistory(FrameworkElement anchor)
    {
        if (!await SocialKit.ConfirmAsync(anchor, "Clear browsing history?", "Your library and film timeline stay.", "Clear history")) return;
        try { _app.Session.Db.ClearHistory(); }
        catch (Exception) { }
        _app.Toasts.Show("Browsing history cleared");
    }

    private async Task ClearCookies(FrameworkElement anchor)
    {
        if (!await SocialKit.ConfirmAsync(anchor, "Clear cookies and logins?", "You'll be signed out of every site in this profile.", "Clear cookies and logins")) return;
        // TODO(port-browser): clear this profile's WebView2 data (the Mac's dataStore.removeData(ofTypes: all,
        // modifiedSince: .distantPast)), e.g. `await _app.Session.Web.ClearBrowsingDataAsync()` through
        // CoreWebView2Profile.ClearBrowsingDataAsync(), then:
        //   _app.Toasts.Show("Cookies and logins cleared");
    }

    private async Task Export()
    {
        var app = _app;
        if (app.Window is not { } window) return;
        Microsoft.Windows.Storage.Pickers.PickFileResult? result;
        try
        {
            var picker = new Microsoft.Windows.Storage.Pickers.FileSavePicker(window.AppWindow.Id)
            {
                SuggestedFileName = "Cineon library",
                DefaultFileExtension = ".json",
            };
            picker.FileTypeChoices.Add("JSON", new List<string> { ".json" });
            result = await picker.PickSaveFileAsync();
        }
        catch (Exception error)
        {
            app.Toasts.Show($"Couldn't export: {error.Message}");
            return;
        }
        if (result is null || string.IsNullOrEmpty(result.Path)) return;
        try
        {
            var data = LibraryExport.Make(app.Library);
            var temporary = result.Path + ".tmp";
            await File.WriteAllBytesAsync(temporary, data);
            File.Move(temporary, result.Path, overwrite: true);
            app.Toasts.Show("Library exported");
        }
        catch (Exception error)
        {
            app.Toasts.Show($"Couldn't export: {error.Message}");
        }
    }
}

/// The library as JSON, the Mac's LibraryExport: the same keys, sorted, dates in ISO 8601, and
/// missing values left out.
internal static class LibraryExport
{
    public static byte[] Make(LibraryStore library, DateTimeOffset? now = null)
    {
        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            w.WriteStartObject();
            w.WriteString("exportedAt", Iso(now ?? DateTimeOffset.Now));
            w.WriteStartArray("timeline");
            foreach (var session in library.Sessions)
            {
                w.WriteStartObject();
                w.WriteNumber("duration", session.Duration);
                w.WriteString("endedAt", Iso(session.EndedAt));
                w.WriteNumber("episode", session.Ref.Episode);
                w.WriteBoolean("finished", session.Finished);
                w.WriteNumber("season", session.Ref.Season);
                w.WriteString("site", session.Host);
                w.WriteString("startedAt", Iso(session.StartedAt));
                w.WriteNumber("stoppedAt", session.EndPosition);
                w.WriteString("title", library.Titles.TryGetValue(session.TitleId, out var title) ? title.Name : "");
                if (session.Url is { } url) w.WriteString("url", url.OriginalString);
                w.WriteNumber("watchedSeconds", session.WatchedSeconds);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteStartArray("titles");
            foreach (var title in library.Titles.Values.OrderBy(t => t.Name, StringComparer.Ordinal))
            {
                w.WriteStartObject();
                if (title.FinishedAt is { } finished) w.WriteString("finishedAt", Iso(finished));
                if (title.ImdbId is { } imdb) w.WriteString("imdbID", imdb);
                w.WriteString("kind", title.Kind.ToRaw());
                w.WriteString("name", title.Name);
                if (title.Rating is { } rating) w.WriteNumber("rating", rating);
                w.WriteString("status", title.Status.ToRaw());
                if (title.Year is { } year) w.WriteNumber("year", year);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }
        return stream.ToArray();
    }

    /// JSONEncoder's `.iso8601`: UTC, whole seconds, a Z.
    private static string Iso(DateTimeOffset date) => date.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
}
