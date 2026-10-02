using System.Runtime.InteropServices;

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
        if (!TryFindSource(device, out var adapter, out var source)) return false;
        var get = new DPI_SCALE_GET
        {
            header = new DEVICE_INFO_HEADER { type = -3, size = Marshal.SizeOf<DPI_SCALE_GET>(), adapterId = adapter, id = source },
        };
        if (DisplayConfigGetDeviceInfo(ref get) != 0) return false;

        // Scales are relative to the display's recommended step, which sits
        // |minScaleRel| steps above 100%.
        int recommended = Math.Abs(get.minScaleRel);
        int wanted = Array.IndexOf(Steps, percent);
        if (wanted < 0) return false;
        int relative = Math.Clamp(wanted - recommended, get.minScaleRel, get.maxScaleRel);
        var set = new DPI_SCALE_SET
        {
            header = new DEVICE_INFO_HEADER { type = -4, size = Marshal.SizeOf<DPI_SCALE_SET>(), adapterId = adapter, id = source },
            scaleRel = relative,
        };
        return DisplayConfigSetDeviceInfo(ref set) == 0;
    }

    private static bool TryFindSource(string device, out LUID adapter, out uint source)
    {
        adapter = default;
        source = 0;
        if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out uint pathCount, out uint modeCount) != 0) return false;
        var paths = new PATH_INFO[pathCount];
        var modes = new MODE_INFO[modeCount];
        if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref pathCount, paths, ref modeCount, modes, 0) != 0) return false;

        for (int i = 0; i < pathCount; i++)
        {
            var name = new SOURCE_DEVICE_NAME
            {
                header = new DEVICE_INFO_HEADER
                {
                    type = 1, // DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME
                    size = Marshal.SizeOf<SOURCE_DEVICE_NAME>(),
                    adapterId = paths[i].sourceInfo.adapterId,
                    id = paths[i].sourceInfo.id,
                },
            };
            if (DisplayConfigGetDeviceInfo(ref name) == 0
                && string.Equals(name.viewGdiDeviceName, device, StringComparison.OrdinalIgnoreCase))
            {
                adapter = paths[i].sourceInfo.adapterId;
                source = paths[i].sourceInfo.id;
                return true;
            }
        }
        return false;
    }

    private const uint QDC_ONLY_ACTIVE_PATHS = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct LUID { public uint LowPart; public int HighPart; }

    [StructLayout(LayoutKind.Sequential)]
    private struct DEVICE_INFO_HEADER { public int type; public int size; public LUID adapterId; public uint id; }

    [StructLayout(LayoutKind.Sequential)]
    private struct DPI_SCALE_GET { public DEVICE_INFO_HEADER header; public int minScaleRel; public int curScaleRel; public int maxScaleRel; }

    [StructLayout(LayoutKind.Sequential)]
    private struct DPI_SCALE_SET { public DEVICE_INFO_HEADER header; public int scaleRel; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SOURCE_DEVICE_NAME
    {
        public DEVICE_INFO_HEADER header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PATH_SOURCE_INFO { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PATH_TARGET_INFO
    {
        public LUID adapterId; public uint id; public uint modeInfoIdx; public int outputTechnology;
        public int rotation; public int scaling; public uint refreshNumerator; public uint refreshDenominator;
        public int scanLineOrdering; public int targetAvailable; public uint statusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PATH_INFO { public PATH_SOURCE_INFO sourceInfo; public PATH_TARGET_INFO targetInfo; public uint flags; }

    /// <summary>DISPLAYCONFIG_MODE_INFO: 64 bytes; only its size matters here.</summary>
    [StructLayout(LayoutKind.Sequential, Size = 64)]
    private struct MODE_INFO { public int infoType; }

    [DllImport("user32.dll")] private static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
    [DllImport("user32.dll")] private static extern int QueryDisplayConfig(uint flags, ref uint pathCount, [Out] PATH_INFO[] paths, ref uint modeCount, [Out] MODE_INFO[] modes, nint topology);
    [DllImport("user32.dll")] private static extern int DisplayConfigGetDeviceInfo(ref DPI_SCALE_GET info);
    [DllImport("user32.dll")] private static extern int DisplayConfigGetDeviceInfo(ref SOURCE_DEVICE_NAME info);
    [DllImport("user32.dll")] private static extern int DisplayConfigSetDeviceInfo(ref DPI_SCALE_SET info);
}
