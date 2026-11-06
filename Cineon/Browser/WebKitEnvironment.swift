import WebKit

/// The WebKit setup one profile shares across its tabs: cookies, scripts and rule lists.
final class WebKitEnvironment {
    /// Private world for our scripts. Pages can't see these or the message handlers.
    static let world = WKContentWorld.world(name: "CineonWorld")

    let dataStore: WKWebsiteDataStore
    let controller = WKUserContentController()

    init(profileID: UUID, router: ScriptRouter) {
        // A separate store per profile keeps logins and cookies apart between family members.
        dataStore = WKWebsiteDataStore(forIdentifier: profileID)

        controller.add(router, contentWorld: Self.world, name: "cineonMedia")
        controller.add(router, contentWorld: Self.world, name: "cineonMeta")
        controller.addScriptMessageHandler(router, contentWorld: Self.world, name: "cineonMediaReply")
        controller.add(router, contentWorld: .page, name: "cineonShield")
    }

    /// Installs the page scripts. The sweeper is optional, so it can be switched off in Settings.
    func installScripts(overlaySweeper enabled: Bool) {
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(
            source: PageScripts.media, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: Self.world
        ))
        controller.addUserScript(WKUserScript(
            source: PageScripts.meta, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: Self.world
        ))
        if enabled {
            controller.addUserScript(WKUserScript(
                source: PageScripts.shield, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page
            ))
        }
    }

    func applyRules(_ lists: [WKContentRuleList]) {
        controller.removeAllContentRuleLists()
        for list in lists { controller.add(list) }
    }

    /// Turns all rule lists off for one page load. Rule lists can't cancel each other, since
    /// ignore-previous-rules only reaches rules in its own list, so a site can't be allowed
    /// with another list. This is the switch Safari itself uses, and it isn't in the public API,
    /// hence the check. If it ever disappeared, sites would simply stay blocked.
    static func disableContentBlockers(in preferences: WKWebpagePreferences) {
        setPrivate(preferences, "contentBlockersEnabled", false)
    }

    /// Lets one page start playing with sound, for the episode someone asked to carry on with.
    /// Also not in the public API, and the worst case without it is pressing play by hand.
    static func allowAutoplay(in preferences: WKWebpagePreferences) {
        setPrivate(preferences, "autoplayPolicy", 1)
    }

    func makeConfiguration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        config.userContentController = controller
        config.mediaTypesRequiringUserActionForPlayback = .audio
        config.allowsAirPlayForMediaPlayback = true
        config.suppressesIncrementalRendering = false
        config.upgradeKnownHostsToHTTPS = true
        // Sites serve their real player to Safari. Plain WKWebView gets turned away by some.
        config.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15"
        config.defaultWebpagePreferences.preferredContentMode = .desktop
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let prefs = config.preferences
        prefs.isElementFullscreenEnabled = true
        prefs.javaScriptCanOpenWindowsAutomatically = true // The pop-up shield decides instead.
        prefs.isFraudulentWebsiteWarningEnabled = false // Streaming sites trip it constantly.
        // Not in the public API on macOS.
        Self.setPrivate(prefs, "allowsPictureInPictureMediaPlayback", true)
        Self.setPrivate(prefs, "developerExtrasEnabled", true)
        return config
    }

    /// Sets a WebKit setting that isn't in the public API, if this WebKit has it. Give the plain
    /// key, `fooEnabled`: key-value coding calls `_setFooEnabled:` for it, and that's what is
    /// checked first. An unknown key throws an Objective-C exception, which Swift can't catch.
    /// Inside async code that also corrupts the concurrency runtime, and the app crashes later
    /// somewhere unrelated.
    @discardableResult
    static func setPrivate(_ object: NSObject, _ key: String, _ value: Any) -> Bool {
        guard !key.hasPrefix("_"), let first = key.first else { return false }
        let selector = NSSelectorFromString("_set" + first.uppercased() + key.dropFirst() + ":")
        guard object.responds(to: selector) else { return false }
        object.setValue(value, forKey: key)
        return true
    }

    func makeWebView(configuration: WKWebViewConfiguration? = nil) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: configuration ?? makeConfiguration())
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.isInspectable = true
        webView.autoresizingMask = [.width, .height]
        return webView
    }

    func teardown() {
        controller.removeAllScriptMessageHandlers(from: Self.world)
        controller.removeAllScriptMessageHandlers(from: .page)
        controller.removeAllUserScripts()
        controller.removeAllContentRuleLists()
    }
}

private nonisolated struct ScriptReply: @unchecked Sendable {
    let value: Any?
}

extension WKWebView {
    /// Runs a script in Cineon's private world and waits for what it returns.
    func runScript(_ script: String, in frame: WKFrameInfo? = nil) async -> Any? {
        let reply = await withCheckedContinuation { (continuation: CheckedContinuation<ScriptReply, Never>) in
            evaluateJavaScript(script, in: frame, in: WebKitEnvironment.world) { result in
                continuation.resume(returning: ScriptReply(value: try? result.get()))
            }
        }
        return reply.value
    }
}

enum PageScripts {
    private static func load(_ name: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: "js", subdirectory: "Scripts"),
              let text = try? String(contentsOf: url, encoding: .utf8)
        else {
            assertionFailure("Missing script \(name)")
            return ""
        }
        return text
    }

    static let media = load("media")
    static let meta = load("meta")
    static let shield = load("shield")
    static let theater = load("theater")
}

/// Delivers messages from page scripts to whichever tab owns the web view.
final class ScriptRouter: NSObject, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    weak var browser: BrowserModel?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let webView = message.webView, let tab = browser?.tab(for: webView) else { return }
        switch message.name {
        case "cineonMedia":
            tab.receiveMedia(message.body, frame: message.frameInfo)
        case "cineonMeta":
            tab.receiveMeta(message.body)
        case "cineonShield":
            tab.receiveShield(message.body)
        default:
            break
        }
    }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard let webView = message.webView, let tab = browser?.tab(for: webView),
              let event = MediaEvent(message.body)
        else {
            replyHandler(nil, nil)
            return
        }
        tab.mediaFrame = message.frameInfo
        replyHandler(tab.replyToReadyVideo(event), nil)
    }
}
