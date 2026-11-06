namespace Cineon.App.Browser;

// Stand-ins from Cineon/Browser/EpisodeAutopilot.swift with only what AppModel uses. The browser
// port owns this file.

/// A tab's autopilot: skips, the next episode, and whether a sleep timer is holding it.
// TODO(port-browser): struct AutopilotState { rules, jump, proposedIntro, ..., isHeldForSleep }
public sealed class AutopilotState
{
    /// A sleep timer is waiting for this episode to end, so nothing should start after it.
    public bool IsHeldForSleep { get; set; }
}

/// Skips intros and moves on to the next episode on a site.
public sealed class EpisodeAutopilot
{
    private readonly ProfileSession _session;

    // TODO(port-browser): init(session: ProfileSession)
    public EpisodeAutopilot(ProfileSession session)
    {
        _session = session;
    }

    // TODO(port-browser): func skipToNext(tab: BrowserTab)
    public void SkipToNext(BrowserTab tab)
    {
    }
}
