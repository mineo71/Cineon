using Cineon.App.Browser;
using Cineon.App.Playback;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Windows.System;
using Windows.UI.Core;

namespace Cineon.App.UI;

/// A key and its modifiers. The Mac's ⌘ is Ctrl here, ⌥ is Alt and ⇧ stays Shift.
public readonly record struct Shortcut(VirtualKey Key, bool Shift = false, bool Control = true, bool Alt = false)
{
    // Keys VirtualKey has no names for, on a US layout.
    public const VirtualKey Comma = (VirtualKey)188;
    public const VirtualKey Equal = (VirtualKey)187;
    public const VirtualKey Minus = (VirtualKey)189;
    public const VirtualKey OpenBracket = (VirtualKey)219;
    public const VirtualKey CloseBracket = (VirtualKey)221;

    public static Shortcut Ctrl(VirtualKey key) => new(key);
    public static Shortcut CtrlShift(VirtualKey key) => new(key, Shift: true);

    /// "Ctrl+Shift+P", as Windows menus write it.
    public string Text
    {
        get
        {
            var parts = new List<string>();
            if (Control) parts.Add("Ctrl");
            if (Alt) parts.Add("Alt");
            if (Shift) parts.Add("Shift");
            parts.Add(KeyName(Key));
            return string.Join("+", parts);
        }
    }

    private static string KeyName(VirtualKey key) => key switch
    {
        Comma => ",",
        Equal => "=",
        Minus => "-",
        OpenBracket => "[",
        CloseBracket => "]",
        >= VirtualKey.Number0 and <= VirtualKey.Number9 => ((int)key - (int)VirtualKey.Number0).ToString(),
        _ => key.ToString(),
    };
}

/// One menu command: what it says, what it does, and its shortcut.
public sealed record AppCommand(string Title, Action Run)
{
    public Shortcut? Shortcut { get; init; }
    public Func<bool>? IsEnabled { get; init; }
    /// For a toggle, whether it's on.
    public Func<bool>? IsChecked { get; init; }
}

/// A menu's entries: commands, submenus and separators.
public abstract record MenuEntry
{
    public sealed record Item(AppCommand Command) : MenuEntry;
    public sealed record Submenu(string Title, IReadOnlyList<MenuEntry> Entries) : MenuEntry;
    public sealed record Separator : MenuEntry;

    public static implicit operator MenuEntry(AppCommand command) => new Item(command);
}

/// The Mac's menu bar (CineonApp.swift's AppCommands), as one table that both the keyboard and the
/// app menu read. Windows has no menu bar, so the menu opens from the More button at the end of the
/// top bar's tools, or with Alt or F10.
public static class AppCommands
{
    private static readonly MenuEntry.Separator Divider = new();

    /// The tab the page commands act on: the selected one, while a site is on screen.
    private static BrowserTab? Tab(AppModel app) => app.Route == Route.Web ? app.Browser.Selected : null;

    /// The app menu, in the Mac's "Cineon" menu.
    public static IReadOnlyList<MenuEntry> AppMenu(AppModel app) =>
    [
        new AppCommand("Check for Updates…", Services.Updater.Shared.CheckForUpdates) { IsEnabled = () => Services.Updater.Shared.CanCheck },
        new AppCommand("Settings…", () => app.Go(Route.Settings)) { Shortcut = Shortcut.Ctrl(Shortcut.Comma) },
    ];

    public static IReadOnlyList<MenuEntry> File(AppModel app) =>
    [
        new AppCommand("New Tab", () => app.OpenCommandBar()) { Shortcut = Shortcut.Ctrl(VirtualKey.T) },
        new AppCommand("Open Location…", () => app.OpenCommandBar(Tab(app)?.Url?.OriginalString ?? "")) { Shortcut = Shortcut.Ctrl(VirtualKey.L) },
        new AppCommand("Reopen Closed Tab", app.Browser.ReopenClosed) { Shortcut = Shortcut.CtrlShift(VirtualKey.T) },
        Divider,
        new AppCommand("Import from Another Browser…", () => app.Sheet = new AppSheet.ImportBrowser()),
        new AppCommand("Close Tab", () => { if (Tab(app) is { } tab) app.Browser.Close(tab); }) { Shortcut = Shortcut.Ctrl(VirtualKey.W) },
    ];

    public static IReadOnlyList<MenuEntry> Edit(AppModel app) =>
    [
        new AppCommand("Find in Page", () => app.IsFindVisible = true) { Shortcut = Shortcut.Ctrl(VirtualKey.F) },
    ];

    /// The Mac's View menu (its toolbar group).
    public static IReadOnlyList<MenuEntry> View(AppModel app) =>
    [
        new AppCommand("Hide Toolbars on Sites", app.ToggleSidebar) { Shortcut = Shortcut.Ctrl(VirtualKey.S) },
        new AppCommand("Cinema Mode", app.ToggleCinema) { Shortcut = Shortcut.CtrlShift(VirtualKey.C) },
        Divider,
        new AppCommand("Reload Page", () => Tab(app)?.Reload()) { Shortcut = Shortcut.Ctrl(VirtualKey.R) },
        new AppCommand("Actual Size", () => Tab(app)?.ResetZoom()) { Shortcut = Shortcut.Ctrl(VirtualKey.Number0) },
        new AppCommand("Zoom In", () => Tab(app)?.Zoom(0.1)) { Shortcut = Shortcut.Ctrl(Shortcut.Equal) },
        new AppCommand("Zoom Out", () => Tab(app)?.Zoom(-0.1)) { Shortcut = Shortcut.Ctrl(Shortcut.Minus) },
        Divider,
        new AppCommand("Switch Theme", app.ToggleTheme) { Shortcut = Shortcut.CtrlShift(VirtualKey.D) },
    ];

    public static IReadOnlyList<MenuEntry> Watch(AppModel app) =>
    [
        new AppCommand("Home", () => app.Go(Route.Home)) { Shortcut = Shortcut.CtrlShift(VirtualKey.H) },
        new AppCommand("Library", () => app.Go(Route.Library)) { Shortcut = Shortcut.CtrlShift(VirtualKey.L) },
        new AppCommand("Timeline", () => app.Go(Route.Timeline)) { Shortcut = Shortcut.Ctrl(VirtualKey.Y) },
        new AppCommand("Together", () => app.Go(Route.Together)),
        new AppCommand("My Profile", () => app.Go(Route.Profile)),
        new AppCommand("Rate My Films", () => app.Go(Route.Rate)) { Shortcut = Shortcut.CtrlShift(VirtualKey.R) },
        Divider,
        new AppCommand("Add to Backlog", app.AddCurrentPageToBacklog) { Shortcut = Shortcut.Ctrl(VirtualKey.D) },
        new AppCommand("Search All Sites", () => app.OpenCommandBar()) { Shortcut = Shortcut.CtrlShift(VirtualKey.F) },
        Divider,
        new AppCommand("Play or Pause", app.TogglePlayback) { Shortcut = Shortcut.CtrlShift(VirtualKey.P) },
        new AppCommand("Back 10 Seconds", () => app.ActivePlayer?.Skip(-10)) { Shortcut = Shortcut.CtrlShift(VirtualKey.Left) },
        new AppCommand("Forward 10 Seconds", () => app.ActivePlayer?.Skip(10)) { Shortcut = Shortcut.CtrlShift(VirtualKey.Right) },
        new AppCommand("Next Episode", app.PlayNextEpisode) { Shortcut = Shortcut.CtrlShift(VirtualKey.N) },
        new AppCommand("Picture in Picture", () => app.Browser.PlayingTab?.TogglePictureInPicture()) { Shortcut = Shortcut.CtrlShift(VirtualKey.I) },
        new MenuEntry.Submenu("Sleep Timer", SleepTimer(app)),
        new AppCommand("Voice Boost", () => app.Settings = app.Settings with { VoiceBoost = !app.Settings.VoiceBoost })
        {
            Shortcut = Shortcut.CtrlShift(VirtualKey.B),
            IsChecked = () => app.Settings.VoiceBoost,
        },
        Divider,
        new AppCommand("Save This Moment", app.SaveMoment) { Shortcut = Shortcut.CtrlShift(VirtualKey.M) },
        new AppCommand("Download This Video", app.DownloadCurrentVideo) { Shortcut = Shortcut.CtrlShift(VirtualKey.S) },
        new AppCommand("Download the Rest of This Season", app.DownloadRestOfSeason),
        new AppCommand("Download the Whole Series…", app.DownloadWholeSeries),
        new AppCommand("Downloads", () => app.Go(Route.Downloads)) { Shortcut = Shortcut.CtrlShift(VirtualKey.J) },
        new AppCommand("Find This on Another Site", app.FindElsewhere) { Shortcut = Shortcut.CtrlShift(VirtualKey.E) },
        Divider,
        new AppCommand("Who's Watching…", () => app.IsProfilePickerVisible = true) { Shortcut = Shortcut.CtrlShift(VirtualKey.U) },
    ];

    private static IReadOnlyList<MenuEntry> SleepTimer(AppModel app)
    {
        var entries = new List<MenuEntry>();
        foreach (var mode in SleepTimerMode.Choices)
        {
            entries.Add(new AppCommand(mode.IsEndOfItem ? "At the End of This" : mode.Label, () => app.StartSleepTimer(mode)));
        }
        entries.Add(Divider);
        entries.Add(new AppCommand("Turn Off", app.CancelSleepTimer) { IsEnabled = () => app.SleepTimer is not null });
        return entries;
    }

    public static IReadOnlyList<MenuEntry> Tabs(AppModel app)
    {
        var entries = new List<MenuEntry>
        {
            new AppCommand("Back", () => Tab(app)?.GoBack()) { Shortcut = Shortcut.Ctrl(Shortcut.OpenBracket) },
            new AppCommand("Forward", () => Tab(app)?.GoForward()) { Shortcut = Shortcut.Ctrl(Shortcut.CloseBracket) },
            Divider,
            new AppCommand("Next Tab", () => app.Browser.SelectAdjacent(1)) { Shortcut = Shortcut.Ctrl(VirtualKey.Tab) },
            new AppCommand("Previous Tab", () => app.Browser.SelectAdjacent(-1)) { Shortcut = Shortcut.CtrlShift(VirtualKey.Tab) },
            Divider,
        };
        for (var number = 1; number <= 9; number++)
        {
            var index = number - 1;
            entries.Add(new AppCommand($"Tab {number}", () => app.Browser.SelectTab(index))
            {
                Shortcut = Shortcut.Ctrl(VirtualKey.Number0 + number),
            });
        }
        return entries;
    }

    /// The More menu: the Mac's Watch, Tabs and View menus, then the File and Edit commands, then
    /// the app's own.
    public static IReadOnlyList<MenuEntry> Menu(AppModel app) =>
    [
        new MenuEntry.Submenu("Watch", Watch(app)),
        new MenuEntry.Submenu("Tabs", Tabs(app)),
        new MenuEntry.Submenu("View", View(app)),
        Divider,
        .. File(app).Where(entry => entry is not MenuEntry.Item { Command.Title: "Import from Another Browser…" }),
        .. Edit(app),
        Divider,
        new AppCommand("Import from Another Browser…", () => app.Sheet = new AppSheet.ImportBrowser()),
        .. AppMenu(app).Reverse(),
    ];

    /// Every command with a shortcut.
    public static IEnumerable<AppCommand> All(AppModel app)
    {
        static IEnumerable<AppCommand> Flatten(IEnumerable<MenuEntry> entries)
        {
            foreach (var entry in entries)
            {
                switch (entry)
                {
                    case MenuEntry.Item item: yield return item.Command; break;
                    case MenuEntry.Submenu submenu:
                        foreach (var command in Flatten(submenu.Entries)) yield return command;
                        break;
                }
            }
        }
        return Flatten([.. AppMenu(app), .. File(app), .. Edit(app), .. View(app), .. Watch(app), .. Tabs(app)]);
    }
}

/// Runs the shortcuts. The window calls `Handle` for keys its views didn't use; the browser port
/// should also call it for keys pressed while a web page has focus, which WinUI never sees.
public static class Shortcuts
{
    public static bool Handle(AppModel app, VirtualKey key, bool control, bool shift, bool alt)
    {
        if (!control && !shift && !alt && key == VirtualKey.Escape) return app.HandleEscape();
        // The search button's tooltip promises Ctrl+K, as the Mac's does ⌘K.
        if (control && !shift && !alt && key == VirtualKey.K)
        {
            app.OpenCommandBar();
            return true;
        }
        var pressed = new Shortcut(key, shift, control, alt);
        foreach (var command in AppCommands.All(app))
        {
            if (command.Shortcut != pressed) continue;
            if (command.IsEnabled?.Invoke() == false) return true;
            command.Run();
            return true;
        }
        return false;
    }

    /// The modifiers held right now.
    public static (bool Control, bool Shift, bool Alt) Modifiers() =>
        (Down(VirtualKey.Control), Down(VirtualKey.Shift), Down(VirtualKey.Menu));

    private static bool Down(VirtualKey key) =>
        InputKeyboardSource.GetKeyStateForCurrentThread(key).HasFlag(CoreVirtualKeyStates.Down);
}

/// Builds the app menu as a MenuFlyout, fresh each time it opens so ticks and greyed items are current.
public static class AppMenu
{
    public static void Show(AppModel app, FrameworkElement anchor, Windows.Foundation.Point? at = null)
    {
        var flyout = new MenuFlyout();
        foreach (var item in Items(AppCommands.Menu(app))) flyout.Items.Add(item);
        var options = new FlyoutShowOptions { Placement = FlyoutPlacementMode.BottomEdgeAlignedRight };
        if (at is { } point) options.Position = point;
        flyout.ShowAt(anchor, options);
    }

    private static IEnumerable<MenuFlyoutItemBase> Items(IEnumerable<MenuEntry> entries)
    {
        foreach (var entry in entries)
        {
            switch (entry)
            {
                case MenuEntry.Separator:
                    yield return new MenuFlyoutSeparator();
                    break;
                case MenuEntry.Submenu submenu:
                    var sub = new MenuFlyoutSubItem { Text = submenu.Title };
                    foreach (var item in Items(submenu.Entries)) sub.Items.Add(item);
                    yield return sub;
                    break;
                case MenuEntry.Item { Command: var command }:
                    MenuFlyoutItem menuItem = command.IsChecked is { } isChecked
                        ? new ToggleMenuFlyoutItem { IsChecked = isChecked() }
                        : new MenuFlyoutItem();
                    menuItem.Text = command.Title;
                    menuItem.IsEnabled = command.IsEnabled?.Invoke() ?? true;
                    if (command.Shortcut is { } shortcut) menuItem.KeyboardAcceleratorTextOverride = shortcut.Text;
                    var run = command.Run;
                    menuItem.Click += (_, _) => run();
                    yield return menuItem;
                    break;
            }
        }
    }
}
