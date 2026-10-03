using System.Globalization;
using System.Text.RegularExpressions;

namespace SecondScreen.Tars;

/// <summary>One action a UI-TARS model asked for.</summary>
/// <param name="Inputs">Arguments as written.</param>
/// <param name="Boxes"><c>start_box</c> and <c>end_box</c> normalised to 0..1, as x1, y1, x2, y2.</param>
public sealed record ParsedAction(string Type, Dictionary<string, string> Inputs, Dictionary<string, double[]> Boxes)
{
    public ParsedAction(string type) : this(type, new(), new()) { }
    public string Input(string name) => Inputs.GetValueOrDefault(name) ?? "";
}

/// <summary>A model reply: its reasoning and the actions it chose.</summary>
public sealed record Prediction(string Thought, IReadOnlyList<ParsedAction> Actions, string Raw);

/// <summary>
/// Reads UI-TARS replies, in the <c>Thought: … Action: …</c> format of its prompt. Follows
/// <c>@ui-tars/action-parser</c> (Apache-2.0, ByteDance) for what models write, and also reads
/// boxes it misses: models now and then drop the comma, <c>[383 117]</c>, or write
/// <c>&lt;point&gt;383 117&lt;/point&gt;</c>.
/// </summary>
public static class ActionParser
{
    private const double Factor = 1000;
    private static readonly Regex Numbers = new(@"-?\d+(?:\.\d+)?", RegexOptions.Compiled);

    public static Prediction Parse(string text)
    {
        text = text.Trim();
        var thought = "";
        var match = Regex.Match(text, @"Thought:\s*([\s\S]+?)(?=\s*Action[:：]|$)");
        if (!match.Success) match = Regex.Match(text, @"Action_Summary:\s*([\s\S]+?)(?=\s*Action[:：]|$)");
        if (match.Success) thought = match.Groups[1].Value.Trim();

        var actionText = text;
        var last = Regex.Matches(text, "Action[:：]").LastOrDefault();
        if (last is not null) actionText = text[(last.Index + last.Length)..];
        var actions = actionText.Split("\n\n").Select(chunk => chunk.Trim()).Where(chunk => chunk.Length > 0)
            .Select(ParseCall).OfType<ParsedAction>().ToList();
        return new Prediction(thought, actions, text);
    }

    /// <summary><c>name(key='value', …)</c> as an action, or null if it is not a call.</summary>
    public static ParsedAction? ParseCall(string text)
    {
        var call = text.Replace("<|box_start|>", "").Replace("<|box_end|>", "").Replace("\n", "\\n");
        call = Regex.Replace(call, @"(?<!start_|end_)point=", "start_box=").Replace("start_point=", "start_box=").Replace("end_point=", "end_box=");
        int open = call.IndexOf('(');
        if (open <= 0 || !call.EndsWith(')')) return null;
        var name = call[..open].Trim();
        if (name.Length == 0 || !name.All(c => char.IsLetterOrDigit(c) || c == '_')) return null;

        var action = new ParsedAction(name);
        foreach (var (key, value) in Arguments(call[(open + 1)..^1]))
        {
            if (key.Contains("start_box") || key.Contains("end_box"))
            {
                var box = key.Contains("start_box") ? "start_box" : "end_box";
                if (Box(value) is { } numbers) action.Boxes[box] = numbers;
                action.Inputs[box] = value;
            }
            else
            {
                action.Inputs[key] = value;
            }
        }
        return action;
    }

    /// <summary><c>key='value'</c> pairs, split on commas outside quotes and brackets.</summary>
    private static List<(string, string)> Arguments(string body)
    {
        var pairs = new List<(string, string)>();
        var current = new System.Text.StringBuilder();
        char? quote = null;
        void Flush()
        {
            var text = current.ToString();
            int equals = text.IndexOf('=');
            if (equals > 0)
            {
                var key = text[..equals].Trim();
                var value = text[(equals + 1)..].Trim();
                if (value.Length > 0 && value[0] is '\'' or '"') value = value[1..];
                if (value.Length > 0 && value[^1] is '\'' or '"') value = value[..^1];
                if (key.Length > 0) pairs.Add((key, value));
            }
            current.Clear();
        }
        foreach (var c in body)
        {
            if (quote is { } q)
            {
                if (c == q) quote = null;
                current.Append(c);
            }
            else if (c is '\'' or '"')
            {
                quote = c;
                current.Append(c);
            }
            else if (c == ',' && (!current.ToString().Contains('=') || Balanced(current.ToString())))
            {
                Flush();
            }
            else
            {
                current.Append(c);
            }
        }
        Flush();
        return pairs;
    }

    private static bool Balanced(string text) =>
        text.Count(c => c is '(' or '[') == text.Count(c => c is ')' or ']');

    /// <summary>
    /// A box as four numbers in 0..1 from any of the forms models write; a point becomes a
    /// box of zero size. Values above 1 are on the 0..1000 scale.
    /// </summary>
    public static double[]? Box(string text)
    {
        var numbers = Numbers.Matches(text).Select(m => double.Parse(m.Value, CultureInfo.InvariantCulture)).ToList();
        if (numbers.Count < 2) return null;
        double scale = numbers.Any(n => n > 1) ? Factor : 1;
        var n = numbers.Take(4).Select(v => v / scale).ToArray();
        return n.Length >= 4 ? n : new[] { n[0], n[1], n[0], n[1] };
    }

    /// <summary>The box named <paramref name="name"/> read again from the whole reply.</summary>
    public static double[]? RecoverBox(string prediction, string name)
    {
        int at = prediction.LastIndexOf(name, StringComparison.Ordinal);
        if (at < 0) return null;
        var rest = prediction[(at + name.Length)..];
        foreach (var stop in new[] { "end_box", "direction", "content" })
        {
            int end = rest.IndexOf(stop, StringComparison.Ordinal);
            if (end >= 0) rest = rest[..end];
        }
        return Box(rest);
    }

    /// <summary>The reply as it goes into the conversation history: without any Reflection block.</summary>
    public static string Summary(string prediction) =>
        Regex.Replace(prediction, @"Reflection:[\s\S]*?(?=Action_Summary:|Action:|$)", "").Trim();
}
