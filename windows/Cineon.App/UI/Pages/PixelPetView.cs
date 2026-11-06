using System.Runtime.InteropServices.WindowsRuntime;
using Cineon.Core.Profile;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Cineon.App.UI;

/// The pixel pet, drawn the way the Mac's PixelPetView draws it: every pet pixel a square of whole
/// device pixels, into a bitmap exactly the size it's shown at, so nothing resamples it. Animated
/// views redraw every 100 ms when the pose changes; still ones, and every pet while Windows'
/// animation effects are off, show the resting pose.
public sealed class PixelPetView : Grid
{
    private readonly PixelPet _pet;
    private readonly double _size;
    private readonly bool _animated;
    private readonly PetFraming _framing;
    private readonly Image _image = new()
    {
        Stretch = Stretch.Fill,
        HorizontalAlignment = HorizontalAlignment.Left,
        VerticalAlignment = VerticalAlignment.Top,
    };
    private WriteableBitmap? _bitmap;
    private double _scale;
    private PetFrame? _drawn;
    private DispatcherQueueTimer? _timer;
    private XamlRoot? _root;

    public PixelPetView(PixelPet pet, double size, bool animated = true, PetFraming framing = PetFraming.Automatic)
    {
        _pet = pet;
        _size = size;
        _animated = animated;
        _framing = framing;
        Width = size;
        Height = size;
        Children.Add(_image);
        AutomationProperties.SetName(this, pet.AccessibilityDescription);
        AutomationProperties.SetAccessibilityView(_image, AccessibilityView.Raw);
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
    }

    public PixelPet Pet => _pet;

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        _root = XamlRoot;
        if (_root is not null) _root.Changed += OnRootChanged;
        if (_animated && SocialKit.AnimationsEnabled && DispatcherQueue is { } queue)
        {
            _timer ??= queue.CreateTimer();
            _timer.Interval = PetCanvas.FrameInterval;
            _timer.IsRepeating = true;
            _timer.Tick -= OnTick;
            _timer.Tick += OnTick;
            _timer.Start();
        }
        Draw(force: true);
    }

    private void OnUnloaded(object sender, RoutedEventArgs e)
    {
        _timer?.Stop();
        if (_root is not null) _root.Changed -= OnRootChanged;
        _root = null;
    }

    private void OnTick(DispatcherQueueTimer sender, object args) => Draw(force: false);

    // Moving to a screen with another scale redraws at the new device-pixel size.
    private void OnRootChanged(XamlRoot sender, XamlRootChangedEventArgs args)
    {
        if (sender.RasterizationScale != _scale) Draw(force: true);
    }

    private void Draw(bool force)
    {
        var scale = XamlRoot?.RasterizationScale ?? 1;
        var moving = _timer is { IsRunning: true };
        var frame = PetCanvas.FrameFor(_pet, _size, _framing, animated: moving, reduceMotion: !moving);
        if (!force && scale == _scale && _drawn is { } last && last == frame) return;
        var image = PetCanvas.Render(_pet, frame, _size, scale, _framing);
        if (_bitmap is null || _bitmap.PixelWidth != image.PixelWidth || _bitmap.PixelHeight != image.PixelHeight)
        {
            _bitmap = new WriteableBitmap(image.PixelWidth, image.PixelHeight);
            _image.Source = _bitmap;
        }
        image.Bgra.CopyTo(_bitmap.PixelBuffer);
        _bitmap.Invalidate();
        _image.Width = image.PixelWidth / scale;
        _image.Height = image.PixelHeight / scale;
        _scale = scale;
        _drawn = frame;
    }

    protected override AutomationPeer OnCreateAutomationPeer() => new PetPeer(this);

    private sealed class PetPeer(PixelPetView owner) : FrameworkElementAutomationPeer(owner)
    {
        protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Image;
        protected override string GetClassNameCore() => nameof(PixelPetView);
        protected override IList<AutomationPeer>? GetChildrenCore() => null;
    }
}
