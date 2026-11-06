using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cineon.App.UI;

/// The Mac's ProgressLine, as an element whose fraction can change in place. `Progress.Line` draws
/// a fixed one; this one is for progress that moves several times a second (downloads, a season
/// being fetched), where rebuilding would restart everything around it.
public sealed class ProgressLine : Grid
{
    private readonly Border _track;
    private readonly Border _bar;
    private readonly double _height;
    private double _fraction;

    public ProgressLine(double fraction, double height = 3)
    {
        var p = Theme.P;
        _height = height;
        _fraction = fraction;
        Height = height;
        _track = new Border { Height = height, CornerRadius = new CornerRadius(height / 2), Background = new SolidColorBrush(p.Raised2) };
        _bar = new Border { Height = height, CornerRadius = new CornerRadius(height / 2), Background = new SolidColorBrush(p.Ink), HorizontalAlignment = HorizontalAlignment.Left };
        Children.Add(_track);
        Children.Add(_bar);
        SizeChanged += (_, _) => Layout();
        Label();
    }

    public double Fraction
    {
        get => _fraction;
        set
        {
            if (Math.Abs(value - _fraction) < 0.0005) return;
            _fraction = value;
            Layout();
            Label();
        }
    }

    private void Layout() => _bar.Width = Math.Max(_height, ActualWidth * Math.Clamp(_fraction, 0, 1));

    private void Label() => this.Label($"{(int)(Math.Clamp(_fraction, 0, 1) * 100)} percent");
}
