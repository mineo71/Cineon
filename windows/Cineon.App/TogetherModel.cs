using Cineon.App.UI;

namespace Cineon.App;

/// Watch parties, challenges and shared cards. A stand-in from Cineon/App/TogetherModel.swift with
/// only what ProfileSession calls; the Together port owns this file and builds it on Core's
/// TogetherClient.
public sealed class TogetherModel : Observable
{
    private readonly ProfileSession _session;

    // TODO(port-together): init(session: ProfileSession)
    public TogetherModel(ProfileSession session)
    {
        _session = session;
    }

    // TODO(port-together): func start()
    public void Start() { }

    // TODO(port-together): func stop()
    public void Stop() { }

    /// Sends the new name and pet to the server after either changes.
    // TODO(port-together): func refreshIdentity()
    public void RefreshIdentity() { }
}
