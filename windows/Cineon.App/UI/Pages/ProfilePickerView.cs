using System.Numerics;
using Cineon.Core.Data;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;
using VirtualKey = Windows.System.VirtualKey;

namespace Cineon.App.UI;

/// "Who's watching?" Each person's card is the poster of the last thing they watched, so the picker
/// is a little portrait of the family's taste, and the only colour on screen is film.
/// ProfilePicker.swift. Esc closes it through AppModel.HandleEscape.
internal sealed class ProfilePickerView : KeyedComponent
{
    private readonly AppModel _app;
    private bool _isAdding;
    private bool _isEditing;
    private TextBox? _name;
    private Palette? _namePalette;
    private bool _focusName;

    public ProfilePickerView(AppModel app)
    {
        _app = app;
        WatchKeyed(Changes.Of(app.Profiles));
        WatchKeyed(Changes.Of(app));
    }

    protected override object? Key()
    {
        var session = _app.Session;
        var people = string.Join("\n", _app.Profiles.Profiles.Select(p => $"{p.Id}\t{p.Name}\t{p.LastPosterUrl?.OriginalString}"));
        return (people, session.Profile.Id, session.LatestPosterUrl?.OriginalString, _isAdding, _isEditing);
    }

    protected override UIElement Render()
    {
        Rendered();
        var p = Theme.P;
        var profiles = _app.Profiles.Profiles;
        var cards = Ui.HStack(24);
        foreach (var profile in profiles) cards.Children.Add(Card(profile, profiles.Count));
        cards.Children.Add(AddCard());
        foreach (var child in cards.Children) ((FrameworkElement)child).VerticalAlignment = VerticalAlignment.Top;

        var buttons = Ui.HStack(10,
            profiles.Count > 1 ? Buttons.Outline(_isEditing ? "Done" : "Edit profiles", () => { _isEditing = !_isEditing; Check(); }) : null,
            Buttons.Outline("Close", () => _app.IsProfilePickerVisible = false));

        var title = Ui.Line("Who's watching?", Typeface.Title(38), p.Ink);
        title.TextTrimming = TextTrimming.None;
        var content = Ui.VStack(34, title.Centered(), cards.Centered(), buttons.Centered());
        content.Padding = new Thickness(40);
        content.HorizontalAlignment = HorizontalAlignment.Center;
        content.VerticalAlignment = VerticalAlignment.Center;
        return Ui.ZStack(new Border { Background = new SolidColorBrush(p.Canvas) }, content);
    }

    private FrameworkElement Card(Profile profile, int count)
    {
        var p = Theme.P;
        var session = _app.Session;
        var isCurrent = session.Profile.Id == profile.Id;
        var posterUrl = isCurrent ? session.LatestPosterUrl ?? profile.LastPosterUrl : profile.LastPosterUrl;

        var placeholder = new Grid { Background = new SolidColorBrush(p.Raised), Children = { People.ProfileAvatar(profile, 64).Centered() } };
        var image = new RemoteImage(posterUrl, placeholder, fill: true, cornerRadius: 8) { Width = 140, Height = 210 }.ClipRounded(8);
        var face = new Grid { Width = 140, Height = 210, Children = { image } };
        if (posterUrl is not null)
        {
            var badge = People.ProfileAvatar(profile, 30);
            badge.HorizontalAlignment = HorizontalAlignment.Left;
            badge.VerticalAlignment = VerticalAlignment.Bottom;
            badge.Margin = new Thickness(8);
            face.Children.Add(badge);
        }
        // Hovering lifts the card with the Mac's spring(response: 0.3, dampingFraction: 0.72).
        face.PointerEntered += (_, _) => Spring(face, 1.03f);
        face.PointerExited += (_, _) => Spring(face, 1);
        face.PointerCanceled += (_, _) => Spring(face, 1);
        var button = Buttons.Make(face, () => _app.SwitchProfile(profile)).Label(profile.Name);

        var name = Ui.Line(profile.Name, Typeface.Ui(14, isCurrent ? Typeface.Semibold : Microsoft.UI.Text.FontWeights.Normal), isCurrent ? p.Ink : p.Ink2);
        name.HorizontalAlignment = HorizontalAlignment.Center;
        name.MaxWidth = 140;

        Button? delete = null;
        if (_isEditing && count > 1 && !isCurrent)
        {
            delete = Buttons.Outline("Delete", () => _ = Delete(profile, button));
            delete.HorizontalAlignment = HorizontalAlignment.Center;
        }
        return Ui.VStack(10, button, name, delete);
    }

    private async Task Delete(Profile profile, FrameworkElement anchor)
    {
        var confirmed = await SocialKit.ConfirmAsync(anchor,
            $"Delete {profile.Name}'s profile?",
            "Their library, timeline and site logins are removed for good.",
            "Delete profile and all its data");
        if (confirmed) _app.Profiles.Delete(profile.Id);
    }

    private FrameworkElement AddCard()
    {
        var p = Theme.P;
        FrameworkElement top;
        if (_isAdding)
        {
            var field = NameField();
            var add = Buttons.Silver("Add", AddProfile);
            add.HorizontalAlignment = HorizontalAlignment.Center;
            var form = Ui.VStack(8, field, add);
            form.VerticalAlignment = VerticalAlignment.Center;
            top = new Grid { Width = 140, Height = 210, Children = { form } };
            if (_focusName)
            {
                _focusName = false;
                void Focus(object sender, RoutedEventArgs e)
                {
                    field.Loaded -= Focus;
                    field.Focus(FocusState.Programmatic);
                }
                if (field.IsLoaded) field.Focus(FocusState.Programmatic);
                else field.Loaded += Focus;
            }
        }
        else
        {
            top = Buttons.Make(new Border
            {
                Width = 140,
                Height = 210,
                CornerRadius = new CornerRadius(8),
                BorderBrush = new SolidColorBrush(p.Line),
                BorderThickness = new Thickness(1),
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                Child = Ui.Icon(Glyph.Add, 24, p.Ink2).Centered(),
            }, () =>
            {
                _isAdding = true;
                _focusName = true;
                Check();
            }).Label("Add a profile");
        }
        var label = Ui.Line("Add someone", Typeface.Ui(14), p.Ink3);
        label.HorizontalAlignment = HorizontalAlignment.Center;
        return Ui.VStack(10, top, label);
    }

    /// The same box across rebuilds while the theme stays, so a half-typed name survives.
    private TextBox NameField()
    {
        if (_name is not null && ReferenceEquals(_namePalette, Theme.P))
        {
            SocialKit.Detach(_name);
            return _name;
        }
        var box = SocialKit.Field("Name", Typeface.Ui(14), Theme.P.Raised, 8, 0, new Thickness(8));
        box.TextAlignment = TextAlignment.Center;
        box.Text = _name?.Text ?? "";
        box.KeyDown += (_, e) =>
        {
            if (e.Key != VirtualKey.Enter) return;
            e.Handled = true;
            AddProfile();
        };
        _name = box;
        _namePalette = Theme.P;
        return box;
    }

    private void AddProfile()
    {
        var name = (_name?.Text ?? "").Trim();
        if (name.Length == 0) return;
        var profile = _app.Profiles.Add(name);
        if (_name is not null) _name.Text = "";
        _isAdding = false;
        _app.SwitchProfile(profile);
        Check();
    }

    private static void Spring(FrameworkElement element, float scale)
    {
        var visual = ElementCompositionPreview.GetElementVisual(element);
        visual.CenterPoint = new Vector3((float)element.ActualWidth / 2, (float)element.ActualHeight / 2, 0);
        var target = new Vector3(scale, scale, 1);
        if (!SocialKit.AnimationsEnabled)
        {
            visual.StopAnimation("Scale");
            visual.Scale = target;
            return;
        }
        var spring = visual.Compositor.CreateSpringVector3Animation();
        spring.FinalValue = target;
        spring.DampingRatio = 0.72f;
        // SwiftUI's response is the undamped period; Composition's Period is that over 2π.
        spring.Period = TimeSpan.FromSeconds(0.3 / (2 * Math.PI));
        visual.StartAnimation("Scale", spring);
    }
}
