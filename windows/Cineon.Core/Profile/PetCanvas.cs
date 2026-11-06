namespace Cineon.Core.Profile;

/// <summary>How much of the 24×24 canvas a pet view shows (Swift's <c>PixelPetView.Framing</c>).</summary>
public enum PetFraming
{
    /// <summary><see cref="Tight"/> below 40 DIPs, <see cref="Stage"/> from 40.</summary>
    Automatic,
    /// <summary>The whole 24×24 canvas: size differences between stages show.</summary>
    Stage,
    /// <summary>Cropped to the pet: fills small avatars.</summary>
    Tight,
}

/// <summary>One filled rectangle of a drawn pet, in DIPs (or device pixels from <see cref="PetCanvas.DeviceRects"/>).</summary>
public readonly record struct PetFill(double X, double Y, double Width, double Height, uint Argb);

/// <summary>A drawn pet: premultiplied BGRA8, rows top down, stride <c>PixelWidth × 4</c>.</summary>
public sealed record PetImage(int PixelWidth, int PixelHeight, byte[] Bgra);

/// <summary>
/// Everything <c>PixelPetView</c> and <c>PetCanvas</c> in PixelPet.swift decide, as plain data: which pose,
/// which crop, and the exact device-pixel rectangles the Mac fills. Every pet pixel is an exact square of
/// whole device pixels, so the art stays crisp; any leftover space is split evenly around it.
/// </summary>
public static class PetCanvas
{
    /// <summary>The Mac's <c>TimelineView(.animation(minimumInterval: 0.1))</c>: about 10 fps.</summary>
    public static readonly TimeSpan FrameInterval = TimeSpan.FromSeconds(0.1);

    private static readonly DateTimeOffset ReferenceDate = new(2001, 1, 1, 0, 0, 0, TimeSpan.Zero);

    /// <summary>Seconds since 2001-01-01 UTC, the clock the Mac animates with (<c>timeIntervalSinceReferenceDate</c>).</summary>
    public static double Now() => TimeSinceReferenceDate(DateTimeOffset.UtcNow);

    public static double TimeSinceReferenceDate(DateTimeOffset date) => (date - ReferenceDate).TotalSeconds;

    /// <summary>Below 40 DIPs <see cref="PetFraming.Automatic"/> crops to the pet so avatars stay readable.</summary>
    public static bool IsTight(double size, PetFraming framing) => framing switch
    {
        PetFraming.Stage => false,
        PetFraming.Tight => true,
        _ => size < 40,
    };

    /// <summary>
    /// Tight crops keep the bob to one pixel so the head never leaves the frame, and drop the floating effects
    /// that would be cut off at the crop edge (eyes and mouth still show the mood).
    /// </summary>
    public static PetFrame Adjusted(PetFrame frame, bool tight)
    {
        if (!tight) return frame;
        frame.Lift = Math.Min(frame.Lift, 1);
        frame.Effect = PetEffect.None;
        frame.Sparkle = null;
        return frame;
    }

    /// <summary>
    /// The pose to draw now, already <see cref="Adjusted"/> for the framing. A fixed <paramref name="time"/>
    /// gives that one frame (previews, snapshots); otherwise animated views use <paramref name="now"/>
    /// (default <see cref="Now"/>) and still ones, or Reduce Motion, the resting frame.
    /// </summary>
    public static PetFrame FrameFor(
        PixelPet pet, double size, PetFraming framing = PetFraming.Automatic, bool animated = true,
        bool reduceMotion = false, double? time = null, double? now = null)
    {
        PetFrame frame;
        if (time is { } fixedTime) frame = pet.FrameAt(fixedTime);
        else if (animated && !reduceMotion) frame = pet.FrameAt(now ?? Now());
        else frame = pet.RestingFrame;
        return Adjusted(frame, IsTight(size, framing));
    }

    /// <summary>
    /// The part of the canvas to show in a <paramref name="width"/> × <paramref name="height"/> DIP view at
    /// <paramref name="scale"/> device pixels per DIP.
    /// </summary>
    public static PetCrop CropFor(PixelPet pet, bool tight, double width, double height, double scale)
    {
        if (!tight) return PetCrop.Canvas;
        return PixelPet.TightCrop(pet.ContentBounds, (int)(Math.Min(width, height) * Math.Max(scale, 1)));
    }

    /// <summary>
    /// The rectangles the Mac fills, in whole device pixels: [X0, X1) × [Y0, Y1), merged into horizontal runs
    /// of one colour. Exact port of <c>PetCanvas.draw</c>.
    /// </summary>
    public static IReadOnlyList<(int X0, int Y0, int X1, int Y1, uint Argb)> DeviceRects(
        PetBitmap bitmap, PetCrop crop, double width, double height, double scale)
    {
        var rects = new List<(int, int, int, int, uint)>();
        var n = crop.Side;
        scale = Math.Max(scale, 1);
        var side = Math.Min(width, height) * scale;
        var raw = side / n;
        // Whole device pixels per cell when possible, so every pixel is a crisp square.
        var cell = raw >= 1 ? Math.Floor(raw) : raw;
        var ox = Math.Floor((width * scale - cell * n) / 2);
        var oy = Math.Floor((height * scale - cell * n) / 2);
        for (var row = 0; row < n; row++)
        {
            var y0 = Round(oy + row * cell);
            var y1 = Round(oy + (row + 1) * cell);
            if (!(y1 > y0)) continue;
            var col = 0;
            while (col < n)
            {
                var c = bitmap[crop.X + col, crop.Y + row];
                var run = 1;
                while (col + run < n && bitmap[crop.X + col + run, crop.Y + row] == c) run += 1;
                if (c != 0)
                {
                    var x0 = Round(ox + col * cell);
                    var x1 = Round(ox + (col + run) * cell);
                    if (x1 > x0) rects.Add(((int)x0, (int)y0, (int)x1, (int)y1, c));
                }
                col += run;
            }
        }
        return rects;
    }

    /// <summary>
    /// <see cref="DeviceRects"/> in DIPs (device pixels ÷ scale), as the Mac adds them to its paths: fill each
    /// with its colour, antialiasing off.
    /// </summary>
    public static IReadOnlyList<PetFill> Layout(PetBitmap bitmap, PetCrop crop, double width, double height, double scale)
    {
        var s = Math.Max(scale, 1);
        return DeviceRects(bitmap, crop, width, height, scale)
            .Select(r => new PetFill(r.X0 / s, r.Y0 / s, (r.X1 - r.X0) / s, (r.Y1 - r.Y0) / s, r.Argb))
            .ToList();
    }

    /// <summary>
    /// Draws <paramref name="bitmap"/> into a transparent <paramref name="pixelWidth"/> × <paramref name="pixelHeight"/>
    /// device-pixel buffer, laid out exactly as the Mac lays it out in a view of that many points at scale 1.
    /// </summary>
    public static PetImage Render(PetBitmap bitmap, PetCrop crop, int pixelWidth, int pixelHeight) =>
        Rasterize(DeviceRects(bitmap, crop, pixelWidth, pixelHeight, 1), pixelWidth, pixelHeight);

    /// <summary>
    /// The whole view in one call: <paramref name="frame"/> (from <see cref="FrameFor"/>) drawn for a
    /// <paramref name="size"/> × <paramref name="size"/> DIP view at <paramref name="scale"/> (the XAML
    /// rasterization scale), with the Mac's device-pixel layout for that size and scale. The buffer is
    /// ceil(size × scale) device pixels square; show it at <c>PixelWidth / scale</c> DIPs so nothing resamples.
    /// </summary>
    public static PetImage Render(PixelPet pet, PetFrame frame, double size, double scale, PetFraming framing = PetFraming.Automatic)
    {
        scale = Math.Max(scale, 1);
        var pixels = Math.Max((int)Math.Ceiling(size * scale), 1);
        // Layout rounds the view's frame to whole device pixels before the canvas draws (SwiftUI does, and so
        // does WinUI's layout rounding), so the canvas gets round(size × scale) device pixels.
        var drawn = Round(size * scale) / scale;
        var crop = CropFor(pet, IsTight(size, framing), drawn, drawn, scale);
        return Rasterize(DeviceRects(pet.Bitmap(frame), crop, drawn, drawn, scale), pixels, pixels);
    }

    private static PetImage Rasterize(IReadOnlyList<(int X0, int Y0, int X1, int Y1, uint Argb)> rects, int pixelWidth, int pixelHeight)
    {
        var bytes = new byte[pixelWidth * pixelHeight * 4];
        foreach (var (x0, y0, x1, y1, argb) in rects)
        {
            for (var y = Math.Max(y0, 0); y < Math.Min(y1, pixelHeight); y++)
            {
                for (var x = Math.Max(x0, 0); x < Math.Min(x1, pixelWidth); x++)
                {
                    WriteBgra(bytes, (y * pixelWidth + x) * 4, argb);
                }
            }
        }
        return new PetImage(pixelWidth, pixelHeight, bytes);
    }

    /// <summary>Swift's <c>.rounded()</c>: to nearest, halves away from zero.</summary>
    private static double Round(double value) => Math.Round(value, MidpointRounding.AwayFromZero);

    /// <summary>Writes 0xAARRGGBB as premultiplied BGRA (pet colours are opaque or fully transparent).</summary>
    internal static void WriteBgra(byte[] bytes, int offset, uint argb)
    {
        uint a = argb >> 24;
        if (a == 0)
        {
            bytes[offset] = bytes[offset + 1] = bytes[offset + 2] = bytes[offset + 3] = 0;
            return;
        }
        uint r = (argb >> 16) & 0xFF, g = (argb >> 8) & 0xFF, b = argb & 0xFF;
        if (a != 255)
        {
            r = (r * a + 127) / 255; g = (g * a + 127) / 255; b = (b * a + 127) / 255;
        }
        bytes[offset] = (byte)b;
        bytes[offset + 1] = (byte)g;
        bytes[offset + 2] = (byte)r;
        bytes[offset + 3] = (byte)a;
    }
}
