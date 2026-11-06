using Cineon.Core.Data;
using Cineon.Core.Profile;
using Cineon.Core.Together;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Cineon.App.UI;

/// People on screen: as their pixel pet when they share one, otherwise their initial. The chrome has
/// no colour, so neither do people: you are silver. TogetherView.swift's PersonAvatar and Avatar, and
/// ProfilePicker.swift's ProfileAvatar.
public static class People
{
    /// Someone as their pixel pet when they share one, otherwise their initial.
    public static FrameworkElement PersonAvatar(string name, string? petCode, bool isMe = false, double size = 26)
    {
        if (PixelPet.FromCode(petCode) is not { } pet) return InitialAvatar(name, isMe, size);
        var p = Theme.P;
        var view = new PixelPetView(pet, size * 0.86, animated: false)
        {
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        Brush fill;
        if (isMe)
        {
            var silver = p.Silver;
            silver.Opacity = 0.35;
            fill = silver;
        }
        else
        {
            fill = new SolidColorBrush(p.Raised2);
        }
        var circle = new Grid { Width = size, Height = size, Background = fill, Children = { view } };
        circle.ClipRounded(size / 2);
        // The ring goes over the pet, like the Mac's overlay.
        var ring = new Ellipse
        {
            Width = size,
            Height = size,
            Stroke = isMe ? p.Silver : new SolidColorBrush(p.Line),
            StrokeThickness = isMe ? 1.5 : 1,
            IsHitTestVisible = false,
        };
        var avatar = new Grid { Width = size, Height = size, Children = { circle, ring } };
        return avatar.Label(name);
    }

    /// A person as their initial (the Mac's `Avatar`).
    public static FrameworkElement InitialAvatar(string name, bool isMe = false, double size = 26)
    {
        var p = Theme.P;
        var letter = Ui.Line(SocialKit.Initial(name), Typeface.Bold(size * 0.46), isMe ? p.OnSilver : p.Ink);
        letter.TextTrimming = TextTrimming.None;
        letter.HorizontalAlignment = HorizontalAlignment.Center;
        letter.VerticalAlignment = VerticalAlignment.Center;
        var circle = new Border
        {
            Width = size,
            Height = size,
            CornerRadius = new CornerRadius(size / 2),
            Background = isMe ? p.Silver : new SolidColorBrush(p.Raised2),
            BorderBrush = new SolidColorBrush(p.CardFill),
            BorderThickness = new Thickness(2),
            Child = letter,
        };
        return circle.Label(name);
    }

    /// A profile's initial on silver (ProfilePicker.swift's ProfileAvatar).
    public static FrameworkElement ProfileAvatar(Profile profile, double size = 28)
    {
        var p = Theme.P;
        var letter = Ui.Line(SocialKit.Initial(profile.Name), Typeface.Bold(size * 0.48), p.OnSilver);
        letter.TextTrimming = TextTrimming.None;
        letter.HorizontalAlignment = HorizontalAlignment.Center;
        letter.VerticalAlignment = VerticalAlignment.Center;
        var circle = new Border
        {
            Width = size,
            Height = size,
            CornerRadius = new CornerRadius(size / 2),
            Background = p.Silver,
            Child = letter,
        };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAccessibilityView(circle, Microsoft.UI.Xaml.Automation.Peers.AccessibilityView.Raw);
        return circle;
    }

    /// The code to read out or paste, set like a ticket number (the Mac's CodeBadge).
    public static Button CodeBadge(string code, Action copy)
    {
        var p = Theme.P;
        var text = Ui.Line(ShareCode.Display(code), Typeface.Time(15, Typeface.Semibold), p.Ink).Tracking(1.5);
        text.TextTrimming = TextTrimming.None;
        var content = new Border
        {
            Child = Ui.HStack(6, text, Ui.Icon(SocialKit.Copy, 10.5, p.Ink3)),
            Padding = new Thickness(11, 6, 11, 6),
            CornerRadius = new CornerRadius(8),
            BorderBrush = new SolidColorBrush(p.Line),
            BorderThickness = new Thickness(1),
        };
        return Buttons.Make(content, copy, help: "Copy the code");
    }

    /// SF Symbols' crown.fill, drawn: hosts and winners.
    public static FrameworkElement Crown(double size, Brush fill)
    {
        var figure = new PathFigure { StartPoint = new Windows.Foundation.Point(0.6, 3.2), IsClosed = true, IsFilled = true };
        foreach (var (x, y) in new[] { (3.4, 5.6), (6, 0.8), (8.6, 5.6), (11.4, 3.2), (10.3, 8.4), (1.7, 8.4) })
        {
            figure.Segments.Add(new LineSegment { Point = new Windows.Foundation.Point(x, y) });
        }
        var band = new RectangleGeometry { Rect = new Windows.Foundation.Rect(1.7, 9.2, 8.6, 1.6) };
        var geometry = new GeometryGroup
        {
            Children =
            {
                new PathGeometry { Figures = { figure } },
                band,
                new EllipseGeometry { Center = new Windows.Foundation.Point(0.6, 3.2), RadiusX = 0.9, RadiusY = 0.9 },
                new EllipseGeometry { Center = new Windows.Foundation.Point(6, 0.8), RadiusX = 0.9, RadiusY = 0.9 },
                new EllipseGeometry { Center = new Windows.Foundation.Point(11.4, 3.2), RadiusX = 0.9, RadiusY = 0.9 },
            },
            FillRule = FillRule.Nonzero,
        };
        return new Microsoft.UI.Xaml.Shapes.Path
        {
            Data = geometry,
            Fill = fill,
            Stretch = Stretch.Uniform,
            Width = size * 1.2,
            Height = size,
            IsHitTestVisible = false,
        };
    }

    /// A heading inside a page (Together's SectionHeading).
    public static TextBlock SectionHeading(string name) => Ui.Line(name, Typeface.Title(20), Theme.P.Ink);
}
