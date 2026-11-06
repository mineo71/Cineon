using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace Cineon.App.UI;

/// A small kit for writing WinUI in C# the way the Mac app writes SwiftUI: build a tree of elements
/// from the current state, and build it again when the state changes (see `Component`).
///
///     Ui.VStack(12,
///         Ui.Text("Settings", Typeface.Title(30)),
///         Ui.HStack(8, Buttons.Outline("Hide", Hide), Buttons.Silver("Restore", Restore)))
///     .Padding(32, 34, 32, 60)
public static class Ui
{
    public static TextBlock Text(string text, Typeface.Font font, Color? color = null, int maxLines = 0)
    {
        var block = new TextBlock
        {
            Text = text,
            FontFamily = font.Family,
            FontSize = font.Size,
            FontWeight = font.Weight,
            Foreground = new SolidColorBrush(color ?? Theme.P.Ink),
            TextTrimming = TextTrimming.CharacterEllipsis,
            TextWrapping = maxLines == 1 ? TextWrapping.NoWrap : TextWrapping.WrapWholeWords,
            IsTextScaleFactorEnabled = false,
        };
        if (maxLines > 1) block.MaxLines = maxLines;
        if (font.Tabular) Microsoft.UI.Xaml.Documents.Typography.SetNumeralAlignment(block, Microsoft.UI.Xaml.FontNumeralAlignment.Tabular);
        return block;
    }

    /// One line, cut with an ellipsis.
    public static TextBlock Line(string text, Typeface.Font font, Color? color = null) => Text(text, font, color, maxLines: 1);

    public static FontIcon Icon(string glyph, double size = 14, Color? color = null) => new()
    {
        Glyph = glyph,
        FontFamily = Typeface.Icons,
        FontSize = size,
        Foreground = new SolidColorBrush(color ?? Theme.P.Ink2),
        IsTextScaleFactorEnabled = false,
    };

    public static StackPanel VStack(double spacing, params UIElement?[] children) => Stack(Orientation.Vertical, spacing, children);
    public static StackPanel HStack(double spacing, params UIElement?[] children) => Stack(Orientation.Horizontal, spacing, children);

    public static StackPanel Stack(Orientation orientation, double spacing, IEnumerable<UIElement?> children)
    {
        var panel = new StackPanel { Orientation = orientation, Spacing = spacing };
        foreach (var child in children)
            if (child is not null) panel.Children.Add(child);
        if (orientation == Orientation.Horizontal)
            foreach (var child in panel.Children)
                if (child is FrameworkElement fe && fe.ReadLocalValue(FrameworkElement.VerticalAlignmentProperty) == DependencyProperty.UnsetValue)
                    fe.VerticalAlignment = VerticalAlignment.Center;
        return panel;
    }

    /// A row where `Spacer()` children take the leftover width, like SwiftUI's HStack with Spacer.
    public static Grid Row(double spacing, params UIElement?[] children) => Flex(Orientation.Horizontal, spacing, children);
    public static Grid Column(double spacing, params UIElement?[] children) => Flex(Orientation.Vertical, spacing, children);

    public static Grid Flex(Orientation orientation, double spacing, IEnumerable<UIElement?> children)
    {
        var grid = new Grid();
        var horizontal = orientation == Orientation.Horizontal;
        if (horizontal) grid.ColumnSpacing = spacing; else grid.RowSpacing = spacing;
        var index = 0;
        foreach (var child in children)
        {
            if (child is null) continue;
            var length = child is FrameworkElement { Tag: FillTag } ? new GridLength(1, GridUnitType.Star) : GridLength.Auto;
            if (horizontal)
            {
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = length });
                Grid.SetColumn((FrameworkElement)child, index);
                if (child is FrameworkElement fe && fe.ReadLocalValue(FrameworkElement.VerticalAlignmentProperty) == DependencyProperty.UnsetValue)
                    fe.VerticalAlignment = VerticalAlignment.Center;
            }
            else
            {
                grid.RowDefinitions.Add(new RowDefinition { Height = length });
                Grid.SetRow((FrameworkElement)child, index);
            }
            grid.Children.Add(child);
            index++;
        }
        return grid;
    }

    private sealed class FillTag { public static readonly FillTag Value = new(); }

    /// Takes the leftover room in a `Row` or `Column`.
    public static Border Spacer() => new() { Tag = FillTag.Value };

    /// In a `Row`/`Column`, makes this child take the leftover room instead of a spacer.
    public static T Fill<T>(this T element) where T : FrameworkElement { element.Tag = FillTag.Value; return element; }

    /// Layers children on top of each other, like SwiftUI's ZStack.
    public static Grid ZStack(params UIElement?[] children)
    {
        var grid = new Grid();
        foreach (var child in children)
            if (child is not null) grid.Children.Add(child);
        return grid;
    }

    public static Border Box(UIElement? child = null) => new() { Child = child };

    public static Rectangle Rect(Color fill, double radius = 0) => new() { Fill = new SolidColorBrush(fill), RadiusX = radius, RadiusY = radius };

    public static Border Divider() => new() { Height = 1, Background = new SolidColorBrush(Theme.P.Line), HorizontalAlignment = HorizontalAlignment.Stretch };

    public static ScrollViewer Scroll(UIElement content, bool horizontal = false) => new()
    {
        Content = content,
        HorizontalScrollBarVisibility = horizontal ? ScrollBarVisibility.Hidden : ScrollBarVisibility.Disabled,
        HorizontalScrollMode = horizontal ? ScrollMode.Enabled : ScrollMode.Disabled,
        VerticalScrollBarVisibility = horizontal ? ScrollBarVisibility.Disabled : ScrollBarVisibility.Auto,
        VerticalScrollMode = horizontal ? ScrollMode.Disabled : ScrollMode.Enabled,
    };

    // MARK: Modifiers

    public static T Padding<T>(this T element, double all) where T : FrameworkElement => element.Padding(all, all, all, all);
    public static T Padding<T>(this T element, double horizontal, double vertical) where T : FrameworkElement => element.Padding(horizontal, vertical, horizontal, vertical);

    public static T Padding<T>(this T element, double left, double top, double right, double bottom) where T : FrameworkElement
    {
        var thickness = new Thickness(left, top, right, bottom);
        switch (element)
        {
            case Border b: b.Padding = thickness; break;
            case Control c: c.Padding = thickness; break;
            case StackPanel s: s.Padding = thickness; break;
            case Grid g: g.Padding = thickness; break;
            case TextBlock t: t.Padding = thickness; break;
            default: element.Margin = Add(element.Margin, thickness); break;
        }
        return element;
    }

    public static T Margin<T>(this T element, double all) where T : FrameworkElement { element.Margin = new Thickness(all); return element; }
    public static T Margin<T>(this T element, double left, double top, double right, double bottom) where T : FrameworkElement { element.Margin = new Thickness(left, top, right, bottom); return element; }

    public static T Size<T>(this T element, double? width = null, double? height = null) where T : FrameworkElement
    {
        if (width is { } w) element.Width = w;
        if (height is { } h) element.Height = h;
        return element;
    }

    public static T MaxSize<T>(this T element, double? width = null, double? height = null) where T : FrameworkElement
    {
        if (width is { } w) element.MaxWidth = w;
        if (height is { } h) element.MaxHeight = h;
        return element;
    }

    public static T MinSize<T>(this T element, double? width = null, double? height = null) where T : FrameworkElement
    {
        if (width is { } w) element.MinWidth = w;
        if (height is { } h) element.MinHeight = h;
        return element;
    }

    public static T Align<T>(this T element, HorizontalAlignment? horizontal = null, VerticalAlignment? vertical = null) where T : FrameworkElement
    {
        if (horizontal is { } h) element.HorizontalAlignment = h;
        if (vertical is { } v) element.VerticalAlignment = v;
        return element;
    }

    public static T Leading<T>(this T element) where T : FrameworkElement { element.HorizontalAlignment = HorizontalAlignment.Left; return element; }
    public static T Trailing<T>(this T element) where T : FrameworkElement { element.HorizontalAlignment = HorizontalAlignment.Right; return element; }
    public static T Centered<T>(this T element) where T : FrameworkElement { element.HorizontalAlignment = HorizontalAlignment.Center; element.VerticalAlignment = VerticalAlignment.Center; return element; }
    public static T Stretch<T>(this T element) where T : FrameworkElement { element.HorizontalAlignment = HorizontalAlignment.Stretch; element.VerticalAlignment = VerticalAlignment.Stretch; return element; }

    /// Wraps the element in a border with a fill, an optional corner radius and an optional stroke.
    public static Border Background(this FrameworkElement element, Color fill, double radius = 0, Color? stroke = null, double strokeWidth = 1) =>
        element.Background(new SolidColorBrush(fill), radius, stroke, strokeWidth);

    public static Border Background(this FrameworkElement element, Brush fill, double radius = 0, Color? stroke = null, double strokeWidth = 1)
    {
        var border = element as Border is { Child: not null } existing && existing.Background is null
            ? existing
            : new Border { Child = element };
        border.Background = fill;
        border.CornerRadius = new CornerRadius(radius);
        if (stroke is { } s) { border.BorderBrush = new SolidColorBrush(s); border.BorderThickness = new Thickness(strokeWidth); }
        if (element != border)
        {
            border.HorizontalAlignment = element.HorizontalAlignment;
            border.VerticalAlignment = element.VerticalAlignment;
        }
        return border;
    }

    /// A capsule: a fully rounded fill. Its radius follows its height.
    public static Border Capsule(this FrameworkElement element, Color fill, Color? stroke = null) =>
        element.Capsule(new SolidColorBrush(fill), stroke);

    public static Border Capsule(this FrameworkElement element, Brush fill, Color? stroke = null)
    {
        var border = element.Background(fill, 999, stroke);
        border.SizeChanged += (_, e) => border.CornerRadius = new CornerRadius(e.NewSize.Height / 2);
        return border;
    }

    public static Border Clip(this FrameworkElement element, double radius)
    {
        var border = new Border { Child = element, CornerRadius = new CornerRadius(radius) };
        return border;
    }

    public static T Opacity<T>(this T element, double opacity) where T : UIElement { element.Opacity = opacity; return element; }

    public static T Visible<T>(this T element, bool visible) where T : UIElement
    {
        element.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        return element;
    }

    public static T Tooltip<T>(this T element, string? text) where T : DependencyObject
    {
        if (!string.IsNullOrEmpty(text)) ToolTipService.SetToolTip(element, text);
        return element;
    }

    public static T Label<T>(this T element, string text) where T : DependencyObject
    {
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(element, text);
        return element;
    }

    /// A click on the element, with a hand cursor.
    public static T OnTap<T>(this T element, Action action) where T : UIElement
    {
        element.Tapped += (_, e) => { e.Handled = true; action(); };
        Hand(element);
        return element;
    }

    public static T OnHover<T>(this T element, Action<bool> changed) where T : UIElement
    {
        element.PointerEntered += (_, _) => changed(true);
        element.PointerExited += (_, _) => changed(false);
        element.PointerCanceled += (_, _) => changed(false);
        return element;
    }

    public static T OnRightTap<T>(this T element, Action<Windows.Foundation.Point> action) where T : UIElement
    {
        element.RightTapped += (_, e) => { e.Handled = true; action(e.GetPosition(element)); };
        return element;
    }

    /// Sets the hand cursor. ProtectedCursor is protected, so this goes through reflection once.
    public static void Hand(UIElement element)
    {
        var property = typeof(UIElement).GetProperty("ProtectedCursor", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
        property?.SetValue(element, InputSystemCursor.Create(InputSystemCursorShape.Hand));
    }

    public static T Cell<T>(this T element, int row = 0, int column = 0, int rowSpan = 1, int columnSpan = 1) where T : FrameworkElement
    {
        Microsoft.UI.Xaml.Controls.Grid.SetRow(element, row);
        Microsoft.UI.Xaml.Controls.Grid.SetColumn(element, column);
        if (rowSpan > 1) Microsoft.UI.Xaml.Controls.Grid.SetRowSpan(element, rowSpan);
        if (columnSpan > 1) Microsoft.UI.Xaml.Controls.Grid.SetColumnSpan(element, columnSpan);
        return element;
    }

    public static Thickness Add(Thickness a, Thickness b) => new(a.Left + b.Left, a.Top + b.Top, a.Right + b.Right, a.Bottom + b.Bottom);

    public static SolidColorBrush B(Color color) => new(color);
}
