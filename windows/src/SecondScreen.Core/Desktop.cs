using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace SecondScreen;

/// <summary>A monitor that is part of the desktop. Coordinates are physical pixels.</summary>
public sealed record DisplayInfo(string Device, Rect Bounds, Rect WorkArea, bool IsPrimary, bool IsVirtual, int ScalePercent)
{
    public bool HiDpi => ScalePercent >= 200;
    public int LogicalWidth => Bounds.Width * 100 / Math.Max(ScalePercent, 100);
    public int LogicalHeight => Bounds.Height * 100 / Math.Max(ScalePercent, 100);
}

/// <summary>A visible top-level window of another process.</summary>
public sealed record WindowInfo(nint Handle, int Pid, string App, string Title, Rect Frame)
{
    public long Id => Handle;

    public WindowSummary ToSummary() =>
        new() { Pid = Pid, WindowId = Id, App = App, Title = Title, Frame = new Frame(Frame) };

    public string Label => Title.Length == 0 || Title == App ? App : $"{App} — {Title}";
}

[SupportedOSPlatform("windows")]
public static class Desktop
{
    /// <summary>The adapter name the Virtual Display Driver registers.</summary>
    public const string VirtualAdapterName = "Virtual Display Driver";

    /// <summary>
    /// Report and accept physical pixels everywhere. Call first thing in every process,
    /// so window and monitor coordinates agree with cua-driver's.
    /// </summary>
    public static void BecomeDpiAware() => Native.SetProcessDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    // MARK: Displays

    public static List<DisplayInfo> Displays()
    {
        var virtualDevices = VirtualDevices().Where(d => d.Attached).Select(d => d.Device).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var displays = new List<DisplayInfo>();
        Native.EnumDisplayMonitors(0, 0, (nint monitor, nint _, ref Native.RECT _, nint _) =>
        {
            var info = new Native.MONITORINFOEX { cbSize = (uint)Marshal.SizeOf<Native.MONITORINFOEX>(), szDevice = "" };
            if (Native.GetMonitorInfo(monitor, ref info))
            {
                int scale = Native.GetDpiForMonitor(monitor, 0, out var dpi, out _) == 0 ? (int)Math.Round(dpi * 100 / 96.0) : 100;
                displays.Add(new DisplayInfo(info.szDevice, info.rcMonitor.ToRect(), info.rcWork.ToRect(),
                    (info.dwFlags & Native.MONITORINFOF_PRIMARY) != 0, virtualDevices.Contains(info.szDevice), scale));
            }
            return true;
        }, 0);
        return displays;
    }

    public static DisplayInfo? Display(string device) =>
        Displays().FirstOrDefault(d => string.Equals(d.Device, device, StringComparison.OrdinalIgnoreCase));

    public static DisplayInfo? DisplayContaining(Rect frame) =>
        Displays().FirstOrDefault(d => d.Bounds.ContainsCenterOf(frame));

    public static DisplayInfo Primary() => Displays().First(d => d.IsPrimary);

    /// <summary>Every display output the Virtual Display Driver provides, attached or not.</summary>
    public static List<(string Device, bool Attached)> VirtualDevices() =>
        AllDevices().Where(d => d.Adapter.Contains(VirtualAdapterName, StringComparison.OrdinalIgnoreCase))
            .Select(d => (d.Device, d.Attached)).ToList();

    /// <summary>Every display output of every adapter, attached or not.</summary>
    public static List<(string Device, string Adapter, bool Attached)> AllDevices()
    {
        var result = new List<(string, string, bool)>();
        for (uint i = 0; ; i++)
        {
            var device = new Native.DISPLAY_DEVICE { cb = (uint)Marshal.SizeOf<Native.DISPLAY_DEVICE>() };
            if (!Native.EnumDisplayDevices(null, i, ref device, 0)) break;
            result.Add((device.DeviceName, device.DeviceString, (device.StateFlags & Native.DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) != 0));
        }
        return result;
    }

    /// <summary>Resolutions the device offers, in physical pixels.</summary>
    public static HashSet<(int Width, int Height)> Modes(string device)
    {
        var modes = new HashSet<(int, int)>();
        for (int i = 0; ; i++)
        {
            var mode = Native.DEVMODE.Create();
            if (!Native.EnumDisplaySettings(device, i, ref mode)) break;
            modes.Add(((int)mode.dmPelsWidth, (int)mode.dmPelsHeight));
        }
        return modes;
    }

    /// <summary>
    /// Attach <paramref name="device"/> to the desktop at (<paramref name="x"/>, <paramref name="y"/>)
    /// with the given physical size, or move or resize it if already attached.
    /// </summary>
    /// <returns>0 on success, else a DISP_CHANGE code (see <see cref="DescribeChange"/>).</returns>
    public static int Attach(string device, int width, int height, int x, int y)
    {
        var mode = Native.DEVMODE.Create();
        mode.dmFields = Native.DM_POSITION | Native.DM_PELSWIDTH | Native.DM_PELSHEIGHT;
        mode.dmPelsWidth = (uint)width;
        mode.dmPelsHeight = (uint)height;
        mode.dmPositionX = x;
        mode.dmPositionY = y;
        // Persisting the layout is preferred, so it survives a reconnect; some sessions
        // refuse to write it, so fall back to changing only the current session.
        int result = Native.ChangeDisplaySettingsEx(device, ref mode, 0, Native.CDS_UPDATEREGISTRY | Native.CDS_NORESET, 0);
        if (result == Native.DISP_CHANGE_SUCCESSFUL) result = Native.ApplyDisplaySettings(0, 0, 0, 0, 0);
        if (result != Native.DISP_CHANGE_SUCCESSFUL) result = Native.ChangeDisplaySettingsEx(device, ref mode, 0, 0, 0);
        return result;
    }

    /// <summary>The name of a ChangeDisplaySettingsEx result code.</summary>
    public static string DescribeChange(int code) => code switch
    {
        0 => "DISP_CHANGE_SUCCESSFUL",
        1 => "DISP_CHANGE_RESTART",
        -1 => "DISP_CHANGE_FAILED",
        -2 => "DISP_CHANGE_BADMODE",
        -3 => "DISP_CHANGE_NOTUPDATED",
        -4 => "DISP_CHANGE_BADFLAGS",
        -5 => "DISP_CHANGE_BADPARAM",
        -6 => "DISP_CHANGE_BADDUALVIEW",
        _ => $"code {code}",
    };

    /// <summary>Detach <paramref name="device"/>; Windows moves its windows to the remaining displays.</summary>
    public static int Detach(string device)
    {
        var mode = Native.DEVMODE.Create();
        mode.dmFields = Native.DM_POSITION | Native.DM_PELSWIDTH | Native.DM_PELSHEIGHT;
        int result = Native.ChangeDisplaySettingsEx(device, ref mode, 0, Native.CDS_UPDATEREGISTRY | Native.CDS_NORESET, 0);
        return result == Native.DISP_CHANGE_SUCCESSFUL ? Native.ApplyDisplaySettings(0, 0, 0, 0, 0) : result;
    }

    // MARK: Windows

    /// <summary>Visible, unminimized, uncloaked top-level app windows, front to back.</summary>
    public static List<WindowInfo> Windows(Func<WindowInfo, bool>? where = null)
    {
        int ownPid = Environment.ProcessId;
        var windows = new List<WindowInfo>();
        var names = new Dictionary<int, string>();
        Native.EnumWindows((hwnd, _) =>
        {
            if (!Native.IsWindowVisible(hwnd) || Native.IsIconic(hwnd)) return true;
            if ((Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE) & Native.WS_EX_TOOLWINDOW) != 0) return true;
            if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            Native.GetWindowThreadProcessId(hwnd, out int pid);
            if (pid == ownPid || !Native.GetWindowRect(hwnd, out var rect)) return true;
            var frame = rect.ToRect();
            if (frame.Width < 50 || frame.Height < 50) return true;

            var title = new StringBuilder(512);
            Native.GetWindowText(hwnd, title, title.Capacity);
            if (!names.TryGetValue(pid, out var app))
            {
                try { app = Process.GetProcessById(pid).ProcessName; } catch { app = $"pid {pid}"; }
                names[pid] = app;
            }
            var window = new WindowInfo(hwnd, pid, app, title.ToString(), frame);
            if (where is null || where(window)) windows.Add(window);
            return true;
        }, 0);
        return windows;
    }

    public static List<WindowInfo> WindowsOf(int pid) => Windows(w => w.Pid == pid);

    public static List<WindowInfo> WindowsOn(Rect bounds) => Windows(w => bounds.ContainsCenterOf(w.Frame));

    public static WindowInfo? Window(long id) => Windows(w => w.Id == id).FirstOrDefault();

    /// <summary>
    /// Move <paramref name="window"/> into <paramref name="target"/> (a work area), keeping its
    /// relative position and shrinking it to fit, or filling it. Never activates the window.
    /// </summary>
    public static bool Move(WindowInfo window, Rect target, bool fill)
    {
        var source = DisplayContaining(window.Frame)?.WorkArea ?? window.Frame;
        var frame = fill ? target : Placement.Relative(window.Frame, source, target);
        return Native.SetWindowPos(window.Handle, 0, frame.X, frame.Y, frame.Width, frame.Height,
            Native.SWP_NOZORDER | Native.SWP_NOACTIVATE | Native.SWP_NOOWNERZORDER);
    }

    public static nint Foreground() => Native.GetForegroundWindow();

    public static bool IsAlive(nint hwnd) => Native.IsWindow(hwnd);

    public static void SetForeground(nint hwnd) => Native.SetForegroundWindow(hwnd);

    public static (int X, int Y) CursorPosition() =>
        Native.GetCursorPos(out var p) ? (p.X, p.Y) : (0, 0);
}
