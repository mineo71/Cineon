import AppKit
import ImageIO
import SwiftUI

private nonisolated struct DecodedImage: @unchecked Sendable {
    let image: CGImage
}

/// Downloads, downsamples off the main thread, and caches, in memory and on disk.
/// Posters at display size rather than full size are what keep scrolling smooth.
final class ImagePipeline {
    static let shared = ImagePipeline()

    private let memory = NSCache<NSString, NSImage>()
    private let session: URLSession
    private var running: [NSString: Task<NSImage?, Never>] = [:]

    private init() {
        memory.totalCostLimit = 200 * 1024 * 1024
        let config = URLSessionConfiguration.default
        config.urlCache = URLCache(
            memoryCapacity: 8 * 1024 * 1024,
            diskCapacity: 400 * 1024 * 1024,
            directory: AppPaths.root.appendingPathComponent("ImageCache", isDirectory: true)
        )
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config)
    }

    func cached(_ url: URL, maxPixel: Int) -> NSImage? {
        memory.object(forKey: key(url, maxPixel))
    }

    private func key(_ url: URL, _ maxPixel: Int) -> NSString { "\(maxPixel)|\(url.absoluteString)" as NSString }

    func image(_ url: URL, maxPixel: Int) async -> NSImage? {
        let cacheKey = key(url, maxPixel)
        if let hit = memory.object(forKey: cacheKey) { return hit }
        if let task = running[cacheKey] { return await task.value }

        let task = Task<NSImage?, Never> { [session] in
            guard let (data, _) = try? await session.data(from: url) else { return nil }
            let decoded = await Task.detached(priority: .userInitiated) { () -> DecodedImage? in
                guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
                let options: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: maxPixel,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceShouldCacheImmediately: true,
                ]
                guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
                return DecodedImage(image: thumb)
            }.value
            guard let decoded else { return nil }
            return NSImage(cgImage: decoded.image, size: NSSize(width: decoded.image.width, height: decoded.image.height))
        }
        running[cacheKey] = task
        let result = await task.value
        running[cacheKey] = nil
        if let result {
            memory.setObject(result, forKey: cacheKey, cost: Int(result.size.width * result.size.height * 4))
        }
        return result
    }

    /// Six zones, three across and two down, for ambient light from an image.
    func zones(of url: URL) async -> [RGB]? {
        guard let image = await image(url, maxPixel: 256),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        else { return nil }
        return ColorZones.sample(cg)
    }
}

nonisolated struct RGB: Hashable, Sendable {
    var r: Double
    var g: Double
    var b: Double

    static let black = RGB(r: 0, g: 0, b: 0)
    var color: Color { Color(.sRGB, red: r, green: g, blue: b, opacity: 1) }
    var brightness: Double { 0.2126 * r + 0.7152 * g + 0.0722 * b }

    /// Light from a screen is more saturated than the average pixel value suggests.
    func boosted(saturation amount: Double = 1.5) -> RGB {
        let grey = brightness
        func mix(_ c: Double) -> Double { min(1, max(0, grey + (c - grey) * amount)) }
        return RGB(r: mix(r), g: mix(g), b: mix(b))
    }
}

nonisolated enum ColorZones {
    static func sample(_ image: CGImage) -> [RGB]? {
        let width = 3
        let height = 2
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        let drew = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drew else { return nil }
        return (0..<(width * height)).map { i in
            RGB(
                r: Double(pixels[i * 4]) / 255,
                g: Double(pixels[i * 4 + 1]) / 255,
                b: Double(pixels[i * 4 + 2]) / 255
            )
        }
    }
}

/// An image from the network that appears without a flash when it's already cached.
struct RemoteImage<Placeholder: View>: View {
    let url: URL?
    var maxPixel = 600
    var contentMode: ContentMode = .fill
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var image: NSImage?
    @State private var loadedURL: URL?

    var body: some View {
        ZStack {
            placeholder()
            if let shown = image ?? url.flatMap({ ImagePipeline.shared.cached($0, maxPixel: maxPixel) }) {
                Image(nsImage: shown)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: contentMode)
                    .transition(.opacity)
            }
        }
        .task(id: url) {
            guard let url else {
                image = nil
                return
            }
            guard loadedURL != url || image == nil else { return }
            let result = await ImagePipeline.shared.image(url, maxPixel: maxPixel)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                image = result
                loadedURL = url
            }
        }
    }
}
