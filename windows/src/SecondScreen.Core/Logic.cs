using System.Globalization;
using System.Text.Json;

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

/// <summary>One element of a cua-driver accessibility snapshot.</summary>
public sealed record Element(int Index, string Token, string Role, string Label, string Value,
                             IReadOnlyList<string> Actions, Rect? Frame)
{
    public static Element From(JsonElement raw)
    {
        static string Str(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

        var label = Str(raw, "label");
        if (label.Length == 0) label = Str(raw, "title");
        if (label.Length == 0) label = Str(raw, "description");
        var actions = raw.TryGetProperty("actions", out var a) && a.ValueKind == JsonValueKind.Array
            ? a.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList()
            : new List<string>();
        Rect? frame = null;
        if (raw.TryGetProperty("frame", out var f) && f.ValueKind == JsonValueKind.Object
            && f.TryGetProperty("x", out var x) && f.TryGetProperty("y", out var y)
            && f.TryGetProperty("w", out var w) && f.TryGetProperty("h", out var h))
        {
            frame = new Rect((int)x.GetDouble(), (int)y.GetDouble(), (int)w.GetDouble(), (int)h.GetDouble());
        }
        return new Element(
            raw.TryGetProperty("element_index", out var i) && i.ValueKind == JsonValueKind.Number ? i.GetInt32() : -1,
            Str(raw, "element_token"), Str(raw, "role"), label, Str(raw, "value"), actions, frame);
    }

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

/// <summary>A cua-driver <c>get_window_state</c> result.</summary>
public sealed class Snapshot
{
    public string Id { get; }
    public IReadOnlyList<Element> Elements { get; }
    public string Tree { get; }
    public JsonElement Raw { get; }

    public Snapshot(JsonElement raw)
    {
        Raw = raw;
        Id = raw.GetProperty("snapshot_id").GetString() ?? "";
        Elements = raw.GetProperty("elements").EnumerateArray().Select(Element.From).ToList();
        Tree = raw.TryGetProperty("tree_markdown", out var t) ? t.GetString() ?? "" : "";
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
