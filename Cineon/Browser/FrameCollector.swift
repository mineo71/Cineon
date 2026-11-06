import AppKit
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import WebKit

private nonisolated struct SendableImage: @unchecked Sendable {
    let image: CGImage
}

/// Judges and encodes frames, off the main thread.
nonisolated enum FrameImage {
    struct Grade: Equatable, Sendable {
        var brightness: Double
        var contrast: Double
        var colour: Double

        /// A black screen, a fade, or video the system won't let anyone photograph.
        var isBlank: Bool { brightness < 0.035 || contrast < 0.012 }
        var interest: Double { contrast * 2 + colour + min(brightness, 0.5) * 0.3 }
    }

    /// Reads a tiny copy, which is plenty to tell a scene from an empty screen.
    static func grade(_ image: CGImage) -> Grade? {
        let width = 32
        let height = 18
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ) else { return false }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }

        var lumas = [Double]()
        lumas.reserveCapacity(width * height)
        var colourSum = 0.0
        for index in stride(from: 0, to: pixels.count, by: 4) {
            let r = Double(pixels[index]) / 255
            let g = Double(pixels[index + 1]) / 255
            let b = Double(pixels[index + 2]) / 255
            lumas.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
            colourSum += max(r, g, b) - min(r, g, b)
        }
        let mean = lumas.reduce(0, +) / Double(lumas.count)
        let variance = lumas.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(lumas.count)
        return Grade(brightness: mean, contrast: variance.squareRoot(), colour: colourSum / Double(lumas.count))
    }

    static func image(fromJPEG data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    static func jpeg(_ image: CGImage, maxPixel: Int, quality: Double) -> Data? {
        let scale = min(1, Double(maxPixel) / Double(max(image.width, image.height)))
        let width = Int((Double(image.width) * scale).rounded())
        let height = Int((Double(image.height) * scale).rounded())
        guard width > 0, height > 0, let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, scaled, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }
}

/// How far along collecting has got for the video in one tab.
struct FrameState {
    var sessionID: Int64?
    var count = 0
    var lastPosition: Double?
    var blanks = 0
    var isCapturing = false
    var notBefore = Date.distantPast
}

/// Keeps a few real frames from everything watched, on this Mac only, for the timeline.
final class FrameCollector {
    /// Enough to scrub through a session, little enough that a film costs under a megabyte.
    static let framesPerSession = 14
    private static let frameWidth = 480
    private static let momentWidth = 1600
    private unowned let session: ProfileSession

    init(session: ProfileSession) {
        self.session = session
    }

    private var library: LibraryStore { session.library }

    private enum Capture {
        case frame(jpeg: Data, grade: FrameImage.Grade, position: Double, duration: Double)
        /// The controls are probably showing, or the picture hasn't caught up with a jump.
        case later
        case blank
        case failed
    }

    // MARK: Collecting

    func tick(_ event: MediaEvent, tab: BrowserTab, track: LiveTrack) {
        guard session.settings.keepFrames, event.type == "tick", !event.paused, !tab.frameState.isCapturing, session.browser.selected === tab, session.app?.route == .web,
              tab.webView?.window != nil
        else { return }

        if tab.frameState.sessionID != track.session.id {
            let existing = library.frames(sessionID: track.session.id).filter { !$0.isMoment }
            tab.frameState.sessionID = track.session.id
            tab.frameState.count = existing.count
            tab.frameState.lastPosition = existing.max { $0.at < $1.at }?.position
        }
        guard tab.frameState.count < Self.framesPerSession, Date.now >= tab.frameState.notBefore,
              event.position / event.duration < 0.93
        else { return }

        let spacing = max(90, event.duration / Double(Self.framesPerSession))
        if let last = tab.frameState.lastPosition {
            guard abs(event.position - last) >= spacing else { return }
        } else {
            // Give it a moment first, past whatever the player shows at the very start.
            guard track.session.watchedSeconds >= 20 else { return }
        }

        tab.frameState.isCapturing = true
        Task { [weak self, weak tab] in
            guard let self, let tab else { return }
            let result = await self.capture(tab: tab, maxPixel: Self.frameWidth, quality: 0.72, waitForStillMouse: true)
            tab.frameState.isCapturing = false
            switch result {
            case .frame(let jpeg, let grade, let position, _):
                guard let current = tab.track else { return }
                await self.store(jpeg, grade: grade, position: position, url: tab.url, track: current, isMoment: false)
                tab.frameState.count += 1
                tab.frameState.lastPosition = position
                tab.frameState.blanks = 0
            case .later:
                tab.frameState.notBefore = Date.now.addingTimeInterval(4)
            case .blank:
                // A dark scene passes, so keep trying. Protected video stays black, so try less and less.
                tab.frameState.blanks += 1
                let wait = min(300, 20 * pow(2, Double(tab.frameState.blanks - 1)))
                tab.frameState.notBefore = Date.now.addingTimeInterval(wait)
            case .failed:
                tab.frameState.notBefore = Date.now.addingTimeInterval(30)
            }
        }
    }

    // MARK: Moments

    /// Saves the frame on screen, on purpose. Works even with collecting switched off.
    func saveMoment(tab: BrowserTab) {
        guard tab.media != nil else {
            session.toasts.show("Play something first, then save the moment you like")
            return
        }
        Task { [weak self, weak tab] in
            guard let self, let tab else { return }
            // Pressed just after a jump, the picture needs a moment to catch up.
            var result = Capture.later
            for attempt in 0..<5 {
                if attempt > 0 { try? await Task.sleep(for: .seconds(0.8)) }
                result = await self.capture(tab: tab, maxPixel: Self.momentWidth, quality: 0.88, waitForStillMouse: false)
                if case .frame = result { break }
            }
            guard case .frame(let jpeg, let grade, let position, _) = result else {
                let message = "Couldn't save this frame. Some sites protect their video from being captured."
                tab.showBanner(id: "moment", text: message, timeout: 4)
                return
            }
            guard let track = tab.track else {
                tab.showBanner(id: "moment", text: "Cineon is still working out what this is. Try again in a few seconds.", timeout: 4)
                return
            }
            await self.store(jpeg, grade: grade, position: position, url: tab.url, track: track, isMoment: true)
            tab.playerCommand("flash()")
            tab.showBanner(id: "moment", text: "Saved this moment at \(Timecode.string(position))", timeout: 3)
        }
    }

    // MARK: Capturing

    /// Asks the player for the frame first, which gives a clean picture with no controls on it.
    /// Most video is cross-origin and won't allow that, so the fallback is to photograph the
    /// web view, cropped to where the picture sits.
    private func capture(tab: BrowserTab, maxPixel: Int, quality: Double, waitForStillMouse: Bool) async -> Capture {
        guard let info = await tab.evaluateInPlayer("window.__cineon ? __cineon.capture(\(maxPixel), \(quality)) : null") as? [String: Any],
              let position = (info["t"] as? NSNumber)?.doubleValue
        else { return .failed }
        let duration = (info["d"] as? NSNumber)?.doubleValue ?? 0
        if (info["settled"] as? NSNumber)?.boolValue == false { return .later }

        if let dataURL = info["data"] as? String, let comma = dataURL.firstIndex(of: ","),
           let jpeg = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])) {
            let grade = await Task.detached(priority: .utility) { () -> FrameImage.Grade? in
                FrameImage.image(fromJPEG: jpeg).flatMap(FrameImage.grade)
            }.value
            if let grade, !grade.isBlank {
                return .frame(jpeg: jpeg, grade: grade, position: position, duration: duration)
            }
            // A blank canvas can just mean this kind of video doesn't draw there. Photograph it instead.
        }

        if waitForStillMouse, let idle = (info["idle"] as? NSNumber)?.doubleValue, idle < 2500 { return .later }
        guard let rect = await pictureRect(tab: tab, info: info), let photo = await photograph(tab: tab, rect: rect) else {
            return .failed
        }

        let encoded = await Task.detached(priority: .utility) { () -> (Data, FrameImage.Grade)? in
            guard let grade = FrameImage.grade(photo.image) else { return nil }
            if grade.isBlank { return (Data(), grade) }
            guard let jpeg = FrameImage.jpeg(photo.image, maxPixel: maxPixel, quality: quality) else { return nil }
            return (jpeg, grade)
        }.value
        guard let encoded else { return .failed }
        if encoded.1.isBlank, let webView = tab.webView,
           let screen = await WindowCapture.image(of: webView, rect: rect, maxPixel: maxPixel) {
            // Hardware-decoded video draws outside the web view's own snapshots. The window has it.
            let photo = SendableImage(image: screen)
            let retried = await Task.detached(priority: .utility) { () -> (Data, FrameImage.Grade)? in
                guard let grade = FrameImage.grade(photo.image), !grade.isBlank,
                      let jpeg = FrameImage.jpeg(photo.image, maxPixel: maxPixel, quality: quality)
                else { return nil }
                return (jpeg, grade)
            }.value
            if let retried { return .frame(jpeg: retried.0, grade: retried.1, position: position, duration: duration) }
        }
        return encoded.1.isBlank ? .blank : .frame(jpeg: encoded.0, grade: encoded.1, position: position, duration: duration)
    }

    /// Where the picture sits in the tab's web view, for photographing it from outside.
    func pictureRect(tab: BrowserTab) async -> CGRect? {
        guard let info = await tab.evaluateInPlayer("window.__cineon ? __cineon.capture(1, 0.1) : null") as? [String: Any] else {
            return nil
        }
        return await pictureRect(tab: tab, info: info)
    }

    private func pictureRect(tab: BrowserTab, info: [String: Any]) async -> CGRect? {
        guard let webView = tab.webView,
              var x = (info["x"] as? NSNumber)?.doubleValue, var y = (info["y"] as? NSNumber)?.doubleValue,
              let width = (info["w"] as? NSNumber)?.doubleValue, let height = (info["h"] as? NSNumber)?.doubleValue,
              width > 40, height > 40
        else { return nil }

        if tab.mediaFrame?.isMainFrame == false {
            // The player is in a frame, so its numbers are relative to that frame.
            let url = (info["url"] as? String) ?? ""
            let escaped = (try? JSONSerialization.data(withJSONObject: [url])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
            let script = "window.__cineon ? __cineon.frameRect(\(escaped)[0], \(width), \(height)) : null"
            guard let outer = await tab.evaluateInPage(script) as? [String: Any],
                  let outerX = (outer["x"] as? NSNumber)?.doubleValue, let outerY = (outer["y"] as? NSNumber)?.doubleValue
            else { return nil }
            x += outerX
            y += outerY
        }

        let zoom = webView.pageZoom
        let rect = CGRect(x: x * zoom, y: y * zoom, width: width * zoom, height: height * zoom)
            .intersection(webView.bounds)
        return rect.width > 40 && rect.height > 40 ? rect : nil
    }

    private func photograph(tab: BrowserTab, rect: CGRect) async -> SendableImage? {
        guard let webView = tab.webView else { return nil }
        let config = WKSnapshotConfiguration()
        config.rect = rect
        return await withCheckedContinuation { continuation in
            webView.takeSnapshot(with: config) { image, _ in
                let cg = image?.cgImage(forProposedRect: nil, context: nil, hints: nil)
                continuation.resume(returning: cg.map(SendableImage.init))
            }
        }
    }

    // MARK: Storing

    private func store(_ jpeg: Data, grade: FrameImage.Grade, position: Double, url: URL?, track: LiveTrack, isMoment: Bool) async {
        guard let titleID = library.currentID(track.titleID) else { return }
        let directory = session.db.framesDirectory
        let name = "\(titleID)/\(UUID().uuidString).jpg"
        let wrote = await Task.detached(priority: .utility) { () -> Bool in
            let target = directory.appendingPathComponent(name)
            do {
                try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try jpeg.write(to: target, options: .atomic)
                return true
            } catch {
                return false
            }
        }.value
        guard wrote else { return }
        library.addFrame(FilmFrame(
            id: 0, sessionID: track.session.id, titleID: titleID, ref: track.ref, position: position, url: url, file: name,
            isMoment: isMoment,
            // A moment someone chose always represents its session.
            interest: grade.interest + (isMoment ? 10 : 0),
            at: .now
        ))
    }
}
