using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace SecondScreen.App;

/// <summary>
/// A live view of one virtual screen in a window on a real display. Captures with
/// BitBlt at up to 30 fps and pauses while the window is minimized or hidden.
/// Full screen is a borderless window covering a real display.
/// </summary>
internal sealed class PreviewForm : Form
{
    private readonly string device;
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 33 };
    private Bitmap? frame;
    private Rectangle windowedBounds;
    private FormBorderStyle windowedStyle;

    public PreviewForm(string name, string device, bool topMost)
    {
        this.device = device;
        Text = $"{name} preview";
        BackColor = Color.Black;
        DoubleBuffered = true;
        TopMost = topMost;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = true;
        KeyPreview = true;

        // Open on a real display, never on the screen it shows.
        var host = Desktop.Displays().FirstOrDefault(d => d.IsPrimary && d.Device != device)
            ?? Desktop.Displays().First(d => d.Device != device);
        var bounds = Desktop.Display(device)?.Bounds ?? new Rect(0, 0, 16, 9);
        int width = Math.Min(800, host.WorkArea.Width / 2);
        int height = width * bounds.Height / Math.Max(1, bounds.Width);
        SetBounds(host.WorkArea.Right - width - 24, host.WorkArea.Y + 24, width, height + 40);

        timer.Tick += (_, _) => CaptureFrame();
        timer.Start();
        KeyDown += (_, e) => { if (e.KeyCode == Keys.Escape && IsFullScreen) ToggleFullScreen(); };
        DoubleClick += (_, _) => ToggleFullScreen();
    }

    public bool IsFullScreen => FormBorderStyle == FormBorderStyle.None;

    /// <summary>Cover the real display the window is on, or go back to a window.</summary>
    public void ToggleFullScreen()
    {
        if (IsFullScreen)
        {
            FormBorderStyle = windowedStyle;
            Bounds = windowedBounds;
            return;
        }
        windowedBounds = Bounds;
        windowedStyle = FormBorderStyle;
        var host = Screen.FromControl(this);
        FormBorderStyle = FormBorderStyle.None;
        Bounds = host.Bounds;
        Activate();
    }

    private void CaptureFrame()
    {
        if (WindowState == FormWindowState.Minimized || !Visible) return;
        if (Desktop.Display(device)?.Bounds is not { IsEmpty: false } source) return;
        if (frame is null || frame.Width != source.Width || frame.Height != source.Height)
        {
            frame?.Dispose();
            frame = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppRgb);
        }
        using (var g = Graphics.FromImage(frame))
        {
            g.CopyFromScreen(source.X, source.Y, 0, 0, new Size(source.Width, source.Height), CopyPixelOperation.SourceCopy);
        }
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (frame is null) return;
        var area = ClientRectangle;
        double scale = Math.Min((double)area.Width / frame.Width, (double)area.Height / frame.Height);
        int width = (int)(frame.Width * scale), height = (int)(frame.Height * scale);
        e.Graphics.InterpolationMode = scale >= 1 ? InterpolationMode.NearestNeighbor : InterpolationMode.HighQualityBilinear;
        e.Graphics.DrawImage(frame, (area.Width - width) / 2, (area.Height - height) / 2, width, height);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        timer.Dispose();
        frame?.Dispose();
        base.OnFormClosed(e);
    }
}
