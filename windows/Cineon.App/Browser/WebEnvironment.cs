using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Shields;
using Microsoft.Web.WebView2.Core;
using Windows.System;

namespace Cineon.App.Browser;

/// What one profile's tabs share: the WebView2 environment with its own user data folder (cookies
/// and logins stay apart between family members), the page scripts and the ad rules. The Mac's
/// `WebKitEnvironment`. Lives on the UI thread.
public sealed class WebEnvironment
{
    /// Media keys go to NowPlayingCenter, not to Chromium's own media session. Chromium's own
    /// occlusion tracking is off too, so a film behind another window, or the season grabber's
    /// helper parked out of sight, keeps playing the way a WKWebView does.
    public const string BrowserArguments =
        "--disable-features=HardwareMediaKeyHandling,MediaSessionService,CalculateNativeWinOcclusion";

    private Task<CoreWebView2Environment>? _environment;

    public WebEnvironment(Guid profileId)
    {
        ProfileId = profileId;
    }

    public Guid ProfileId { get; }

    /// Where WebView2 keeps this profile's cookies, cache and logins.
    public string UserDataFolder => Path.Combine(AppPaths.Profile(ProfileId), "WebView2");

    /// The ad and tracker rules every tab matches requests against. Tabs re-read this on `RulesChanged`.
    public ShieldEngine Rules { get; private set; } = ShieldEngine.Empty;

    public event Action? RulesChanged;

    public bool OverlaySweeper { get; private set; } = true;

    /// Raised when the page scripts change, so open tabs install the new set for their next pages.
    public event Action? ScriptsChanged;

    /// The profile closed: no new web views from here.
    public bool IsTornDown { get; private set; }

    /// Completes when the current environment's browser process has gone.
    private TaskCompletionSource? _exited;

    /// The environment, created once on first use. Call on the UI thread.
    public Task<CoreWebView2Environment> EnvironmentAsync()
    {
        if (IsTornDown) return Task.FromException<CoreWebView2Environment>(new ObjectDisposedException(nameof(WebEnvironment)));
        // A failed attempt is tried again, for instance after the WebView2 runtime is installed.
        if (_environment is { IsFaulted: true } or { IsCanceled: true }) _environment = null;
        return _environment ??= CreateAsync(null);
    }

    private async Task<CoreWebView2Environment> CreateAsync(Task? previousExit)
    {
        await Task.Yield();
        // The same user data folder can only take a new browser once the old one has exited.
        if (previousExit is not null) await Task.WhenAny(previousExit, Task.Delay(TimeSpan.FromSeconds(10)));
        Directory.CreateDirectory(UserDataFolder);
        var options = new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = BrowserArguments };
        var environment = await CoreWebView2Environment.CreateWithOptionsAsync("", UserDataFolder, options);
        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _exited = exited;
        environment.BrowserProcessExited += Safe.On<CoreWebView2Environment, CoreWebView2BrowserProcessExitedEventArgs>(
            "browser exited", (_, _) => exited.TrySetResult());
        return environment;
    }

    /// The browser process died: the next web view waits for it to be gone and starts a new one.
    internal void BrowserProcessFailed()
    {
        if (IsTornDown || _environment is not { IsCompletedSuccessfully: true }) return;
        _environment = CreateAsync(_exited?.Task);
    }

    /// Starts the browser process early, so the first tab paints without waiting for it. The Mac
    /// keeps a web view warm for the same reason.
    public void WarmUp() => Safe.Fire("web warm-up", async () => { if (!IsTornDown) await EnvironmentAsync(); });

    /// Installs the page scripts. The sweeper is optional, so it can be switched off in Settings.
    public void InstallScripts(bool overlaySweeper)
    {
        OverlaySweeper = overlaySweeper;
        ScriptsChanged?.Invoke();
    }

    public void ApplyRules(ShieldEngine rules)
    {
        Rules = rules;
        RulesChanged?.Invoke();
    }

    public void Teardown()
    {
        IsTornDown = true;
        RulesChanged = null;
        ScriptsChanged = null;
    }

    // MARK: Setting up a web view

    /// The settings every web view gets, the Mac's `makeConfiguration`. Sites never get to
    /// interrupt the film with a dialog; the pop-up shield decides about new windows; streaming
    /// sites trip SmartScreen constantly, as they do Safari's fraud warning.
    internal static void Configure(CoreWebView2 core)
    {
        var settings = core.Settings;
        settings.AreDefaultScriptDialogsEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false;
        settings.AreDevToolsEnabled = true;
        settings.IsZoomControlEnabled = true;
        settings.IsPinchZoomEnabled = true;
        settings.IsSwipeNavigationEnabled = true;
        settings.IsReputationCheckingRequired = false;
        settings.AreHostObjectsAllowed = false;
        settings.IsWebMessageEnabled = true;
        settings.IsScriptEnabled = true;
    }

    /// The Windows-only scripts that go after the shared ones (see `PageExtras`).
    internal static IEnumerable<string> ExtraScripts() => [KeysScript.Value, PageExtras.Links, PageExtras.Css];

    private static readonly Lazy<string> KeysScript = new(() =>
    {
        var shortcuts = new List<Shortcut> { Shortcut.Ctrl(VirtualKey.K) };
        if (AppModel.Shared is { } app)
        {
            try { shortcuts.AddRange(AppCommands.All(app).Select(c => c.Shortcut).OfType<Shortcut>()); }
            catch (Exception error) { CrashLog.Write("shortcut list", error); }
        }
        return PageExtras.Keys(shortcuts);
    });
}
