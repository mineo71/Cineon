namespace Cineon.Core.Shields;

/// <summary>
/// What a request is for. The names and values match WebView2's <c>CoreWebView2WebResourceContext</c>,
/// so the app can convert with <c>(ResourceType)(int)args.ResourceContext</c>. Core has no WebView2
/// reference, which is why the enum is repeated here.
/// </summary>
public enum ResourceType
{
    All = 0,
    Document = 1,
    Stylesheet = 2,
    Image = 3,
    Media = 4,
    Font = 5,
    Script = 6,
    XmlHttpRequest = 7,
    Fetch = 8,
    TextTrack = 9,
    EventSource = 10,
    Websocket = 11,
    Manifest = 12,
    SignedExchange = 13,
    Ping = 14,
    CspViolationReport = 15,
    Other = 16,
}

/// <summary>What to do with a request.</summary>
public enum Decision
{
    Allow,
    Block,
}

/// <summary>
/// WebKit's content-blocker resource types, the ones the Mac converter emits, as bits. A rule
/// without a resource-type applies to all of them.
/// </summary>
[Flags]
internal enum KitType : ushort
{
    None = 0,
    Document = 1 << 0,
    Image = 1 << 1,
    StyleSheet = 1 << 2,
    Script = 1 << 3,
    Font = 1 << 4,
    Media = 1 << 5,
    Fetch = 1 << 6,
    Websocket = 1 << 7,
    Other = 1 << 8,
    Ping = 1 << 9,
    All = (1 << 10) - 1,
}

internal static class KitTypes
{
    /// <summary>The list FilterConverter.swift uses when a rule excludes types.</summary>
    internal static readonly string[] AllNames =
        ["document", "image", "style-sheet", "script", "font", "media", "fetch", "websocket", "other", "ping"];

    internal static KitType FromName(string name) => name switch
    {
        "document" => KitType.Document,
        "image" => KitType.Image,
        "style-sheet" => KitType.StyleSheet,
        "script" => KitType.Script,
        "font" => KitType.Font,
        "media" => KitType.Media,
        "fetch" => KitType.Fetch,
        "websocket" => KitType.Websocket,
        "other" => KitType.Other,
        "ping" => KitType.Ping,
        _ => KitType.None,
    };

    /// <summary>How WebKit would classify the load Chromium reports.</summary>
    internal static KitType From(ResourceType type) => type switch
    {
        ResourceType.Document => KitType.Document,
        ResourceType.Stylesheet => KitType.StyleSheet,
        ResourceType.Image => KitType.Image,
        ResourceType.Media or ResourceType.TextTrack => KitType.Media,
        ResourceType.Font => KitType.Font,
        ResourceType.Script => KitType.Script,
        ResourceType.XmlHttpRequest or ResourceType.Fetch or ResourceType.EventSource => KitType.Fetch,
        ResourceType.Websocket => KitType.Websocket,
        ResourceType.Ping or ResourceType.CspViolationReport => KitType.Ping,
        _ => KitType.Other,
    };
}
