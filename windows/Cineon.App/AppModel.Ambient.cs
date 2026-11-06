using Cineon.App.Browser;
using Cineon.App.UI;
using Windows.UI;

namespace Cineon.App;

// Ambient light: the "Ambient light" part of Cineon/App/AppModel.swift.
public sealed partial class AppModel
{
    private int _snapshotCounter;
    private bool _isSamplingWindow;
    private int _windowCaptureFails;

    /// Light follows the film on screen, reads from the video when the browser allows it, from a
    /// small capture when it doesn't, and from the poster as a last resort.
    private void TickAmbient()
    {
        // Runs whenever the window can be seen, including while you work in another app beside it.
        var isVisible = Window?.IsShowing ?? true;
        if (!Settings.AmbientLight || !isVisible)
        {
            Browser.Selected?.SetAmbient(false);
            if (!Settings.AmbientLight) Ambient.Clear();
            return;
        }

        if (Route == Route.Player && LocalPlayback is { } playback)
        {
            if (!playback.IsPlaying || playback.SampleZones() is not { } zones)
            {
                if (!playback.IsPlaying) Ambient.Dim();
                return;
            }
            Ambient.SetActive(CinemaStrength);
            Ambient.UpdateFromLive(zones);
            return;
        }

        if (Route != Route.Web || Browser.Selected is not { } tab || tab.Media?.IsPlaying != true)
        {
            Browser.Selected?.SetAmbient(false);
            if (Route is Route.Web or Route.Settings) Ambient.Dim();
            else ShowHeroLight();
            return;
        }

        Ambient.SetActive(CinemaStrength);
        tab.SetAmbient(true);

        if (!tab.AmbientFramesBlocked) return;
        // The page won't let the video be read. Capture the window instead, which sees it.
        if (_windowCaptureFails < 3)
        {
            _ = SampleWindowAsync(tab);
            return;
        }
        _snapshotCounter++;
        if (_snapshotCounter % 2 == 0 && !Ambient.SnapshotsAreBlack) _ = SampleSnapshotAsync(tab);
        if (Ambient.SnapshotsAreBlack && tab.LinkedTitleId is long id && Library.Titles.TryGetValue(id, out var title)
            && (title.BackdropUrl ?? title.PosterUrl) is { } url)
        {
            Ambient.SetFromImage(url);
        }
    }

    /// Cinema mode leaves a dark frame around the film, where the light gets to be brighter.
    private double CinemaStrength
    {
        get
        {
            var strength = Settings.AmbientStrength;
            return IsCinema ? Math.Min(1, strength * 1.45 + 0.1) : strength;
        }
    }

    private async Task SampleWindowAsync(BrowserTab tab)
    {
        if (_isSamplingWindow || !tab.HasWebView) return;
        _isSamplingWindow = true;
        try
        {
            if (await tab.CaptureWindowZonesAsync() is not { } zones)
            {
                _windowCaptureFails++;
                return;
            }
            _windowCaptureFails = 0;
            Ambient.UpdateFromLive(zones);
        }
        finally
        {
            _isSamplingWindow = false;
        }
    }

    private async Task SampleSnapshotAsync(BrowserTab tab)
    {
        if (!tab.HasWebView) return;
        if (await tab.SnapshotZonesAsync() is { } zones) Ambient.UpdateFromSnapshot(zones);
    }

    /// Off screen pages show faint light from the title being featured on Home.
    private void ShowHeroLight()
    {
        if (Route == Route.Home && Library.ContinueWatching is [var first, ..]
            && (first.Title.BackdropUrl ?? first.Title.PosterUrl) is { } url)
        {
            Ambient.SetActive(Settings.AmbientStrength * 0.55);
            Ambient.SetFromImage(url);
        }
        else
        {
            Ambient.Dim();
        }
    }
}

/// The light around the film: six colour zones (top left, top, top right, bottom left, bottom,
/// bottom right) and how strong it is. Views ease `Level` over 1.2 s and `Zones` over 1.4 s, as
/// the Mac's animations do.
public sealed class AmbientModel : Observable
{
    /// A colour from 0 to 1 per channel. The Mac's `RGB` from Images.swift.
    public readonly record struct Rgb(double R, double G, double B)
    {
        public static Rgb Black => new(0, 0, 0);

        public double Brightness => 0.2126 * R + 0.7152 * G + 0.0722 * B;

        public Color Color => Color.FromArgb(255, Channel(R), Channel(G), Channel(B));

        /// Light from a screen is more saturated than the average pixel value suggests.
        public Rgb Boosted(double saturation = 1.5)
        {
            var grey = Brightness;
            double Mix(double c) => Math.Min(1, Math.Max(0, grey + (c - grey) * saturation));
            return new Rgb(Mix(R), Mix(G), Mix(B));
        }

        private static byte Channel(double value) => (byte)Math.Round(Math.Clamp(value, 0, 1) * 255);
    }

    private static readonly IReadOnlyList<Rgb> Dark = [Rgb.Black, Rgb.Black, Rgb.Black, Rgb.Black, Rgb.Black, Rgb.Black];

    public IReadOnlyList<Rgb> Zones { get; private set; } = Dark;
    public double Level { get; private set; }

    private Uri? _imageUrl;
    private int _blackSnapshots;

    public bool SnapshotsAreBlack => _blackSnapshots >= 3;

    public void SetActive(double strength)
    {
        if (Level == strength) return;
        Level = strength;
        Notify();
    }

    public void Dim()
    {
        if (Level == 0) return;
        _imageUrl = null;
        Level = 0;
        Notify();
    }

    public void Clear()
    {
        _imageUrl = null;
        _blackSnapshots = 0;
        if (Level == 0 && Zones.SequenceEqual(Dark)) return;
        Level = 0;
        Zones = Dark;
        Notify();
    }

    /// Zones from media.js, as [r, g, b] in 0...255.
    public void UpdateFromFrames(IReadOnlyList<IReadOnlyList<double>> raw)
    {
        var parsed = raw.Where(c => c.Count == 3).Select(c => new Rgb(c[0] / 255, c[1] / 255, c[2] / 255)).ToList();
        if (parsed.Count != 6) return;
        _imageUrl = null;
        Apply(parsed);
    }

    /// Frames read straight from the video, where a dark scene is just a dark scene.
    public void UpdateFromLive(IReadOnlyList<Rgb> sampled)
    {
        if (sampled.Count != 6) return;
        _blackSnapshots = 0;
        _imageUrl = null;
        Apply(sampled);
    }

    public void UpdateFromSnapshot(IReadOnlyList<Rgb> sampled)
    {
        if (sampled.Count != 6) return;
        if (sampled.All(c => c.Brightness < 0.015))
        {
            // Hardware video often isn't captured in snapshots. After three black ones, stop asking.
            _blackSnapshots++;
            return;
        }
        _blackSnapshots = 0;
        _imageUrl = null;
        Apply(sampled);
    }

    public void SetFromImage(Uri url)
    {
        if (_imageUrl?.OriginalString == url.OriginalString) return;
        _imageUrl = url;
        _ = LoadImageZonesAsync(url);
    }

    private async Task LoadImageZonesAsync(Uri url)
    {
        // TODO(after core merge): `await ImagePipeline.Shared.ZonesAsync(url)` (Core's image cache:
        // the picture at 256 px, then ColorZones.Sample), mapped into Rgb.
        IReadOnlyList<Rgb>? sampled = await Task.FromResult<IReadOnlyList<Rgb>?>(null);
        if (sampled is null || _imageUrl?.OriginalString != url.OriginalString) return;
        Apply(sampled);
    }

    private void Apply(IReadOnlyList<Rgb> sampled)
    {
        var boosted = sampled.Select(c => c.Boosted()).ToList();
        if (boosted.SequenceEqual(Zones)) return;
        Zones = boosted;
        Notify();
    }
}
