using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Rgb = Cineon.App.AmbientModel.Rgb;

namespace Cineon.App.UI;

/// Light from the film spilling onto the chrome, the way a TV lights the wall behind it. The Mac's
/// AmbientLight in RootView.swift draws a 3×3 MeshGradient: the six sampled zones round the outer
/// ring, and a dimmer copy of the top zone in the centre, which stays dark under the card. WinUI has
/// no mesh gradient, so the same nine points are blended smoothly (cubic Hermite, like a mesh with
/// smoothed colours) into a small bitmap stretched over the window. It sits under the pages.
///
/// The level eases over 1.2 s and the colours over 1.4 s, as AmbientModel's animations do; `Clear`
/// (a profile switch, ambient light switched off) is instant. Its strength is the level, and half
/// as much again over white, where the Mac multiplies it over the canvas (the same thing on white).
public sealed class AmbientLight : Grid
{
    private const int PixelWidth = 96;
    private const int PixelHeight = 60;
    private const double ZoneSeconds = 1.4;
    private const double LevelSeconds = 1.2;

    private readonly AppModel _app;
    private readonly WriteableBitmap _bitmap = new(PixelWidth, PixelHeight);
    private readonly byte[] _pixels = new byte[PixelWidth * PixelHeight * 4];
    private readonly Image _image;

    private Rgb[] _from = Black();
    private Rgb[] _to = Black();
    private Rgb[] _shown = Black();
    private DateTimeOffset _started;
    private bool _animating;
    private double? _opacity;
    private bool _attached;

    public AmbientLight(AppModel app)
    {
        _app = app;
        IsHitTestVisible = false;
        _image = new Image { Source = _bitmap, Stretch = Stretch.Fill, IsHitTestVisible = false };
        Children.Add(_image);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAccessibilityView(this, Microsoft.UI.Xaml.Automation.Peers.AccessibilityView.Raw);
        // Dark until the model says otherwise; the bitmap starts black, which would show over white.
        ElementCompositionPreview.GetElementVisual(this).Opacity = 0;
        Draw();
        Loaded += (_, _) =>
        {
            if (_attached) return;
            _attached = true;
            _app.Ambient.Changed += Update;
            Theme.Changed += Update;
            Update();
        };
        Unloaded += (_, _) =>
        {
            if (!_attached) return;
            _attached = false;
            _app.Ambient.Changed -= Update;
            Theme.Changed -= Update;
            StopFrames();
        };
    }

    private static Rgb[] Black() => [Rgb.Black, Rgb.Black, Rgb.Black, Rgb.Black, Rgb.Black, Rgb.Black];

    private void Update()
    {
        var ambient = _app.Ambient;
        var zones = ambient.Zones.Count == 6 ? ambient.Zones.ToArray() : Black();
        var cleared = ambient.Level == 0 && zones.All(z => z == Rgb.Black);

        if (!zones.SequenceEqual(_to))
        {
            if (cleared)
            {
                StopFrames();
                _from = _to = _shown = zones;
                Draw();
            }
            else
            {
                // From wherever the colours are now, so a change mid-way doesn't jump.
                _from = _shown;
                _to = zones;
                _started = DateTimeOffset.Now;
                StartFrames();
            }
        }

        var opacity = ambient.Level * (Theme.P.IsDark ? 1 : 0.55);
        if (_opacity != opacity)
        {
            SetOpacity(opacity, animated: !cleared && _opacity is not null);
            _opacity = opacity;
        }
    }

    private void SetOpacity(double opacity, bool animated)
    {
        var visual = ElementCompositionPreview.GetElementVisual(this);
        if (!animated)
        {
            visual.StopAnimation("Opacity");
            visual.Opacity = (float)opacity;
            return;
        }
        var compositor = visual.Compositor;
        var animation = compositor.CreateScalarKeyFrameAnimation();
        animation.InsertKeyFrame(1, (float)opacity, Motion.EaseInOut(compositor));
        animation.Duration = TimeSpan.FromSeconds(LevelSeconds);
        visual.StartAnimation("Opacity", animation);
    }

    private void StartFrames()
    {
        if (_animating) return;
        _animating = true;
        Microsoft.UI.Xaml.Media.CompositionTarget.Rendering += OnFrame;
    }

    private void StopFrames()
    {
        if (!_animating) return;
        _animating = false;
        Microsoft.UI.Xaml.Media.CompositionTarget.Rendering -= OnFrame;
    }

    private void OnFrame(object? sender, object e)
    {
        var t = Math.Min(1, (DateTimeOffset.Now - _started).TotalSeconds / ZoneSeconds);
        var eased = Easing.EaseInOut(t);
        _shown = [.. _from.Zip(_to, (a, b) => new Rgb(a.R + (b.R - a.R) * eased, a.G + (b.G - a.G) * eased, a.B + (b.B - a.B) * eased))];
        Draw();
        if (t >= 1) StopFrames();
    }

    /// The mesh into the bitmap: nine points, premultiplied, blended along each axis.
    private void Draw()
    {
        var z = _shown;
        // (r, g, b, a) premultiplied, rows top to bottom.
        var points = new (double R, double G, double B, double A)[3, 3];
        static (double, double, double, double) Opaque(Rgb c) => (c.R, c.G, c.B, 1);
        points[0, 0] = Opaque(z[0]); points[0, 1] = Opaque(z[1]); points[0, 2] = Opaque(z[2]);
        points[1, 0] = Opaque(z[3]); points[1, 1] = (z[1].R * 0.7, z[1].G * 0.7, z[1].B * 0.7, 0.7); points[1, 2] = Opaque(z[5]);
        points[2, 0] = Opaque(z[3]); points[2, 1] = Opaque(z[4]); points[2, 2] = Opaque(z[5]);

        var columnWeights = new (double, double, double)[PixelWidth];
        for (var x = 0; x < PixelWidth; x++) columnWeights[x] = Weights(x / (double)(PixelWidth - 1));
        for (var y = 0; y < PixelHeight; y++)
        {
            var (v0, v1, v2) = Weights(y / (double)(PixelHeight - 1));
            for (var x = 0; x < PixelWidth; x++)
            {
                var (u0, u1, u2) = columnWeights[x];
                double r = 0, g = 0, b = 0, a = 0;
                for (var row = 0; row < 3; row++)
                {
                    var wv = row == 0 ? v0 : row == 1 ? v1 : v2;
                    for (var column = 0; column < 3; column++)
                    {
                        var w = wv * (column == 0 ? u0 : column == 1 ? u1 : u2);
                        var point = points[row, column];
                        r += point.R * w; g += point.G * w; b += point.B * w; a += point.A * w;
                    }
                }
                a = Math.Clamp(a, 0, 1);
                var i = (y * PixelWidth + x) * 4;
                _pixels[i] = Byte(Math.Min(b, a));
                _pixels[i + 1] = Byte(Math.Min(g, a));
                _pixels[i + 2] = Byte(Math.Min(r, a));
                _pixels[i + 3] = Byte(a);
            }
        }
        using (var stream = _bitmap.PixelBuffer.AsStream())
        {
            stream.Write(_pixels, 0, _pixels.Length);
        }
        _bitmap.Invalidate();
    }

    private static byte Byte(double value) => (byte)Math.Round(Math.Clamp(value, 0, 1) * 255);

    /// How much each of three points at 0, ½ and 1 counts at `t`: a cubic Hermite curve through them,
    /// with Catmull-Rom tangents in the middle and one-sided ones at the ends.
    private static (double, double, double) Weights(double t)
    {
        // Each half is its own segment, parametrised 0...1.
        var first = t <= 0.5;
        var s = first ? t * 2 : (t - 0.5) * 2;
        var s2 = s * s;
        var s3 = s2 * s;
        var h00 = 2 * s3 - 3 * s2 + 1;
        var h10 = s3 - 2 * s2 + s;
        var h01 = -2 * s3 + 3 * s2;
        var h11 = s3 - s2;
        // Tangents per segment, as weights of P0, P1, P2: m0 = P1 - P0, m1 = (P2 - P0) / 2, m2 = P2 - P1.
        if (first)
        {
            // p = h00 P0 + h10 m0 + h01 P1 + h11 m1
            return (h00 - h10 - h11 / 2, h10 + h01, h11 / 2);
        }
        // p = h00 P1 + h10 m1 + h01 P2 + h11 m2
        return (-h10 / 2, h00 - h11, h10 / 2 + h01 + h11);
    }
}
