using Cineon.App.Browser;
using Cineon.Core.Data;

namespace Cineon.App.Playback;

/// Whatever is playing: the native player when it's open, otherwise the tab with the video.
/// The Mac's `enum ActivePlayer { case local(LocalPlayback), case web(BrowserTab) }`.
public abstract record ActivePlayer
{
    private ActivePlayer() { }

    public sealed record Local(LocalPlayback Playback) : ActivePlayer;

    public sealed record Web(BrowserTab Tab) : ActivePlayer;

    public bool IsPlaying => this switch
    {
        Local l => l.Playback.IsPlaying,
        Web w => w.Tab.Media?.IsPlaying == true,
        _ => false,
    };

    public double Position => this switch
    {
        Local l => l.Playback.Position,
        Web w => w.Tab.Media?.Position ?? 0,
        _ => 0,
    };

    public double Duration => this switch
    {
        Local l => l.Playback.Duration,
        Web w => w.Tab.Media?.Duration ?? 0,
        _ => 0,
    };

    public double Rate => this switch
    {
        Local l => l.Playback.Rate,
        Web w => w.Tab.Media?.Rate ?? 1,
        _ => 1,
    };

    public long? TitleId => this switch
    {
        Local l => l.Playback.DownloadItem.TitleId,
        Web w => w.Tab.Track?.TitleId ?? w.Tab.LinkedTitleId,
        _ => null,
    };

    /// The episode on, or null for a film.
    public EpisodeRef? Ref
    {
        get
        {
            switch (this)
            {
                case Local l:
                    return l.Playback.DownloadItem.Ref.IsEpisode ? l.Playback.DownloadItem.Ref : null;
                case Web w:
                    var episode = w.Tab.Track?.Ref ?? w.Tab.Parsed?.Ref;
                    return episode?.IsEpisode == true ? episode : null;
                default:
                    return null;
            }
        }
    }

    /// A stable name for what's on, so a timer set for one episode knows when another starts.
    public string Identity => this switch
    {
        Local l => $"local:{l.Playback.DownloadId}",
        Web w => $"web:{Database.UuidString(w.Tab.Id)}:{w.Tab.Track?.UrlKey ?? w.Tab.Url?.OriginalString ?? ""}",
        _ => "",
    };

    public void Toggle()
    {
        if (this is Local l) l.Playback.TogglePlayback();
        else if (this is Web w) w.Tab.TogglePlayback();
    }

    public void Play()
    {
        if (this is Local l) l.Playback.Play();
        else if (this is Web w) w.Tab.Play();
    }

    public void Pause()
    {
        if (this is Local l) l.Playback.Pause();
        else if (this is Web w) w.Tab.PausePlayback();
    }

    public void Skip(double seconds)
    {
        if (this is Local l) l.Playback.Skip(seconds);
        else if (this is Web w) w.Tab.Skip(seconds);
    }

    public void Seek(double seconds)
    {
        if (this is Local l) l.Playback.Seek(seconds);
        else if (this is Web w) w.Tab.Seek(seconds);
    }

    public void FadeOut(double seconds)
    {
        if (this is Local l) l.Playback.FadeOut(seconds);
        else if (this is Web w) w.Tab.FadeOut(seconds);
    }

    public void CancelFade()
    {
        if (this is Local l) l.Playback.CancelFade();
        else if (this is Web w) w.Tab.CancelFade();
    }
}

/// How a sleep timer ends: after some minutes, or when what's on ends (`Minutes` is null).
public readonly record struct SleepTimerMode
{
    private SleepTimerMode(int? minutes) { Minutes = minutes; }

    public int? Minutes { get; }

    /// Stops when this film or episode ends, and nothing starts after it.
    public bool IsEndOfItem => Minutes is null;

    public static SleepTimerMode ForMinutes(int minutes) => new(minutes);

    public static SleepTimerMode EndOfItem => new(null);

    public string Label => Minutes is int minutes
        ? minutes >= 60 && minutes % 60 == 0 ? $"{minutes / 60} h" : $"{minutes} min"
        : "End of this";

    public static IReadOnlyList<SleepTimerMode> Choices { get; } =
        [ForMinutes(15), ForMinutes(30), ForMinutes(45), ForMinutes(60), ForMinutes(90), EndOfItem];
}

public sealed record SleepTimerState(SleepTimerMode Mode)
{
    public DateTimeOffset? Deadline { get; init; }

    /// What was playing when it was set, for "end of this".
    public string? Item { get; init; }

    public bool IsFading { get; init; }

    /// Seconds of sound fading out before playback stops.
    public const double FadeSeconds = 20.0;

    public double? Remaining(ActivePlayer? player, DateTimeOffset? now = null)
    {
        if (!Mode.IsEndOfItem) return Deadline is { } deadline ? (deadline - (now ?? DateTimeOffset.Now)).TotalSeconds : null;
        if (player is null || player.Duration <= 0) return null;
        return Math.Max(0, player.Duration - player.Position);
    }
}

/// The native player's next episode, counting down before it starts.
public sealed record UpNext(DownloadItem Item, DateTimeOffset StartsAt);
