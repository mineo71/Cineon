using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Windows.System;
using Windows.UI;

namespace Cineon.App.UI;

/// Text fields, checkboxes, spinners, pop-up pickers and menus, drawn in the Mac app's quiet style
/// rather than Fluent's: no accent colour, no underline, the palette's raised fills.
public static class Inputs
{
    // MARK: Text

    /// The Mac's `InputField` (Sheets.swift): a plain field on a raised fill, 38 tall, radius 9.
    /// Keep the box across renders (see `Ui.Detached`), or typing loses its focus and caret.
    public static TextBox Field(string placeholder, string text = "", Action<string>? changed = null, Action? submit = null,
        double size = 14, bool focus = false)
    {
        var box = new TextBox
        {
            PlaceholderText = placeholder,
            Text = text,
            FontFamily = Typeface.Ui(size).Family,
            FontSize = size,
            IsSpellCheckEnabled = false,
            IsTextPredictionEnabled = false,
            IsTextScaleFactorEnabled = false,
            MinHeight = 38,
            MinWidth = 0,
            Padding = new Thickness(12, 9, 12, 8),
            VerticalContentAlignment = VerticalAlignment.Center,
            CornerRadius = new CornerRadius(9),
            BorderThickness = new Thickness(0),
        };
        Paint(box);
        box.Label(placeholder);
        if (changed is not null) box.TextChanged += (_, _) => changed(box.Text);
        if (submit is not null)
        {
            box.KeyDown += (_, e) =>
            {
                if (e.Key != VirtualKey.Enter) return;
                e.Handled = true;
                submit();
            };
        }
        if (focus) FocusWhenLoaded(box);
        return box;
    }

    /// Puts the palette's colours on a field. Call again after the theme changes.
    public static void Paint(TextBox box)
    {
        var p = Theme.P;
        var fill = new SolidColorBrush(p.Raised);
        var ink = new SolidColorBrush(p.Ink);
        var placeholder = new SolidColorBrush(p.Ink3);
        var clear = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        foreach (var state in new[] { "", "PointerOver", "Focused", "Disabled" })
        {
            box.Resources["TextControlBackground" + state] = fill;
            box.Resources["TextControlForeground" + state] = ink;
            box.Resources["TextControlPlaceholderForeground" + state] = placeholder;
            box.Resources["TextControlBorderBrush" + state] = clear;
        }
        box.Resources["TextControlElevationBorderBrush"] = clear;
        box.Resources["TextControlElevationBorderFocusedBrush"] = clear;
        box.Resources["TextControlBorderThemeThickness"] = new Thickness(0);
        box.Resources["TextControlBorderThemeThicknessFocused"] = new Thickness(0);
        box.Resources["TextControlButtonForeground"] = new SolidColorBrush(p.Ink3);
        box.Resources["TextControlSelectionHighlightColor"] = new SolidColorBrush(Palette.WithOpacity(p.Ink, 0.3));
        box.Foreground = ink;
        box.Background = fill;
        box.PlaceholderForeground = placeholder;
        box.SelectionHighlightColor = new SolidColorBrush(Palette.WithOpacity(p.Ink, 0.3));
    }

    /// Focuses the element once it's on screen, like SwiftUI's `focused = true` in onAppear.
    public static void FocusWhenLoaded(Control control)
    {
        void Loaded(object sender, RoutedEventArgs e)
        {
            control.Loaded -= Loaded;
            control.DispatcherQueue?.TryEnqueue(() => control.Focus(FocusState.Programmatic));
        }
        control.Loaded += Loaded;
    }

    // MARK: Choices

    /// A checkbox in the chrome's silver, not the system accent: the Mac's `.tint` on its toggles.
    public static CheckBox Checkbox(bool isOn, Action<bool> changed, object content)
    {
        var p = Theme.P;
        var box = new CheckBox
        {
            IsChecked = isOn,
            Content = content,
            MinWidth = 0,
            MinHeight = 0,
            Padding = new Thickness(8, 0, 0, 0),
            VerticalContentAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
        };
        var tint = new SolidColorBrush(p.IsDark ? Palette.Grey(0.82) : Microsoft.UI.Colors.Black);
        var glyph = new SolidColorBrush(p.IsDark ? Microsoft.UI.Colors.Black : Microsoft.UI.Colors.White);
        foreach (var state in new[] { "", "PointerOver", "Pressed" })
        {
            box.Resources["CheckBoxCheckBackgroundFillChecked" + state] = tint;
            box.Resources["CheckBoxCheckBackgroundStrokeChecked" + state] = tint;
            box.Resources["CheckBoxCheckGlyphForegroundChecked" + state] = glyph;
        }
        box.Checked += (_, _) => changed(true);
        box.Unchecked += (_, _) => changed(false);
        return box;
    }

    /// A small pop-up button, like the Mac's `Picker` with `.controlSize(.small)`: the choice and a
    /// chevron, opening a menu of the options.
    public static Button Picker<T>(IReadOnlyList<(T Value, string Label)> options, T selected, Action<T> changed, bool enabled = true)
    {
        var p = Theme.P;
        var label = options.FirstOrDefault(o => EqualityComparer<T>.Default.Equals(o.Value, selected)).Label ?? "";
        var content = Ui.HStack(6,
            Ui.Line(label, Typeface.Ui(12), p.Ink),
            Ui.Icon(Glyph.ChevronDown, 8, p.Ink2));
        Button? button = null;
        button = Buttons.Make(content, () =>
        {
            if (button is null) return;
            var menu = new MenuFlyout();
            foreach (var option in options)
            {
                var value = option.Value;
                var item = new ToggleMenuFlyoutItem { Text = option.Label, IsChecked = EqualityComparer<T>.Default.Equals(value, selected) };
                item.Click += (_, _) => changed(value);
                menu.Items.Add(item);
            }
            menu.ShowAt(button, new FlyoutShowOptions { Placement = FlyoutPlacementMode.BottomEdgeAlignedLeft });
        }, (b, hovered, pressed) =>
        {
            b.Background = new SolidColorBrush(hovered || pressed ? p.Raised2 : p.Raised);
        }, enabled);
        button.Padding = new Thickness(9, 3, 7, 4);
        button.CornerRadius = new CornerRadius(6);
        button.BorderBrush = new SolidColorBrush(p.Line);
        button.BorderThickness = new Thickness(0.5);
        return button;
    }

    /// The Mac's small `ProgressView()`: an indeterminate ring in the ink's grey.
    public static ProgressRing Spinner(double size = 16, Color? color = null) => new()
    {
        IsActive = true,
        IsIndeterminate = true,
        Width = size,
        Height = size,
        MinWidth = 0,
        MinHeight = 0,
        Foreground = new SolidColorBrush(color ?? Theme.P.Ink2),
        Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
    };

    // MARK: Menus

    /// A plain button that opens a menu, like SwiftUI's `Menu` with `.menuStyle(.button)` and the
    /// plain button style. The menu is built fresh each time, so its ticks are current.
    public static Button MenuButton(UIElement content, Action<IList<MenuFlyoutItemBase>> fill, string help, Thickness? padding = null)
    {
        Button? button = null;
        button = Buttons.Make(content, () =>
        {
            if (button is not null) ShowMenu(button, fill);
        }, help: help);
        button.Padding = padding ?? new Thickness(0);
        return button;
    }

    /// Shows a menu built by `fill` at the anchor, or at a point on it (a right click).
    public static void ShowMenu(FrameworkElement anchor, Action<IList<MenuFlyoutItemBase>> fill, Windows.Foundation.Point? at = null)
    {
        if (anchor.XamlRoot is null) return;
        var menu = new MenuFlyout();
        fill(menu.Items);
        if (menu.Items.Count == 0) return;
        var options = new FlyoutShowOptions { Placement = FlyoutPlacementMode.BottomEdgeAlignedRight };
        if (at is { } point) options.Position = point;
        menu.ShowAt(anchor, options);
    }

    public static MenuFlyoutItem Item(string text, Action run, bool enabled = true)
    {
        var item = new MenuFlyoutItem { Text = text, IsEnabled = enabled };
        item.Click += (_, _) => run();
        return item;
    }

    /// A choice in a menu, ticked when it's the current one.
    public static ToggleMenuFlyoutItem Choice(string text, bool isChosen, Action run)
    {
        var item = new ToggleMenuFlyoutItem { Text = text, IsChecked = isChosen };
        item.Click += (_, _) => run();
        return item;
    }

    /// A section's title inside a menu, like an inline Picker's label.
    public static MenuFlyoutItem Header(string text) => new() { Text = text, IsEnabled = false };

    public static MenuFlyoutSeparator Separator() => new();
}
