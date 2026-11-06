using System.Text.RegularExpressions;
using Cineon.App.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Cineon.App.UI;

/// Shows the updater's news: an offered version as a dialog with its release notes (what Sparkle
/// shows on the Mac), and anything it has to say as a toast.
public static partial class UpdatePrompt
{
    private static bool _isShowing;

    /// Connects the updater to the window and starts its daily check. Call once, after the window is up.
    public static void Attach(MainWindow window, AppModel app)
    {
        var updater = Updater.Shared;
        var queue = window.DispatcherQueue;
        updater.Said += message => queue.TryEnqueue(() => app.Toasts.Show(message));
        updater.Changed += () => queue.TryEnqueue(() => _ = ShowOfferAsync(window));
        updater.Start();
    }

    private static async Task ShowOfferAsync(MainWindow window)
    {
        var updater = Updater.Shared;
        if (_isShowing || updater.Offer is not { } offer || window.Content?.XamlRoot is not { } root) return;
        _isShowing = true;
        try
        {
            var p = Theme.P;
            var version = offer.TargetFullRelease.Version.ToString();
            var body = Ui.VStack(12,
                Ui.Text($"Cineon {version} is now available—you have {updater.Version}. Would you like to install it now?", Typeface.Ui(14), p.Ink));
            var notes = PlainNotes(offer.TargetFullRelease.NotesMarkdown);
            if (notes.Length > 0)
            {
                body.Children.Add(Ui.Text("Release Notes:", Typeface.Ui(13, Typeface.Semibold), p.Ink));
                var text = Ui.Text(notes, Typeface.Ui(13), p.Ink2);
                text.IsTextSelectionEnabled = true;
                body.Children.Add(new ScrollViewer { Content = text, MaxHeight = 280, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
            }
            var dialog = new ContentDialog
            {
                XamlRoot = root,
                RequestedTheme = p.IsDark ? ElementTheme.Dark : ElementTheme.Light,
                Title = "A new version of Cineon is available!",
                Content = body,
                PrimaryButtonText = "Install and Relaunch",
                SecondaryButtonText = "Skip This Version",
                CloseButtonText = "Remind Me Later",
                DefaultButton = ContentDialogButton.Primary,
            };
            var choice = await dialog.ShowAsync();
            switch (choice)
            {
                case ContentDialogResult.Primary:
                    await updater.InstallOfferAsync();
                    break;
                case ContentDialogResult.Secondary:
                    updater.SkipOffer();
                    break;
                default:
                    updater.RemindLater();
                    break;
            }
        }
        catch (Exception error)
        {
            // Another dialog was already open. The offer stays, and shows again on the next change.
            CrashLog.Write("update dialog", error);
        }
        finally
        {
            _isShowing = false;
        }
    }

    /// Release notes are Markdown. The dialog shows them as plain text: headings and emphasis
    /// marks dropped, list items as bullets.
    public static string PlainNotes(string? markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown)) return "";
        var lines = markdown.Replace("\r\n", "\n").Split('\n').Select(line =>
        {
            var text = Heading().Replace(line, "");
            text = Bullet().Replace(text, "$1• ");
            text = Emphasis().Replace(text, "");
            return Link().Replace(text, "$1");
        });
        return string.Join("\n", lines).Trim();
    }

    [GeneratedRegex(@"^\s{0,3}#{1,6}\s*")]
    private static partial Regex Heading();

    [GeneratedRegex(@"^(\s*)[-*+]\s+")]
    private static partial Regex Bullet();

    [GeneratedRegex(@"(\*\*|__|`)")]
    private static partial Regex Emphasis();

    [GeneratedRegex(@"\[([^\]]+)\]\([^)]+\)")]
    private static partial Regex Link();
}
