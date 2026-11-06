using Cineon.App.Browser;
using Cineon.Core.Data;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Cineon.App.UI;

/// Floats over a page that's still there but whose video stopped, or where someone asked.
/// The Mac's RescuePanel from RescueView.swift.
public sealed class RescuePanel : Component
{
    private readonly AppModel _app;
    private readonly RescueSession _rescue;
    private readonly BrowserTab _tab;

    public RescuePanel(AppModel app, RescueSession rescue, BrowserTab tab)
    {
        _app = app;
        _rescue = rescue;
        _tab = tab;
        Watch(rescue);
    }

    private string Headline => _rescue.Reason switch
    {
        RescueSession.ReasonKind.VideoFailed => $"The video on {_rescue.Host} stopped",
        RescueSession.ReasonKind.VideoStalled => $"The video on {_rescue.Host} is stuck",
        RescueSession.ReasonKind.PageMissing => $"{_rescue.Name} is gone from {_rescue.Host}",
        RescueSession.ReasonKind.PageFailed => $"{_rescue.Host} didn't load",
        _ => $"Find {_rescue.Name} elsewhere",
    };

    protected override UIElement Render()
    {
        var content = Ui.VStack(10,
            Ui.Text(Headline, Typeface.Title(17), Theme.P.Ink, maxLines: 2),
            RescueSearchBody.Build(_app, _rescue, _tab));
        content.Padding = new Thickness(16);
        content.Width = 380;
        return content.GlassPanel(16);
    }
}

/// What's being tried, what turned up, and the choice between them. Rebuilt by whoever holds it
/// when the rescue changes.
public static class RescueSearchBody
{
    public static StackPanel Build(AppModel app, RescueSession rescue, BrowserTab tab)
    {
        var p = Theme.P;
        var engine = app.Session.Rescue;
        var isWorking = rescue.Stage != RescueSession.StageKind.Finished;
        var statusRow = Ui.HStack(8,
            isWorking ? new ProgressRing { IsActive = true, Width = 16, Height = 16 } : null,
            Ui.Text(Status(rescue), Typeface.Ui(13), p.Ink2));
        var body = Ui.VStack(10, statusRow);

        if (rescue.Options.Count > 0)
        {
            var list = Ui.VStack(2);
            foreach (var option in rescue.Options.Take(5)) list.Children.Add(OptionRow(app, rescue, tab, option));
            body.Children.Add(list);
        }

        if (rescue.Ref.IsEpisode && rescue.Options.Count > 0)
        {
            var jump = rescue.ResumePoint is { } point ? $" and Cineon jumps to {Timecode.String(point)}" : "";
            body.Children.Add(Ui.Text(
                $"These open the series' page. Choose {rescue.Ref.LongLabel.ToLowerInvariant()} there{jump}.",
                Typeface.Ui(12), p.Ink3));
        }

        var buttons = Ui.HStack(8);
        if (rescue.Stage == RescueSession.StageKind.Finished && rescue.Options.Count == 0)
        {
            buttons.Children.Add(Buttons.Silver("Search the web", () =>
            {
                var query = $"{rescue.Name} {(rescue.Year is { } year ? year.ToString(System.Globalization.CultureInfo.InvariantCulture) : "")} watch online";
                if (app.Settings.SearchEngine.Url(query) is { } url)
                {
                    engine.Stop(tab);
                    tab.Load(url);
                }
            }));
        }
        if (tab.Failure is not null)
        {
            buttons.Children.Add(Buttons.Outline("Try again", () =>
            {
                engine.Stop(tab);
                tab.Reload();
            }));
        }
        buttons.Children.Add(Buttons.Outline(rescue.Countdown is not null ? "Stay here" : "Close", () =>
        {
            if (rescue.Countdown is not null) engine.StopCountdown(tab);
            else engine.Dismiss(tab);
        }));
        body.Children.Add(buttons);
        return body;
    }

    private static string Status(RescueSession rescue)
    {
        if (rescue.Countdown is { } countdown && rescue.Options.FirstOrDefault() is { } first)
        {
            return $"Opening on {first.SiteName} in {countdown}.";
        }
        return rescue.Stage switch
        {
            RescueSession.StageKind.Mirrors => rescue.MirrorsTotal > 0
                ? $"Trying {rescue.MirrorsTotal} other addresses for {rescue.Host}."
                : $"Looking for {rescue.Name}.",
            RescueSession.StageKind.Searching => $"Searching your sites for {rescue.Name}, {rescue.SitesDone} of {rescue.SitesTotal}.",
            _ when rescue.Options.Count > 0 => rescue.Options.Count == 1
                ? "Found it on one of your sites."
                : $"Found it on {rescue.Options.Count} of your sites.",
            _ when rescue.SitesTotal == 0 => "You have no other sites to look on.",
            _ => $"{rescue.Name} isn't on your other sites.",
        };
    }

    private static string CarryOn(RescueSession rescue)
    {
        if (rescue.Ref.IsEpisode) return "Open";
        return rescue.ResumePoint is { } point ? $"Carry on at {Timecode.String(point)}" : "Open";
    }

    private static FrameworkElement OptionRow(AppModel app, RescueSession rescue, BrowserTab tab, RescueSession.Option option)
    {
        var p = Theme.P;
        var take = Buttons.Silver(CarryOn(rescue), () => app.Session.Rescue.Take(option, tab));
        take.Tooltip(option.IsStrong ? "Looks like the same film" : "Might be the same film. Check once it opens.");
        var row = Ui.Row(10,
            Posters.SiteIcon(option.SiteName, option.SiteIcon, 20),
            Ui.VStack(1,
                Ui.Line(option.SiteName, Typeface.Ui(13, Typeface.Medium), p.Ink),
                Ui.Line(option.Label, Typeface.Ui(12), p.Ink3)).Fill(),
            take);
        row.Padding = new Thickness(0, 5, 0, 5);
        return row;
    }
}
