using System.Runtime.InteropServices;

namespace Cineon.App.Playback;

/// Keeps the screen on while a film plays, as the Films & TV app and Edge do. The moment it pauses,
/// ends or stalls, Windows dims and sleeps on its usual schedule again.
///
/// SetThreadExecutionState belongs to the thread that calls it, so this is only used from the UI thread.
public sealed class StayAwake : IDisposable
{
    public const string Reason = "Playing a film in Cineon";

    private const uint EsContinuous = 0x80000000;
    private const uint EsSystemRequired = 0x00000001;
    private const uint EsDisplayRequired = 0x00000002;

    public bool IsHolding { get; private set; }

    public void Hold(bool on)
    {
        if (on == IsHolding) return;
        if (on)
        {
            if (SetThreadExecutionState(EsContinuous | EsDisplayRequired | EsSystemRequired) == 0) return;
            IsHolding = true;
        }
        else
        {
            SetThreadExecutionState(EsContinuous);
            IsHolding = false;
        }
    }

    public void Dispose() => Hold(false);

    [DllImport("kernel32.dll")]
    private static extern uint SetThreadExecutionState(uint flags);
}
