// The window 2ndscreen's end-to-end test drives through cua-driver.
var form = new Form { Text = "2ndscreen test target", Width = 520, Height = 520 };
var input = new TextBox { Left = 20, Top = 20, Width = 460, AccessibleName = "Input" };
var button = new Button { Left = 20, Top = 70, Width = 160, Height = 40, Text = "Press me" };
var label = new Label { Left = 200, Top = 80, Width = 280, Text = "Pressed 0" }; // no AccessibleName: UI Automation then exposes the text
int presses = 0;
button.Click += (_, _) => label.Text = $"Pressed {++presses}";

// A list to scroll, and a pad that reports double-clicks, right-clicks and drags.
var list = new ListBox { Left = 20, Top = 130, Width = 200, Height = 300, AccessibleName = "Rows" };
list.Items.AddRange(Enumerable.Range(1, 200).Select(i => (object)$"Row {i}").ToArray());
var top = new Label { Left = 240, Top = 130, Width = 240, Text = "Top 0" };
// A label, since UI Automation names it by its text; a panel's AccessibleName does not show up.
var pad = new Label { Left = 240, Top = 170, Width = 240, Height = 200, BorderStyle = BorderStyle.FixedSingle, Text = "Pad" };
var events = new Label { Left = 240, Top = 390, Width = 240, Height = 60, Text = "Pad idle" };
var timer = new System.Windows.Forms.Timer { Interval = 100 };
timer.Tick += (_, _) => top.Text = $"Top {list.TopIndex}";
timer.Start();
Point? down = null;
pad.MouseDown += (_, e) => { if (e.Button == MouseButtons.Left) down = e.Location; };
pad.MouseUp += (_, e) =>
{
    if (e.Button == MouseButtons.Right) events.Text += " right";
    if (e.Button == MouseButtons.Left && down is { } start && Math.Abs(e.X - start.X) + Math.Abs(e.Y - start.Y) > 40) events.Text += " drag";
    down = null;
};
pad.MouseDoubleClick += (_, e) => { if (e.Button == MouseButtons.Left) events.Text += " double"; };

form.Controls.AddRange(new Control[] { input, button, label, list, top, pad, events });
// With --second-window, a second window, so the e2e test can move one and check the other stays.
if (args.Contains("--second-window"))
{
    form.Shown += (_, _) => new Form
    {
        Text = "2ndscreen test target, second window", Width = 300, Height = 200,
        StartPosition = FormStartPosition.Manual, Location = new Point(form.Left + 40, form.Top + 40),
    }.Show();
}
Application.Run(form);
