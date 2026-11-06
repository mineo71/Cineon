import Foundation

/// Converts Adblock Plus syntax filter lists into WebKit content blocker JSON.
///
/// WebKit compiles rules to bytecode, which is why blocking costs almost nothing at page load.
/// The price is a strict format: one bad regular expression or a non-ASCII character rejects the
/// whole list, so this converter only ever emits constructs WebKit is known to accept and skips
/// anything it can't express. Skipped rules are procedural cosmetics, scriptlets and complex regexes.
nonisolated enum FilterConverter {

    struct Output: Sendable {
        var json: String
        var ruleCount: Int
        var skipped: Int
    }

    /// WebKit rejects lists over 150,000 rules.
    static let maxRules = 145_000
    private static let cosmeticBatch = 200

    static func convert(_ text: String, maxRules: Int = FilterConverter.maxRules) -> Output {
        var genericSelectors: [String] = []
        var genericExceptions: [String: [String]] = [:]
        var domainSelectors: [String: [String]] = [:] // Domains joined by "," to selectors.
        var unlessSelectors: [String: [String]] = [:]
        var blocks: [String] = []
        var exceptions: [String] = []
        var skipped = 0

        text.enumerateLines { rawLine, _ in
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("!") || line.hasPrefix("[") { return }

            if let cosmetic = parseCosmetic(line) {
                switch cosmetic {
                case .skip:
                    skipped += 1
                case .generic(let selector):
                    genericSelectors.append(selector)
                case .only(let domains, let selector):
                    domainSelectors[domains.joined(separator: ","), default: []].append(selector)
                case .except(let domains, let selector):
                    unlessSelectors[domains.joined(separator: ","), default: []].append(selector)
                case .exception(let domains, let selector):
                    genericExceptions[selector, default: []].append(contentsOf: domains)
                }
                return
            }

            guard let network = parseNetwork(line) else {
                skipped += 1
                return
            }
            if network.isException {
                exceptions.append(network.json)
            } else {
                blocks.append(network.json)
            }
        }

        var rules: [String] = []
        rules.reserveCapacity(blocks.count + exceptions.count + 512)

        // Generic cosmetic rules first, batched: one combined stylesheet rule per 200 selectors
        // keeps the rule count down and is what makes compiling fast.
        var plainGeneric: [String] = []
        for selector in genericSelectors {
            if let domains = genericExceptions[selector], !domains.isEmpty {
                rules.append(cosmeticRule(selector: selector, trigger: unlessDomainJSON(domains)))
            } else {
                plainGeneric.append(selector)
            }
        }
        for start in stride(from: 0, to: plainGeneric.count, by: cosmeticBatch) {
            let batch = plainGeneric[start..<min(start + cosmeticBatch, plainGeneric.count)]
            rules.append(cosmeticRule(selector: batch.joined(separator: ","), trigger: ""))
        }

        for (joined, selectors) in domainSelectors {
            let domains = joined.split(separator: ",").map(String.init)
            for start in stride(from: 0, to: selectors.count, by: cosmeticBatch) {
                let batch = selectors[start..<min(start + cosmeticBatch, selectors.count)]
                rules.append(cosmeticRule(selector: batch.joined(separator: ","), trigger: ifDomainJSON(domains)))
            }
        }
        for (joined, selectors) in unlessSelectors {
            let domains = joined.split(separator: ",").map(String.init)
            for start in stride(from: 0, to: selectors.count, by: cosmeticBatch) {
                let batch = selectors[start..<min(start + cosmeticBatch, selectors.count)]
                rules.append(cosmeticRule(selector: batch.joined(separator: ","), trigger: unlessDomainJSON(domains)))
            }
        }

        rules.append(contentsOf: blocks)
        // Exceptions must come last: ignore-previous-rules only cancels rules above it.
        rules.append(contentsOf: exceptions)

        if rules.count > maxRules {
            // Keep exceptions: dropping them would break sites rather than just miss an ad.
            let keepFromStart = max(0, maxRules - exceptions.count)
            skipped += rules.count - maxRules
            rules = Array(rules.prefix(keepFromStart)) + exceptions.prefix(maxRules)
        }

        return Output(json: "[" + rules.joined(separator: ",") + "]", ruleCount: rules.count, skipped: skipped)
    }

    // MARK: Cosmetic filters

    private enum Cosmetic {
        case skip
        case generic(String)
        case only([String], String)
        case except([String], String)
        case exception([String], String)
    }

    private static let proceduralMarkers = [
        ":-abp-", ":has-text", ":contains(", ":xpath", ":style(", ":upward", ":remove(", ":matches-",
        ":min-text-length", ":watch-attr", ":if(", ":if-not", ":nth-ancestor", ":others(", ":-ext-", ":remove-attr",
        ":remove-class", ":matches-path", ":matches-css", ":matches-attr", ":matches-prop",
    ]

    private static func parseCosmetic(_ line: String) -> Cosmetic? {
        // Advanced syntaxes have no WebKit equivalent.
        for marker in ["#?#", "#$#", "#%#", "#@?#", "#@$#", "##+js", "##^", "$$", "#@%#"] where line.contains(marker) {
            if marker == "$$" && !line.contains("##") { continue }
            return .skip
        }
        if let range = line.range(of: "#@#") {
            let domains = parseCosmeticDomains(String(line[..<range.lowerBound])).only
            let selector = String(line[range.upperBound...])
            guard isUsableSelector(selector), !domains.isEmpty else { return .skip }
            return .exception(domains, selector)
        }
        guard let range = line.range(of: "##") else { return nil }

        let selector = String(line[range.upperBound...]).trimmingCharacters(in: .whitespaces)
        guard isUsableSelector(selector) else { return .skip }

        let prefix = String(line[..<range.lowerBound])
        if prefix.isEmpty { return .generic(selector) }

        let parsed = parseCosmeticDomains(prefix)
        if parsed.invalid { return .skip }
        if !parsed.only.isEmpty { return .only(parsed.only, selector) }
        if !parsed.except.isEmpty { return .except(parsed.except, selector) }
        return .skip
    }

    private static func parseCosmeticDomains(_ text: String) -> (only: [String], except: [String], invalid: Bool) {
        var only: [String] = []
        var except: [String] = []
        for part in text.split(separator: ",") {
            let negated = part.hasPrefix("~")
            let name = String(negated ? part.dropFirst() : part).lowercased()
            guard isPlainDomain(name) else { return ([], [], true) }
            if negated { except.append(name) } else { only.append(name) }
        }
        return (only, except, false)
    }

    private static func isUsableSelector(_ selector: String) -> Bool {
        guard !selector.isEmpty, selector.utf8.allSatisfy({ $0 < 128 && $0 >= 32 }) else { return false }
        return !proceduralMarkers.contains { selector.contains($0) }
    }

    private static func cosmeticRule(selector: String, trigger: String) -> String {
        #"{"trigger":{"url-filter":".*"\#(trigger)},"action":{"type":"css-display-none","selector":\#(jsonString(selector))}}"#
    }

    // MARK: Network filters

    private struct NetworkRule {
        var isException: Bool
        var json: String
    }

    private static func parseNetwork(_ raw: String) -> NetworkRule? {
        var line = raw
        let isException = line.hasPrefix("@@")
        if isException { line.removeFirst(2) }

        // Regular expression rules rarely fit WebKit's subset, and they are few. Skip them.
        if line.hasPrefix("/"), line.hasSuffix("/") || line.contains("/$") { return nil }

        var options: [String] = []
        if let dollar = line.lastIndex(of: "$"), line[line.index(after: dollar)...].first != nil,
           !line[line.index(after: dollar)...].contains("/") {
            options = line[line.index(after: dollar)...].split(separator: ",").map(String.init)
            line = String(line[..<dollar])
        }

        var loadType: String?
        var ifDomains: [String] = []
        var unlessDomains: [String] = []
        var types: [String] = []
        var excludedTypes: Set<String> = []
        var caseSensitive = false
        var childFrameOnly = false
        var wholeSite = false

        for option in options {
            let lower = option.lowercased()
            switch lower {
            case "third-party", "3p": loadType = "third-party"
            case "~third-party", "first-party", "1p", "~3p": loadType = "first-party"
            case "script": types.append("script")
            case "image": types.append("image")
            case "stylesheet", "css": types.append("style-sheet")
            case "font": types.append("font")
            case "media": types.append("media")
            case "xmlhttprequest", "xhr": types.append("fetch")
            case "websocket": types.append("websocket")
            case "other": types.append("other")
            case "ping": types.append("ping")
            case "subdocument", "frame":
                types.append("document")
                childFrameOnly = true
            case "~script": excludedTypes.insert("script")
            case "~image": excludedTypes.insert("image")
            case "~stylesheet": excludedTypes.insert("style-sheet")
            case "~font": excludedTypes.insert("font")
            case "~media": excludedTypes.insert("media")
            case "~xmlhttprequest": excludedTypes.insert("fetch")
            case "~subdocument": excludedTypes.insert("document")
            case "match-case": caseSensitive = true
            case "important", "all", "first-party-only": break
            case "document", "doc", "elemhide", "ehide", "generichide", "ghide":
                guard isException else { return nil }
                wholeSite = true
            case "popup", "popunder":
                // Handled by the pop-up shield, which sees the real target before it opens.
                return nil
            default:
                if lower.hasPrefix("domain=") || lower.hasPrefix("from=") {
                    let list = option[option.index(after: option.firstIndex(of: "=")!)...]
                    for part in list.split(separator: "|") {
                        let negated = part.hasPrefix("~")
                        let name = String(negated ? part.dropFirst() : part).lowercased()
                        guard isPlainDomain(name) else { return nil }
                        if negated { unlessDomains.append(name) } else { ifDomains.append(name) }
                    }
                } else {
                    // csp=, redirect=, removeparam=, badfilter and so on have no equivalent.
                    return nil
                }
            }
        }

        // WebKit allows if-domain or unless-domain on a rule, never both.
        if !ifDomains.isEmpty && !unlessDomains.isEmpty { unlessDomains = [] }

        if !excludedTypes.isEmpty {
            let all = ["document", "image", "style-sheet", "script", "font", "media", "fetch", "websocket", "other", "ping"]
            types = all.filter { !excludedTypes.contains($0) }
        }

        // Whole-site exceptions: "@@||example.com^$document" turns everything off for that site.
        if wholeSite {
            guard let domain = hostAnchoredDomain(line) else { return nil }
            let trigger = #""url-filter":".*","if-domain":\#(jsonArray(["*" + domain]))"#
            return NetworkRule(isException: true, json: #"{"trigger":{\#(trigger)},"action":{"type":"ignore-previous-rules"}}"#)
        }

        guard line.count >= 4 || line.hasPrefix("||"), let filter = urlFilter(from: line) else { return nil }

        var trigger = #""url-filter":\#(jsonString(filter))"#
        if caseSensitive { trigger += #","url-filter-is-case-sensitive":true"# }
        if !types.isEmpty { trigger += #","resource-type":\#(jsonArray(types))"# }
        if let loadType { trigger += #","load-type":["\#(loadType)"]"# }
        if childFrameOnly { trigger += #","load-context":["child-frame"]"# }
        if !ifDomains.isEmpty { trigger += #","if-domain":\#(jsonArray(ifDomains.map { "*" + $0 }))"# }
        if !unlessDomains.isEmpty { trigger += #","unless-domain":\#(jsonArray(unlessDomains.map { "*" + $0 }))"# }

        let action = isException ? "ignore-previous-rules" : "block"
        return NetworkRule(isException: isException, json: #"{"trigger":{\#(trigger)},"action":{"type":"\#(action)"}}"#)
    }

    /// "||example.com^" gives "example.com". Anything with a path is not a whole-site rule.
    private static func hostAnchoredDomain(_ pattern: String) -> String? {
        guard pattern.hasPrefix("||") else { return nil }
        var rest = String(pattern.dropFirst(2))
        if rest.hasSuffix("^") { rest.removeLast() }
        let lower = rest.lowercased()
        return isPlainDomain(lower) ? lower : nil
    }

    /// Translates an ABP pattern to the regular expression subset WebKit accepts.
    static func urlFilter(from pattern: String) -> String? {
        guard pattern.utf8.allSatisfy({ $0 < 128 && $0 >= 32 }) else { return nil }
        var p = Substring(pattern)
        var prefix = ""
        var suffix = ""

        if p.hasPrefix("||") {
            p = p.dropFirst(2)
            prefix = "^[^:]+://+([^:/]+\\.)?"
        } else if p.hasPrefix("|") {
            p = p.dropFirst()
            prefix = "^"
        }
        if p.hasSuffix("|") {
            p = p.dropLast()
            suffix = "$"
        }
        while p.hasPrefix("*") { p = p.dropFirst() }
        while p.hasSuffix("*") { p = p.dropLast() }
        guard !p.isEmpty else { return nil }

        var out = prefix
        var previousWasWildcard = false
        for c in p {
            switch c {
            case "*":
                if !previousWasWildcard { out += ".*" }
                previousWasWildcard = true
                continue
            case "^":
                out += "[/:&?=]?"
            case ".", "?", "+", "(", ")", "[", "]", "{", "}", "|", "\\", "$":
                out += "\\\(c)"
            default:
                out.append(c)
            }
            previousWasWildcard = false
        }
        out += suffix

        // A pattern this short, with no anchor, would match half the web.
        let literalLength = p.filter { $0 != "*" && $0 != "^" }.count
        if literalLength < 3 { return nil }
        return out
    }

    // MARK: JSON

    private static func isPlainDomain(_ s: String) -> Bool {
        guard !s.isEmpty, s.contains(".") || s.count > 1 else { return false }
        return s.utf8.allSatisfy { c in
            (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 45 || c == 46
        } && !s.hasPrefix(".") && !s.hasSuffix(".")
    }

    private static func ifDomainJSON(_ domains: [String]) -> String {
        #","if-domain":\#(jsonArray(domains.map { "*" + $0 }))"#
    }

    private static func unlessDomainJSON(_ domains: [String]) -> String {
        #","unless-domain":\#(jsonArray(domains.map { "*" + $0 }))"#
    }

    private static func jsonArray(_ items: [String]) -> String {
        "[" + items.map(jsonString).joined(separator: ",") + "]"
    }

    static func jsonString(_ s: String) -> String {
        var out = "\""
        out.reserveCapacity(s.utf8.count + 2)
        for c in s.unicodeScalars {
            switch c {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if c.value < 0x20 {
                    out += String(format: "\\u%04x", c.value)
                } else {
                    out.unicodeScalars.append(c)
                }
            }
        }
        return out + "\""
    }
}
