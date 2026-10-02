// The window 2ndscreen's end-to-end test drives through cua-driver.
var form = new Form { Text = "2ndscreen test target", Width = 520, Height = 260 };
var input = new TextBox { Left = 20, Top = 20, Width = 460, AccessibleName = "Input" };
var button = new Button { Left = 20, Top = 70, Width = 160, Height = 40, Text = "Press me" };
var label = new Label { Left = 200, Top = 80, Width = 280, Text = "Pressed 0", AccessibleName = "Counter" };
int presses = 0;
button.Click += (_, _) => label.Text = $"Pressed {++presses}";
form.Controls.AddRange(new Control[] { input, button, label });
Application.Run(form);
