using System.Runtime.InteropServices;
using static SecondScreen.Topology;

namespace SecondScreen.App;

/// <summary>
/// Per-display scaling ("Scale" in Settings). Windows offers no public API for it;
/// this uses the DisplayConfig device-info types Settings itself uses (-3 get, -4 set),
/// as tools such as SetDpi do. Treat it as best effort: report what actually applied.
/// </summary>
internal static class DisplayScale
{
    private static readonly int[] Steps = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

    /// <summary>Set <paramref name="device"/> (such as \\.\DISPLAY5) to <paramref name="percent"/>.</summary>
    public static bool Set(string device, int percent)
    {
        if (!Query(QDC_ONLY_ACTIVE_PATHS, out var paths, out _, out _)) return false;
        int index = Array.FindIndex(paths, p => string.Equals(SourceName(p), device, StringComparison.OrdinalIgnoreCase));
        if (index < 0) return false;
        var source = paths[index].sourceInfo;

        var get = new DPI_SCALE_GET
        {
            header = new DEVICE_INFO_HEADER { type = -3, size = Marshal.SizeOf<DPI_SCALE_GET>(), adapterId = source.adapterId, id = source.id },
        };
        if (DisplayConfigGetDeviceInfo(ref get) != 0) return false;

        // Scales are relative to the display's recommended step, which sits
        // |minScaleRel| steps above 100%.
        int recommended = Math.Abs(get.minScaleRel);
        int wanted = Array.IndexOf(Steps, percent);
        if (wanted < 0) return false;
        var set = new DPI_SCALE_SET
        {
            header = new DEVICE_INFO_HEADER { type = -4, size = Marshal.SizeOf<DPI_SCALE_SET>(), adapterId = source.adapterId, id = source.id },
            scaleRel = Math.Clamp(wanted - recommended, get.minScaleRel, get.maxScaleRel),
        };
        return DisplayConfigSetDeviceInfo(ref set) == 0;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DPI_SCALE_GET { public DEVICE_INFO_HEADER header; public int minScaleRel; public int curScaleRel; public int maxScaleRel; }

    [StructLayout(LayoutKind.Sequential)]
    private struct DPI_SCALE_SET { public DEVICE_INFO_HEADER header; public int scaleRel; }

    [DllImport("user32.dll")] private static extern int DisplayConfigGetDeviceInfo(ref DPI_SCALE_GET info);
    [DllImport("user32.dll")] private static extern int DisplayConfigSetDeviceInfo(ref DPI_SCALE_SET info);
}
