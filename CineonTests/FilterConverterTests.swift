import WebKit
import XCTest
@testable import Cineon

@MainActor
final class FilterConverterTests: XCTestCase {

    private func rules(_ text: String) throws -> [[String: Any]] {
        let output = FilterConverter.convert(text)
        let data = Data(output.json.utf8)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    }

    private func trigger(_ rule: [String: Any]) -> [String: Any] { rule["trigger"] as? [String: Any] ?? [:] }
    private func action(_ rule: [String: Any]) -> [String: Any] { rule["action"] as? [String: Any] ?? [:] }

    func testHostAnchoredBlock() throws {
        let r = try rules("||popads.net^")
        XCTAssertEqual(r.count, 1)
        XCTAssertEqual(action(r[0])["type"] as? String, "block")
        XCTAssertEqual(trigger(r[0])["url-filter"] as? String, #"^[^:]+://+([^:/]+\.)?popads\.net[/:&?=]?"#)
    }

    func testOptions() throws {
        let r = try rules("||ads.example.com^$script,third-party,domain=site.com|other.org")
        let t = trigger(r[0])
        XCTAssertEqual(t["resource-type"] as? [String], ["script"])
        XCTAssertEqual(t["load-type"] as? [String], ["third-party"])
        XCTAssertEqual(t["if-domain"] as? [String], ["*site.com", "*other.org"])
    }

    func testExceptionsComeLast() throws {
        let r = try rules("@@||good.com^\n||bad.com^")
        XCTAssertEqual(action(r[0])["type"] as? String, "block")
        XCTAssertEqual(action(r[1])["type"] as? String, "ignore-previous-rules")
    }

    func testCosmeticGenericAreBatched() throws {
        let r = try rules("##.ad-a\n##.ad-b")
        XCTAssertEqual(r.count, 1)
        XCTAssertEqual(action(r[0])["selector"] as? String, ".ad-a,.ad-b")
    }

    func testCosmeticDomainSpecific() throws {
        let r = try rules("example.com,other.org##.banner")
        XCTAssertEqual(trigger(r[0])["if-domain"] as? [String], ["*example.com", "*other.org"])
    }

    func testCosmeticExceptionBecomesUnlessDomain() throws {
        let r = try rules("##.promo\nexample.com#@#.promo")
        XCTAssertEqual(r.count, 1)
        XCTAssertEqual(trigger(r[0])["unless-domain"] as? [String], ["*example.com"])
    }

    func testWholeSiteException() throws {
        let r = try rules("@@||example.com^$document")
        XCTAssertEqual(trigger(r[0])["if-domain"] as? [String], ["*example.com"])
        XCTAssertEqual(action(r[0])["type"] as? String, "ignore-previous-rules")
    }

    func testUnsupportedRulesAreSkipped() throws {
        let text = """
        ! comment
        [Adblock Plus 2.0]
        example.com##+js(noop)
        example.com#?#.a:has-text(ad)
        ||a.com^$csp=script-src 'none'
        ||b.com^$redirect=noop.js
        /banner[0-9]+/
        ||c.com^$popup
        ||кино.рф^
        """
        XCTAssertEqual(try rules(text).count, 0)
    }

    func testBothDomainKindsNeverAppearTogether() throws {
        let r = try rules("||x.example.net^$domain=a.com|~b.com")
        XCTAssertNotNil(trigger(r[0])["if-domain"])
        XCTAssertNil(trigger(r[0])["unless-domain"])
    }

    func testSpecialCharactersAreEscaped() {
        XCTAssertEqual(FilterConverter.urlFilter(from: "/ads.js?v=1"), #"/ads\.js\?v=1"#)
        XCTAssertEqual(FilterConverter.urlFilter(from: "|https://x.com/a*b|"), #"^https://x\.com/a.*b$"#)
    }

    func testTooShortPatternRejected() {
        XCTAssertNil(FilterConverter.urlFilter(from: "*^"))
    }

    /// The real proof: WebKit must accept the output for every list the app ships.
    func testBundledListsCompileInWebKit() async throws {
        let store = try XCTUnwrap(WKContentRuleListStore(url: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)))
        for info in FilterEngine.catalog {
            let url = try XCTUnwrap(Bundle.main.url(forResource: info.id, withExtension: "txt", subdirectory: "Filters"), info.id)
            let text = try String(contentsOf: url, encoding: .utf8)
            let output = FilterConverter.convert(text)
            XCTAssertGreaterThan(output.ruleCount, 10, info.id)
            XCTAssertLessThan(output.ruleCount, 150_000, info.id)
            let error: String? = await withCheckedContinuation { continuation in
                store.compileContentRuleList(forIdentifier: info.id, encodedContentRuleList: output.json) { list, error in
                    continuation.resume(returning: list == nil ? (error?.localizedDescription ?? "no list") : nil)
                }
            }
            XCTAssertNil(error, "\(info.id) failed: \(error ?? "")")
            print("list \(info.id): \(output.ruleCount) rules, \(output.skipped) skipped")
        }
    }
}
