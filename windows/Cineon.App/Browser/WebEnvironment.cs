using Cineon.Core.Data;
using Cineon.Core.Shields;

namespace Cineon.App.Browser;

/// What one profile's tabs share: the WebView2 environment with its own user data folder (cookies
/// and logins stay apart between family members), the page scripts and the ad rules. The Mac's
/// `WebKitEnvironment`. The browser port owns this file and builds the real one.
public sealed class WebEnvironment
{
    // TODO(port-browser): init(profileID: UUID, router: ScriptRouter). Create the CoreWebView2Environment
    // here with UserDataFolder (below) and AdditionalBrowserArguments
    // "--disable-features=HardwareMediaKeyHandling,MediaSessionService" so media keys reach
    // NowPlayingCenter instead of Chromium (see windows/notes/app.md).
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

    // TODO(port-browser): func installScripts(overlaySweeper enabled: Bool). Reinstall in open tabs
    // through ScriptBridge.InstallAsync(overlaySweeper).
    public void InstallScripts(bool overlaySweeper)
    {
        OverlaySweeper = overlaySweeper;
    }

    // TODO(port-browser): func applyRules(_ lists: [WKContentRuleList]).
    public void ApplyRules(ShieldEngine rules)
    {
        Rules = rules;
        RulesChanged?.Invoke();
    }

    // TODO(port-browser): func teardown()
    public void Teardown()
    {
        RulesChanged = null;
    }
}
