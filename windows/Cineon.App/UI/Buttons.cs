using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Cineon.App.UI;

/// The Mac's button styles: Silver (the one strong button on a screen), Outline, Hover (quiet, fills
/// on hover) and Icon. They're real Buttons, so keyboard focus, Enter/Space and screen readers work.
public static class Buttons
{
    private static ControlTemplate? _plain;

    /// A template that draws only the content and the button's own background and border.
    private static ControlTemplate Plain => _plain ??= (ControlTemplate)XamlReader.Load("""
        <ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Button">
          <ContentPresenter x:Name="ContentPresenter"
                            xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                            Background="{TemplateBinding Background}"
                            BorderBrush="{TemplateBinding BorderBrush}"
                            BorderThickness="{TemplateBinding BorderThickness}"
                            CornerRadius="{TemplateBinding CornerRadius}"
                            Padding="{TemplateBinding Padding}"
                            Content="{TemplateBinding Content}"
                            HorizontalContentAlignment="{TemplateBinding HorizontalContentAlignment}"
                            VerticalContentAlignment="{TemplateBinding VerticalContentAlignment}" />
        </ControlTemplate>
        """);

    /// A bare button: no chrome, a hand cursor, a small press. `paint` is called with (hovered, pressed)
    /// whenever either changes, to restyle it.
    public static Button Make(object content, Action action, Action<Button, bool, bool>? paint = null, bool enabled = true, string? help = null)
    {
        var button = new Button
        {
            Template = Plain,
            Content = content,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(0),
            IsEnabled = enabled,
            UseSystemFocusVisuals = true,
            RenderTransformOrigin = new Windows.Foundation.Point(0.5, 0.5),
            RenderTransform = new ScaleTransform(),
        };
        var hovered = false;
        var pressed = false;
        void Repaint()
        {
            paint?.Invoke(button, hovered && button.IsEnabled, pressed);
            var scale = (ScaleTransform)button.RenderTransform;
            scale.ScaleX = scale.ScaleY = pressed ? 0.97 : 1;
            button.Opacity = button.IsEnabled ? 1 : 0.38;
        }
        button.PointerEntered += (_, _) => { hovered = true; Repaint(); };
        button.PointerExited += (_, _) => { hovered = false; pressed = false; Repaint(); };
        button.AddHandler(UIElement.PointerPressedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => { pressed = true; Repaint(); }), true);
        button.AddHandler(UIElement.PointerReleasedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => { pressed = false; Repaint(); }), true);
        button.IsEnabledChanged += (_, _) => Repaint();
        button.Click += (_, _) => action();
        Ui.Hand(button);
        if (help is not null) { button.Tooltip(help); button.Label(help); }
        Repaint();
        return button;
    }

    /// The one strong button on any screen, finished like the film strip in the logo.
    public static Button Silver(string title, Action action, bool large = false, bool enabled = true)
    {
        var p = Theme.P;
        var text = Ui.Line(title, Typeface.Ui(large ? 15 : 13, Typeface.Semibold), p.OnSilver);
        var button = Make(text, action, (b, hovered, _) =>
        {
            b.Background = p.Silver;
            b.Opacity = b.IsEnabled ? 1 : 0.38;
            // Brighten on hover, the way SwiftUI's .brightness does.
            text.Opacity = 1;
            b.BorderBrush = new SolidColorBrush(hovered ? Palette.WithOpacity(p.Ink, 0.25) : Microsoft.UI.Colors.Transparent);
        }, enabled);
        button.Padding = large ? new Thickness(22, 11, 22, 11) : new Thickness(14, 7, 14, 7);
        button.BorderThickness = new Thickness(1);
        button.SizeChanged += (_, e) => button.CornerRadius = new CornerRadius(e.NewSize.Height / 2);
        return button;
    }

    public static Button Outline(string title, Action action, bool large = false, bool enabled = true)
    {
        var p = Theme.P;
        var button = Make(Ui.Line(title, Typeface.Ui(large ? 15 : 13, Typeface.Medium), p.Ink), action, (b, hovered, pressed) =>
        {
            b.Background = new SolidColorBrush(hovered || pressed ? p.Raised : Microsoft.UI.Colors.Transparent);
            b.BorderBrush = new SolidColorBrush(p.Line);
        }, enabled);
        button.Padding = large ? new Thickness(20, 10, 20, 10) : new Thickness(13, 6, 13, 6);
        button.BorderThickness = new Thickness(1);
        button.SizeChanged += (_, e) => button.CornerRadius = new CornerRadius(e.NewSize.Height / 2);
        return button;
    }

    /// A quiet button that fills on hover, like the Mac's HoverButtonStyle.
    public static Button Hover(object content, Action action, double radius = 8, bool selected = false, Thickness? padding = null, bool enabled = true, string? help = null)
    {
        var p = Theme.P;
        var button = Make(content, action, (b, hovered, pressed) =>
        {
            b.Background = new SolidColorBrush(selected || pressed ? p.Raised2 : hovered ? p.Raised : Microsoft.UI.Colors.Transparent);
        }, enabled, help);
        button.CornerRadius = new CornerRadius(radius);
        button.Padding = padding ?? new Thickness(8, 6, 8, 6);
        return button;
    }

    public static Button Icon(string glyph, string label, Action action, double size = 13, bool enabled = true, Color? color = null)
    {
        var p = Theme.P;
        var icon = Ui.Icon(glyph, size, enabled ? color ?? p.Ink2 : Palette.WithOpacity(p.Ink3, 0.6));
        var box = new Border { Width = 16, Height = 16, Child = icon };
        return Hover(box, action, radius: 7, padding: new Thickness(5), enabled: enabled, help: label);
    }
}
