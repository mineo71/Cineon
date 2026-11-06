using Cineon.Core.Data;
using Cineon.Core.Together;

namespace Cineon.App.Browser;

/// The browser as a watch party sees it: tab snapshots, opening and loading tabs, and the video's
/// frame to read and command. What Core's TogetherModel needs from BrowserModel and BrowserTab
/// (see windows/notes/together.md). Call on the UI thread.
public sealed class PartyPlayer(BrowserModel browser) : IPartyPlayer
{
    public PartyTab? SelectedTab => browser.Selected is { } tab ? Snapshot(tab) : null;

    public PartyTab? Tab(Guid id) => Find(id) is { } tab ? Snapshot(tab) : null;

    public Guid OpenTab(Uri url, bool select) => browser.OpenTab(url, select).Id;

    public void Load(Guid tab, Uri url) => Find(tab)?.Load(url);

    public Task<string?> EvaluateInPlayerAsync(Guid tab, string script) =>
        Find(tab) is { } found ? found.EvaluateInPlayerAsync(script) : Task.FromResult<string?>(null);

    public void PlayerCommand(Guid tab, string command) => Find(tab)?.PlayerCommand(command);

    public void ShowBanner(Guid tab, string id, string text, double timeout) => Find(tab)?.ShowBanner(id, text, timeout: timeout);

    private BrowserTab? Find(Guid id) => browser.Tabs.FirstOrDefault(t => t.Id == id);

    private static PartyTab Snapshot(BrowserTab tab) => new(
        tab.Id,
        tab.Url,
        tab.Media is { } media ? new PartyMedia(media.Position, media.Duration, media.IsPlaying, media.Rate) : null,
        tab.LinkedTitleId,
        tab.Parsed is { } parsed ? new TitleCard(parsed.Name, parsed.Year, parsed.KindHint.ToRaw()) : null);
}
