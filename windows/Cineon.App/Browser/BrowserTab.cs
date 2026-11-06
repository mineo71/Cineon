using Cineon.App.UI;
using Cineon.Core.Data;

namespace Cineon.App.Browser;

/// One site tab. A stand-in from Cineon/Browser/BrowserTab.swift with only the members AppModel,
/// ProfileSession and the menus use; the browser port owns this file and gives it its WebView2.
public sealed class BrowserTab : Observable
{
    // TODO(port-browser): init(id: UUID = UUID(), browser: BrowserModel, url: URL? = nil, title: String = "", favicon: URL? = nil, state: Data? = nil)
    public BrowserTab(BrowserModel browser, Uri? url = null, Guid? id = null, string title = "")
    {
        Browser = browser;
        Url = url;
        Id = id ?? Guid.NewGuid();
        Title = title;
    }

    public BrowserModel Browser { get; }

    // TODO(port-browser): let id: UUID
    public Guid Id { get; }

    // TODO(port-browser): var url: URL?
    public Uri? Url { get; set; }

    // TODO(port-browser): var title = ""
    public string Title { get; set; }

    // TODO(port-browser): var media: MediaState?
    public MediaState? Media { get; set; }

    // TODO(port-browser): var linkedTitleID: Int64?
    public long? LinkedTitleId { get; set; }

    // TODO(port-browser): var searchGroup: UUID?
    public Guid? SearchGroup { get; set; }

    // TODO(port-browser): var track: LiveTrack?
    public LiveTrack? Track { get; set; }

    // TODO(port-browser): var lastPlaybackReport: Date?
    public DateTimeOffset? LastPlaybackReport { get; set; }

    // TODO(port-browser): var autopilot = AutopilotState()
    public AutopilotState Autopilot { get; } = new();

    // TODO(port-browser): private(set) var ambientFramesBlocked = false
    public bool AmbientFramesBlocked { get; private set; }

    // TODO(after core merge): var parsed: ParsedTitle? (TitleParser's result for the page). AppModel's
    // AddCurrentPageToBacklog, ActivePlayer.Ref and NowPlayingCenter read it; see their TODOs.

    // TODO(port-browser): private(set) var webView: WKWebView?  (the WebView2 here)
    public bool HasWebView => false;

    // TODO(port-browser): var displayTitle: String
    public string DisplayTitle
    {
        get
        {
            if (Title.Length > 0) return Title;
            if (Url is { Host.Length: > 0 } url) return DomainName.DisplayName(url.Host);
            return "New tab";
        }
    }

    // TODO(port-browser): @discardableResult func ensureWebView(configuration:) -> WKWebView
    public void EnsureWebView() { }

    // TODO(port-browser): func goBack()
    public void GoBack() { }

    // TODO(port-browser): func goForward()
    public void GoForward() { }

    // TODO(port-browser): func reload()
    public void Reload() { }

    // TODO(port-browser): func zoom(by delta: CGFloat)  (WebView2 ZoomFactor, clamped to 0.5...3)
    public void Zoom(double delta) { }

    // TODO(port-browser): func resetZoom()
    public void ResetZoom() { }

    // TODO(port-browser): func pausePlayback()
    public void PausePlayback() { }

    // TODO(port-browser): func play()
    public void Play() { }

    // TODO(port-browser): func togglePlayback()
    public void TogglePlayback() { }

    // TODO(port-browser): func seek(to seconds: Double)
    public void Seek(double seconds) { }

    // TODO(port-browser): func skip(by seconds: Double)
    public void Skip(double seconds) { }

    // TODO(port-browser): func fadeOut(over seconds: Double)  (media.js fadeOut(max(0.5, seconds)))
    public void FadeOut(double seconds) { }

    // TODO(port-browser): func cancelFade()
    public void CancelFade() { }

    // TODO(port-browser): func togglePictureInPicture()
    public void TogglePictureInPicture() { }

    // TODO(port-browser): func setAmbient(_ on: Bool)
    public void SetAmbient(bool on) { }

    // TODO(port-browser): func setTheater(_ on: Bool)
    public void SetTheater(bool on) { }

    // TODO(port-browser): func applyVoiceBoost()
    public void ApplyVoiceBoost() { }

    // TODO(port-browser): func applyCaptions(force: Bool = false)
    public void ApplyCaptions(bool force = false) { }

    /// Light from the film when the page won't let its video be read: a small capture of the
    /// window where the picture is, sampled into six zones. Null when the capture failed.
    // TODO(port-browser): AppModel.sampleWindow(of:) on the Mac: WindowCapture.image(of: webView,
    // rect: frames.pictureRect(tab:) ?? bounds, maxPixel: 48) then ColorZones.sample. On Windows,
    // Windows.Graphics.Capture of the main window cropped to the WebView2's video rect.
    public Task<IReadOnlyList<AmbientModel.Rgb>?> CaptureWindowZonesAsync() => Task.FromResult<IReadOnlyList<AmbientModel.Rgb>?>(null);

    /// The same from the page's own snapshot, which often comes back black for hardware video.
    // TODO(port-browser): AppModel.sampleSnapshot(of:) on the Mac: WKWebView.takeSnapshot(width 48)
    // then ColorZones.sample. On Windows, CoreWebView2.CapturePreviewAsync.
    public Task<IReadOnlyList<AmbientModel.Rgb>?> SnapshotZonesAsync() => Task.FromResult<IReadOnlyList<AmbientModel.Rgb>?>(null);
}
