namespace Cineon.App.Browser;

// Stand-in from Cineon/Browser/Rescue.swift with only what AppModel uses. The browser port owns
// this file (RescueEngine, RescueSession, the hidden search tab).

/// Finds the film again on the person's other sites when a page fails or the video breaks.
public sealed class RescueEngine
{
    private readonly ProfileSession _session;

    // TODO(port-browser): init(session: ProfileSession)
    public RescueEngine(ProfileSession session)
    {
        _session = session;
    }

    // TODO(port-browser): func findElsewhere(tab: BrowserTab)
    public void FindElsewhere(BrowserTab tab)
    {
    }

    // TODO(port-browser): func stop(tab: BrowserTab)
    public void Stop(BrowserTab tab)
    {
    }
}
