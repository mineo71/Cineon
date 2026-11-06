import Foundation

nonisolated struct SubtitleCue: Hashable, Sendable {
    var start: Double
    var end: Double
    var text: String
}

/// A subtitle file saved next to a download, WebVTT or SubRip.
nonisolated struct SubtitleTrack: Identifiable, Hashable, Sendable {
    /// The file's path.
    let id: String
    let label: String
    let cues: [SubtitleCue]

    static func load(path: String) -> SubtitleTrack? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .windowsCP1251) ?? ""
        let cues = parse(text)
        guard !cues.isEmpty else { return nil }
        // "Film [1080p].en.vtt" is labelled by the part before the extension.
        let stem = URL(fileURLWithPath: path).deletingPathExtension().pathExtension
        return SubtitleTrack(id: path, label: displayName(stem), cues: cues)
    }

    static func parse(_ raw: String) -> [SubtitleCue] {
        let text = raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        var cues: [SubtitleCue] = []
        for block in text.components(separatedBy: "\n\n") {
            let lines = block.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            guard let timing = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
            let parts = lines[timing].components(separatedBy: "-->")
            guard parts.count == 2,
                  let start = time(parts[0]),
                  let end = time(parts[1].trimmingCharacters(in: .whitespaces).components(separatedBy: " ").first ?? "")
            else { continue }
            let body = lines[(timing + 1)...]
                .map(clean)
                .filter { !$0.isEmpty }
                .joined(separator: "\n")
            guard !body.isEmpty, end > start else { continue }
            cues.append(SubtitleCue(start: start, end: end, text: body))
        }
        return cues.sorted { $0.start < $1.start }
    }

    /// What should be on screen at this moment, if anything.
    func text(at time: Double) -> String? {
        var low = 0
        var high = cues.count - 1
        var found: Int?
        // The last cue starting at or before now.
        while low <= high {
            let mid = (low + high) / 2
            if cues[mid].start <= time {
                found = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        guard let found else { return nil }
        // Cues can overlap. Show every one that covers now, oldest first.
        var lines: [String] = []
        var index = found
        while index >= 0, index >= found - 4 {
            let cue = cues[index]
            if cue.start <= time, time < cue.end { lines.insert(cue.text, at: 0) }
            index -= 1
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// `00:01:02.345`, `01:02.345` or SubRip's `00:01:02,345`.
    static func time(_ raw: String) -> Double? {
        let parts = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".").split(separator: ":")
        guard (2...3).contains(parts.count) else { return nil }
        var seconds = 0.0
        for part in parts {
            guard let value = Double(part) else { return nil }
            seconds = seconds * 60 + value
        }
        return seconds
    }

    private static func clean(_ line: String) -> String {
        line.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\{\\[^}]*\}"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .trimmingCharacters(in: .whitespaces)
    }

    private static let languages: [String: String] = [
        "en": "en", "eng": "en", "english": "en",
        "uk": "uk", "ua": "uk", "ukr": "uk", "ukrainian": "uk", "украинский": "uk", "українська": "uk",
        "ru": "ru", "rus": "ru", "russian": "ru", "русский": "ru",
        "de": "de", "ger": "de", "deu": "de", "fr": "fr", "fre": "fr", "fra": "fr", "es": "es", "spa": "es",
        "it": "it", "ita": "it", "pl": "pl", "pol": "pl", "pt": "pt", "por": "pt", "ja": "ja", "jpn": "ja",
    ]

    /// A short language code from a subtitle address, or a number when there's none.
    static func label(for url: URL, index: Int) -> String {
        let words = url.deletingPathExtension().pathComponents.suffix(2)
            .flatMap { $0.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted) }
        for word in words.reversed() {
            if let code = languages[word] { return code }
        }
        return "sub\(index + 1)"
    }

    static func displayName(_ code: String) -> String {
        if code.hasPrefix("sub") { return "Subtitles \(code.dropFirst(3))" }
        return Locale.current.localizedString(forLanguageCode: code)?.capitalized ?? code.uppercased()
    }
}
