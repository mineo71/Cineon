using System.Numerics;
using Cineon.App.Browser;
using Cineon.Core.Data;
using Cineon.Core.Together;
using Microsoft.Graphics.Canvas.Effects;
using Microsoft.UI.Composition;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using VirtualKey = Windows.System.VirtualKey;

namespace Cineon.App.UI;

/// Watching with friends: parties, challenges and lists shared by code. TogetherView.swift.
public sealed class TogetherPage : UserControl
{
    public TogetherPage(AppModel app)
    {
        IsTabStop = false;
        var together = app.Session.Together;
        var column = Ui.VStack(36, new TogetherHeader(app));
        if (together.IsAvailable)
        {
            column.Children.Add(new PartySection(app));
            column.Children.Add(new ChallengesSection(app));
            column.Children.Add(new SharesSection(app));
        }
        else
        {
            // The Mac names Info.plist's CineonTogetherURL; Windows reads the environment.
            column.Children.Add(new Live(() => Ui.Text(
                "Together needs a server address, and this build has none. Set the CINEON_TOGETHER_URL environment variable.",
                Typeface.Ui(13), Theme.P.Ink2)));
        }
        Content = new PageScroll(column, 760, new Thickness(32, 34, 32, 60), centred: false, padInside: false);
        Loaded += (_, _) => _ = together.RefreshChallengesAsync();
    }

    /// The party's place on the Mac's `TogetherModel.minimumDuration`: shorter videos are ads.
    internal static BrowserTab? Playing(AppModel app)
    {
        var tab = app.Browser.PlayingTab ?? app.Browser.Selected;
        return tab?.Media is { } media && media.Duration >= TogetherModel.MinimumDuration ? tab : null;
    }

    /// A poster's colours behind a card, blurred into light. The only colour comes from the film.
    internal static Grid Stage(Uri? poster, FrameworkElement content)
    {
        var p = Theme.P;
        var back = new Grid { Background = new SolidColorBrush(p.Raised) };
        if (poster is not null) back.Children.Add(new BlurredImage(poster, blur: 50, saturation: 1.4, opacity: p.IsDark ? 0.35 : 0.25));
        back.ClipRounded(18);
        var edge = new Border
        {
            CornerRadius = new CornerRadius(18),
            BorderBrush = new SolidColorBrush(p.Line),
            BorderThickness = new Thickness(SocialKit.Hair),
            IsHitTestVisible = false,
        };
        return new Grid { Children = { back, content, edge } };
    }
}

/// The title, what Together is, and the box for a friend's code.
internal sealed class TogetherHeader : KeyedComponent
{
    private readonly TogetherModel _together;
    private TextBox? _box;
    private Palette? _boxPalette;
    private Button? _open;

    public TogetherHeader(AppModel app)
    {
        _together = app.Session.Together;
        WatchKeyed(Changes.Of(_together));
    }

    protected override object? Key() => _together.IsWorking;

    private bool CanOpen => ShareCode.Normalize(_box?.Text ?? "").Length == 6 && !_together.IsWorking;

    protected override UIElement Render()
    {
        Rendered();
        var p = Theme.P;
        var stack = Ui.VStack(14,
            Ui.Text("Together", Typeface.Title(30), p.Ink),
            Ui.Text("Watch the same film at the same second, race friends to the end of a series, or send them what you've seen. Everything works with a six-letter code. No accounts.",
                Typeface.Ui(13), p.Ink2));
        if (!_together.IsAvailable) return stack;
        var box = CodeBox();
        _open = Buttons.Silver("Open", Join, enabled: CanOpen);
        stack.Children.Add(Ui.HStack(8, box, _open, _together.IsWorking ? SocialKit.Spinner() : null));
        return stack;
    }

    /// The same box across rebuilds, so typing isn't interrupted; a new one only for a new theme.
    private TextBox CodeBox()
    {
        if (_box is not null && ReferenceEquals(_boxPalette, Theme.P))
        {
            SocialKit.Detach(_box);
            return _box;
        }
        var box = SocialKit.Field("Enter a code, like K7Q-2MX", Typeface.Time(15, Typeface.Medium), Theme.P.Raised, 9, 36, new Thickness(12, 7, 12, 7));
        box.Width = 260;
        box.Text = _box?.Text ?? "";
        box.TextChanged += (_, _) => { if (_open is not null) _open.IsEnabled = CanOpen; };
        box.KeyDown += (_, e) =>
        {
            if (e.Key != VirtualKey.Enter) return;
            e.Handled = true;
            Join();
        };
        _box = box;
        _boxPalette = Theme.P;
        return box;
    }

    private void Join()
    {
        if (_box is null || ShareCode.Normalize(_box.Text).Length != 6) return;
        _ = _together.Enter(_box.Text);
        _box.Text = "";
    }
}

// MARK: Party

/// The party that's on, or an invitation to start one.
internal sealed class PartySection : KeyedComponent
{
    private readonly AppModel _app;
    private readonly TogetherModel _together;
    private PartyStage? _stage;
    private DispatcherQueueTimer? _timer;

    public PartySection(AppModel app)
    {
        _app = app;
        _together = app.Session.Together;
        WatchKeyed(Changes.Of(_together));
        WatchKeyed(Changes.Of(app));
        WatchKeyed(Changes.Of(app.Browser));
        WatchKeyed(Changes.Of(app.Library));
    }

    // What's playing moves without telling anyone, so look again every second while on screen.
    protected override void OnAppeared()
    {
        base.OnAppeared();
        if (DispatcherQueue is not { } queue) return;
        _timer ??= queue.CreateTimer();
        _timer.Interval = TimeSpan.FromSeconds(1);
        _timer.Tick -= OnTick;
        _timer.Tick += OnTick;
        _timer.Start();
    }

    protected override void OnDisappeared() => _timer?.Stop();

    private void OnTick(DispatcherQueueTimer sender, object args) => Check();

    protected override object? Key()
    {
        if (_together.Party is { } party)
        {
            return ("party", party.Code, party.Title?.Name, party.Title?.PosterUrl, _together.IsHost);
        }
        var tab = TogetherPage.Playing(_app);
        var title = Linked(tab);
        var next = _app.Library.ContinueWatching.FirstOrDefault().Title;
        return ("invite", tab?.Id, tab?.DisplayTitle, title?.Id, title?.Name, title?.PosterUrl, _together.IsWorking, next?.Id, next?.Name);
    }

    protected override void OnSame()
    {
        if (_together.Party is { } party) _stage?.Update(party);
    }

    private Title? Linked(BrowserTab? tab) =>
        tab?.LinkedTitleId is long id && _app.Library.Titles.TryGetValue(id, out var title) ? title : null;

    protected override UIElement Render()
    {
        Rendered();
        if (_together.Party is { } party)
        {
            _stage = new PartyStage(_app, party);
            return _stage.Root;
        }
        _stage = null;
        return Invite();
    }

    /// No party yet: what's playing, ready to share, or a nudge to start something.
    private FrameworkElement Invite()
    {
        var p = Theme.P;
        var tab = TogetherPage.Playing(_app);
        var title = Linked(tab);
        FrameworkElement art = title is not null
            ? Posters.Image(title, width: 86, cornerRadius: 6, keepsColour: true)
            : new Border
            {
                Width = 86,
                Height = 129,
                CornerRadius = new CornerRadius(6),
                Background = new SolidColorBrush(p.Raised2),
                Child = Ui.Icon(SocialKit.Video, 24, p.Ink3).Centered(),
            };
        // TODO(after core merge): `tab.Parsed?.Name` between the linked title and the tab's title, as on the Mac.
        var text = tab is not null
            ? $"Invite friends to {title?.Name ?? tab.DisplayTitle}. They open the same page and their player follows yours: play, pause, every jump. You can talk in the chat while you watch."
            : "Start a film on one of your sites, then come back here to invite people to it.";
        var start = Buttons.Silver("Start a party", () =>
        {
            if (tab is not null) _app.Browser.Select(tab);
            _ = _together.StartParty();
        }, large: true, enabled: tab is not null && !_together.IsWorking).WithIcon(Glyph.People);
        Button? open = null;
        if (tab is null && _app.Library.ContinueWatching.Count > 0)
        {
            var next = _app.Library.ContinueWatching[0].Title;
            open = Buttons.Outline($"Open {next.Name}", () => _app.ContinueWatching(next.Id));
        }
        var column = Ui.VStack(8,
            Ui.Line("Watch party", Typeface.Title(26), p.Ink),
            Ui.Text(text, Typeface.Ui(13), p.Ink2).MaxSize(width: 460).Leading(),
            Ui.HStack(10, start, open).Margin(0, 6, 0, 0));
        var row = Ui.Row(22, art, column.Fill());
        row.Padding = new Thickness(22);
        return TogetherPage.Stage(title?.PosterUrl, row);
    }
}

/// The party that's on: the film and where it is, who's here, the chat and the reactions. Built once
/// per party and updated in place every second, so the chat box keeps its text and focus.
internal sealed class PartyStage
{
    private static readonly string[] Reactions = ["😂", "😮", "😭", "❤️", "👏", "🍿"];

    private readonly AppModel _app;
    private readonly TogetherModel _together;
    private readonly TextBlock _sync;
    private readonly FontIcon _playIcon;
    private readonly TextBlock _time;
    private readonly StackPanel _members = Ui.HStack(16);
    private readonly StackPanel _messages = Ui.VStack(10);
    private readonly ScrollViewer _chat;
    private readonly TextBlock _lastReaction;
    private readonly TextBox _draft;
    private readonly Button _send;
    /// Your pet, worked out once per party rather than every second.
    private readonly string _myPet;
    private string _membersKey = "";
    private List<string>? _messageIds;

    public FrameworkElement Root { get; }

    public PartyStage(AppModel app, PartyState party)
    {
        _app = app;
        _together = app.Session.Together;
        _myPet = app.Session.Pet.Code;
        var p = Theme.P;

        // The film, where it is, and the ticket.
        var poster = new RemoteImage(party.Title?.PosterUri, Posters.Placeholder(party.Title?.Name ?? "Party"), fill: true, cornerRadius: 7)
        {
            Width = 92,
            Height = 138,
        };
        var posterFrame = new Border
        {
            Width = 92,
            Height = 138,
            CornerRadius = new CornerRadius(7),
            Background = new SolidColorBrush(p.Raised),
            Child = poster.ClipRounded(7),
            Shadow = new ThemeShadow(),
            // The Mac's shadow(radius: 12, y: 6): ThemeShadow takes its depth from Z.
            Translation = new Vector3(0, 0, 16),
            VerticalAlignment = VerticalAlignment.Top,
        };

        _sync = Ui.Text("", Typeface.Ui(13), p.Ink2);
        _playIcon = Ui.Icon(Glyph.Play, 10, p.Ink2);
        _time = Ui.Line("", Typeface.Time(12, Typeface.Medium), p.Ink);
        var info = Ui.VStack(8,
            Ui.HStack(7,
                new Ellipse { Width = 7, Height = 7, Fill = p.Gold },
                Ui.Line("Party on", Typeface.Ui(12, Typeface.Medium), p.Ink2)),
            Ui.Text(party.Title?.Name ?? "Watch party", Typeface.Title(30), p.Ink, maxLines: 2),
            _sync,
            Ui.HStack(8, _playIcon, _time).Margin(0, 2, 0, 0));
        info.VerticalAlignment = VerticalAlignment.Top;
        info.Margin = new Thickness(0, 0, 12, 0);

        var buttons = Ui.HStack(8,
            _together.IsHost ? null : Buttons.Outline("Go to the film", () => _app.Go(Route.Web)),
            Buttons.Outline(_together.IsHost ? "End party" : "Leave", () => _ = _together.LeaveParty()));
        var actions = Ui.VStack(10, Ticket(party.Code, _together.CopyPartyCode).Trailing(), buttons.Trailing());
        actions.VerticalAlignment = VerticalAlignment.Top;
        var top = Ui.Row(20, posterFrame, info.Fill(), actions);
        top.Padding = new Thickness(22);

        var members = new Border { Child = _members, Padding = new Thickness(22, 0, 22, 16) };

        // The chat.
        _chat = new ScrollViewer
        {
            Content = new Border { Child = _messages, Padding = new Thickness(16) },
            VerticalScrollBarVisibility = ScrollBarVisibility.Hidden,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollMode = ScrollMode.Disabled,
        };
        _draft = SocialKit.Field("Message everyone", Typeface.Ui(13), null, 0, 0, new Thickness(0, 2, 0, 2));
        _draft.Label("Message everyone");
        _send = Buttons.Make(new Border
        {
            Width = 24,
            Height = 24,
            CornerRadius = new CornerRadius(12),
            Background = p.Silver,
            Child = Ui.Icon(SocialKit.ArrowUp, 11, p.OnSilver).Centered(),
        }, Send, enabled: false).Label("Send");
        _draft.TextChanged += (_, _) => _send.IsEnabled = _draft.Text.Trim(' ', '\t').Length > 0;
        _draft.KeyDown += (_, e) =>
        {
            if (e.Key != VirtualKey.Enter) return;
            e.Handled = true;
            Send();
        };
        var input = Ui.Row(8, _draft.Fill(), _send);
        input.Padding = new Thickness(14, 9, 14, 9);
        var inputCapsule = input.Capsule(p.Raised);
        inputCapsule.Margin = new Thickness(12);
        var chat = new Grid
        {
            RowDefinitions = { new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }, new RowDefinition { Height = GridLength.Auto } },
            Children = { _chat, inputCapsule.Cell(row: 1) },
        };

        // The reactions.
        var pad = new Grid { ColumnSpacing = 6, RowSpacing = 6 };
        for (var i = 0; i < 3; i++) pad.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        pad.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        pad.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        for (var i = 0; i < Reactions.Length; i++)
        {
            var emoji = Reactions[i];
            var face = new TextBlock
            {
                Text = emoji,
                FontFamily = new FontFamily("Segoe UI Emoji"),
                FontSize = 24,
                IsTextScaleFactorEnabled = false,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            var button = Buttons.Hover(face, () => _ = _together.React(emoji), radius: 12, padding: new Thickness(0));
            button.MinHeight = 44;
            button.HorizontalAlignment = HorizontalAlignment.Stretch;
            button.HorizontalContentAlignment = HorizontalAlignment.Center;
            button.VerticalContentAlignment = VerticalAlignment.Center;
            button.Label($"React {emoji}");
            pad.Children.Add(button.Cell(row: i / 3, column: i % 3));
        }
        _lastReaction = Ui.Line("", Typeface.Ui(11.5), p.Ink3);
        var reactions = Ui.VStack(10, Ui.Line("React", Typeface.Ui(12, Typeface.Medium), p.Ink3), pad, _lastReaction);
        reactions.Padding = new Thickness(16);

        var bottom = new Grid
        {
            Height = 260,
            ColumnDefinitions =
            {
                new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) },
                new ColumnDefinition { Width = GridLength.Auto },
                new ColumnDefinition { Width = new GridLength(190) },
            },
            Children = { chat, SocialKit.Hairline(vertical: true).Cell(column: 1), reactions.Cell(column: 2) },
        };

        var body = Ui.VStack(0, top, members, SocialKit.Hairline(), bottom);
        Root = TogetherPage.Stage(party.Title?.PosterUri, body);
        Update(party);
    }

    private string SyncLine(PartyState party) => _together.IsHost
        ? "You're the host. Everyone's player follows yours."
        : $"Following {party.HostName}, {(party.Playing ? "playing" : "paused")} at {Timecode.String(party.ExpectedPosition)}";

    /// The second-by-second part: where the film is, who's here, what they said.
    public void Update(PartyState party)
    {
        var p = Theme.P;
        _sync.Text = SyncLine(party);
        _playIcon.Glyph = party.Playing ? Glyph.Play : Glyph.Pause;
        _time.Text = Timecode.String(party.ExpectedPosition);

        var myPet = _myPet;
        var me = _together.PersonId;
        var membersKey = string.Join("\n", party.Members.Select(m => $"{m.PersonId}\t{m.Name}\t{m.Pet}")) + $"\n{party.HostId}\n{me}\n{myPet}";
        if (membersKey != _membersKey)
        {
            _membersKey = membersKey;
            _members.Children.Clear();
            foreach (var member in party.Members) _members.Children.Add(Member(member, member.PersonId == me, member.PersonId == party.HostId, myPet));
        }

        var ids = party.Messages.Select(m => m.Id).ToList();
        if (_messageIds is null || !ids.SequenceEqual(_messageIds))
        {
            var shown = _messageIds ?? [];
            // New messages at the end are added; anything else redraws the conversation.
            var appended = shown.Count > 0 && ids.Count > shown.Count && ids.Take(shown.Count).SequenceEqual(shown);
            if (!appended) _messages.Children.Clear();
            var start = appended ? shown.Count : 0;
            if (ids.Count == 0)
            {
                _messages.Children.Add(Ui.Text("Say hello. Messages also show over the film for a moment.", Typeface.Ui(12.5), p.Ink3).Margin(0, 4, 0, 0));
            }
            for (var i = start; i < party.Messages.Count; i++)
            {
                var message = party.Messages[i];
                _messages.Children.Add(ChatLine(message, message.PersonId == me, myPet));
            }
            var hadMessages = shown.Count > 0;
            _messageIds = ids;
            if (ids.Count > 0) ScrollToEnd(animated: hadMessages);
        }

        if (party.Reactions.Count > 0)
        {
            var last = party.Reactions[^1];
            _lastReaction.Text = $"{last.Name} {last.Emoji}";
            _lastReaction.Visibility = Visibility.Visible;
        }
        else
        {
            _lastReaction.Visibility = Visibility.Collapsed;
        }
    }

    private void ScrollToEnd(bool animated)
    {
        _chat.DispatcherQueue?.TryEnqueue(DispatcherQueuePriority.Low, () =>
        {
            _chat.UpdateLayout();
            _chat.ChangeView(null, _chat.ScrollableHeight, null, disableAnimation: !animated || !SocialKit.AnimationsEnabled);
        });
    }

    private void Send()
    {
        var text = _draft.Text;
        _draft.Text = "";
        _ = _together.Say(text);
        _draft.Focus(FocusState.Programmatic);
    }

    private static FrameworkElement Member(PartyMember member, bool isMe, bool isHost, string myPet)
    {
        var p = Theme.P;
        var avatar = new Grid { Width = 44, Height = 44, Children = { People.PersonAvatar(member.Name, isMe ? myPet : member.Pet, isMe, 44) } };
        if (isHost)
        {
            var crown = new Border
            {
                Child = People.Crown(9, p.Gold),
                Padding = new Thickness(3),
                Background = new SolidColorBrush(p.CardFill),
                CornerRadius = new CornerRadius(99),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Bottom,
            }.Label("Host");
            avatar.Children.Add(crown);
        }
        var name = Ui.Line(isMe ? "You" : member.Name, Typeface.Ui(11.5, isMe ? Typeface.Semibold : Microsoft.UI.Text.FontWeights.Normal), p.Ink2);
        name.HorizontalAlignment = HorizontalAlignment.Center;
        avatar.HorizontalAlignment = HorizontalAlignment.Center;
        var cell = Ui.VStack(5, avatar, name);
        cell.Width = 60;
        cell.VerticalAlignment = VerticalAlignment.Top;
        cell.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        return cell.Tooltip(isHost ? $"{member.Name}, hosting" : member.Name);
    }

    private static FrameworkElement ChatLine(PartyMessage message, bool isMe, string myPet)
    {
        var p = Theme.P;
        var avatar = People.PersonAvatar(message.Name, isMe ? myPet : message.Pet, isMe, 24);
        avatar.VerticalAlignment = VerticalAlignment.Top;
        var at = DateTimeOffset.FromUnixTimeMilliseconds((long)message.At).ToLocalTime();
        var head = Ui.HStack(6,
            Ui.Line(isMe ? "You" : message.Name, Typeface.Ui(12, Typeface.Semibold), p.Ink).OnBaseline(),
            Ui.Line(at.ToString("t", System.Globalization.CultureInfo.CurrentCulture), Typeface.Time(10.5), p.Ink3).OnBaseline());
        var text = Ui.Text(message.Text, Typeface.Ui(13), p.Ink2);
        text.IsTextSelectionEnabled = true;
        text.SelectionHighlightColor = new SolidColorBrush(Palette.WithOpacity(p.Ink, 0.3));
        var column = Ui.VStack(2, head, text);
        column.VerticalAlignment = VerticalAlignment.Top;
        return Ui.Row(9, avatar, column.Fill());
    }

    /// The party's code as a cinema ticket: punched edge, big numbers, tap to copy.
    private static Button Ticket(string code, Action copy)
    {
        var p = Theme.P;
        var number = Ui.Line(ShareCode.Display(code), Typeface.Time(22, Microsoft.UI.Text.FontWeights.Bold), p.Ink).Tracking(2);
        number.TextTrimming = TextTrimming.None;
        var content = Ui.VStack(2,
            Ui.Line("Invite code", Typeface.Ui(10.5), p.Ink3),
            Ui.HStack(8, number, Ui.Icon(SocialKit.Copy, 11, p.Ink3)));
        content.Padding = new Thickness(18, 9, 14, 9);
        var shape = new Microsoft.UI.Xaml.Shapes.Path
        {
            Fill = new SolidColorBrush(p.Raised2),
            Stroke = new SolidColorBrush(p.Line),
            StrokeThickness = 1,
            StrokeDashArray = new DoubleCollection { 3, 3 },
            IsHitTestVisible = false,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Top,
        };
        var holder = new Grid { Children = { shape, content } };
        holder.SizeChanged += (_, e) =>
        {
            shape.Width = e.NewSize.Width;
            shape.Height = e.NewSize.Height;
            shape.Data = TicketShape(e.NewSize.Width, e.NewSize.Height);
        };
        return Buttons.Make(holder, copy, help: "Copy the code to send to friends");
    }

    /// A rounded rectangle with a half-circle punched out of each short side. The Mac's TicketShape, an
    /// even-odd fill of the rectangle and both circles, so the halves outside the edge are filled.
    private static Geometry TicketShape(double width, double height)
    {
        var r = Math.Min(8, Math.Min(width, height) / 2);
        const double notch = 6;
        var figure = new PathFigure { StartPoint = new Windows.Foundation.Point(r, 0), IsClosed = true, IsFilled = true };
        void Line(double x, double y) => figure.Segments.Add(new LineSegment { Point = new Windows.Foundation.Point(x, y) });
        void Arc(double x, double y) => figure.Segments.Add(new ArcSegment
        {
            Point = new Windows.Foundation.Point(x, y),
            Size = new Windows.Foundation.Size(r, r),
            SweepDirection = SweepDirection.Clockwise,
        });
        Line(width - r, 0);
        Arc(width, r);
        Line(width, height - r);
        Arc(width - r, height);
        Line(r, height);
        Arc(0, height - r);
        Line(0, r);
        Arc(r, 0);
        return new GeometryGroup
        {
            FillRule = FillRule.EvenOdd,
            Children =
            {
                new PathGeometry { Figures = { figure } },
                new EllipseGeometry { Center = new Windows.Foundation.Point(0, height / 2), RadiusX = notch, RadiusY = notch },
                new EllipseGeometry { Center = new Windows.Foundation.Point(width, height / 2), RadiusX = notch, RadiusY = notch },
            },
        };
    }
}

// MARK: Challenges

internal sealed class ChallengesSection : KeyedComponent
{
    private readonly AppModel _app;
    private readonly TogetherModel _together;

    public ChallengesSection(AppModel app)
    {
        _app = app;
        _together = app.Session.Together;
        WatchKeyed(Changes.Of(_together));
        WatchKeyed(Changes.Of(app.Library));
    }

    protected override object? Key()
    {
        var parts = new List<string> { _together.PersonId ?? "", _app.Session.Pet.Code };
        foreach (var summary in _together.Challenges)
        {
            parts.Add($"{summary.Code}\t{summary.Title.Name}\t{summary.Title.PosterUrl}\t{summary.TotalEpisodes}\t{summary.WinnerName}\t{summary.MemberCount}");
            if (_together.Details.TryGetValue(summary.Code, out var state))
            {
                parts.Add($"{state.WinnerId}\t{state.WinnerName}");
                parts.AddRange(state.Members.Select(m => $"{m.PersonId}\t{m.Name}\t{m.Pet}\t{m.Fraction}\t{m.Label}"));
            }
            else
            {
                parts.Add("loading");
            }
        }
        return string.Join("\n", parts);
    }

    protected override UIElement Render()
    {
        Rendered();
        var p = Theme.P;
        var header = Ui.Row(0,
            People.SectionHeading("Challenges"),
            Ui.Spacer(),
            Buttons.Outline("New challenge", () => _app.Sheet = new AppSheet.NewChallenge()).WithIcon(SocialKit.Flag));
        UIElement body;
        if (_together.Challenges.Count == 0)
        {
            body = Ui.Text("Pick a series or a film, send the code, and see who gets to the end first. Everyone's progress comes from what they actually watch.",
                Typeface.Ui(13), p.Ink2);
        }
        else
        {
            var myPet = _app.Session.Pet.Code;
            body = Ui.Stack(Orientation.Vertical, 12, _together.Challenges.Select(summary =>
                (UIElement)Card(summary, _together.Details.GetValueOrDefault(summary.Code), myPet)));
        }
        return Ui.VStack(14, header, body);
    }

    private string Subtitle(ChallengeSummary summary, ChallengeState? state)
    {
        if ((state?.WinnerName ?? summary.WinnerName) is { } winner)
        {
            return state?.WinnerId == _together.PersonId ? "You won. First to the end." : $"{winner} got there first";
        }
        var total = (int)summary.TotalEpisodes;
        var goal = total > 1 ? $"First to finish all {total} episodes" : "First to finish it";
        return $"{goal} · {(int)summary.MemberCount} in";
    }

    private FrameworkElement Card(ChallengeSummary summary, ChallengeState? state, string myPet)
    {
        var p = Theme.P;
        var code = summary.Code;
        var poster = new RemoteImage(summary.Title.PosterUri, Posters.Placeholder(summary.Title.Name), fill: true, cornerRadius: 5)
        {
            Width = 48,
            Height = 72,
            VerticalAlignment = VerticalAlignment.Top,
        }.ClipRounded(5);
        var info = Ui.VStack(4,
            Ui.Text(summary.Title.Name, Typeface.Title(18), p.Ink),
            Ui.Text(Subtitle(summary, state), Typeface.Ui(12.5), p.Ink2));
        info.VerticalAlignment = VerticalAlignment.Top;
        var badge = People.CodeBadge(code, () => _together.CopyChallengeCode(code));
        badge.VerticalAlignment = VerticalAlignment.Top;

        var menu = new MenuFlyout();
        var copy = new MenuFlyoutItem { Text = "Copy code" };
        copy.Click += (_, _) => _together.CopyChallengeCode(code);
        var leave = new MenuFlyoutItem { Text = "Leave challenge" };
        leave.Click += (_, _) => _ = _together.LeaveChallenge(code);
        menu.Items.Add(copy);
        menu.Items.Add(leave);
        var more = Buttons.Make(new Border
        {
            Width = 26,
            Height = 26,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            Child = Ui.Icon(Glyph.More, 13, p.Ink2).Centered(),
        }, () => { }, help: "More");
        more.Flyout = menu;
        more.VerticalAlignment = VerticalAlignment.Top;

        var top = Ui.Row(14, poster, info.Fill(), badge, more);
        UIElement race;
        if (state is not null)
        {
            race = Ui.Stack(Orientation.Vertical, 10, state.Members.Select((member, index) => (UIElement)RaceRow(
                member, index + 1, member.PersonId == _together.PersonId, member.PersonId == state.WinnerId, myPet)));
        }
        else
        {
            race = SocialKit.Spinner().Leading();
        }
        var card = Ui.VStack(14, top, race);
        card.Padding = new Thickness(18);
        return card.Background(p.Raised, 14);
    }

    /// One person in a race: where they are, and how far.
    private static FrameworkElement RaceRow(ChallengeMember member, int place, bool isMe, bool isWinner, string myPet)
    {
        var p = Theme.P;
        var number = Ui.Line($"{place}", Typeface.Time(12, Typeface.Semibold), p.Ink3);
        number.Width = 14;
        number.TextAlignment = TextAlignment.Right;
        var avatar = People.PersonAvatar(member.Name, isMe ? myPet : member.Pet, isMe);
        var name = Ui.Line(isMe ? $"{member.Name} (you)" : member.Name, Typeface.Ui(13, isMe ? Typeface.Semibold : Typeface.Medium), p.Ink);
        var crown = isWinner ? People.Crown(11, p.Gold).Label("Winner") : null;
        var label = Ui.Line(member.Label, Typeface.Ui(11.5), p.Ink3);
        var nameRow = Ui.Row(6, name, crown, Ui.Spacer(), label);
        var column = Ui.VStack(5, nameRow, Progress.Line(member.Fraction, isMe ? 5 : 4));
        return Ui.Row(12, number, avatar, column.Fill());
    }
}

// MARK: Shares

internal sealed class SharesSection : KeyedComponent
{
    private readonly AppModel _app;
    private readonly TogetherModel _together;

    public SharesSection(AppModel app)
    {
        _app = app;
        _together = app.Session.Together;
        WatchKeyed(Changes.Of(_together));
        WatchKeyed(Changes.Of(app.Library));
    }

    protected override object? Key()
    {
        var parts = new List<string>
        {
            _together.IsWorking.ToString(),
            _app.Library.Count(TitleStatus.Watched).ToString(System.Globalization.CultureInfo.InvariantCulture),
            _together.LastShareCode ?? "",
        };
        foreach (var share in _together.OpenedShares)
        {
            parts.Add($"{share.Code}\t{share.Label}\t{share.OwnerName}");
            parts.AddRange(share.Titles.Select(card => $"{card.Name}\t{card.PosterUrl}\t{card.Rating}\t{_together.HasInLibrary(card)}"));
        }
        return string.Join("\n", parts);
    }

    protected override UIElement Render()
    {
        Rendered();
        var p = Theme.P;
        var watched = _app.Library.Count(TitleStatus.Watched);
        Button? badge = null;
        if (_together.LastShareCode is { } code)
        {
            badge = People.CodeBadge(code, () =>
            {
                SocialKit.CopyText(ShareCode.Display(code));
                _app.Toasts.Show($"Code {ShareCode.Display(code)} copied");
            });
        }
        var row = Ui.Row(12,
            Buttons.Outline("Share my Watched list", () => _ = _together.ShareWatched(), enabled: !_together.IsWorking && watched > 0).WithIcon(Glyph.Share),
            badge,
            Ui.Spacer());
        var note = watched == 0
            ? "Films you mark as watched can go in a list for friends: posters and your ratings, nothing else."
            : $"{watched} {(watched == 1 ? "film goes" : "films go")} in, with their posters, your ratings and nothing else. A friend types the code and can add any of them to their backlog.";
        var stack = Ui.VStack(14,
            People.SectionHeading("Share what you've watched"),
            row,
            Ui.Text(note, Typeface.Ui(12), p.Ink3));
        foreach (var share in _together.OpenedShares) stack.Children.Add(SharedList(share));
        return stack;
    }

    private FrameworkElement SharedList(ShareInfo share)
    {
        var p = Theme.P;
        var count = share.Titles.Count;
        var heading = Ui.VStack(2,
            Ui.Line(share.Label, Typeface.Title(17), p.Ink),
            Ui.Line($"From {share.OwnerName} · {count} {(count == 1 ? "title" : "titles")}", Typeface.Ui(12), p.Ink3));
        var close = Buttons.Make(Ui.Line("Close", Typeface.Ui(12), p.Ink2), () => _together.ForgetShare(share.Code));
        close.VerticalAlignment = VerticalAlignment.Top;
        close.Margin = new Thickness(0, 5, 0, 0);
        heading.VerticalAlignment = VerticalAlignment.Top;
        var posters = Ui.Stack(Orientation.Horizontal, 12, share.Titles.Select(card => (UIElement)SharedPoster(card)));
        foreach (var child in posters.Children) ((FrameworkElement)child).VerticalAlignment = VerticalAlignment.Top;
        var list = Ui.VStack(12, Ui.Row(0, heading, Ui.Spacer(), close), Ui.Scroll(posters, horizontal: true));
        list.Padding = new Thickness(16);
        return list.Background(p.Raised, 14);
    }

    private FrameworkElement SharedPoster(TitleCard card)
    {
        var p = Theme.P;
        var have = _together.HasInLibrary(card);
        var image = new RemoteImage(card.PosterUri, Posters.Placeholder(card.Name), fill: true, cornerRadius: 6);
        var add = Buttons.Make(new Border
        {
            Width = 24,
            Height = 24,
            CornerRadius = new CornerRadius(12),
            Background = p.Silver,
            Child = Ui.Icon(have ? Glyph.Check : Glyph.Add, 11, p.OnSilver).Centered(),
        }, () => _together.AddToBacklog(card), enabled: !have, help: have ? "In your library" : "Add to backlog");
        add.HorizontalAlignment = HorizontalAlignment.Right;
        add.VerticalAlignment = VerticalAlignment.Bottom;
        add.Margin = new Thickness(6);
        add.Visibility = have ? Visibility.Visible : Visibility.Collapsed;
        var frame = new Grid { Width = 96, Height = 144, Children = { image, add } }.ClipRounded(6);
        var name = Ui.Text(card.Name, Typeface.Ui(11.5, Typeface.Medium), p.Ink2, maxLines: 2);
        name.Width = 96;
        var stars = card.Rating is int rating && rating > 0 ? Stars.Row(Math.Min(Rating.MaxHalves, rating), 7.5, 0.5) : null;
        stars?.Leading();
        var cell = Ui.VStack(6, frame, name, stars);
        cell.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        cell.OnHover(on => add.Visibility = on || have ? Visibility.Visible : Visibility.Collapsed);
        return cell;
    }
}

/// An image from a URL, blurred and more saturated, drawn by the compositor: the light a poster gives
/// off behind a card (SwiftUI's `.blur(radius:)` and `.saturation(_:)`).
internal sealed class BlurredImage : Grid
{
    private readonly Uri _url;
    private readonly float _blur;
    private readonly float _saturation;
    private readonly SpriteVisual _sprite;

    public BlurredImage(Uri url, double blur, double saturation, double opacity)
    {
        _url = url;
        _blur = (float)blur;
        _saturation = (float)saturation;
        IsHitTestVisible = false;
        var compositor = ElementCompositionPreview.GetElementVisual(this).Compositor;
        _sprite = compositor.CreateSpriteVisual();
        _sprite.Opacity = (float)opacity;
        ElementCompositionPreview.SetElementChildVisual(this, _sprite);
        SizeChanged += (_, e) => _sprite.Size = new Vector2((float)e.NewSize.Width, (float)e.NewSize.Height);
        Loaded += async (_, _) => await LoadAsync(compositor);
    }

    private async Task LoadAsync(Compositor compositor)
    {
        if (_sprite.Brush is not null) return;
        var stream = await ImageBytes.StreamAsync(_url);
        if (stream is null) return;
        var surface = LoadedImageSurface.StartLoadFromStream(stream);
        var loaded = new TaskCompletionSource<bool>();
        surface.LoadCompleted += (_, e) => loaded.TrySetResult(e.Status == LoadedImageSourceLoadStatus.Success);
        if (!await loaded.Task) return;
        var image = compositor.CreateSurfaceBrush(surface);
        image.Stretch = CompositionStretch.UniformToFill;
        image.HorizontalAlignmentRatio = 0.5f;
        image.VerticalAlignmentRatio = 0.5f;
        // Saturation as a colour matrix (Rec. 709 weights), which goes above 1 where SaturationEffect stops.
        const float rw = 0.2126f, gw = 0.7152f, bw = 0.0722f;
        var s = _saturation;
        var effect = new ColorMatrixEffect
        {
            Name = "Saturation",
            ColorMatrix = new Matrix5x4
            {
                M11 = rw * (1 - s) + s, M12 = rw * (1 - s), M13 = rw * (1 - s),
                M21 = gw * (1 - s), M22 = gw * (1 - s) + s, M23 = gw * (1 - s),
                M31 = bw * (1 - s), M32 = bw * (1 - s), M33 = bw * (1 - s) + s,
                M44 = 1,
            },
            Source = new GaussianBlurEffect
            {
                Name = "Blur",
                BlurAmount = _blur,
                BorderMode = EffectBorderMode.Hard,
                Source = new CompositionEffectSourceParameter("Image"),
            },
        };
        var brush = compositor.CreateEffectFactory(effect).CreateBrush();
        brush.SetSourceParameter("Image", image);
        _sprite.Brush = brush;
    }
}
