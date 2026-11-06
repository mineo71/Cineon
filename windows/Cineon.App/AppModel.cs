using Cineon.App.UI;

namespace Cineon.App;

/// Same cases as the Mac's `Route`.
public enum Route { Home, Library, Timeline, Web, Settings, Downloads, Player, Together, Profile, Rate }

/// Same cases as the Mac's `AppSheet`.
public abstract record AppSheet
{
    public sealed record AddSite(string? Prefill) : AppSheet;
    public sealed record EditSite(long SiteId) : AppSheet;
    public sealed record AddTitle(string? Query) : AppSheet;
    public sealed record Relink : AppSheet;
    public sealed record ImportBrowser : AppSheet;
    public sealed record NewChallenge : AppSheet;
}

/// The whole app's state: who's watching, what's on screen, and the commands that change it.
/// Ported from the Mac's `AppModel` piece by piece; see windows/PLAN.md.
public sealed partial class AppModel : Observable
{
    public ToastCenter Toasts { get; } = new();

    private Route _route = Route.Home;
    public Route Route
    {
        get => _route;
        set
        {
            if (_route == value) return;
            PreviousRoute = _route;
            _route = value;
            Notify();
        }
    }

    public Route PreviousRoute { get; private set; } = Route.Home;

    private bool _isCommandBarVisible;
    public bool IsCommandBarVisible { get => _isCommandBarVisible; set => Set(ref _isCommandBarVisible, value); }
    public string CommandBarSeed { get; set; } = "";

    private long? _detailTitleId;
    public long? DetailTitleId { get => _detailTitleId; set => Set(ref _detailTitleId, value); }

    private AppSheet? _sheet;
    public AppSheet? Sheet { get => _sheet; set => Set(ref _sheet, value); }

    private bool _isProfilePickerVisible;
    public bool IsProfilePickerVisible { get => _isProfilePickerVisible; set => Set(ref _isProfilePickerVisible, value); }

    private bool _isFindVisible;
    public bool IsFindVisible { get => _isFindVisible; set => Set(ref _isFindVisible, value); }

    private bool _isCinema;
    public bool IsCinema { get => _isCinema; set => Set(ref _isCinema, value); }

    private bool _splashVisible = true;
    public bool SplashVisible { get => _splashVisible; set => Set(ref _splashVisible, value); }

    private bool _isDark = true;
    public bool IsDark
    {
        get => _isDark;
        set { if (Set(ref _isDark, value)) Theme.Set(value); }
    }

    /// Whether any site tabs are open, which shows the Browse section.
    public bool HasTabs => false;

    public void Go(Route destination)
    {
        DetailTitleId = null;
        Route = destination;
    }

    public void OpenCommandBar(string seed = "")
    {
        CommandBarSeed = seed;
        IsCommandBarVisible = true;
    }

    public void CloseCommandBar() => IsCommandBarVisible = false;

    public void ToggleTheme() => IsDark = !IsDark;

    /// Saves what needs saving before the app closes.
    public void PrepareToQuit()
    {
        Services.Updater.Shared.ApplyOnQuit();
    }
}

/// Short messages at the bottom of the window, sometimes with one action.
public sealed class ToastCenter : Observable
{
    public sealed record Toast(string Message, string? ActionTitle = null, Action? Run = null)
    {
        public Guid Id { get; } = Guid.NewGuid();
    }

    public Toast? Current { get; private set; }
    private CancellationTokenSource? _dismiss;

    public void Show(string message, string? actionTitle = null, Action? run = null)
    {
        // A burst of blocked pop-ups shouldn't restart the same message over and over.
        if (Current?.Message == message && Current.Run is null && run is null) return;
        Current = new Toast(message, actionTitle, run);
        Notify();
        _dismiss?.Cancel();
        var cts = _dismiss = new CancellationTokenSource();
        var delay = run is null ? 3.0 : 6.0;
        _ = DismissLater(delay, cts.Token);
    }

    private async Task DismissLater(double seconds, CancellationToken token)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(seconds), token); }
        catch (TaskCanceledException) { return; }
        Dismiss();
    }

    public void Dismiss()
    {
        if (Current is null) return;
        Current = null;
        Notify();
    }
}
