using System.Runtime.InteropServices;

namespace SecondScreen.App;

/// <summary>
/// The display topology (QueryDisplayConfig/SetDisplayConfig): which source outputs drive
/// which monitors. This is how Settings extends the desktop onto a display. A detached
/// output reports no modes, so ChangeDisplaySettingsEx cannot attach it; activating its
/// path here can, after which ordinary mode changes work.
/// </summary>
internal static class Topology
{
    /// <summary>Extend the desktop onto <paramref name="device"/> (such as \\.\DISPLAY5) at a mode Windows picks.</summary>
    public static string? Activate(string device)
    {
        if (!Query(QDC_ALL_PATHS, out var paths, out var modes, out var error)) return error;

        var active = paths.Where(p => (p.flags & PATH_ACTIVE) != 0).ToList();
        var busyTargets = active.Select(p => (p.targetInfo.adapterId.LowPart, p.targetInfo.adapterId.HighPart, p.targetInfo.id)).ToHashSet();
        if (active.Any(p => SourceName(p) == device)) return null; // already on the desktop

        int index = Array.FindIndex(paths, p =>
            (p.flags & PATH_ACTIVE) == 0
            && p.targetInfo.targetAvailable != 0
            && !busyTargets.Contains((p.targetInfo.adapterId.LowPart, p.targetInfo.adapterId.HighPart, p.targetInfo.id))
            && string.Equals(SourceName(p), device, StringComparison.OrdinalIgnoreCase));
        if (index < 0) return $"no available monitor path for {device}";

        var path = paths[index];
        path.flags |= PATH_ACTIVE;
        path.sourceInfo.modeInfoIdx = MODE_IDX_INVALID;
        path.targetInfo.modeInfoIdx = MODE_IDX_INVALID;
        active.Add(path);

        var applied = active.ToArray();
        int result = SetDisplayConfig((uint)applied.Length, applied, (uint)modes.Length, modes,
            SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES | SDC_SAVE_TO_DATABASE);
        return result == 0 ? null : $"SetDisplayConfig failed with {result} activating {device}";
    }

    /// <summary>Remove <paramref name="device"/> from the desktop; Windows moves its windows elsewhere.</summary>
    public static string? Deactivate(string device)
    {
        if (!Query(QDC_ONLY_ACTIVE_PATHS, out var paths, out var modes, out var error)) return error;
        var remaining = paths.Where(p => !string.Equals(SourceName(p), device, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (remaining.Length == paths.Length) return null; // not on the desktop
        if (remaining.Length == 0) return "refusing to detach the last display";
        int result = SetDisplayConfig((uint)remaining.Length, remaining, (uint)modes.Length, modes,
            SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES | SDC_SAVE_TO_DATABASE);
        return result == 0 ? null : $"SetDisplayConfig failed with {result} detaching {device}";
    }

    /// <summary>The GDI device name (\\.\DISPLAYn) of the path's source.</summary>
    public static string? SourceName(PATH_INFO path)
    {
        var name = new SOURCE_DEVICE_NAME
        {
            header = new DEVICE_INFO_HEADER
            {
                type = 1, // DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME
                size = Marshal.SizeOf<SOURCE_DEVICE_NAME>(),
                adapterId = path.sourceInfo.adapterId,
                id = path.sourceInfo.id,
            },
        };
        return DisplayConfigGetDeviceInfo(ref name) == 0 ? name.viewGdiDeviceName : null;
    }

    public static bool Query(uint flags, out PATH_INFO[] paths, out MODE_INFO[] modes, out string? error)
    {
        paths = Array.Empty<PATH_INFO>();
        modes = Array.Empty<MODE_INFO>();
        error = null;
        // The topology can change between sizing and querying; retry then.
        for (int attempt = 0; attempt < 3; attempt++)
        {
            if (GetDisplayConfigBufferSizes(flags, out uint pathCount, out uint modeCount) is int sized && sized != 0)
            {
                error = $"GetDisplayConfigBufferSizes failed with {sized}";
                return false;
            }
            paths = new PATH_INFO[pathCount];
            modes = new MODE_INFO[modeCount];
            int result = QueryDisplayConfig(flags, ref pathCount, paths, ref modeCount, modes, 0);
            if (result == 0)
            {
                Array.Resize(ref paths, (int)pathCount);
                Array.Resize(ref modes, (int)modeCount);
                return true;
            }
            if (result != ERROR_INSUFFICIENT_BUFFER)
            {
                error = $"QueryDisplayConfig failed with {result}";
                return false;
            }
        }
        error = "the display topology kept changing";
        return false;
    }

    public const uint QDC_ALL_PATHS = 1;
    public const uint QDC_ONLY_ACTIVE_PATHS = 2;
    private const uint PATH_ACTIVE = 1;
    private const uint MODE_IDX_INVALID = 0xFFFFFFFF;
    private const uint SDC_USE_SUPPLIED_DISPLAY_CONFIG = 0x20;
    private const uint SDC_APPLY = 0x80;
    private const uint SDC_SAVE_TO_DATABASE = 0x200;
    private const uint SDC_ALLOW_CHANGES = 0x400;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;

    [StructLayout(LayoutKind.Sequential)]
    public struct LUID { public uint LowPart; public int HighPart; }

    [StructLayout(LayoutKind.Sequential)]
    public struct DEVICE_INFO_HEADER { public int type; public int size; public LUID adapterId; public uint id; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SOURCE_DEVICE_NAME
    {
        public DEVICE_INFO_HEADER header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PATH_SOURCE_INFO { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }

    [StructLayout(LayoutKind.Sequential)]
    public struct PATH_TARGET_INFO
    {
        public LUID adapterId; public uint id; public uint modeInfoIdx; public int outputTechnology;
        public int rotation; public int scaling; public uint refreshNumerator; public uint refreshDenominator;
        public int scanLineOrdering; public int targetAvailable; public uint statusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PATH_INFO { public PATH_SOURCE_INFO sourceInfo; public PATH_TARGET_INFO targetInfo; public uint flags; }

    /// <summary>DISPLAYCONFIG_MODE_INFO is 64 bytes; it is passed back to Windows untouched.</summary>
    [StructLayout(LayoutKind.Sequential, Size = 64)]
    public struct MODE_INFO { public int infoType; }

    [DllImport("user32.dll")] public static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
    [DllImport("user32.dll")] public static extern int QueryDisplayConfig(uint flags, ref uint pathCount, [Out] PATH_INFO[] paths, ref uint modeCount, [Out] MODE_INFO[] modes, nint topology);
    [DllImport("user32.dll")] public static extern int SetDisplayConfig(uint pathCount, [In] PATH_INFO[] paths, uint modeCount, [In] MODE_INFO[] modes, uint flags);
    [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref SOURCE_DEVICE_NAME info);
}
