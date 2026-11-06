using Cineon.App.Browser;
using Cineon.Core.Data;
using Cineon.Core.Together;

namespace Cineon.App;

/// What Core's TogetherModel needs from the app, apart from the player: the parts of the Mac's
/// TogetherModel that reach into ProfileSession and AppModel (settings, the pet, the route, toasts,
/// the clipboard and metadata). Called on the UI thread.
internal sealed class TogetherHost(ProfileSession session) : ITogetherHost
{
    public AppSettings Settings => session.Settings;

    public string PetCode => session.Pet.Code;

    public TogetherRoute Route => session.App?.Route switch
    {
        Cineon.App.Route.Web => TogetherRoute.Web,
        Cineon.App.Route.Together => TogetherRoute.Together,
        _ => TogetherRoute.Other,
    };

    public void Go(TogetherRoute route)
    {
        if (session.App is not { } app) return;
        app.Go(route == TogetherRoute.Web ? Cineon.App.Route.Web : Cineon.App.Route.Together);
    }

    public void ShowToast(string text) => session.Toasts.Show(text);

    public void CopyText(string text) => UI.SocialKit.CopyText(text);

    public void ApplyMetadata(long titleId, TitleCard card)
    {
        // TODO(after core merge): once ProfileSession has `Metadata` (MetadataService), as the Mac does:
        //   _ = session.Metadata.ApplyAsync(new MetadataHit(card.ImdbId!, card.Name, card.Year, card.TitleKind, card.PosterUri), titleId);
    }

    public void EnrichMetadata(long titleId)
    {
        // TODO(after core merge): session.Metadata.Enrich(titleId);
    }

    public Task<int> EpisodeCountAsync(Title title)
    {
        // TODO(after core merge): the Mac counts episodes in seasons above 0:
        //   var episodes = await session.Metadata.EpisodesAsync(title);
        //   return episodes.Count(e => e.Season > 0);
        // Until then a series challenge counts as one episode (the model's floor).
        return Task.FromResult(0);
    }
}

/// The browser tabs as a watch party drives them: BrowserModel and BrowserTab behind Core's
/// IPartyPlayer. Tabs are named by id; a closed tab is null and every call on it does nothing.
// TODO(port-browser): fill in Load, EvaluateInPlayerAsync, PlayerCommand and ShowBanner with the real
// tab (see windows/notes/together.md, "IPartyPlayer"), and Parsed once BrowserTab has it.
internal sealed class PartyPlayer(ProfileSession session) : IPartyPlayer
{
    private BrowserModel Browser => session.Browser;

    public PartyTab? SelectedTab => Browser.Selected is { } tab ? Snapshot(tab) : null;

    public PartyTab? Tab(Guid id) => Find(id) is { } tab ? Snapshot(tab) : null;

    public Guid OpenTab(Uri url, bool select) => Browser.OpenTab(url, select).Id;

    public void Load(Guid tab, Uri url)
    {
        if (Find(tab) is null) return;
        // TODO(port-browser): tab.Load(url)
    }

    public Task<string?> EvaluateInPlayerAsync(Guid tab, string script)
    {
        // TODO(port-browser): run `script` in the frame that holds the video (CoreWebView2Frame.ExecuteScriptAsync,
        // or the top frame) and return WebView2's JSON result text.
        return Task.FromResult<string?>(null);
    }

    public void PlayerCommand(Guid tab, string command)
    {
        // TODO(port-browser): `window.__cineon && __cineon.<command>;` in the video's frame, without waiting.
    }

    public void ShowBanner(Guid tab, string id, string text, double timeout)
    {
        // TODO(port-browser): tab.ShowBanner(id, text, timeout), media.js's __cineon.banner.
    }

    private BrowserTab? Find(Guid id) => Browser.Tabs.FirstOrDefault(t => t.Id == id);

    private static PartyTab Snapshot(BrowserTab tab) => new(
        tab.Id,
        tab.Url,
        tab.Media is { } media ? new PartyMedia(media.Position, media.Duration, media.IsPlaying, media.Rate) : null,
        tab.LinkedTitleId,
        // TODO(after core merge): tab.Parsed as `new TitleCard(parsed.Name, parsed.Year, parsed.KindHint.ToRaw())`.
        Parsed: null);
}
