using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cineon.App.Browser;

/// The page scripts shared with the Mac (`Cineon/Resources/Scripts/*.js`), adapted for WebView2.
///
/// On the Mac they post through `window.webkit.messageHandlers.<name>`. Here each script's lookup of
/// those handlers is pointed at `__cineonHandlers`, which a small shim injected first provides in
/// every frame. It sends `{cineon: 1, h: name, b: body, id}` through `chrome.webview.postMessage`;
/// `cineonMediaReply` returns a Promise that resolves when the app answers (`ScriptMessage.Reply`).
/// Pages never see a `window.webkit`, so sites don't mistake Chromium for Safari.
public static class PageScripts
{
    private const string MacHandlers = "window.webkit && window.webkit.messageHandlers";
    private const string WindowsHandlers = "window.__cineonHandlers";

    public static readonly string Shim = """
        (() => {
          if (window.__cineonHandlers) return;
          const wv = window.chrome && window.chrome.webview;
          const pending = new Map();
          let next = 1;
          const post = (h, b, id) => { try { wv && wv.postMessage({ cineon: 1, h, b, id }); } catch (_) {} };
          if (wv) wv.addEventListener('message', (e) => {
            const d = e.data;
            if (!d || !d.cineonReply) return;
            const resolve = pending.get(d.id);
            if (resolve) { pending.delete(d.id); resolve(d.value); }
          });
          const make = (h, withReply) => ({
            postMessage(b) {
              if (!withReply) { post(h, b); return; }
              const id = next++;
              return new Promise((resolve) => { pending.set(id, resolve); post(h, b, id); });
            },
          });
          Object.defineProperty(window, '__cineonHandlers', {
            value: {
              cineonMedia: make('cineonMedia'),
              cineonMeta: make('cineonMeta'),
              cineonMediaReply: make('cineonMediaReply', true),
              cineonShield: make('cineonShield'),
            },
            enumerable: false,
          });
        })();
        """;

    public static string Media => Load("media.js");
    public static string Meta => Load("meta.js");
    public static string Shield => Load("shield.js");
    public static string Theater => Load("theater.js");

    private static readonly Dictionary<string, string> Cache = [];

    public static string Load(string name)
    {
        lock (Cache)
        {
            if (Cache.TryGetValue(name, out var cached)) return cached;
            var path = Path.Combine(AppContext.BaseDirectory, "Scripts", name);
            var source = File.ReadAllText(path).Replace(MacHandlers, WindowsHandlers);
            Cache[name] = source;
            return source;
        }
    }

    /// The Mac runs meta.js at document end in the main frame only. WebView2 runs every injected
    /// script at document creation in every frame, so this wrapper waits and checks.
    public static string MainFrameAtDocumentEnd(string source) => $$"""
        (() => {
          if (window.top !== window) return;
          const run = () => { {{source}} };
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
          else run();
        })();
        """;
}

/// One message from a page script.
public sealed class ScriptMessage
{
    /// `cineonMedia`, `cineonMeta`, `cineonMediaReply` or `cineonShield`.
    public required string Handler { get; init; }
    public required JsonElement Body { get; init; }
    /// The frame that sent it, or null for the main frame.
    public CoreWebView2Frame? Frame { get; init; }
    public string Source { get; init; } = "";
    internal int? ReplyId { get; init; }
    internal Action<string>? Send { get; init; }

    /// Answers a `cineonMediaReply` message. `value` is serialized to JSON.
    public void Reply(object? value)
    {
        if (ReplyId is not { } id || Send is null) return;
        Send(JsonSerializer.Serialize(new { cineonReply = 1, id, value }));
    }
}

/// Installs the scripts in a WebView, follows its frames, and turns their posts into `ScriptMessage`s.
public sealed class ScriptBridge
{
    private readonly CoreWebView2 _web;
    private readonly List<string> _scriptIds = [];
    private readonly Dictionary<CoreWebView2Frame, bool> _frames = [];

    public event Action<ScriptMessage>? Received;

    /// Frames that are still alive, child frames included.
    public IReadOnlyCollection<CoreWebView2Frame> Frames => _frames.Keys;

    public ScriptBridge(CoreWebView2 web)
    {
        _web = web;
        _web.WebMessageReceived += (_, e) => Handle(e.WebMessageAsJson, e.Source, null, json => _web.PostWebMessageAsJson(json));
        _web.FrameCreated += (_, e) => Follow(e.Frame);
    }

    private void Follow(CoreWebView2Frame frame)
    {
        _frames[frame] = true;
        frame.Destroyed += (_, _) => _frames.Remove(frame);
        frame.WebMessageReceived += (_, e) => Handle(e.WebMessageAsJson, e.Source, frame, json => { try { frame.PostWebMessageAsJson(json); } catch { } });
        frame.FrameCreated += (_, e) => Follow(e.Frame);
    }

    /// Installs the shim and page scripts for every new document. The overlay sweeper (shield.js)
    /// is optional, like on the Mac.
    public async Task InstallAsync(bool overlaySweeper)
    {
        foreach (var id in _scriptIds) _web.RemoveScriptToExecuteOnDocumentCreated(id);
        _scriptIds.Clear();
        _scriptIds.Add(await _web.AddScriptToExecuteOnDocumentCreatedAsync(PageScripts.Shim));
        _scriptIds.Add(await _web.AddScriptToExecuteOnDocumentCreatedAsync(PageScripts.Media));
        _scriptIds.Add(await _web.AddScriptToExecuteOnDocumentCreatedAsync(PageScripts.MainFrameAtDocumentEnd(PageScripts.Meta)));
        if (overlaySweeper) _scriptIds.Add(await _web.AddScriptToExecuteOnDocumentCreatedAsync(PageScripts.Shield));
    }

    /// Runs `script` in `frame`, or in the main frame when it's null or gone. Returns the JSON result.
    public async Task<string?> RunAsync(string script, CoreWebView2Frame? frame = null)
    {
        try
        {
            if (frame is not null && _frames.ContainsKey(frame)) return await frame.ExecuteScriptAsync(script);
            return await _web.ExecuteScriptAsync(script);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private void Handle(string json, string source, CoreWebView2Frame? frame, Action<string> send)
    {
        JsonDocument document;
        try { document = JsonDocument.Parse(json); }
        catch (JsonException) { return; }
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("cineon", out _)) return;
        if (!root.TryGetProperty("h", out var handler) || handler.ValueKind != JsonValueKind.String) return;
        root.TryGetProperty("b", out var body);
        int? replyId = root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number ? id.GetInt32() : null;
        Received?.Invoke(new ScriptMessage
        {
            Handler = handler.GetString()!,
            Body = body.Clone(),
            Frame = frame,
            Source = source,
            ReplyId = replyId,
            Send = send,
        });
    }
}
