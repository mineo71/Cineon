using System.Text.Json;
using Microsoft.UI.Windowing;
using Windows.Graphics;

namespace Cineon.App.UI;

/// Remembers where the window was, like the Mac's frame autosave, and opens centred the first time.
/// Test runs keep their own copy, since it lives in the data folder.
public static class WindowPlacement
{
    private sealed record Saved(int X, int Y, int Width, int Height, bool Maximized);

    private static string FilePath => Path.Combine(Cineon.Core.Data.AppPaths.Root, "window.json");

    /// Puts the window where it was, if that's still on a screen, or centred at `width`×`height`
    /// view pixels on the primary screen.
    public static void Restore(AppWindow window, double width, double height)
    {
        var saved = Load();
        if (saved is not null && saved.Width >= 400 && saved.Height >= 300)
        {
            var rect = new RectInt32(saved.X, saved.Y, saved.Width, saved.Height);
            var area = DisplayArea.GetFromRect(rect, DisplayAreaFallback.None);
            if (area is not null)
            {
                window.MoveAndResize(rect);
                if (saved.Maximized && window.Presenter is OverlappedPresenter p) p.Maximize();
                return;
            }
        }
        var display = DisplayArea.Primary;
        var work = display.WorkArea;
        var scale = Scale(window);
        var w = Math.Min((int)(width * scale), work.Width);
        var h = Math.Min((int)(height * scale), work.Height);
        window.MoveAndResize(new RectInt32(work.X + (work.Width - w) / 2, work.Y + (work.Height - h) / 2, w, h));
    }

    /// Saves the placement whenever the window settles somewhere new.
    public static void Track(AppWindow window)
    {
        window.Changed += (_, change) =>
        {
            if (!(change.DidPositionChange || change.DidSizeChange || change.DidPresenterChange)) return;
            if (window.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized }) return;
            if (window.Presenter.Kind == AppWindowPresenterKind.FullScreen) return;
            var maximized = window.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Maximized };
            // A maximized window keeps the size it had before, so restoring it un-maximizes sensibly.
            var previous = Load();
            var rect = maximized && previous is not null
                ? new RectInt32(previous.X, previous.Y, previous.Width, previous.Height)
                : new RectInt32(window.Position.X, window.Position.Y, window.Size.Width, window.Size.Height);
            Save(new Saved(rect.X, rect.Y, rect.Width, rect.Height, maximized));
        };
    }

    private static double Scale(AppWindow window)
    {
        try
        {
            var dpi = GetDpiForWindow(Microsoft.UI.Win32Interop.GetWindowFromWindowId(window.Id));
            return dpi > 0 ? dpi / 96.0 : 1;
        }
        catch
        {
            return 1;
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(nint hwnd);

    private static Saved? Load()
    {
        try { return JsonSerializer.Deserialize<Saved>(File.ReadAllText(FilePath)); }
        catch { return null; }
    }

    private static void Save(Saved saved)
    {
        try { File.WriteAllText(FilePath, JsonSerializer.Serialize(saved)); }
        catch { }
    }
}
