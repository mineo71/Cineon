using System.Runtime.InteropServices;
using Windows.Foundation;

namespace Cineon.App.Browser;

/// Pictures of what a tab shows, for frames, moments and ambient light. The Mac photographs its
/// own window with ScreenCaptureKit because a WKWebView snapshot leaves hardware video black.
/// WebView2's own capture (`CapturePreviewAsync`) includes the video picture, so it's tried
/// first; the screen under the web view is the fallback, for protected or overlay video.
public static class WindowCapture
{
    /// The web view's size in its own units (CSS pixels at zoom 1), the space page rectangles use.
    public static (double Width, double Height) ViewSize(BrowserTab tab) =>
        tab.Control is { ActualWidth: > 0 } control ? (control.ActualWidth, control.ActualHeight) : (1280, 800);

    /// Part of the page from WebView2's capture, cropped to `rect` (page units, or all of it when
    /// null) and scaled so its longest side is at most `maxPixel`.
    public static async Task<DecodedImage?> PhotographAsync(BrowserTab tab, Rect? rect, int maxPixel)
    {
        if (await tab.CaptureAsync() is not { } data) return null;
        if (rect is not { } area) return await FrameImage.DecodeAsync(data, maxPixel);
        var (viewWidth, _) = ViewSize(tab);
        // The capture is in device pixels; work out the scale from its width.
        var scale = await PixelsPerUnitAsync(data, viewWidth);
        var crop = new Rect(area.X * scale, area.Y * scale, area.Width * scale, area.Height * scale);
        return await FrameImage.DecodeAsync(data, maxPixel, crop);
    }

    private static async Task<double> PixelsPerUnitAsync(byte[] data, double viewWidth)
    {
        try
        {
            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            await stream.WriteAsync(System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions.AsBuffer(data));
            stream.Seek(0);
            var decoder = await Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(stream);
            return viewWidth > 0 ? decoder.PixelWidth / viewWidth : 1;
        }
        catch (Exception)
        {
            return 1;
        }
    }

    /// What's on screen where the tab's web view shows `rect`, the Mac's `WindowCapture.image`.
    /// Only for a tab on screen; anything covering the window is in the picture too.
    public static async Task<DecodedImage?> ScreenAsync(BrowserTab tab, Rect? rect, int maxPixel)
    {
        if (tab.Control is not { XamlRoot: { } root } control || AppModel.Shared?.Window?.Handle is not { } window || window == IntPtr.Zero)
        {
            return null;
        }
        var area = rect ?? new Rect(0, 0, control.ActualWidth, control.ActualHeight);
        if (area.Width < 8 || area.Height < 8) return null;
        Point origin;
        try
        {
            origin = control.TransformToVisual(null).TransformPoint(new Point(area.X, area.Y));
        }
        catch (Exception)
        {
            return null;
        }
        var scale = root.RasterizationScale;
        var client = new NativePoint();
        if (!ClientToScreen(window, ref client)) return null;
        var x = client.X + (int)Math.Round(origin.X * scale);
        var y = client.Y + (int)Math.Round(origin.Y * scale);
        var width = (int)Math.Round(area.Width * scale);
        var height = (int)Math.Round(area.Height * scale);
        return await Task.Run(() => Grab(x, y, width, height, maxPixel));
    }

    /// The page's capture first, then the screen when that came back blank.
    public static async Task<DecodedImage?> ImageAsync(BrowserTab tab, Rect? rect, int maxPixel)
    {
        if (await PhotographAsync(tab, rect, maxPixel) is { } photo && FrameImage.GradeOf(photo) is { IsBlank: false })
        {
            return photo;
        }
        return await ScreenAsync(tab, rect, maxPixel);
    }

    private static DecodedImage? Grab(int x, int y, int width, int height, int maxPixel)
    {
        if (width < 2 || height < 2) return null;
        var screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return null;
        var memory = CreateCompatibleDC(screen);
        var bitmap = CreateCompatibleBitmap(screen, width, height);
        try
        {
            var old = SelectObject(memory, bitmap);
            const int SrcCopy = 0x00CC0020;
            const int CaptureBlt = 0x40000000;
            var copied = BitBlt(memory, 0, 0, width, height, screen, x, y, SrcCopy | CaptureBlt);
            SelectObject(memory, old);
            if (!copied) return null;
            var info = new BitmapInfoHeader
            {
                Size = (uint)Marshal.SizeOf<BitmapInfoHeader>(),
                Width = width,
                Height = -height,
                Planes = 1,
                BitCount = 32,
                Compression = 0,
            };
            var pixels = new byte[width * height * 4];
            if (GetDIBits(memory, bitmap, 0, (uint)height, pixels, ref info, 0) == 0) return null;
            var full = new DecodedImage(width, height, pixels);
            return Shrink(full, maxPixel);
        }
        finally
        {
            DeleteObject(bitmap);
            DeleteDC(memory);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    /// Box-filters an image down so its longest side is at most `maxPixel`.
    private static DecodedImage Shrink(DecodedImage image, int maxPixel)
    {
        var scale = Math.Min(1, (double)maxPixel / Math.Max(image.Width, image.Height));
        if (scale >= 1) return image;
        var width = Math.Max(1, (int)Math.Round(image.Width * scale));
        var height = Math.Max(1, (int)Math.Round(image.Height * scale));
        var pixels = new byte[width * height * 4];
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var (r, g, b) = FrameImage.Average(image, x * image.Width / width, y * image.Height / height,
                    Math.Max(x * image.Width / width + 1, (x + 1) * image.Width / width),
                    Math.Max(y * image.Height / height + 1, (y + 1) * image.Height / height));
                var i = (y * width + x) * 4;
                pixels[i] = (byte)Math.Round(b * 255);
                pixels[i + 1] = (byte)Math.Round(g * 255);
                pixels[i + 2] = (byte)Math.Round(r * 255);
                pixels[i + 3] = 255;
            }
        }
        return new DecodedImage(width, height, pixels);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfoHeader
    {
        public uint Size;
        public int Width;
        public int Height;
        public ushort Planes;
        public ushort BitCount;
        public uint Compression;
        public uint SizeImage;
        public int XPelsPerMeter;
        public int YPelsPerMeter;
        public uint ClrUsed;
        public uint ClrImportant;
    }

    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr gdiObject);
    [DllImport("gdi32.dll")] private static extern bool BitBlt(IntPtr dest, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, int operation);
    [DllImport("gdi32.dll")] private static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint lines, byte[] bits, ref BitmapInfoHeader info, uint usage);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr gdiObject);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
}
