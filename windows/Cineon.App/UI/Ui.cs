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

    /// Takes an element that outlives a render (a text box being typed in, a list that keeps its
    /// scroll position, a playing video) out of the tree it was in, so the next render can place it.
    /// An element has one parent at a time.
    public static T Detached<T>(this T element) where T : FrameworkElement
    {
        switch (element.Parent)
        {
            case Panel panel: panel.Children.Remove(element); break;
            case Border border when border.Child == element: border.Child = null; break;
            case ContentControl control when control.Content == element: control.Content = null; break;
            case UserControl user when user.Content == element: user.Content = null; break;
            case Viewbox box when box.Child == element: box.Child = null; break;
            case Microsoft.UI.Xaml.Controls.Primitives.Popup popup when popup.Child == element: popup.Child = null; break;
        }
        return element;
    }

    public static Thickness Add(Thickness a, Thickness b) => new(a.Left + b.Left, a.Top + b.Top, a.Right + b.Right, a.Bottom + b.Bottom);

    public static SolidColorBrush B(Color color) => new(color);

    /// A box of a fixed shape, `heightOverWidth`, filling the width it's offered: SwiftUI's
    /// `.aspectRatio(_, contentMode: .fit)`. Its height is known while it's measured, so lists can lay
    /// it out in one pass.
    public static AspectRatioPanel AspectRatio(UIElement child, double heightOverWidth) => new(heightOverWidth) { Children = { child } };

    /// Takes an element out of its parent, so it can join another layout. An element has one parent,
    /// and adding it to a second one throws. False when it has a parent this can't take it from
    /// (a template's ContentPresenter, a Popup, a repeater), so the caller shouldn't add it elsewhere.
    public static bool Detach(UIElement element)
    {
        var parent = (element as FrameworkElement)?.Parent ?? VisualTreeHelper.GetParent(element);
        switch (parent)
        {
            case null: return true;
            case Panel panel when panel.Children.Contains(element): panel.Children.Remove(element); return true;
            case Border border when ReferenceEquals(border.Child, element): border.Child = null; return true;
            case Viewbox box when ReferenceEquals(box.Child, element): box.Child = null; return true;
            case ContentControl control when ReferenceEquals(control.Content, element): control.Content = null; return true;
            case UserControl user when ReferenceEquals(user.Content, element): user.Content = null; return true;
            default: return false;
        }
    }

    /// SwiftUI's `minimumScaleFactor`: the text gets smaller, down to `minimumScale`, rather than be
    /// cut. The size is worked out in one go whenever the width changes, by measuring copies of the
    /// text, so it never shrinks on screen step by step. It stretches across its container, so its
    /// width doesn't follow its own size.
    public static TextBlock ShrinkToFit(this TextBlock text, double minimumScale)
    {
        var full = text.FontSize;
        var floor = full * minimumScale;
        var width = -1.0;
        text.HorizontalAlignment = HorizontalAlignment.Stretch;
        text.SizeChanged += (_, e) =>
        {
            if (Math.Abs(e.NewSize.Width - width) < 0.5) return;
            width = e.NewSize.Width;
            var size = FittingSize(text, width, full, floor);
            if (Math.Abs(size - text.FontSize) > 0.01) text.FontSize = size;
        };
        return text;
    }

    private static double FittingSize(TextBlock text, double width, double full, double floor)
    {
        if (width <= 0 || string.IsNullOrEmpty(text.Text)) return full;
        TextBlock Copy(string content, double size, bool wrap) => new()
        {
            Text = content,
            FontFamily = text.FontFamily,
            FontWeight = text.FontWeight,
            FontSize = size,
            LineHeight = text.LineHeight,
            TextWrapping = wrap ? TextWrapping.WrapWholeWords : TextWrapping.NoWrap,
            IsTextScaleFactorEnabled = false,
        };
        var words = text.Text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var wraps = text.TextWrapping != TextWrapping.NoWrap;
        var infinite = new Windows.Foundation.Size(double.PositiveInfinity, double.PositiveInfinity);
        bool Fits(double size)
        {
            if (!wraps)
            {
                var line = Copy(text.Text, size, wrap: false);
                line.Measure(infinite);
                return line.DesiredSize.Width <= width + 0.5;
            }
            // A word wider than the line can't wrap, so it would be cut.
            foreach (var word in words)
            {
                var piece = Copy(word, size, wrap: false);
                piece.Measure(infinite);
                if (piece.DesiredSize.Width > width + 0.5) return false;
            }
            if (text.MaxLines <= 0) return true;
            var block = Copy(text.Text, size, wrap: true);
            block.Measure(new Windows.Foundation.Size(width, double.PositiveInfinity));
            var one = Copy("Ag", size, wrap: false);
            one.Measure(infinite);
            return block.DesiredSize.Height <= one.DesiredSize.Height * text.MaxLines + 0.5;
        }
        if (Fits(full)) return full;
        if (!Fits(floor)) return floor;
        double low = floor, high = full;
        for (var i = 0; i < 8; i++)
        {
            var middle = (low + high) / 2;
            if (Fits(middle)) low = middle; else high = middle;
        }
        return low;
    }
}

/// A box of a fixed shape that fills the width it's offered, or the height when only that is known.
/// Children are laid out over the whole box. See `Ui.AspectRatio`.
public sealed class AspectRatioPanel : Panel
{
    public AspectRatioPanel(double heightOverWidth) { Ratio = heightOverWidth; }

    /// Height over width: 1.5 for a poster, 9/16 for a frame.
    public double Ratio { get; }

    private Windows.Foundation.Size Fit(Windows.Foundation.Size available)
    {
        var width = available.Width;
        if (double.IsInfinity(width) || double.IsNaN(width)) width = double.IsInfinity(available.Height) ? 0 : available.Height / Ratio;
        var height = width * Ratio;
        if (!double.IsInfinity(available.Height) && height > available.Height + 0.01)
        {
            height = available.Height;
            width = height / Ratio;
        }
        return new(width, height);
    }

    protected override Windows.Foundation.Size MeasureOverride(Windows.Foundation.Size availableSize)
    {
        var size = Fit(availableSize);
        foreach (var child in Children) child.Measure(size);
        return size;
    }

    protected override Windows.Foundation.Size ArrangeOverride(Windows.Foundation.Size finalSize)
    {
        var size = Fit(finalSize);
        var rect = new Windows.Foundation.Rect((finalSize.Width - size.Width) / 2, (finalSize.Height - size.Height) / 2, size.Width, size.Height);
        foreach (var child in Children) child.Arrange(rect);
        return finalSize;
    }
}

/// SwiftUI's `ViewThatFits(in: .horizontal)`: shows the first child whose ideal width fits, the last
/// one when none does. The others stay in the tree, laid out at no size, hidden and switched off.
public sealed class ViewThatFits : Panel
{
    private int _chosen;

    /// Which child is on screen, after the last layout.
    public int Chosen => _chosen;

    protected override Windows.Foundation.Size MeasureOverride(Windows.Foundation.Size availableSize)
    {
        if (Children.Count == 0) return new(0, 0);
        _chosen = Children.Count - 1;
        for (var i = 0; i < Children.Count; i++)
        {
            Children[i].Measure(new Windows.Foundation.Size(double.PositiveInfinity, availableSize.Height));
            if (Children[i].DesiredSize.Width <= availableSize.Width + 0.5)
            {
                _chosen = i;
                break;
            }
        }
        var chosen = Children[_chosen];
        chosen.Measure(availableSize);
        var width = double.IsInfinity(availableSize.Width) ? chosen.DesiredSize.Width : availableSize.Width;
        return new(width, chosen.DesiredSize.Height);
    }

    protected override Windows.Foundation.Size ArrangeOverride(Windows.Foundation.Size finalSize)
    {
        for (var i = 0; i < Children.Count; i++)
        {
            var child = Children[i];
            var shown = i == _chosen;
            child.Arrange(shown ? new Windows.Foundation.Rect(0, 0, finalSize.Width, finalSize.Height) : new Windows.Foundation.Rect(0, 0, 0, 0));
            child.Opacity = shown ? 1 : 0;
            child.IsHitTestVisible = shown;
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAccessibilityView(child,
                shown ? Microsoft.UI.Xaml.Automation.Peers.AccessibilityView.Content : Microsoft.UI.Xaml.Automation.Peers.AccessibilityView.Raw);
            if (child is Control control) control.IsEnabled = shown;
        }
        return finalSize;
    }
}

/// Two groups on one line, the first at the start and the second at the end, while they fit with
/// `minGap` between them; otherwise the second goes on its own line under the first. Like an HStack
/// with a Spacer inside a ViewThatFits, for groups that must stay the same elements (a text box keeps
/// its focus).
public sealed class FitRow : Panel
{
    private bool _oneLine = true;

    public double MinGap { get; set; } = 20;
    public double LineSpacing { get; set; } = 10;

    protected override Windows.Foundation.Size MeasureOverride(Windows.Foundation.Size availableSize)
    {
        if (Children.Count != 2) return new(0, 0);
        var ideal = new Windows.Foundation.Size(double.PositiveInfinity, availableSize.Height);
        Children[0].Measure(ideal);
        Children[1].Measure(ideal);
        var a = Children[0].DesiredSize;
        var b = Children[1].DesiredSize;
        _oneLine = a.Width + MinGap + b.Width <= availableSize.Width + 0.5;
        var width = double.IsInfinity(availableSize.Width) ? a.Width + MinGap + b.Width : availableSize.Width;
        if (_oneLine) return new(width, Math.Max(a.Height, b.Height));
        var line = new Windows.Foundation.Size(availableSize.Width, double.PositiveInfinity);
        Children[0].Measure(line);
        Children[1].Measure(line);
        return new(width, Children[0].DesiredSize.Height + LineSpacing + Children[1].DesiredSize.Height);
    }

    protected override Windows.Foundation.Size ArrangeOverride(Windows.Foundation.Size finalSize)
    {
        if (Children.Count != 2) return finalSize;
        var a = Children[0].DesiredSize;
        var b = Children[1].DesiredSize;
        if (_oneLine)
        {
            var height = Math.Max(a.Height, b.Height);
            Children[0].Arrange(new(0, (height - a.Height) / 2, a.Width, a.Height));
            Children[1].Arrange(new(Math.Max(a.Width + MinGap, finalSize.Width - b.Width), (height - b.Height) / 2, b.Width, b.Height));
        }
        else
        {
            Children[0].Arrange(new(0, 0, Math.Min(a.Width, finalSize.Width), a.Height));
            Children[1].Arrange(new(0, a.Height + LineSpacing, Math.Min(b.Width, finalSize.Width), b.Height));
        }
        return finalSize;
    }
}

/// Animations, the way the Mac's views animate. Movement is skipped when "Animation effects" is off
/// in Windows settings, as the Mac skips it under Reduce Motion.
public static class Motion
{
    private static Windows.UI.ViewManagement.UISettings? _settings;

    /// Windows' "Animation effects" setting.
    public static bool Enabled
    {
        get
        {
            try { return (_settings ??= new Windows.UI.ViewManagement.UISettings()).AnimationsEnabled; }
            catch (Exception) { return true; }
        }
    }

    /// SwiftUI's spring response is the period of the undamped spring. Composition's Period is
    /// the time for one radian of it.
    public static TimeSpan Period(double response) => TimeSpan.FromSeconds(response / (2 * Math.PI));

    /// SwiftUI's `.easeInOut` and `.easeOut` curves.
    public static Microsoft.UI.Composition.CompositionEasingFunction EaseInOut(Microsoft.UI.Composition.Compositor compositor) =>
        compositor.CreateCubicBezierEasingFunction(new(0.42f, 0), new(0.58f, 1));

    public static Microsoft.UI.Composition.CompositionEasingFunction EaseOut(Microsoft.UI.Composition.Compositor compositor) =>
        compositor.CreateCubicBezierEasingFunction(new(0, 0), new(0.58f, 1));

    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<FrameworkElement, object> Centred = new();

    /// Scales around the element's centre with a spring, like `.scaleEffect` under `.spring(response:dampingFraction:)`.
    /// `animated: false` sets it at once.
    public static void Scale(FrameworkElement element, double scale, double response = 0.3, double damping = 0.75, bool animated = true)
    {
        var visual = Microsoft.UI.Xaml.Hosting.ElementCompositionPreview.GetElementVisual(element);
        if (!Centred.TryGetValue(element, out _))
        {
            Centred.Add(element, true);
            element.SizeChanged += (_, e) => visual.CenterPoint = new System.Numerics.Vector3((float)(e.NewSize.Width / 2), (float)(e.NewSize.Height / 2), 0);
        }
        visual.CenterPoint = new System.Numerics.Vector3((float)(element.ActualWidth / 2), (float)(element.ActualHeight / 2), 0);
        var target = new System.Numerics.Vector3((float)scale, (float)scale, 1);
        if (!animated || !Enabled)
        {
            visual.StopAnimation("Scale");
            visual.Scale = target;
            return;
        }
        var spring = visual.Compositor.CreateSpringVector3Animation();
        spring.FinalValue = target;
        spring.DampingRatio = (float)damping;
        spring.Period = Period(response);
        visual.StartAnimation("Scale", spring);
    }

    /// Shows an element that appears on hover (`if isHovered { ... }.transition(.opacity)`): it takes
    /// its place and fades in, or fades out and then gives its place back.
    public static void Reveal(UIElement element, bool shown, double seconds = 0.12)
    {
        if (shown)
        {
            element.Visibility = Visibility.Visible;
            Fade(element, 1, seconds);
            return;
        }
        Fade(element, 0, seconds);
        if (seconds <= 0 || element.DispatcherQueue is not { } queue)
        {
            element.Visibility = Visibility.Collapsed;
            return;
        }
        var timer = queue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(seconds);
        timer.IsRepeating = false;
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            // Shown again in the meantime.
            if (element.IsHitTestVisible) return;
            element.Visibility = Visibility.Collapsed;
        };
        timer.Start();
    }

    /// Fades an element's own opacity, like a `.transition(.opacity)` under `.easeOut(duration:)`. A
    /// faded-out element stops taking clicks. Fades aren't movement, so they run whatever the setting.
    public static void Fade(UIElement element, double opacity, double seconds = 0.12)
    {
        element.IsHitTestVisible = opacity > 0;
        if (seconds <= 0)
        {
            element.OpacityTransition = null;
            element.Opacity = opacity;
            return;
        }
        element.OpacityTransition ??= new ScalarTransition { Duration = TimeSpan.FromSeconds(seconds) };
        element.Opacity = opacity;
    }
}
