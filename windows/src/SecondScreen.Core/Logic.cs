using System.Globalization;

namespace SecondScreen;

public static class Duration
{
    /// <summary>"90s", "30m", "2h", or bare seconds.</summary>
    public static double? Parse(string text)
    {
        text = text.Trim();
        if (text.Length == 0) return null;
        double unit = char.ToLowerInvariant(text[^1]) switch { 's' => 1, 'm' => 60, 'h' => 3600, _ => 0 };
        var number = unit > 0 ? text[..^1] : text;
        if (!double.TryParse(number, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)) return null;
        return value * (unit > 0 ? unit : 1);
    }
}

public static class Placement
{
    /// <summary>
    /// <paramref name="frame"/> placed in <paramref name="target"/> at the same relative
    /// offset it had in <paramref name="source"/>, shrunk if it does not fit.
    /// </summary>
    public static Rect Relative(Rect frame, Rect source, Rect target)
    {
        int width = Math.Min(frame.Width, target.Width);
        int height = Math.Min(frame.Height, target.Height);
        static double Fraction(double offset, double room) => room > 0 ? Math.Clamp(offset / room, 0, 1) : 0;
        double fx = Fraction(frame.X - source.X, source.Width - frame.Width);
        double fy = Fraction(frame.Y - source.Y, source.Height - frame.Height);
        return new Rect(
            target.X + (int)Math.Round(fx * (target.Width - width)),
            target.Y + (int)Math.Round(fy * (target.Height - height)),
            width, height);
    }
}

/// <summary>One element of a window's accessibility snapshot.</summary>
/// <param name="Index">Its number in the snapshot, for <c>--index</c>; -1 for elements that
/// are only context (unnamed panes and groups).</param>
/// <param name="Role">The UI Automation control type, such as <c>Button</c> or <c>Edit</c>.</param>
/// <param name="Actions">The patterns it supports: invoke, toggle, select, expand, value, scroll.</param>
public sealed record Element(int Index, string Role, string Label, string Value,
                             IReadOnlyList<string> Actions, Rect? Frame)
{
    public (double X, double Y)? Center => Frame is { } f ? (f.CenterX, f.CenterY) : null;

    public Dictionary<string, object> ToJson()
    {
        var o = new Dictionary<string, object> { ["index"] = Index, ["role"] = Role };
        if (Label.Length > 0) o["label"] = Label;
        if (Value.Length > 0) o["value"] = Value;
        if (Actions.Count > 0) o["actions"] = Actions;
        if (Frame is { } f) o["frame"] = new Dictionary<string, int> { ["x"] = f.X, ["y"] = f.Y, ["width"] = f.Width, ["height"] = f.Height };
        return o;
    }
}

/// <summary>
/// One node met while walking a window's tree, in walk order, before it gets an index.
/// </summary>
public sealed record SnapshotNode(int Depth, string Role, string Label, string Value,
                                  IReadOnlyList<string> Actions, Rect? Frame, bool Offscreen);

/// <summary>A snapshot of one window's accessibility tree.</summary>
public sealed class Snapshot
{
    /// <summary>Roles worth an index even without a name: things one acts on.</summary>
    private static readonly HashSet<string> Actionable = new(StringComparer.OrdinalIgnoreCase)
    {
        "Button", "CheckBox", "RadioButton", "ComboBox", "Edit", "Document", "Hyperlink", "ListItem",
        "MenuItem", "MenuBar", "Menu", "Slider", "Spinner", "SplitButton", "Tab", "TabItem", "TreeItem",
        "DataItem", "List", "Tree", "Table", "DataGrid", "ScrollBar",
    };

    public IReadOnlyList<Element> Elements { get; }
    /// <summary>An indented outline, one element a line, with <c>[N]</c> before indexed ones.</summary>
    public string Tree { get; }

    public Snapshot(IReadOnlyList<Element> elements, string tree)
    {
        Elements = elements;
        Tree = tree;
    }

    /// <summary>
    /// Number the nodes of a walk. Indexes depend only on the walk, so the same window
    /// gives the same indexes from one command to the next while its UI is unchanged.
    /// Off-screen nodes keep their place in the numbering but are left out of the output.
    /// </summary>
    public static Snapshot Build(IEnumerable<SnapshotNode> nodes, string? query = null)
    {
        var elements = new List<Element>();
        var lines = new List<string>();
        int next = 0;
        foreach (var node in nodes)
        {
            bool interesting = IsIndexed(node);
            int index = interesting ? next++ : -1;
            if (node.Offscreen) continue;
            if (query is { Length: > 0 } q && !(node.Label.Contains(q, StringComparison.OrdinalIgnoreCase)
                || node.Value.Contains(q, StringComparison.OrdinalIgnoreCase)
                || node.Role.Contains(q, StringComparison.OrdinalIgnoreCase))) continue;
            if (!interesting && node.Role is "Pane" or "Group" or "Custom") continue;
            var element = new Element(index, node.Role, node.Label, node.Value, node.Actions, node.Frame);
            elements.Add(element);
            lines.Add(Line(element, node.Depth));
        }
        return new Snapshot(elements, string.Join('\n', lines));
    }

    /// <summary>
    /// Whether a node gets an index. Indexes count these nodes in walk order, so a walker
    /// can keep the live element behind each index alongside.
    /// </summary>
    public static bool IsIndexed(SnapshotNode node) =>
        Actionable.Contains(node.Role) || node.Label.Length > 0 || node.Actions.Count > 0
        || (node.Role == "Text" && node.Value.Length > 0);

    private static string Line(Element element, int depth)
    {
        var parts = new List<string> { new string(' ', depth * 2) + "-" };
        if (element.Index >= 0) parts.Add($"[{element.Index}]");
        parts.Add(element.Role);
        if (element.Label.Length > 0) parts.Add($"\"{Clip(element.Label)}\"");
        if (element.Value.Length > 0 && element.Value != element.Label) parts.Add($"= \"{Clip(element.Value)}\"");
        return string.Join(' ', parts);
    }

    private static string Clip(string text)
    {
        var flat = text.Replace('\n', ' ').Replace('\r', ' ');
        return flat.Length > 120 ? flat[..117] + "..." : flat;
    }

    public Element? ByIndex(int index) => Elements.FirstOrDefault(e => e.Index == index);
    /// <summary>
    /// The element whose text best matches: an exact label or value first, then one
    /// containing the text, then the nearest indexed ancestor of a tree line containing
    /// it. Web and Electron apps often put the visible text in an unindexed child of the
    /// actionable element.
    /// </summary>
    public Element? ByText(string text)
    {
        var needle = text.ToLowerInvariant();
        var indexed = Elements.Where(e => e.Index >= 0).ToList();
        var exact = indexed.FirstOrDefault(e => e.Label.ToLowerInvariant() == needle || e.Value.ToLowerInvariant() == needle);
        if (exact is not null) return exact;
        var partial = indexed.FirstOrDefault(e =>
            e.Label.Contains(needle, StringComparison.OrdinalIgnoreCase) || e.Value.Contains(needle, StringComparison.OrdinalIgnoreCase));
        if (partial is not null) return partial;

        var lines = Tree.Split('\n');
        for (int n = 0; n < lines.Length; n++)
        {
            if (!lines[n].Contains(text, StringComparison.OrdinalIgnoreCase)) continue;
            int indent = Indent(lines[n]);
            for (int c = n; c >= 0; c--)
            {
                if (c != n && Indent(lines[c]) >= indent) continue;
                if (LeadingIndex(lines[c]) is int index && ByIndex(index) is { } element) return element;
            }
        }
        return null;
    }

    private static int Indent(string line) => line.Length - line.TrimStart(' ').Length;

    private static int? LeadingIndex(string line)
    {
        int open = line.IndexOf('[');
        if (open < 0) return null;
        int close = line.IndexOf(']', open);
        return close > open && int.TryParse(line.AsSpan(open + 1, close - open - 1), out var i) ? i : null;
    }
}
