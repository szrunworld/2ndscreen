using System.Drawing;
using System.Drawing.Drawing2D;

namespace SecondScreen.App;

/// <summary>
/// The agent cursor: a transparent, click-through, topmost window covering one
/// virtual screen. It only shows where an agent acts; the real pointer never moves.
/// Screenshots and the preview capture it, so a person can follow along.
/// </summary>
internal sealed class CursorOverlay : Form
{
    private const int GlideMs = 350;
    private const int IdleHideMs = 4000;
    private static readonly Color Key = Color.FromArgb(1, 2, 3);

    private readonly string device;
    private readonly System.Windows.Forms.Timer frame = new() { Interval = 15 };
    private PointF from, to, at;
    private DateTime glideStart, lastEvent, rippleStart = DateTime.MinValue;
    private bool visible;

    public CursorOverlay(string device)
    {
        this.device = device;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Key;
        TransparencyKey = Key;
        DoubleBuffered = true;
        frame.Tick += (_, _) => Step();
        Fit();
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            const int WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000;
            var parameters = base.CreateParams;
            parameters.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return parameters;
        }
    }

    /// <summary>Handle a cursor event at a global physical point. Ignores points off this screen.</summary>
    public void Show(string action, double x, double y)
    {
        Fit();
        if (action == "hide")
        {
            visible = false;
            Invalidate();
            return;
        }
        var bounds = Bounds;
        if (!bounds.Contains((int)x, (int)y)) return;
        var target = new PointF((float)(x - bounds.X), (float)(y - bounds.Y));
        from = visible ? at : target;
        to = target;
        glideStart = DateTime.UtcNow;
        lastEvent = DateTime.UtcNow;
        visible = true;
        if (action == "click") rippleStart = DateTime.UtcNow.AddMilliseconds(GlideMs);
        if (!Visible) Show();
        frame.Start();
    }

    private void Fit()
    {
        if (Desktop.Display(device) is { } display)
        {
            var b = display.Bounds;
            var wanted = new Rectangle(b.X, b.Y, b.Width, b.Height);
            if (Bounds != wanted) Bounds = wanted;
        }
    }

    private void Step()
    {
        double t = Math.Clamp((DateTime.UtcNow - glideStart).TotalMilliseconds / GlideMs, 0, 1);
        double eased = t < 0.5 ? 2 * t * t : 1 - Math.Pow(-2 * t + 2, 2) / 2;
        at = new PointF((float)(from.X + (to.X - from.X) * eased), (float)(from.Y + (to.Y - from.Y) * eased));
        if ((DateTime.UtcNow - lastEvent).TotalMilliseconds > IdleHideMs) visible = false;
        bool rippling = (DateTime.UtcNow - rippleStart).TotalMilliseconds is >= 0 and < 500;
        Invalidate();
        if (!visible && !rippling) frame.Stop();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (!visible) return;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        double ripple = (DateTime.UtcNow - rippleStart).TotalMilliseconds / 500;
        if (ripple is >= 0 and < 1)
        {
            float radius = (float)(6 + 20 * ripple);
            int alpha = (int)(255 * (1 - ripple));
            using var pen = new Pen(Color.FromArgb(alpha, 255, 45, 120), 2);
            g.DrawEllipse(pen, at.X - radius, at.Y - radius, radius * 2, radius * 2);
        }

        // A classic arrow pointer with its tip at the point.
        var arrow = new[]
        {
            new PointF(0, 0), new PointF(0, 22), new PointF(6, 16.5f), new PointF(10, 25),
            new PointF(13.5f, 23.5f), new PointF(9.5f, 15), new PointF(17, 15),
        }.Select(p => new PointF(at.X + p.X, at.Y + p.Y)).ToArray();
        using var fill = new SolidBrush(Color.FromArgb(255, 45, 120));
        using var outline = new Pen(Color.White, 1.5f);
        g.FillPolygon(fill, arrow);
        g.DrawPolygon(outline, arrow);
    }
}
