using System.Drawing;
using System.Runtime.InteropServices;

namespace SecondScreen.App;

/// <summary>
/// Copying the screen with BitBlt. Graphics.CopyFromScreen rejects CAPTUREBLT, which
/// layered windows such as the agent cursor need; and no BitBlt includes the mouse
/// pointer, so <see cref="DrawPointer"/> adds it.
/// </summary>
internal static class ScreenCapture
{
    /// <summary>
    /// Copy <paramref name="source"/> (global physical pixels) to the top left of
    /// <paramref name="target"/>. <paramref name="layered"/> includes layered windows;
    /// avoid it at video rates, because it makes the real pointer flicker.
    /// </summary>
    public static void Copy(Graphics target, Rect source, bool layered)
    {
        nint screen = GetDC(0);
        nint dc = target.GetHdc();
        try
        {
            BitBlt(dc, 0, 0, source.Width, source.Height, screen, source.X, source.Y, SRCCOPY | (layered ? CAPTUREBLT : 0));
        }
        finally
        {
            target.ReleaseHdc(dc);
            ReleaseDC(0, screen);
        }
    }

    /// <summary>
    /// Draw the real mouse pointer if it is inside <paramref name="source"/>, mapping
    /// <paramref name="source"/> onto <paramref name="area"/>.
    /// </summary>
    public static void DrawPointer(Graphics target, Rect source, RectangleF area)
    {
        var info = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
        if (!GetCursorInfo(ref info) || (info.flags & CURSOR_SHOWING) == 0 || info.hCursor == 0) return;
        if (info.x < source.X || info.y < source.Y || info.x >= source.Right || info.y >= source.Bottom) return;
        if (!GetIconInfo(info.hCursor, out var icon)) return;
        // GetIconInfo hands over copies of the cursor's bitmaps.
        if (icon.hbmMask != 0) DeleteObject(icon.hbmMask);
        if (icon.hbmColor != 0) DeleteObject(icon.hbmColor);

        float scale = area.Width / source.Width;
        float x = area.X + (info.x - source.X - icon.xHotspot) * scale;
        float y = area.Y + (info.y - source.Y - icon.yHotspot) * scale;
        int size = Math.Max(16, (int)(GetSystemMetrics(SM_CXCURSOR) * Math.Max(scale, 0.75f)));
        nint dc = target.GetHdc();
        try
        {
            DrawIconEx(dc, (int)x, (int)y, info.hCursor, size, size, 0, 0, DI_NORMAL);
        }
        finally
        {
            target.ReleaseHdc(dc);
        }
    }

    private const int SRCCOPY = 0x00CC0020;
    private const int CAPTUREBLT = 0x40000000;
    private const int CURSOR_SHOWING = 1;
    private const int DI_NORMAL = 3;
    private const int SM_CXCURSOR = 13;

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO { public int cbSize; public int flags; public nint hCursor; public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public nint hbmMask; public nint hbmColor; }

    [DllImport("user32.dll")] private static extern nint GetDC(nint hwnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(nint hwnd, nint dc);
    [DllImport("gdi32.dll")] private static extern bool BitBlt(nint dc, int x, int y, int width, int height, nint source, int sourceX, int sourceY, int rop);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(nint handle);
    [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref CURSORINFO info);
    [DllImport("user32.dll")] private static extern bool GetIconInfo(nint icon, out ICONINFO info);
    [DllImport("user32.dll")] private static extern bool DrawIconEx(nint dc, int x, int y, nint icon, int width, int height, int step, nint brush, int flags);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
}
