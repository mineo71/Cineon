using System.Numerics;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Geometry;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;

namespace Cineon.App.UI;

/// The one orchestrated moment: the logo's film strip unspools around the C. It's drawn over the
/// app rather than before it, so everything underneath is already ready and launch never waits.
/// Ported from Cineon/UI/Splash.swift (SplashView). Off when "Logo animation on launch" is off or
/// Windows' animation effects are, as the Mac skips it under Reduce Motion.
public sealed class SplashView : Grid
{
    private const double LogoSize = 170;
    /// Where the sweep starts, in degrees clockwise from three o'clock: just above the top end of the C.
    private const double StartAngle = -38;

    private readonly AppModel _app;
    private readonly FrameworkElement _logo;
    private bool _started;

    public SplashView(AppModel app)
    {
        _app = app;
        IsHitTestVisible = false;
        Background = new SolidColorBrush(Theme.P.Canvas);
        _logo = Images.LogoMark(LogoSize);
        _logo.HorizontalAlignment = HorizontalAlignment.Center;
        _logo.VerticalAlignment = VerticalAlignment.Center;
        // Hidden until the sweep starts, so the first frame isn't the whole mark.
        _logo.Opacity = 0;
        Children.Add(_logo);
        Loaded += (_, _) => _ = PlayAsync();
    }

    private async Task PlayAsync()
    {
        if (_started) return;
        _started = true;
        try
        {
            if (!_app.Settings.LaunchAnimation || !Motion.Enabled)
            {
                _app.SplashVisible = false;
                return;
            }
            Sweep(0.42);
            // The Mac runs a strip of light along the metal here, with the overlay blend mode. Over a
            // mark in one flat colour that blend changes nothing, so it's left out; the timing stays.
            await Task.Delay(240);
            await Task.Delay(300);
            await FadeOutAsync(0.22);
        }
        catch (Exception error)
        {
            CrashLog.Write("splash", error);
        }
        _app.SplashVisible = false;
    }

    /// Wipes the mark in round the C, from the top end clockwise, the way the Mac's angular-gradient
    /// mask does. The clip is a pie slice that grows each frame with an ease-in-out curve.
    private void Sweep(double seconds)
    {
        var visual = ElementCompositionPreview.GetElementVisual(_logo);
        var compositor = visual.Compositor;
        CanvasDevice device;
        try
        {
            device = CanvasDevice.GetSharedDevice();
        }
        catch (Exception)
        {
            _logo.Opacity = 1;
            return;
        }
        var geometry = compositor.CreatePathGeometry();
        visual.Clip = compositor.CreateGeometricClip(geometry);
        geometry.Path = Pie(device, 0);
        _logo.Opacity = 1;

        var started = DateTimeOffset.Now;
        EventHandler<object>? tick = null;
        tick = (_, _) =>
        {
            var t = Math.Min(1, (DateTimeOffset.Now - started).TotalSeconds / seconds);
            var sweep = Easing.EaseInOut(t);
            if (t >= 1)
            {
                Microsoft.UI.Xaml.Media.CompositionTarget.Rendering -= tick;
                visual.Clip = null;
                return;
            }
            try { geometry.Path = Pie(device, sweep); }
            catch (Exception)
            {
                Microsoft.UI.Xaml.Media.CompositionTarget.Rendering -= tick;
                visual.Clip = null;
            }
        };
        Microsoft.UI.Xaml.Media.CompositionTarget.Rendering += tick;
    }

    /// The part of the logo's box already revealed: a slice from the start angle round `sweep` of a turn.
    private static CompositionPath Pie(CanvasDevice device, double sweep)
    {
        var centre = new Vector2((float)(LogoSize / 2), (float)(LogoSize / 2));
        var radius = (float)LogoSize;
        using var builder = new CanvasPathBuilder(device);
        if (sweep <= 0.0001)
        {
            builder.BeginFigure(centre);
            builder.EndFigure(CanvasFigureLoop.Closed);
            return new CompositionPath(CanvasGeometry.CreatePath(builder));
        }
        var start = StartAngle * Math.PI / 180;
        var end = start + sweep * 2 * Math.PI;
        Vector2 At(double angle) => centre + new Vector2((float)(Math.Cos(angle) * radius), (float)(Math.Sin(angle) * radius));
        builder.BeginFigure(centre);
        builder.AddLine(At(start));
        // Two arcs, so a sweep past half a turn never has to choose between the long and short way.
        var middle = start + (end - start) / 2;
        builder.AddArc(At(middle), radius, radius, 0, CanvasSweepDirection.Clockwise, CanvasArcSize.Small);
        builder.AddArc(At(end), radius, radius, 0, CanvasSweepDirection.Clockwise, CanvasArcSize.Small);
        builder.EndFigure(CanvasFigureLoop.Closed);
        return new CompositionPath(CanvasGeometry.CreatePath(builder));
    }

    private async Task FadeOutAsync(double seconds)
    {
        var visual = ElementCompositionPreview.GetElementVisual(this);
        var compositor = visual.Compositor;
        var fade = compositor.CreateScalarKeyFrameAnimation();
        fade.InsertKeyFrame(1, 0, Motion.EaseOut(compositor));
        fade.Duration = TimeSpan.FromSeconds(seconds);
        visual.StartAnimation("Opacity", fade);
        await Task.Delay(TimeSpan.FromSeconds(seconds));
    }
}

/// Timing curves for animations driven frame by frame.
internal static class Easing
{
    /// SwiftUI's `.easeInOut`: the cubic Bézier (0.42, 0), (0.58, 1).
    public static double EaseInOut(double t) => Bezier(t, 0.42, 0, 0.58, 1);

    /// The y of a CSS-style cubic Bézier timing curve at x = t.
    public static double Bezier(double t, double x1, double y1, double x2, double y2)
    {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        static double Curve(double s, double a, double b) => 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
        // Solve x(s) = t by bisection; it's monotonic for these curves.
        double lo = 0, hi = 1, s = t;
        for (var i = 0; i < 30; i++)
        {
            s = (lo + hi) / 2;
            if (Curve(s, x1, x2) < t) lo = s; else hi = s;
        }
        return Curve(s, y1, y2);
    }
}
