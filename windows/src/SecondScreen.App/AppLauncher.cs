using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace SecondScreen.App;

/// <summary>Starts programs without taking the foreground from the user.</summary>
internal static class AppLauncher
{
    /// <summary>
    /// Start <paramref name="path"/> asking its first window not to activate
    /// (SW_SHOWNOACTIVATE), and hand the foreground back if it takes it anyway.
    /// </summary>
    public static int Start(string path, IReadOnlyList<string> arguments)
    {
        var previous = Desktop.Foreground();
        var commandLine = new StringBuilder(Quote(path));
        foreach (var argument in arguments) commandLine.Append(' ').Append(Quote(argument));

        var startup = new STARTUPINFO
        {
            cb = Marshal.SizeOf<STARTUPINFO>(),
            dwFlags = STARTF_USESHOWWINDOW,
            wShowWindow = SW_SHOWNOACTIVATE,
        };
        if (!CreateProcess(null, commandLine, 0, 0, false, 0, 0,
                Path.GetDirectoryName(path), ref startup, out var info))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        CloseHandle(info.hThread);
        CloseHandle(info.hProcess);
        GuardForeground(previous, info.dwProcessId, TimeSpan.FromSeconds(5));
        return info.dwProcessId;
    }

    /// <summary>For <paramref name="duration"/>, give the foreground back to <paramref name="previous"/>
    /// whenever a window of <paramref name="pid"/> takes it.</summary>
    public static void GuardForeground(nint previous, int pid, TimeSpan duration)
    {
        if (previous == 0) return;
        var deadline = DateTime.UtcNow + duration;
        _ = Task.Run(async () =>
        {
            while (DateTime.UtcNow < deadline)
            {
                var front = Desktop.Foreground();
                if (front != previous && front != 0)
                {
                    GetWindowThreadProcessId(front, out int frontPid);
                    if (frontPid == pid && Desktop.IsAlive(previous)) Restore(previous, front);
                }
                await Task.Delay(50);
            }
        });
    }

    /// <summary>
    /// SetForegroundWindow from a background process is normally refused; attaching to
    /// the current foreground thread's input queue for the call is the standard way.
    /// </summary>
    private static void Restore(nint previous, nint current)
    {
        uint currentThread = GetWindowThreadProcessId(current, out _);
        uint ownThread = GetCurrentThreadId();
        bool attached = currentThread != ownThread && AttachThreadInput(ownThread, currentThread, true);
        Desktop.SetForeground(previous);
        if (attached) AttachThreadInput(ownThread, currentThread, false);
    }

    /// <summary>Whether an executable at <paramref name="path"/> is already running.</summary>
    public static bool IsRunning(string path)
    {
        var name = Path.GetFileNameWithoutExtension(path);
        foreach (var process in Process.GetProcessesByName(name))
        {
            try
            {
                if (string.Equals(process.MainModule?.FileName, Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch (Win32Exception)
            {
                // Elevated or protected processes hide their path; treat the name as a match.
                return true;
            }
        }
        return false;
    }

    /// <summary>Resolve a bare program name, such as notepad.exe, through PATH.</summary>
    public static string? Resolve(string path)
    {
        var expanded = Environment.ExpandEnvironmentVariables(path);
        if (File.Exists(expanded)) return Path.GetFullPath(expanded);
        if (Path.IsPathRooted(expanded)) return null;
        var candidates = Path.HasExtension(expanded) ? new[] { expanded } : new[] { expanded + ".exe", expanded };
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var candidate in candidates)
            {
                var full = Path.Combine(directory, candidate);
                if (File.Exists(full)) return full;
            }
        }
        return null;
    }

    private static string Quote(string argument) =>
        argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0 ? argument : "\"" + argument.Replace("\"", "\\\"") + "\"";

    private const int STARTF_USESHOWWINDOW = 1;
    private const short SW_SHOWNOACTIVATE = 4;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public nint lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public nint hProcess; public nint hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string? application, StringBuilder commandLine, nint processAttributes, nint threadAttributes,
        bool inheritHandles, uint flags, nint environment, string? directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd, out int pid);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint to, bool doAttach);
}
