import WebKit
import XCTest
@testable import Cineon

/// Private WebKit settings are set by key-value coding. A key WebKit doesn't have throws an
/// Objective-C exception, which Swift can't catch and which crashed the season downloader.
@MainActor
final class PrivateSettingTests: XCTestCase {
    func testUnknownKeysAreSkippedNotThrown() {
        let view = WKWebView()
        XCTAssertFalse(WebKitEnvironment.setPrivate(view, "noSuchSettingAnywhere", false))
        // The setter's own name is the mistake that crashed it: KVC wants the plain key.
        XCTAssertFalse(WebKitEnvironment.setPrivate(view, "_windowOcclusionDetectionEnabled", false))
    }

    func testTheHelperWindowSettingExistsInThisWebKit() {
        let view = WKWebView()
        XCTAssertTrue(WebKitEnvironment.setPrivate(view, "windowOcclusionDetectionEnabled", false))
    }

    func testPreferencesStillApply() {
        let prefs = WKWebpagePreferences()
        XCTAssertTrue(WebKitEnvironment.setPrivate(prefs, "contentBlockersEnabled", false))
        XCTAssertTrue(WebKitEnvironment.setPrivate(prefs, "autoplayPolicy", 1))
    }
}
