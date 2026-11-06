import AppKit
import ScreenCaptureKit

/// Photographs part of Cineon's own window as it is on screen, the picture of hardware-decoded
/// video included, which a web view's own snapshot leaves black. An app may always capture its
/// own windows, so this never asks for screen recording permission.
enum WindowCapture {
    private static var cached: (number: Int, window: SCWindow, at: Date)?

    static func image(of view: NSView, rect: CGRect, maxPixel: Int) async -> CGImage? {
        guard let window = view.window, rect.width >= 8, rect.height >= 8 else { return nil }
        guard let target = await scWindow(for: window) else { return nil }
        let inWindow = view.convert(rect, to: nil)
        // ScreenCaptureKit measures from the window's top left, AppKit from its bottom left.
        let source = CGRect(
            x: inWindow.minX, y: window.frame.height - inWindow.maxY, width: inWindow.width, height: inWindow.height
        )
        let filter = SCContentFilter(desktopIndependentWindow: target)
        let config = SCStreamConfiguration()
        config.sourceRect = source
        let scale = min(1, Double(maxPixel) / max(source.width, source.height))
        config.width = max(2, Int((source.width * scale).rounded()))
        config.height = max(2, Int((source.height * scale).rounded()))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        return try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    private static func scWindow(for window: NSWindow) async -> SCWindow? {
        let number = window.windowNumber
        if let cached, cached.number == number, Date.now.timeIntervalSince(cached.at) < 30 { return cached.window }
        guard let content = try? await SCShareableContent.currentProcess,
              let found = content.windows.first(where: { Int($0.windowID) == number })
        else { return nil }
        cached = (number, found, .now)
        return found
    }
}
