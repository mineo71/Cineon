using Cineon.Core.Data;

namespace Cineon.App.Browser;

// Stand-ins from Cineon/Browser/WatchTracker.swift with only what AppModel reads. The browser port
// owns this file and replaces them with the real thing (WatchTracker, MediaEvent, the full LiveTrack).

/// What a tab's video is doing, from its last report.
// TODO(port-browser): struct MediaState: Equatable { position, duration, isPlaying, rate, fraction }
public readonly record struct MediaState(double Position, double Duration, bool IsPlaying, double Rate)
{
    public double Fraction => Duration > 0 ? Math.Min(1, Position / Duration) : 0;
}

/// The session being recorded in a tab.
// TODO(port-browser): struct LiveTrack { titleID, ref, urlKey, session: WatchSession, lastFlush, startedWith, finishedAnnounced }
public sealed record LiveTrack(long TitleId, EpisodeRef Ref, string UrlKey);
