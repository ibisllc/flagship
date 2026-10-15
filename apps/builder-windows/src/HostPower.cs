using System.Runtime.InteropServices;

namespace Flagship.Builder;

/// <summary>Keeps Windows out of idle sleep while hosted servers need it (the
/// Mac's idleSystemSleepDisabled activity). The display may still turn off;
/// closing a laptop lid or choosing Sleep still sleeps the PC.</summary>
internal static class HostPower
{
    private const uint EsContinuous = 0x80000000;
    private const uint EsSystemRequired = 0x00000001;

    [DllImport("kernel32.dll")]
    private static extern uint SetThreadExecutionState(uint esFlags);

    /// <summary>Call on the UI thread: the request lasts as long as the
    /// thread that made it.</summary>
    public static void KeepAwake(bool on)
        => SetThreadExecutionState(on ? EsContinuous | EsSystemRequired : EsContinuous);
}
