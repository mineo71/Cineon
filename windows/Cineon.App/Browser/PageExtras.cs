using Cineon.App.UI;

namespace Cineon.App.Browser;

/// Small scripts the Windows app adds to every frame, after the shared ones. They do what WebKit
/// gives the Mac for free: the menus' shortcuts while a page has focus, which links someone
/// actually clicked (WebKit's navigation types), and the ad rules' hiding CSS in every frame
/// (WebKit's css-display-none rules).
public static class PageExtras
{
    /// Forwards the app's shortcuts, which a page with focus would otherwise keep: on the Mac the
    /// menus see ⌘ keys before the web view does. `shortcuts` are the ones to take from the page,
    /// as "ctrl,shift,alt,keyCode"; JavaScript's keyCode is the Windows virtual key. Esc and F10
    /// are passed on too, without being taken, so the page can still close its own things.
    public static string Keys(IEnumerable<Shortcut> shortcuts)
    {
        var ids = shortcuts.Select(s => $"{(s.Control ? 1 : 0)},{(s.Shift ? 1 : 0)},{(s.Alt ? 1 : 0)},{(int)s.Key}").Distinct();
        return $$"""
            (() => {
              if (window.__cineonKeys) return;
              window.__cineonKeys = true;
              const h = window.__cineonHandlers;
              if (!h || !h.cineonKey) return;
              const taken = new Set({{Json.Literal(ids.ToArray())}});
              // Text fields keep what they use these keys for: redo, and selecting a word at a time.
              const textKeys = new Set(['1,0,0,89', '1,1,0,37', '1,1,0,39']);
              const editable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
              window.addEventListener('keydown', (e) => {
                if (!e.isTrusted) return;
                const k = e.keyCode;
                const plain = !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
                if (plain && (k === 27 || k === 121)) {
                  if (e.repeat) return;
                  if (k === 121) e.preventDefault();
                  h.cineonKey.postMessage({ k, c: false, s: false, a: false });
                  return;
                }
                if (!e.ctrlKey) return;
                const id = `${e.ctrlKey ? 1 : 0},${e.shiftKey ? 1 : 0},${e.altKey ? 1 : 0},${k}`;
                if (!taken.has(id)) return;
                const target = e.composedPath ? e.composedPath()[0] : e.target;
                if (textKeys.has(id) && editable(target)) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                h.cineonKey.postMessage({ k, c: e.ctrlKey, s: e.shiftKey, a: e.altKey });
              }, true);
            })();
            """;
    }

    /// Says which link someone pressed, just before the navigation it starts. WebView2 only says
    /// whether a navigation had a user gesture; WebKit says whether it was a link, a form or a
    /// script, and the redirect shield needs to know.
    public const string Links = """
        (() => {
          if (window.__cineonLinks) return;
          window.__cineonLinks = true;
          const h = window.__cineonHandlers;
          if (!h || !h.cineonLink) return;
          const top = window === window.top;
          const hrefOf = (a) => typeof a.href === 'string' ? a.href : (a.href && a.href.baseVal) || '';
          const note = (e) => {
            if (!e.isTrusted) return;
            const path = e.composedPath ? e.composedPath() : [];
            for (const node of path) {
              if (node && node.tagName && node.tagName.toUpperCase() === 'A' && hrefOf(node)) {
                h.cineonLink.postMessage({ href: String(new URL(hrefOf(node), location.href)), top });
                return;
              }
            }
          };
          window.addEventListener('pointerdown', note, true);
          window.addEventListener('keydown', (e) => { if (e.key === 'Enter') note(e); }, true);
          window.addEventListener('submit', (e) => {
            if (!e.isTrusted) return;
            const form = e.target;
            const action = form && form.action ? String(form.action) : location.href;
            h.cineonLink.postMessage({ href: action, top, form: true });
          }, true);
        })();
        """;

    /// Asks the app for the ad rules' hiding CSS for the page this frame is in, and adds it.
    /// A constructed stylesheet, because a site's content security policy can forbid style
    /// elements; a style element if that fails.
    public const string Css = """
        (() => {
          if (window.__cineonCss) return;
          window.__cineonCss = true;
          const h = window.__cineonHandlers;
          if (!h || !h.cineonCss) return;
          let top = location.href;
          if (window.top !== window) {
            try { top = window.top.location.href; } catch (_) {
              const origins = location.ancestorOrigins;
              top = origins && origins.length ? origins[origins.length - 1] : '';
            }
          }
          Promise.resolve(h.cineonCss.postMessage({ top })).then((css) => {
            if (!css || typeof css !== 'string') return;
            try {
              const sheet = new CSSStyleSheet();
              sheet.replaceSync(css);
              document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
            } catch (_) {
              const add = () => {
                const style = document.createElement('style');
                style.textContent = css;
                (document.head || document.documentElement).appendChild(style);
              };
              if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add, { once: true });
            }
          }).catch(() => {});
        })();
        """;

    /// Page zoom. WinUI's WebView2 doesn't expose the controller's zoom factor, so the zoom is CSS
    /// zoom on the page, put back on every new document in the tab.
    public static string Zoom(double factor) =>
        $"(() => {{ const z = {Json.Num(factor)}; const apply = () => {{ if (document.documentElement) document.documentElement.style.zoom = z === 1 ? '' : String(z); }}; if (document.documentElement) apply(); else document.addEventListener('DOMContentLoaded', apply, {{ once: true }}); }})();";
}
