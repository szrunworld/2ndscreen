using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace SecondScreen.Tars;

/// <summary>
/// A control as a learned step names it: by role and label, which survive the window being
/// rebuilt, and by where its center was, normalised to the screen, to tell twins apart.
/// The label may hold slots.
/// </summary>
public sealed record ElementRef(string Role, string Label, double X, double Y)
{
    /// <summary>How far an unnamed control may have moved and still be the one.</summary>
    public const double Reach = 0.1;

    public static ElementRef? Of(Element element, Rect frame)
    {
        if (element.Index < 0 || element.Frame is not { } box) return null;
        var (x, y) = Normalise(box, frame);
        return new ElementRef(element.Role, element.Label.Trim(), x, y);
    }

    public static (double X, double Y) Normalise(Rect box, Rect frame) =>
        ((box.CenterX - frame.X) / Math.Max(frame.Width, 1), (box.CenterY - frame.Y) / Math.Max(frame.Height, 1));

    /// <summary>
    /// The element this names among <paramref name="elements"/>: same role and label, the
    /// nearest to where it was. A label that was a slot matches labels that start with what
    /// the slot now holds, a whole match first.
    /// </summary>
    public Element? Find(IEnumerable<Element> elements, Rect frame, IReadOnlyList<string> bindings)
    {
        double Distance(Element e)
        {
            var (x, y) = Normalise(e.Frame!.Value, frame);
            return Math.Sqrt((x - X) * (x - X) + (y - Y) * (y - Y));
        }
        var wanted = Slots.Fill(Label, bindings);
        bool open = Slots.HasSlot(Label) && wanted.EndsWith('…');
        if (open) wanted = wanted[..^1];
        return elements
            .Where(e => e.Index >= 0 && e.Role == Role && e.Frame is not null)
            .Select(e =>
            {
                var found = e.Label.Trim();
                if (Label.Length == 0) return found.Length == 0 && Distance(e) <= Reach ? (e, 0) : (e, -1);
                if (found == wanted) return (e, 0);
                if (Slots.HasSlot(Label) && found.StartsWith(wanted, StringComparison.Ordinal)) return (e, 1);
                return (e, -1);
            })
            .Where(m => m.Item2 >= 0)
            .OrderBy(m => m.Item2).ThenBy(m => Distance(m.e))
            .Select(m => m.e).FirstOrDefault();
    }
}

/// <summary>One command of a learned procedure, as the 2ndscreen command it ran less its target.</summary>
public sealed record LearnedStep
{
    /// <summary>The command, such as click, type, key or scroll; or "wait".</summary>
    public required string Verb { get; init; }
    /// <summary>Its options other than the screen, program and point, such as --double or --value; values may hold slots.</summary>
    public List<string> Options { get; init; } = new();
    public ElementRef? Target { get; init; }
    /// <summary>For a command the model aimed at a point: where in the target it landed, 0 to 1.</summary>
    public double? OffsetX { get; init; }
    public double? OffsetY { get; init; }
    public int? Milliseconds { get; init; }

    public string Summary(IReadOnlyList<string> bindings)
    {
        var parts = new List<string> { Verb };
        parts.AddRange(Options.Select(o => Slots.Fill(o, bindings)));
        if (Milliseconds is { } ms) parts.Add($"{ms / 1000} s");
        if (Target is { } t) parts.Add(t.Label.Length == 0 ? $"→ {t.Role}" : $"→ {t.Role} \"{Slots.Fill(t.Label, bindings)}\"");
        return string.Join(' ', parts);
    }

    /// <summary>The value an option holds, such as --value's text.</summary>
    public string? Option(string name)
    {
        int at = Options.IndexOf(name);
        return at >= 0 && at + 1 < Options.Count ? Options[at + 1] : null;
    }
}

public enum ProcedureFinish
{
    /// <summary>The task is done when the steps are.</summary>
    Steps,
    /// <summary>The answer is the text of <see cref="Procedure.AnswerFrom"/> once the steps ran.</summary>
    Element,
    /// <summary>The answer takes a look at the screen: the model gives it.</summary>
    Model,
}

/// <summary>The steps that carried out an instruction in a program once, kept so the next run can repeat them without the model.</summary>
public sealed record Procedure
{
    public required string App { get; init; }
    public required string Instruction { get; init; }
    /// <summary>The instruction with the texts its steps use replaced by slots.</summary>
    public required string Template { get; init; }
    public int Slots { get; init; }
    public List<LearnedStep> Steps { get; init; } = new();
    public ProcedureFinish Finish { get; init; }
    public ElementRef? AnswerFrom { get; init; }
    public string Reason { get; init; } = "";
    /// <summary>The named controls on screen when the run ended, as "role|label".</summary>
    public List<string> EndControls { get; init; } = new();
    public bool AllowSubmit { get; init; }
    public DateTime Learned { get; init; }
    public int Successes { get; set; }
    /// <summary>Replays in a row that had to hand over to the model.</summary>
    public int Failures { get; set; }

    /// <summary>The procedure for an instruction and what its slots hold: one learned from these exact words first, then the most specific.</summary>
    public static (Procedure Procedure, List<string> Bindings)? Best(string instruction, IEnumerable<Procedure> procedures, bool allowSubmit) =>
        procedures.Where(p => p.AllowSubmit == allowSubmit)
            .Select(p => (p, b: SecondScreen.Tars.Slots.Match(p.Template, instruction)))
            .Where(m => m.b is not null)
            .OrderBy(m => m.p.Instruction == instruction ? 0 : 1).ThenBy(m => m.p.Slots)
            .Select(m => ((Procedure, List<string>)?)(m.p, m.b!))
            .FirstOrDefault();
}

/// <summary>
/// Slots stand for the parts of an instruction its steps use: typed text, and names of
/// controls acted on. Found by looking: such a text that the instruction holds is a slot.
/// </summary>
public static class Slots
{
    private static readonly Regex Pattern = new(@"⟦(\d+)⟧");
    /// <summary>Shorter texts match by accident: "1" is in most instructions.</summary>
    public const int MinLength = 2;

    public static string Marker(int number) => $"⟦{number}⟧";
    public static bool HasSlot(string text) => Pattern.IsMatch(text);

    public static string Fill(string text, IReadOnlyList<string> bindings)
    {
        for (int i = 0; i < bindings.Count; i++) text = text.Replace(Marker(i), bindings[i]);
        return text;
    }

    public static (string Template, List<LearnedStep> Steps, List<string> Texts, int Slots) Discover(
        string instruction, IReadOnlyList<LearnedStep> steps, IReadOnlyList<string> texts)
    {
        var literals = new List<string>();
        void Add(string text)
        {
            text = text.Trim();
            if (text.Length >= MinLength && instruction.Contains(text, StringComparison.Ordinal) && !literals.Contains(text)) literals.Add(text);
        }
        foreach (var step in steps)
        {
            if (step.Verb == "type" && step.Option("--value") is { } value) Add(value);
            if (step.Target is { Label.Length: > 0 } target)
                Add(instruction.Contains(target.Label, StringComparison.Ordinal) ? target.Label : LeadingPart(target.Label, instruction));
        }

        // Longest first, each where the instruction still has room for it.
        var taken = new List<(int Start, int End, string Literal)>();
        foreach (var literal in literals.OrderByDescending(l => l.Length))
        {
            for (int from = 0; (from = instruction.IndexOf(literal, from, StringComparison.Ordinal)) >= 0; from += literal.Length)
            {
                int end = from + literal.Length;
                int start = from;
                if (!taken.Any(t => t.Start < end && start < t.End)) taken.Add((start, end, literal));
            }
        }
        taken.Sort((a, b) => a.Start.CompareTo(b.Start));
        // Two slots with nothing between them cannot be told apart next time; keep the longer.
        for (int i = 1; i < taken.Count;)
        {
            if (taken[i - 1].End == taken[i].Start && taken[i - 1].Literal != taken[i].Literal)
            {
                var drop = taken[i - 1].Literal.Length < taken[i].Literal.Length ? taken[i - 1].Literal : taken[i].Literal;
                taken.RemoveAll(t => t.Literal == drop);
                i = 1;
            }
            else
            {
                i++;
            }
        }

        var numbers = new Dictionary<string, int>();
        foreach (var t in taken) numbers.TryAdd(t.Literal, numbers.Count);
        var template = new System.Text.StringBuilder();
        int position = 0;
        foreach (var t in taken)
        {
            template.Append(instruction, position, t.Start - position).Append(Marker(numbers[t.Literal]));
            position = t.End;
        }
        template.Append(instruction, position, instruction.Length - position);

        var ordered = numbers.OrderByDescending(n => n.Key.Length).ToList();
        string Mark(string text) => ordered.Aggregate(text, (s, n) => s.Replace(n.Key, Marker(n.Value)));
        var marked = steps.Select(step =>
        {
            var options = step.Options.ToList();
            if (step.Verb == "type")
            {
                int at = options.IndexOf("--value");
                if (at >= 0 && at + 1 < options.Count) options[at + 1] = Mark(options[at + 1]);
            }
            var target = step.Target;
            if (target is not null && ordered.FirstOrDefault(n => target.Label.StartsWith(n.Key, StringComparison.Ordinal)) is { Key: not null } literal)
                target = target with { Label = Marker(literal.Value) + (target.Label == literal.Key ? "" : "…") };
            return step with { Options = options, Target = target };
        }).ToList();
        return (template.ToString(), marked, texts.Select(Mark).ToList(), numbers.Count);
    }

    /// <summary>What the slots of a template hold in an instruction, or null if it is a different one.</summary>
    public static List<string>? Match(string template, string instruction)
    {
        var expression = new System.Text.StringBuilder("^");
        var groups = new Dictionary<int, int>();
        int position = 0;
        foreach (System.Text.RegularExpressions.Match found in Pattern.Matches(template))
        {
            expression.Append(Regex.Escape(template[position..found.Index]));
            int number = int.Parse(found.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
            if (groups.TryGetValue(number, out var group)) expression.Append($"\\{group}");
            else
            {
                groups[number] = groups.Count + 1;
                expression.Append("(.+?)");
            }
            position = found.Index + found.Length;
        }
        expression.Append(Regex.Escape(template[position..])).Append('$');
        var match = Regex.Match(instruction, expression.ToString(), RegexOptions.Singleline);
        if (!match.Success) return null;
        var bindings = new string[groups.Count];
        foreach (var (number, group) in groups)
        {
            if (number >= bindings.Length) return null;
            bindings[number] = match.Groups[group].Value;
        }
        return bindings.Any(b => b.Trim().Length == 0) ? null : bindings.ToList();
    }

    /// <summary>The longest start of a label that the instruction contains.</summary>
    public static string LeadingPart(string label, string instruction)
    {
        int length = 0;
        while (length < label.Length && instruction.Contains(label[..(length + 1)], StringComparison.Ordinal)) length++;
        return label[..length];
    }
}

/// <summary>Where procedures are kept between runs.</summary>
public interface IProcedureStore
{
    List<Procedure> Load(string app);
    void Save(List<Procedure> procedures, string app);
}

/// <summary>One JSON file a program, under a directory.</summary>
public sealed class FileProcedureStore : IProcedureStore
{
    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public string Directory { get; }

    public FileProcedureStore(string directory) => Directory = directory;

    /// <summary>%APPDATA%\2ndscreen\procedures</summary>
    public static FileProcedureStore Standard => new(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "2ndscreen", "procedures"));

    public string FileFor(string app)
    {
        var name = new string(app.Select(c => char.IsLetterOrDigit(c) || c is '.' or '-' ? c : '_').ToArray());
        return Path.Combine(Directory, (name.Length == 0 ? "app" : name) + ".json");
    }

    public List<Procedure> Load(string app)
    {
        try
        {
            return JsonSerializer.Deserialize<List<Procedure>>(File.ReadAllText(FileFor(app)), Json) ?? new();
        }
        catch (Exception)
        {
            return new();
        }
    }

    public void Save(List<Procedure> procedures, string app)
    {
        System.IO.Directory.CreateDirectory(Directory);
        var path = FileFor(app);
        var scratch = path + ".tmp";
        File.WriteAllText(scratch, JsonSerializer.Serialize(procedures, Json));
        File.Move(scratch, path, overwrite: true);
    }
}
