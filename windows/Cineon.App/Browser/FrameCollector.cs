using System.Runtime.InteropServices.WindowsRuntime;
using Cineon.Core.Data;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Cineon.App.Browser;

/// Pixels in memory: BGRA, 8 bits a channel, top row first.
public sealed record DecodedImage(int Width, int Height, byte[] Bgra);

/// Judges and encodes frames, off the UI thread. The Mac's `FrameImage`.
public static class FrameImage
{
    public readonly record struct Grade(double Brightness, double Contrast, double Colour)
    {
        /// A black screen, a fade, or video the system won't let anyone photograph.
        public bool IsBlank => Brightness < 0.035 || Contrast < 0.012;
        public double Interest => Contrast * 2 + Colour + Math.Min(Brightness, 0.5) * 0.3;
    }

    /// Reads a tiny copy, which is plenty to tell a scene from an empty screen.
    public static Grade? GradeOf(DecodedImage image)
    {
        const int width = 32;
        const int height = 18;
        if (image.Width <= 0 || image.Height <= 0) return null;
        var lumas = new double[width * height];
        var colourSum = 0.0;
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var (r, g, b) = Average(image, x * image.Width / width, y * image.Height / height,
                    Math.Max(x * image.Width / width + 1, (x + 1) * image.Width / width),
                    Math.Max(y * image.Height / height + 1, (y + 1) * image.Height / height));
                lumas[y * width + x] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                colourSum += Math.Max(r, Math.Max(g, b)) - Math.Min(r, Math.Min(g, b));
            }
        }
        var mean = lumas.Average();
        var variance = lumas.Sum(l => (l - mean) * (l - mean)) / lumas.Length;
        return new Grade(mean, Math.Sqrt(variance), colourSum / lumas.Length);
    }

    /// The average colour of a block of pixels, each channel 0 to 1.
    internal static (double R, double G, double B) Average(DecodedImage image, int x0, int y0, int x1, int y1)
    {
        x1 = Math.Min(x1, image.Width);
        y1 = Math.Min(y1, image.Height);
        double r = 0, g = 0, b = 0;
        var count = 0;
        for (var y = y0; y < y1; y++)
        {
            var row = y * image.Width * 4;
            for (var x = x0; x < x1; x++)
            {
                var i = row + x * 4;
                b += image.Bgra[i];
                g += image.Bgra[i + 1];
                r += image.Bgra[i + 2];
                count++;
            }
        }
        if (count == 0) return (0, 0, 0);
        return (r / count / 255, g / count / 255, b / count / 255);
    }

    /// Decodes an image, scaled so its longest side is at most `maxPixel`, optionally cropped to
    /// `crop` (in the image's own pixels) first. Null when it can't be read.
    public static Task<DecodedImage?> DecodeAsync(byte[] data, int maxPixel, Rect? crop = null) => Task.Run(async () =>
    {
        try
        {
            using var stream = new InMemoryRandomAccessStream();
            await stream.WriteAsync(data.AsBuffer());
            stream.Seek(0);
            var decoder = await BitmapDecoder.CreateAsync(stream);
            var sourceWidth = (double)decoder.OrientedPixelWidth;
            var sourceHeight = (double)decoder.OrientedPixelHeight;
            var area = crop is { } c
                ? new Rect(Math.Max(0, c.X), Math.Max(0, c.Y), Math.Min(c.Width, sourceWidth - Math.Max(0, c.X)), Math.Min(c.Height, sourceHeight - Math.Max(0, c.Y)))
                : new Rect(0, 0, sourceWidth, sourceHeight);
            if (area.Width < 2 || area.Height < 2) return null;
            var scale = Math.Min(1, maxPixel / Math.Max(area.Width, area.Height));
            var transform = new BitmapTransform
            {
                ScaledWidth = (uint)Math.Max(1, Math.Round(sourceWidth * scale)),
                ScaledHeight = (uint)Math.Max(1, Math.Round(sourceHeight * scale)),
                InterpolationMode = BitmapInterpolationMode.Fant,
            };
            var bounds = new BitmapBounds
            {
                X = (uint)Math.Floor(area.X * scale),
                Y = (uint)Math.Floor(area.Y * scale),
                Width = (uint)Math.Max(1, Math.Floor(area.Width * scale)),
                Height = (uint)Math.Max(1, Math.Floor(area.Height * scale)),
            };
            bounds.Width = Math.Min(bounds.Width, transform.ScaledWidth - bounds.X);
            bounds.Height = Math.Min(bounds.Height, transform.ScaledHeight - bounds.Y);
            transform.Bounds = bounds;
            var pixels = await decoder.GetPixelDataAsync(
                BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, transform,
                ExifOrientationMode.RespectExifOrientation, ColorManagementMode.DoNotColorManage);
            return new DecodedImage((int)bounds.Width, (int)bounds.Height, pixels.DetachPixelData());
        }
        catch (Exception)
        {
            return null;
        }
    });

    /// JPEG bytes, the image scaled so its longest side is at most `maxPixel`.
    public static Task<byte[]?> JpegAsync(DecodedImage image, int maxPixel, double quality) => Task.Run(async () =>
    {
        try
        {
            var scale = Math.Min(1, (double)maxPixel / Math.Max(image.Width, image.Height));
            var width = (uint)Math.Max(1, Math.Round(image.Width * scale));
            var height = (uint)Math.Max(1, Math.Round(image.Height * scale));
            using var stream = new InMemoryRandomAccessStream();
            var options = new BitmapPropertySet
            {
                ["ImageQuality"] = new BitmapTypedValue((float)quality, PropertyType.Single),
            };
            var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, stream, options);
            encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, (uint)image.Width, (uint)image.Height, 96, 96, image.Bgra);
            if (width != image.Width || height != image.Height)
            {
                encoder.BitmapTransform.ScaledWidth = width;
                encoder.BitmapTransform.ScaledHeight = height;
                encoder.BitmapTransform.InterpolationMode = BitmapInterpolationMode.Fant;
            }
            await encoder.FlushAsync();
            return await BrowserTab.ReadAllAsync(stream);
        }
        catch (Exception)
        {
            return null;
        }
    });
}

/// Six colours from a picture: top left, top, top right, bottom left, bottom, bottom right. The
/// Mac's `ColorZones.sample`, which scales the picture to 3×2.
public static class ColorZones
{
    public static IReadOnlyList<AmbientModel.Rgb>? Sample(DecodedImage image)
    {
        if (image.Width < 3 || image.Height < 2) return null;
        var zones = new List<AmbientModel.Rgb>(6);
        for (var row = 0; row < 2; row++)
        {
            for (var column = 0; column < 3; column++)
            {
                var (r, g, b) = FrameImage.Average(image,
                    column * image.Width / 3, row * image.Height / 2,
                    (column + 1) * image.Width / 3, (row + 1) * image.Height / 2);
                zones.Add(new AmbientModel.Rgb(r, g, b));
            }
        }
        return zones;
    }
}

/// How far collecting has got for the video in one tab.
public sealed class FrameState
{
    public long? SessionId { get; set; }
    public int Count { get; set; }
    public double? LastPosition { get; set; }
    public int Blanks { get; set; }
    public bool IsCapturing { get; set; }
    public DateTimeOffset NotBefore { get; set; } = DateTimeOffset.MinValue;
}

/// Keeps a few real frames from everything watched, on this PC only, for the timeline.
public sealed class FrameCollector
{
    /// Enough to scrub through a session, little enough that a film costs under a megabyte.
    public const int FramesPerSession = 14;
    private const int FrameWidth = 480;
    private const int MomentWidth = 1600;

    private readonly ProfileSession _session;

    public FrameCollector(ProfileSession session)
    {
        _session = session;
    }

    private LibraryStore Library => _session.Library;

    private abstract record Capture
    {
        public sealed record Frame(byte[] Jpeg, FrameImage.Grade Grade, double Position, double Duration) : Capture;
        /// The controls are probably showing, or the picture hasn't caught up with a jump.
        public sealed record Later : Capture;
        public sealed record Blank : Capture;
        public sealed record Failed : Capture;
    }

    // MARK: Collecting

    public void Tick(MediaEvent e, BrowserTab tab, LiveTrack track)
    {
        if (!_session.Settings.KeepFrames || e.Type != "tick" || e.Paused || tab.FrameState.IsCapturing
            || !ReferenceEquals(_session.Browser.Selected, tab) || _session.App?.Route != Route.Web
            || tab.Control?.XamlRoot is null)
        {
            return;
        }

        var state = tab.FrameState;
        if (state.SessionId != track.Session.Id)
        {
            var existing = Library.Frames(track.Session.Id).Where(f => !f.IsMoment).ToList();
            state.SessionId = track.Session.Id;
            state.Count = existing.Count;
            state.LastPosition = existing.Count == 0 ? null : existing.MaxBy(f => f.At)!.Position;
        }
        if (state.Count >= FramesPerSession || DateTimeOffset.Now < state.NotBefore || e.Position / e.Duration >= 0.93) return;

        var spacing = Math.Max(90, e.Duration / FramesPerSession);
        if (state.LastPosition is { } last)
        {
            if (Math.Abs(e.Position - last) < spacing) return;
        }
        else if (track.Session.WatchedSeconds < 20)
        {
            // Give it a moment first, past whatever the player shows at the very start.
            return;
        }

        state.IsCapturing = true;
        Safe.Fire("frame", async () =>
        {
            var result = await CaptureAsync(tab, FrameWidth, 0.72, waitForStillMouse: true);
            var now = tab.FrameState;
            now.IsCapturing = false;
            switch (result)
            {
                case Capture.Frame frame:
                    if (tab.Track is not { } current) return;
                    await StoreAsync(frame.Jpeg, frame.Grade, frame.Position, tab.Url, current, isMoment: false);
                    now.Count++;
                    now.LastPosition = frame.Position;
                    now.Blanks = 0;
                    break;
                case Capture.Later:
                    now.NotBefore = DateTimeOffset.Now.AddSeconds(4);
                    break;
                case Capture.Blank:
                    // A dark scene passes, so keep trying. Protected video stays black, so try less and less.
                    now.Blanks++;
                    var wait = Math.Min(300, 20 * Math.Pow(2, now.Blanks - 1));
                    now.NotBefore = DateTimeOffset.Now.AddSeconds(wait);
                    break;
                default:
                    now.NotBefore = DateTimeOffset.Now.AddSeconds(30);
                    break;
            }
        });
    }

    // MARK: Moments

    /// Saves the frame on screen, on purpose. Works even with collecting switched off.
    public void SaveMoment(BrowserTab tab)
    {
        if (tab.Media is null)
        {
            _session.Toasts.Show("Play something first, then save the moment you like");
            return;
        }
        Safe.Fire("moment", async () =>
        {
            // Pressed just after a jump, the picture needs a moment to catch up.
            Capture result = new Capture.Later();
            for (var attempt = 0; attempt < 5; attempt++)
            {
                if (attempt > 0) await Task.Delay(800);
                result = await CaptureAsync(tab, MomentWidth, 0.88, waitForStillMouse: false);
                if (result is Capture.Frame) break;
            }
            if (result is not Capture.Frame frame)
            {
                tab.ShowBanner("moment", "Couldn't save this frame. Some sites protect their video from being captured.", timeout: 4);
                return;
            }
            if (tab.Track is not { } track)
            {
                tab.ShowBanner("moment", "Cineon is still working out what this is. Try again in a few seconds.", timeout: 4);
                return;
            }
            await StoreAsync(frame.Jpeg, frame.Grade, frame.Position, tab.Url, track, isMoment: true);
            tab.PlayerCommand("flash()");
            tab.ShowBanner("moment", $"Saved this moment at {Timecode.String(frame.Position)}", timeout: 3);
        });
    }

    // MARK: Capturing

    /// Asks the player for the frame first, which gives a clean picture with no controls on it.
    /// Most video is cross-origin and won't allow that, so the fallback is to photograph the page,
    /// cropped to where the picture sits, and then the screen.
    private async Task<Capture> CaptureAsync(BrowserTab tab, int maxPixel, double quality, bool waitForStillMouse)
    {
        var script = $"window.__cineon ? __cineon.capture({maxPixel}, {Json.Num(quality)}) : null";
        if (Json.Parse(await tab.EvaluateInPlayerAsync(script)) is not { ValueKind: System.Text.Json.JsonValueKind.Object } info
            || info.Number("t") is not { } position)
        {
            return new Capture.Failed();
        }
        var duration = info.Number("d") ?? 0;
        if (info.Bool("settled") == false) return new Capture.Later();

        if (info.Text("data") is { } dataUrl && dataUrl.IndexOf(',') is var comma and >= 0)
        {
            byte[]? jpeg = null;
            try { jpeg = Convert.FromBase64String(dataUrl[(comma + 1)..]); }
            catch (FormatException) { }
            if (jpeg is not null && await FrameImage.DecodeAsync(jpeg, 64) is { } small && FrameImage.GradeOf(small) is { IsBlank: false } grade)
            {
                return new Capture.Frame(jpeg, grade, position, duration);
            }
            // A blank canvas can just mean this kind of video doesn't draw there. Photograph it instead.
        }

        if (waitForStillMouse && info.Number("idle") is { } idle && idle < 2500) return new Capture.Later();
        if (await PictureRectAsync(tab, info) is not { } rect) return new Capture.Failed();

        foreach (var photograph in new Func<Task<DecodedImage?>>[]
        {
            () => WindowCapture.PhotographAsync(tab, rect, maxPixel),
            // Hardware video can draw outside the page's own capture. The screen has it.
            () => WindowCapture.ScreenAsync(tab, rect, maxPixel),
        })
        {
            if (await photograph() is not { } image) continue;
            if (FrameImage.GradeOf(image) is not { } grade) continue;
            if (grade.IsBlank) continue;
            if (await FrameImage.JpegAsync(image, maxPixel, quality) is not { } jpeg) return new Capture.Failed();
            return new Capture.Frame(jpeg, grade, position, duration);
        }
        return new Capture.Blank();
    }

    /// Where the picture sits in the tab's web view, for photographing it from outside.
    public async Task<Rect?> PictureRectAsync(BrowserTab tab)
    {
        if (Json.Parse(await tab.EvaluateInPlayerAsync("window.__cineon ? __cineon.capture(1, 0.1) : null")) is not { ValueKind: System.Text.Json.JsonValueKind.Object } info)
        {
            return null;
        }
        return await PictureRectAsync(tab, info);
    }

    private static async Task<Rect?> PictureRectAsync(BrowserTab tab, System.Text.Json.JsonElement info)
    {
        if (info.Number("x") is not { } x || info.Number("y") is not { } y
            || info.Number("w") is not { } width || info.Number("h") is not { } height || width <= 40 || height <= 40)
        {
            return null;
        }
        if (tab.IsMediaInSubframe)
        {
            // The player is in a frame, so its numbers are relative to that frame.
            var url = info.Text("url") ?? "";
            var script = $"window.__cineon ? __cineon.frameRect({Json.Literal(url)}, {Json.Num(width)}, {Json.Num(height)}) : null";
            if (Json.Parse(await tab.EvaluateInPageAsync(script)) is not { ValueKind: System.Text.Json.JsonValueKind.Object } outer
                || outer.Number("x") is not { } outerX || outer.Number("y") is not { } outerY)
            {
                return null;
            }
            x += outerX;
            y += outerY;
        }
        // CSS zoom already scales what the page measures, unlike WebKit's page zoom.
        var (viewWidth, viewHeight) = WindowCapture.ViewSize(tab);
        var left = Math.Max(0, x);
        var top = Math.Max(0, y);
        var right = Math.Min(viewWidth, x + width);
        var bottom = Math.Min(viewHeight, y + height);
        var rect = new Rect(left, top, Math.Max(0, right - left), Math.Max(0, bottom - top));
        return rect.Width > 40 && rect.Height > 40 ? rect : null;
    }

    // MARK: Storing

    private async Task StoreAsync(byte[] jpeg, FrameImage.Grade grade, double position, Uri? url, LiveTrack track, bool isMoment)
    {
        if (Library.CurrentId(track.TitleId) is not long titleId) return;
        var directory = _session.Db.FramesDirectory;
        // Forward slashes, as the Mac writes the name; Windows reads them too.
        var name = $"{titleId}/{Guid.NewGuid().ToString("D").ToUpperInvariant()}.jpg";
        var wrote = await Task.Run(() =>
        {
            try
            {
                var target = Path.Combine(directory, name);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                var temp = target + ".tmp";
                File.WriteAllBytes(temp, jpeg);
                File.Move(temp, target, overwrite: true);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        });
        if (!wrote) return;
        Library.AddFrame(new FilmFrame
        {
            Id = 0, SessionId = track.Session.Id, TitleId = titleId, Ref = track.Ref, Position = position, Url = url, File = name,
            IsMoment = isMoment,
            // A moment someone chose always represents its session.
            Interest = grade.Interest + (isMoment ? 10 : 0),
            At = DateTimeOffset.Now,
        });
    }
}
