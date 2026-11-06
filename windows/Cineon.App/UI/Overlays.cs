using Cineon.Core.Data;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Windows.UI;

namespace Cineon.App.UI;

/// What shows over the pages: the title card, sheets, the command bar, the profile picker and the
/// splash. Ports register their views here, like `Pages`; until one does, its slot shows a placeholder.
/// Each is built once when it opens and kept until it closes, so a sheet's text survives the app
/// changing underneath it.
public static class Overlays
{
    /// The title detail card for `app.DetailTitleId` (TitleDetailView).
    public static UIElement? TitleDetail(AppModel app, Title title) => null;

    /// One of the sheets (Sheets.swift's SheetHost: AddSiteSheet, EditSiteSheet, AddTitleSheet,
    /// RelinkSheet, ImportSheet, NewChallengeSheet).
    public static UIElement? Sheet(AppModel app, AppSheet sheet) => sheet switch
    {
        _ => null,
    };

    /// The command bar (CommandBar.swift). It places itself; the host only dims behind it.
    public static UIElement? CommandBar(AppModel app) => null;

    /// "Who's watching?" (ProfilePicker.swift, in UI/Pages/ProfilePickerView.cs).
    public static UIElement ProfilePicker(AppModel app) => new ProfilePickerView(app);

    /// The launch animation (Splash.swift's SplashView). It sets `app.SplashVisible = false` when it's
    /// done; with none registered the splash is skipped.
    public static UIElement? Splash(AppModel app) => null;

    // TODO(after core merge): the series download proposal (SeriesDownloadSheet), between the sheet and
    // the command bar, shown while `app.Session.Seasons.Proposal` is set and dismissed with
    // `app.Session.Seasons.Decline()`.
}

/// Hosts the overlays over the whole window, in the Mac's order (RootView's Overlays): title card,
/// sheet, command bar, toasts, profile picker, reel change, splash.
public sealed class OverlayHost : Grid
{
    private readonly AppModel _app;
    private readonly Layer _detail = new(new PopupThemeTransition());
    private readonly Layer _sheet = new(new PopupThemeTransition());
    private readonly Layer _commandBar = new(new PopupThemeTransition());
    private readonly Layer _picker = new(new ContentThemeTransition());
    private readonly Layer _reel = new(null);
    private readonly Layer _splash = new(null);

    public OverlayHost(AppModel app)
    {
        _app = app;
        Children.Add(_detail.Root);
        Children.Add(_sheet.Root);
        Children.Add(_commandBar.Root);
        Children.Add(new ToastHost(app));
        Children.Add(_picker.Root);
        Children.Add(_reel.Root);
        Children.Add(_splash.Root);
        app.Changed += Update;
        Loaded += (_, _) => Update();
    }

    private void Update()
    {
        var app = _app;
        var title = app.DetailTitleId is long id && app.Library.Titles.TryGetValue(id, out var found) ? found : null;
        _detail.Show(title?.Id, () => Dimmed(0.5, () => app.DetailTitleId = null,
            Overlays.TitleDetail(app, title!) ?? Placeholder(title!.Name, () => app.DetailTitleId = null)));

        var sheet = app.Sheet;
        _sheet.Show(sheet, () => Dimmed(0.5, () => app.Sheet = null,
            Overlays.Sheet(app, sheet!) ?? Placeholder(sheet!.Id, () => app.Sheet = null)));

        _commandBar.Show(app.IsCommandBarVisible ? true : null, () => Dimmed(0.3, app.CloseCommandBar,
            Overlays.CommandBar(app) ?? Placeholder("Search films and sites", app.CloseCommandBar)));

        _picker.Show(app.IsProfilePickerVisible ? true : null, () => Overlays.ProfilePicker(app));

        _reel.Show(app.IsChangingReel ? true : null, () => new ReelChange());

        if (!app.SplashVisible)
        {
            _splash.Show(null, null);
        }
        else if (!_splash.IsShown)
        {
            if (Overlays.Splash(app) is { } splash) _splash.Show(true, () => splash);
            else DispatcherQueue?.TryEnqueue(() => app.SplashVisible = false);
        }
    }

    /// The Mac's DimmedBackdrop under an overlay: a click outside it closes it.
    private static Grid Dimmed(double strength, Action dismiss, UIElement content)
    {
        var backdrop = new Border { Background = new SolidColorBrush(Color.FromArgb((byte)Math.Round(strength * 255), 0, 0, 0)) };
        backdrop.Tapped += (_, e) => { e.Handled = true; dismiss(); };
        return Ui.ZStack(backdrop, content);
    }

    /// Stands in for an overlay that hasn't been ported yet.
    private static UIElement Placeholder(string name, Action close) => new Live(() =>
    {
        var p = Theme.P;
        return Ui.VStack(10,
                Ui.Text(name, Typeface.Title(24)),
                Ui.Text("This is being ported from the Mac app.", Typeface.Ui(13), p.Ink3),
                Buttons.Outline("Close", close).Margin(0, 8, 0, 0))
            .Padding(28, 24)
            .Size(width: 440)
            .GlassPanel(20)
            .Centered();
    });

    /// One overlay's slot. Builds its content when the key changes and keeps it while the key stays.
    private sealed class Layer
    {
        private object? _key;

        public Layer(Transition? transition)
        {
            if (transition is not null) Root.ChildrenTransitions = new TransitionCollection { transition };
        }

        public Grid Root { get; } = new() { Visibility = Visibility.Collapsed };

        public bool IsShown => _key is not null;

        public void Show(object? key, Func<UIElement>? build)
        {
            if (key is null || build is null)
            {
                if (_key is null) return;
                _key = null;
                Root.Children.Clear();
                Root.Visibility = Visibility.Collapsed;
                return;
            }
            if (Equals(key, _key)) return;
            _key = key;
            Root.Children.Clear();
            Root.Children.Add(build());
            Root.Visibility = Visibility.Visible;
        }
    }
}

/// Short messages at the bottom of the window, like the Mac's ToastHost.
public sealed class ToastHost : Component
{
    private readonly AppModel _app;

    public ToastHost(AppModel app)
    {
        _app = app;
        Watch(app.Toasts);
        HorizontalAlignment = HorizontalAlignment.Center;
        VerticalAlignment = VerticalAlignment.Bottom;
    }

    protected override UIElement Render()
    {
        var p = Theme.P;
        var holder = new Grid
        {
            ChildrenTransitions = new TransitionCollection { new EntranceThemeTransition { FromVerticalOffset = 24, IsStaggeringEnabled = false } },
        };
        if (_app.Toasts.Current is not { } toast) return holder;
        var message = Ui.Text(toast.Message, Typeface.Ui(13, Typeface.Medium), p.Ink, maxLines: 2).MaxSize(width: 620);
        var row = Ui.HStack(14, message);
        if (toast.ActionTitle is { } title && toast.Run is { } run)
        {
            var label = Ui.Line(title, Typeface.Ui(13, Typeface.Semibold), p.Ink);
            label.TextDecorations = Windows.UI.Text.TextDecorations.Underline;
            row.Children.Add(Buttons.Make(label, () =>
            {
                run();
                _app.Toasts.Dismiss();
            }));
        }
        var panel = row.Padding(18, 11).GlassPanel(22);
        panel.Margin = new Thickness(0, 0, 0, 26);
        holder.Children.Add(panel);
        return holder;
    }
}

/// Profile change: the reels swap in the dark, the way a projectionist changes over. The Mac's
/// ReelChange from Splash.swift: the logo turns once on the canvas.
public sealed class ReelChange : Grid
{
    public ReelChange()
    {
        Background = new SolidColorBrush(Theme.P.Canvas);
        var logo = Images.LogoMark(92);
        logo.HorizontalAlignment = HorizontalAlignment.Center;
        logo.VerticalAlignment = VerticalAlignment.Center;
        var rotation = new RotateTransform();
        logo.RenderTransform = rotation;
        logo.RenderTransformOrigin = new Windows.Foundation.Point(0.5, 0.5);
        Children.Add(logo);
        Loaded += (_, _) =>
        {
            if (!new Windows.UI.ViewManagement.UISettings().AnimationsEnabled) return;
            var turn = new DoubleAnimation
            {
                From = 0,
                To = 360,
                Duration = new Duration(TimeSpan.FromSeconds(0.75)),
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
            };
            Storyboard.SetTarget(turn, rotation);
            Storyboard.SetTargetProperty(turn, "Angle");
            var story = new Storyboard();
            story.Children.Add(turn);
            story.Begin();
        };
    }
}

public static class Glass
{
    /// The Mac's `glassPanel(cornerRadius:)` for anything floating over the app: the card colour,
    /// mostly opaque over in-app acrylic, a hairline edge and a soft shadow.
    public static Border GlassPanel(this FrameworkElement content, double radius = 20)
    {
        var p = Theme.P;
        return new Border
        {
            Child = content,
            CornerRadius = new CornerRadius(radius),
            Background = new AcrylicBrush
            {
                TintColor = p.CardFill,
                TintOpacity = 0.72,
                FallbackColor = Palette.WithOpacity(p.CardFill, 0.94),
            },
            BorderBrush = new SolidColorBrush(p.Line),
            BorderThickness = new Thickness(1),
            Shadow = new ThemeShadow(),
            Translation = new System.Numerics.Vector3(0, 0, 32),
            HorizontalAlignment = content.HorizontalAlignment,
            VerticalAlignment = content.VerticalAlignment,
        };
    }
}
