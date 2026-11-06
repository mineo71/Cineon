using Cineon.App.Browser;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Cineon.Core.Metadata;
using Cineon.Core.Parsing;

namespace Cineon.App;

// TEMPORARY. Members other ports add, which the downloads, player, sheets, import and command bar
// screens call. They're extension members, so the real instance members win as soon as they're
// merged and these go quiet; delete this file then. Each names the port that owns the real one.
public static class PortStandIns
{
    extension(ProfileSession session)
    {
        // TODO(port-browser): `DownloadCenter Downloads`, created in ProfileSession like the Mac's
        // (`DownloadCenter(session: self)`) over the browser's IRequestContext and Services/DownloadHost.
        public DownloadCenter Downloads => throw new InvalidOperationException("TODO(port-browser): ProfileSession.Downloads");

        // TODO(port-browser): `SeasonGrabber Seasons` (SeasonGrabber(downloads, host, resolver, profile folder)).
        public SeasonGrabber Seasons => throw new InvalidOperationException("TODO(port-browser): ProfileSession.Seasons");

        // TODO(port-browser): `MetadataService Metadata` (MetadataService(library) { settings.fetchMetadata }).
        public MetadataService Metadata => throw new InvalidOperationException("TODO(port-browser): ProfileSession.Metadata");

        // TODO(port-browser): `WatchTracker Tracker` with `Relink(tab, titleId, ref)` and `Ignore(tab)`.
        public PendingWatchTracker Tracker => new();
    }

    extension(BrowserTab tab)
    {
        // TODO(port-browser): `ParsedTitle? Parsed`, TitleParser's result for the page (Swift `tab.parsed`).
        public ParsedTitle? Parsed => null;

        // TODO(port-browser): `Uri? FaviconUrl` (Swift `tab.faviconURL`).
        public Uri? FaviconUrl => null;
    }

    // Extends the app's TogetherModel stub, which the Together port deletes (ProfileSession.Together
    // becomes Core's TogetherModel): this block won't compile after that merge, so delete it with it.
    extension(TogetherModel together)
    {
        // TODO(port-together): Core's `TogetherModel.CreateChallenge(Title)`.
        public Task CreateChallenge(Title title) => Task.CompletedTask;
    }
}

/// TEMPORARY: what the relink sheet calls on the browser port's WatchTracker.
public sealed class PendingWatchTracker
{
    // TODO(port-browser): func relink(tab: BrowserTab, to titleID: Int64, ref: EpisodeRef)
    public void Relink(BrowserTab tab, long titleId, EpisodeRef episode) { }

    // TODO(port-browser): func ignore(tab: BrowserTab)
    public void Ignore(BrowserTab tab) { }
}
