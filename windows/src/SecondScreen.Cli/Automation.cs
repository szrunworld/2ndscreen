using System.Runtime.Versioning;
using System.Windows.Automation;

namespace SecondScreen.Cli;

/// <summary>
/// A window's UI Automation tree as a <see cref="Snapshot"/>, with the live element behind
/// each index. Each command walks the window afresh; the walk order, and so the indexes,
/// stay the same while the window's UI does.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class Automation
{
    /// <summary>Deep programs (browsers, Electron) have thousands of nodes; these bound a walk.</summary>
    private const int MaxDepth = 40, MaxNodes = 4000;
    private static readonly TimeSpan MaxTime = TimeSpan.FromSeconds(8);

    public Snapshot Snapshot { get; }
    private readonly Dictionary<int, AutomationElement> handles;

    private Automation(Snapshot snapshot, Dictionary<int, AutomationElement> handles)
    {
        Snapshot = snapshot;
        this.handles = handles;
    }

    public static Automation Walk(nint window, string? query = null)
    {
        var root = AutomationElement.FromHandle(window);
        var nodes = new List<SnapshotNode>();
        var handles = new Dictionary<int, AutomationElement>();
        var deadline = DateTime.UtcNow + MaxTime;
        int next = 0;

        void Visit(AutomationElement element, int depth)
        {
            if (depth > MaxDepth || nodes.Count >= MaxNodes || DateTime.UtcNow > deadline) return;
            SnapshotNode node;
            try
            {
                node = Describe(element, depth);
            }
            catch (ElementNotAvailableException)
            {
                return;
            }
            nodes.Add(node);
            if (Snapshot.IsIndexed(node)) handles[next++] = element;

            var walker = TreeWalker.ControlViewWalker;
            AutomationElement? child;
            try { child = walker.GetFirstChild(element); }
            catch (ElementNotAvailableException) { return; }
            while (child is not null)
            {
                Visit(child, depth + 1);
                try { child = walker.GetNextSibling(child); }
                catch (ElementNotAvailableException) { break; }
            }
        }

        Visit(root, 0);
        return new Automation(Snapshot.Build(nodes, query), handles);
    }

    private static SnapshotNode Describe(AutomationElement element, int depth)
    {
        var current = element.Current;
        var role = current.ControlType.ProgrammaticName.Replace("ControlType.", "");
        var label = current.Name ?? "";
        var value = "";
        var actions = new List<string>();
        if (Has(element, AutomationElement.IsInvokePatternAvailableProperty)) actions.Add("invoke");
        if (Has(element, AutomationElement.IsTogglePatternAvailableProperty)) actions.Add("toggle");
        if (Has(element, AutomationElement.IsSelectionItemPatternAvailableProperty)) actions.Add("select");
        if (Has(element, AutomationElement.IsExpandCollapsePatternAvailableProperty)) actions.Add("expand");
        if (Has(element, AutomationElement.IsValuePatternAvailableProperty))
        {
            actions.Add("value");
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern))
                value = ((ValuePattern)pattern).Current.Value ?? "";
        }
        if (Has(element, AutomationElement.IsScrollPatternAvailableProperty)) actions.Add("scroll");
        // Static text carries its words as its name; report them as its value as well.
        if (role == "Text" && value.Length == 0) value = label;

        Rect? frame = null;
        var bounds = current.BoundingRectangle;
        if (!bounds.IsEmpty && bounds.Width > 0 && bounds.Height > 0 && !double.IsInfinity(bounds.Width))
            frame = new Rect((int)bounds.X, (int)bounds.Y, (int)bounds.Width, (int)bounds.Height);
        return new SnapshotNode(depth, role, label, value, actions, frame, current.IsOffscreen);
    }

    private static bool Has(AutomationElement element, AutomationProperty property) =>
        element.GetCurrentPropertyValue(property) is true;

    public AutomationElement? Handle(int index) => handles.GetValueOrDefault(index);

    // MARK: Actions through patterns, which need no input events and reach background windows.

    /// <summary>
    /// Press the element: invoke, toggle, select or expand, whichever it supports.
    /// Invoke can block while the program shows a modal dialog, so it is given a moment
    /// and then left to finish. Returns the route, or null if no pattern applies.
    /// </summary>
    public static string? Press(AutomationElement element)
    {
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke))
        {
            var call = Task.Run(() => ((InvokePattern)invoke).Invoke());
            try
            {
                call.Wait(TimeSpan.FromSeconds(3));
            }
            catch (AggregateException error) when (error.InnerException is InvalidOperationException or ElementNotEnabledException)
            {
                return null;
            }
            return "uia.invoke";
        }
        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle))
        {
            ((TogglePattern)toggle).Toggle();
            return "uia.toggle";
        }
        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var select))
        {
            ((SelectionItemPattern)select).Select();
            return "uia.select";
        }
        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expand))
        {
            var pattern = (ExpandCollapsePattern)expand;
            if (pattern.Current.ExpandCollapseState == ExpandCollapseState.Expanded) pattern.Collapse();
            else pattern.Expand();
            return "uia.expand";
        }
        return null;
    }

    /// <summary>
    /// Scroll the element, or its nearest scrollable ancestor, by notches. Returns the
    /// route, or null if nothing there scrolls through UI Automation.
    /// </summary>
    public static string? Scroll(AutomationElement element, string direction, int notches, bool byPage)
    {
        for (var node = element; node is not null; node = TreeWalker.ControlViewWalker.GetParent(node))
        {
            if (!node.TryGetCurrentPattern(ScrollPattern.Pattern, out var found)) continue;
            var pattern = (ScrollPattern)found;
            bool vertical = direction is "up" or "down";
            if (vertical ? !pattern.Current.VerticallyScrollable : !pattern.Current.HorizontallyScrollable) continue;
            var amount = (direction is "down" or "right", byPage) switch
            {
                (true, true) => ScrollAmount.LargeIncrement,
                (true, false) => ScrollAmount.SmallIncrement,
                (false, true) => ScrollAmount.LargeDecrement,
                (false, false) => ScrollAmount.SmallDecrement,
            };
            double Percent() => vertical ? pattern.Current.VerticalScrollPercent : pattern.Current.HorizontalScrollPercent;
            double before = Percent();
            for (int i = 0; i < notches; i++)
            {
                if (vertical) pattern.ScrollVertical(amount);
                else pattern.ScrollHorizontal(amount);
            }
            if (Percent() != before) return "uia.scroll";
            // Chromium answers Scroll without scrolling a background page; a position it takes.
            double view = vertical ? pattern.Current.VerticalViewSize : pattern.Current.HorizontalViewSize;
            double step = (byPage ? view : Math.Max(view / 10, 1)) * notches * (direction is "down" or "right" ? 1 : -1);
            double target = Math.Clamp(before + step, 0, 100);
            if (vertical) pattern.SetScrollPercent(ScrollPattern.NoScroll, target);
            else pattern.SetScrollPercent(target, ScrollPattern.NoScroll);
            if (Percent() != before) return "uia.scrollpercent";
        }
        return RevealNext(element, direction, notches);
    }

    /// <summary>
    /// Scroll a list by bringing its next hidden item into view, a notch at a time: the one
    /// route Chromium takes for a background page, where it ignores Scroll and the wheel.
    /// </summary>
    private static string? RevealNext(AutomationElement element, string direction, int notches)
    {
        if (direction is not ("up" or "down")) return null;
        bool down = direction == "down";
        for (var container = element; container is not null; container = TreeWalker.ControlViewWalker.GetParent(container))
        {
            var area = container.Current.BoundingRectangle;
            var items = container.FindAll(TreeScope.Children, Condition.TrueCondition).Cast<AutomationElement>()
                .Where(item => item.GetCurrentPropertyValue(AutomationElement.IsScrollItemPatternAvailableProperty) is true).ToList();
            if (items.Count < 2 || area.IsEmpty) continue;
            bool moved = false;
            for (int notch = 0; notch < notches * 3; notch++)
            {
                area = container.Current.BoundingRectangle;
                var hidden = down
                    ? items.FirstOrDefault(item => item.Current.BoundingRectangle.Bottom > area.Bottom + 1)
                    : items.LastOrDefault(item => item.Current.BoundingRectangle.Top < area.Top - 1);
                if (hidden is null) break;
                ((ScrollItemPattern)hidden.GetCurrentPattern(ScrollItemPattern.Pattern)).ScrollIntoView();
                moved = true;
            }
            if (moved) return "uia.scrollintoview";
        }
        return null;
    }

    /// <summary>
    /// The element at a screen point, if it belongs to the window: its program's, or in a
    /// window inside it, as a packaged (UWP) app's content sits in another process's
    /// CoreWindow inside the frame host's window.
    /// </summary>
    public static AutomationElement? At((double X, double Y) point, nint window)
    {
        try
        {
            var element = AutomationElement.FromPoint(new System.Windows.Point(point.X, point.Y));
            int pid = element.Current.ProcessId;
            Win32.GetWindowThreadProcessId(window, out var owner);
            if (pid == owner) return element;
            var native = NativeWindow(element);
            return native != 0 && Win32.GetAncestor(native, Win32.GA_ROOT) == window ? element : null;
        }
        catch (Exception error) when (error is ElementNotAvailableException or InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            return null;
        }
    }

    /// <summary>The element's own window handle, or its nearest ancestor's.</summary>
    public static nint NativeWindow(AutomationElement element)
    {
        for (var node = element; node is not null; node = TreeWalker.RawViewWalker.GetParent(node))
        {
            var handle = node.Current.NativeWindowHandle;
            if (handle != 0) return handle;
        }
        return 0;
    }

    private static readonly HashSet<ControlType> PressableTypes = new()
        { ControlType.Button, ControlType.MenuItem, ControlType.Hyperlink, ControlType.CheckBox, ControlType.RadioButton,
          ControlType.TabItem, ControlType.SplitButton, ControlType.ListItem, ControlType.TreeItem };

    /// <summary>Whether a click on the element is a press its patterns can stand in for.</summary>
    public static bool IsPressable(AutomationElement element)
    {
        try
        {
            return PressableTypes.Contains(element.Current.ControlType) && element.Current.IsEnabled;
        }
        catch (ElementNotAvailableException)
        {
            return false;
        }
    }

    /// <summary>Whether the element's value can be written.</summary>
    public static bool IsEditable(AutomationElement element) =>
        element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern) && !((ValuePattern)pattern).Current.IsReadOnly;

    public static string ValueOf(AutomationElement element) =>
        element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern) ? ((ValuePattern)pattern).Current.Value ?? "" : "";

    public static void SetValue(AutomationElement element, string value) =>
        ((ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern)).SetValue(value);

    /// <summary>Whether the element is web content: inside a document, as browsers expose pages.</summary>
    public static bool IsWeb(AutomationElement element)
    {
        for (var node = TreeWalker.ControlViewWalker.GetParent(element); node is not null; node = TreeWalker.ControlViewWalker.GetParent(node))
        {
            if (node.Current.ControlType == ControlType.Document) return true;
        }
        return false;
    }

    public static bool HasFocus(AutomationElement element)
    {
        try { return element.Current.HasKeyboardFocus; }
        catch (ElementNotAvailableException) { return false; }
    }

    /// <summary>Give the element keyboard focus within its program.</summary>
    public static void Focus(AutomationElement element)
    {
        try { element.SetFocus(); }
        catch (InvalidOperationException) { }
    }
}
