using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace SecondScreen.App;

/// <summary>
/// Windows virtual desktops, the counterpart of macOS Spaces: a full-screen preview on
/// a desktop of its own is a four-finger swipe (or Ctrl+Win+Arrow) away.
///
/// Moving a window uses the documented IVirtualDesktopManager. Creating and removing a
/// desktop needs the shell's undocumented IVirtualDesktopManagerInternal, whose layout
/// changes between Windows releases; this is the layout of Windows 11 24H2 and 25H2.
/// Before relying on it, <see cref="Internal"/> checks that its desktop count matches
/// the registry, and refuses otherwise rather than call into the wrong method.
/// </summary>
internal static class VirtualDesktops
{
    private const string Key = @"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops";

    /// <summary>The desktops in order, from the shell's registry state.</summary>
    public static List<Guid> Ids()
    {
        var ids = new List<Guid>();
        if (Registry.CurrentUser.OpenSubKey(Key)?.GetValue("VirtualDesktopIDs") is not byte[] bytes) return ids;
        for (int i = 0; i + 16 <= bytes.Length; i += 16) ids.Add(new Guid(bytes.AsSpan(i, 16)));
        return ids;
    }

    /// <summary>Add a desktop at the end and return its id; on failure, <paramref name="problem"/> says why.</summary>
    public static Guid? Create(out string? problem)
    {
        var before = Ids();
        if (Internal(out problem) is not { } manager) return null;
        try
        {
            Marshal.Release(manager.CreateDesktop());
        }
        catch (Exception error)
        {
            problem = $"Windows refused to create a desktop: {error.Message}";
            return null;
        }
        // The registry catches up a moment later.
        for (int attempt = 0; attempt < 20; attempt++)
        {
            if (Ids().Except(before).FirstOrDefault() is var id && id != Guid.Empty) return id;
            Thread.Sleep(50);
        }
        problem = "Windows created a desktop but did not report it";
        return null;
    }

    /// <summary>Remove a desktop; Windows moves its windows to the first desktop.</summary>
    public static void Remove(Guid id)
    {
        var ids = Ids();
        if (!ids.Contains(id) || ids.Count < 2 || Internal(out _) is not { } manager) return;
        var fallback = ids.First(other => other != id);
        nint desktop = 0, other = 0;
        try
        {
            desktop = manager.FindDesktop(ref id);
            other = manager.FindDesktop(ref fallback);
            manager.RemoveDesktop(desktop, other);
        }
        catch (Exception) { }
        finally
        {
            if (desktop != 0) Marshal.Release(desktop);
            if (other != 0) Marshal.Release(other);
        }
    }

    /// <summary>Put one of this process's windows on desktop <paramref name="id"/>.</summary>
    public static bool MoveWindow(nint window, Guid id)
    {
        try
        {
            var manager = (IVirtualDesktopManager)new CVirtualDesktopManager();
            manager.MoveWindowToDesktop(window, ref id);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static IVirtualDesktopManagerInternal? Internal(out string? problem)
    {
        problem = null;
        try
        {
            var shell = (IServiceProvider)Activator.CreateInstance(Type.GetTypeFromCLSID(ImmersiveShell)!)!;
            Guid service = ManagerInternalService, iid = typeof(IVirtualDesktopManagerInternal).GUID;
            var manager = (IVirtualDesktopManagerInternal)shell.QueryService(ref service, ref iid);
            int count = manager.GetCount(), expected = Math.Max(1, Ids().Count);
            if (count == expected) return manager;
            problem = $"this Windows version's desktop interface is not the one 2ndscreen knows ({count} desktops, expected {expected})";
        }
        catch (Exception error)
        {
            problem = $"this Windows version does not offer the desktop interface 2ndscreen knows: {error.Message}";
        }
        return null;
    }

    private static readonly Guid ImmersiveShell = new("C2F03A33-21F5-47FA-B4BB-156362A2F239");
    private static readonly Guid ManagerInternalService = new("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");

    [ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")]
    private class CVirtualDesktopManager { }

    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IVirtualDesktopManager
    {
        bool IsWindowOnCurrentVirtualDesktop(nint window);
        Guid GetWindowDesktopId(nint window);
        void MoveWindowToDesktop(nint window, ref Guid desktop);
    }

    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IServiceProvider
    {
        [return: MarshalAs(UnmanagedType.IUnknown)]
        object QueryService(ref Guid service, ref Guid riid);
    }

    /// <summary>Windows 11 24H2/25H2 layout. Only the methods up to FindDesktop are declared; their order is what matters.</summary>
    [ComImport, Guid("53F5CA0B-158F-4124-900C-057158060B27"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IVirtualDesktopManagerInternal
    {
        int GetCount();
        void MoveViewToDesktop(nint view, nint desktop);
        bool CanViewMoveDesktops(nint view);
        nint GetCurrentDesktop();
        nint GetDesktops();
        int GetAdjacentDesktop(nint from, int direction, out nint desktop);
        void SwitchDesktop(nint desktop);
        void SwitchDesktopAndMoveForegroundView(nint desktop);
        nint CreateDesktop();
        void MoveDesktop(nint desktop, int index);
        void RemoveDesktop(nint desktop, nint fallback);
        nint FindDesktop(ref Guid id);
    }
}
