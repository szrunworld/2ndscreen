using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.Versioning;

namespace SecondScreen.Cli;

/// <summary>A picture of one window, whatever covers it, in physical pixels.</summary>
[SupportedOSPlatform("windows")]
public static class WindowCapture
{
    /// <summary>
    /// Ask the window to draw itself, PW_RENDERFULLCONTENT included so that GPU-drawn
    /// content (browsers, Electron) appears, and save the whole window rectangle as a PNG.
    /// </summary>
    public static void Save(nint window, string path)
    {
        if (!Win32.GetWindowRect(window, out var rect)) throw new InvalidOperationException("the window is gone");
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) throw new InvalidOperationException("the window has no area to capture");
        using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var hdc = graphics.GetHdc();
            try
            {
                if (!Win32.PrintWindow(window, hdc, Win32.PW_RENDERFULLCONTENT))
                    throw new InvalidOperationException("the window would not draw itself for a screenshot");
            }
            finally
            {
                graphics.ReleaseHdc(hdc);
            }
        }
        bitmap.Save(path, ImageFormat.Png);
    }
}
