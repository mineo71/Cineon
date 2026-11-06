namespace Cineon.App.Browser;

// Stand-in from Cineon/Browser/FrameCollector.swift with only what AppModel uses. The browser port
// owns this file.

/// Keeps a few graded frames of every session, and the moments people save.
public sealed class FrameCollector
{
    private readonly ProfileSession _session;

    // TODO(port-browser): init(session: ProfileSession)
    public FrameCollector(ProfileSession session)
    {
        _session = session;
    }

    // TODO(port-browser): func saveMoment(tab: BrowserTab)
    public void SaveMoment(BrowserTab tab)
    {
    }
}
