using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

// A text box, a button counting presses, and a list reporting its top row, as in TestTarget.
var app = new Application();
var panel = new StackPanel { Margin = new Thickness(20) };
var input = new TextBox { Width = 460, HorizontalAlignment = HorizontalAlignment.Left };
AutomationProperties.SetName(input, "Input");
var button = new Button { Content = "Press me", Width = 160, Height = 40, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 10, 0, 0) };
var label = new TextBlock { Text = "Pressed 0", Margin = new Thickness(0, 10, 0, 0) };
int presses = 0;
button.Click += (_, _) => label.Text = $"Pressed {++presses}";
var list = new ListBox { Height = 260, Width = 200, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 10, 0, 0) };
AutomationProperties.SetName(list, "Rows");
for (int i = 1; i <= 200; i++) list.Items.Add($"Row {i}");
var top = new TextBlock { Text = "Top 0", Margin = new Thickness(0, 10, 0, 0) };
list.Loaded += (_, _) =>
{
    if (FindScroller(list) is { } scroller) scroller.ScrollChanged += (_, _) => top.Text = $"Top {(int)scroller.VerticalOffset}";
};
panel.Children.Add(input);
panel.Children.Add(button);
panel.Children.Add(label);
panel.Children.Add(list);
panel.Children.Add(top);
var window = new Window { Title = "2ndscreen WPF test target", Width = 520, Height = 520, Content = panel };
app.Run(window);

static ScrollViewer? FindScroller(DependencyObject node)
{
    if (node is ScrollViewer scroller) return scroller;
    for (int i = 0; i < System.Windows.Media.VisualTreeHelper.GetChildrenCount(node); i++)
    {
        if (FindScroller(System.Windows.Media.VisualTreeHelper.GetChild(node, i)) is { } found) return found;
    }
    return null;
}
