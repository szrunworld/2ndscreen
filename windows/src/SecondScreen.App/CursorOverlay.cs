using System.Drawing;
using System.Drawing.Drawing2D;

namespace SecondScreen.App;

/// <summary>
/// The agent cursor: a transparent, click-through, topmost window covering one
/// virtual screen. It starts in the middle of the screen and stays where the agent
/// last acted; the real pointer never moves. Screenshots capture it, and the preview
/// draws it itself (see <see cref="Draw"/>), so a person can follow along.
/// </summary>
internal sealed class CursorOverlay : Form
{
    private const int GlideMs = 350;
    private static readonly Color Key = Color.FromArgb(1, 2, 3);

    private readonly string device;
    private readonly System.Windows.Forms.Timer frame = new() { Interval = 15 };
    private PointF from, to, at;
    private DateTime glideStart, rippleStart = DateTime.MinValue;
    private bool visible, moved;

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
        visible = true;
    }

    /// <summary>Whether the cursor is showing, and where, relative to the screen's top left.</summary>
    public bool CursorVisible => visible;
    public PointF Position => at;

    /// <summary>Progress of the click ripple, from 0 to 1; outside that range when there is none.</summary>
    public double Ripple => (DateTime.UtcNow - rippleStart).TotalMilliseconds / 500;

    /// <summary>The screen's scale, so the arrow is as big as the real pointer there.</summary>
    public float PointerScale { get; private set; } = 1;

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
        moved = true;
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
            PointerScale = Math.Max(display.ScalePercent, 100) / 100f;
            // Until an agent acts, rest in the middle.
            if (!moved) at = from = to = new PointF(b.Width / 2f, b.Height / 2f);
        }
    }

    private void Step()
    {
        double t = Math.Clamp((DateTime.UtcNow - glideStart).TotalMilliseconds / GlideMs, 0, 1);
        double eased = t < 0.5 ? 2 * t * t : 1 - Math.Pow(-2 * t + 2, 2) / 2;
        at = new PointF((float)(from.X + (to.X - from.X) * eased), (float)(from.Y + (to.Y - from.Y) * eased));
        Invalidate();
        if (t >= 1 && Ripple >= 1) frame.Stop();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (visible) Draw(e.Graphics, at, PointerScale, Ripple);
    }

    /// <summary>Draw the cursor with its tip at <paramref name="tip"/>, <paramref name="scale"/> times its normal size.</summary>
    public static void Draw(Graphics g, PointF tip, float scale, double ripple)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        if (ripple is >= 0 and < 1)
        {
            float radius = (float)(6 + 20 * ripple) * scale;
            int alpha = (int)(255 * (1 - ripple));
            using var pen = new Pen(Color.FromArgb(alpha, 255, 45, 120), 2 * scale);
            g.DrawEllipse(pen, tip.X - radius, tip.Y - radius, radius * 2, radius * 2);
        }

        // A classic arrow pointer with its tip at the point.
        var arrow = new[]
        {
            new PointF(0, 0), new PointF(0, 22), new PointF(6, 16.5f), new PointF(10, 25),
            new PointF(13.5f, 23.5f), new PointF(9.5f, 15), new PointF(17, 15),
        }.Select(p => new PointF(tip.X + p.X * scale, tip.Y + p.Y * scale)).ToArray();
        using var fill = new SolidBrush(Color.FromArgb(255, 45, 120));
        using var outline = new Pen(Color.White, 1.5f * scale);
        g.FillPolygon(fill, arrow);
        g.DrawPolygon(outline, arrow);
    }
}
