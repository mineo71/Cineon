using System.Runtime.CompilerServices;
using Cineon.Core.Data;

namespace Cineon.Core.Together;

// What TogetherModel needs from the app around it. On the Mac it reaches these through ProfileSession
// (toasts, the pasteboard, the app's route, settings, the pet, metadata) and BrowserModel/BrowserTab
// (tabs and the player). The WinUI app implements both interfaces; every member is called on the
// SynchronizationContext the model was given (the UI thread).

/// <summary>Where the app is showing, as far as Together cares.</summary>
public enum TogetherRoute { Other, Web, Together }

/// <summary>The app side of <see cref="TogetherModel"/>, apart from the player.</summary>
public interface ITogetherHost
{
    /// <summary>The profile's current settings. Read: <c>SharePet</c>, <c>FinishThreshold</c>.</summary>
    AppSettings Settings { get; }

    /// <summary>This profile's pixel pet code (Swift's <c>session.pet.code</c>).</summary>
    string PetCode { get; }

    /// <summary>The page the app shows (Swift's <c>app.route</c>).</summary>
    TogetherRoute Route { get; }

    /// <summary>Shows a page (Swift's <c>app.go(_:)</c>). Only Web and Together are asked for.</summary>
    void Go(TogetherRoute route);

    /// <summary>A short message at the bottom of the window (Swift's <c>session.toasts.show</c>).</summary>
    void ShowToast(string text);

    /// <summary>Puts text on the clipboard, replacing what's there.</summary>
    void CopyText(string text);

    /// <summary>
    /// A friend's film was just added: fill it in from the IMDb id the card carries. Swift's
    /// <c>metadata.apply(hit: MetadataHit(id: card.imdbId, name:, year:, kind: card.titleKind,
    /// posterURL:), to: titleId)</c>.
    /// </summary>
    void ApplyMetadata(long titleId, TitleCard card);

    /// <summary>A friend's film without an IMDb id was just added: look it up (Swift's <c>metadata.enrich</c>).</summary>
    void EnrichMetadata(long titleId);

    /// <summary>
    /// How many episodes a series has, for a challenge: <c>metadata.episodes(for: title)</c> counting
    /// only seasons above 0. Zero when unknown.
    /// </summary>
    Task<int> EpisodeCountAsync(Title title);
}

/// <summary>
/// The browser tabs and their players, as a watch party drives them. On the Mac these are BrowserModel
/// and BrowserTab. Tabs are named by id, and every call is about a tab that may have closed since:
/// do nothing then.
/// </summary>
public interface IPartyPlayer
{
    /// <summary>The selected tab, or null. A party starts from it.</summary>
    PartyTab? SelectedTab { get; }

    /// <summary>The tab with this id as it is now, or null once it's closed.</summary>
    PartyTab? Tab(Guid id);

    /// <summary>Opens a new tab at <paramref name="url"/>, selecting it when asked, and returns its id.</summary>
    Guid OpenTab(Uri url, bool select);

    /// <summary>Loads <paramref name="url"/> in the tab (Swift's <c>tab.load</c>).</summary>
    void Load(Guid tab, Uri url);

    /// <summary>
    /// Runs <paramref name="script"/> in the frame that holds the video (Swift's
    /// <c>tab.evaluateInPlayer</c>) and returns the result as JSON text, which is what WebView2's
    /// <c>ExecuteScriptAsync</c> gives. The model only asks for <see cref="TogetherModel.PlayerStateScript"/>.
    /// Null (or "null") when there's no player or the script failed.
    /// </summary>
    Task<string?> EvaluateInPlayerAsync(Guid tab, string script);

    /// <summary>
    /// Runs <c>window.__cineon &amp;&amp; __cineon.&lt;command&gt;;</c> in the video's frame (Swift's
    /// <c>mediaCommand</c>), without waiting. Commands sent: <c>play()</c>, <c>pause()</c>,
    /// <c>seek(&lt;seconds&gt;)</c> and <c>rate(&lt;rate&gt;)</c>, numbers in invariant culture.
    /// </summary>
    void PlayerCommand(Guid tab, string command);

    /// <summary>Shows the page banner from media.js (Swift's <c>tab.showBanner(id:text:timeout:)</c>), gone after <paramref name="timeout"/> seconds.</summary>
    void ShowBanner(Guid tab, string id, string text, double timeout);
}

/// <summary>A tab as it is now.</summary>
/// <param name="Id">The tab's id.</param>
/// <param name="Url">Its page, or null before one loads.</param>
/// <param name="Media">Its main video as last reported, or null when it has none.</param>
/// <param name="LinkedTitleId">The library title the tab is playing, when it's known.</param>
/// <param name="Parsed">
/// The title read from the page (TitleParser's name, year and kind hint), used when there's no linked
/// title: <c>new TitleCard(parsed.Name, parsed.Year, parsed.KindHint.ToRaw())</c>.
/// </param>
public sealed record PartyTab(Guid Id, Uri? Url, PartyMedia? Media, long? LinkedTitleId = null, TitleCard? Parsed = null);

/// <summary>A tab's main video as last reported (Swift's <c>tab.media</c>).</summary>
public sealed record PartyMedia(double Position, double Duration, bool IsPlaying, double Rate = 1);

/// <summary>Continues on a SynchronizationContext, or carries on when already there.</summary>
internal readonly struct ContextSwitch(SynchronizationContext context) : INotifyCompletion
{
    public ContextSwitch GetAwaiter() => this;

    public bool IsCompleted => SynchronizationContext.Current == context;

    public void OnCompleted(Action continuation) => context.Post(static state => ((Action)state!)(), continuation);

    public void GetResult()
    {
    }
}

/// <summary>Text helpers that count characters the way Swift does (grapheme clusters).</summary>
internal static class SwiftText
{
    /// <summary>Swift's <c>String(text.prefix(count))</c>.</summary>
    public static string Prefix(string text, int count)
    {
        if (text.Length <= count) return text;
        var enumerator = System.Globalization.StringInfo.GetTextElementEnumerator(text);
        var taken = 0;
        while (taken < count && enumerator.MoveNext()) taken++;
        if (taken < count) return text;
        return enumerator.MoveNext() ? text[..enumerator.ElementIndex] : text;
    }

    /// <summary>Swift's <c>trimmingCharacters(in: .whitespacesAndNewlines)</c>.</summary>
    public static string Trim(string text) => text.Trim();
}
