using Microsoft.Web.WebView2.Core;

namespace Cineon.App.Browser;

/// A WebView2 nobody sees, for rescue probes and the season grabber's helper tab. The Mac makes a
/// WKWebView that belongs to no window. Here it's a plain controller parked far outside the main
/// window's client area, kept "visible" so that players load and play, which they don't in a
/// hidden or minimised view. Create, use and close on the UI thread.
internal sealed class HeadlessWebView
{
    /// Big enough for sites to serve their desktop layout and players.
    private static readonly Windows.Foundation.Rect Parked = new(-30000, -30000, 1280, 800);

    private CoreWebView2Controller? _controller;

    private HeadlessWebView(CoreWebView2Controller controller)
    {
        _controller = controller;
        Core = controller.CoreWebView2;
    }

    public CoreWebView2 Core { get; }

    public bool IsClosed => _controller is null;

    /// Null when there's no window to park it in yet, or WebView2 failed.
    public static async Task<HeadlessWebView?> CreateAsync(WebEnvironment web)
    {
        var window = AppModel.Shared?.Window?.Handle ?? IntPtr.Zero;
        if (window == IntPtr.Zero || web.IsTornDown) return null;
        try
        {
            var environment = await web.EnvironmentAsync();
            var parent = CoreWebView2ControllerWindowReference.CreateFromWindowHandle((ulong)window.ToInt64());
            var controller = await environment.CreateCoreWebView2ControllerAsync(parent);
            controller.Bounds = Parked;
            controller.IsVisible = true;
            WebEnvironment.Configure(controller.CoreWebView2);
            return new HeadlessWebView(controller);
        }
        catch (Exception error)
        {
            CrashLog.Write("headless web view", error);
            return null;
        }
    }

    public void Close()
    {
        if (_controller is not { } controller) return;
        _controller = null;
        try
        {
            Core.Stop();
            controller.Close();
        }
        catch (Exception)
        {
            // Already gone with its browser process.
        }
    }
}
