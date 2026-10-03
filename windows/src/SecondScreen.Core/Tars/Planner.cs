using System.Globalization;

namespace SecondScreen.Tars;

/// <summary>What to do for one model action.</summary>
public abstract record Step
{
    /// <summary>Run a 2ndscreen command; <paramref name="Point"/> is where it acts, if anywhere.</summary>
    public sealed record Run(IReadOnlyList<string> Words, (double X, double Y)? Point = null) : Step;
    public sealed record Wait(int Milliseconds) : Step;
    /// <summary>End the run: done when the model finished or stopped short of submitting, user when it needs a person.</summary>
    public sealed record Stop(bool Done, string Reason) : Step;
}

public sealed record PlanContext(string Screen, int Pid, long? WindowId, Rect Frame,
                                 bool AllowSubmit = false, bool Foreground = false, bool MenuOpen = false);

/// <summary>
/// Turns one parsed UI-TARS action into 2ndscreen commands. Pure, so the mapping and the
/// send policy are tested anywhere.
/// </summary>
public static class Planner
{
    private static readonly HashSet<string> ModifierWords = new()
        { "ctrl", "control", "cmd", "command", "meta", "win", "super", "shift", "alt", "option" };
    private static readonly Dictionary<string, string> KeyNames = new()
    {
        ["arrowup"] = "up", ["arrowdown"] = "down", ["arrowleft"] = "left", ["arrowright"] = "right",
        ["esc"] = "escape", ["enter"] = "return",
    };

    /// <summary>The center of a normalised box as a point on the screen, in its pixels.</summary>
    public static (double X, double Y)? Point(double[]? box, Rect frame)
    {
        if (box is not { Length: >= 2 }) return null;
        var (x1, y1) = (box[0], box[1]);
        var (x2, y2) = box.Length >= 4 ? (box[2], box[3]) : (x1, y1);
        double nx = Math.Clamp((x1 + x2) / 2, 0, 1), ny = Math.Clamp((y1 + y2) / 2, 0, 1);
        return (Math.Round(frame.X + nx * frame.Width), Math.Round(frame.Y + ny * frame.Height));
    }

    /// <summary>"ctrl c", "ctrl+shift+n" or "enter" as a key and its modifiers.</summary>
    public static (string Key, List<string> Modifiers)? Keys(string text)
    {
        var words = System.Text.RegularExpressions.Regex.Replace(text.ToLowerInvariant(), "page (up|down)", "page$1")
            .Split(new[] { ' ', '+' }, StringSplitOptions.RemoveEmptyEntries);
        var modifiers = new List<string>();
        string? key = null;
        foreach (var word in words)
        {
            if (ModifierWords.Contains(word))
            {
                var modifier = word switch
                {
                    "control" => "ctrl",
                    "cmd" or "command" or "meta" or "super" => "win",
                    "option" => "alt",
                    _ => word,
                };
                if (!modifiers.Contains(modifier)) modifiers.Add(modifier);
            }
            else
            {
                key = KeyNames.GetValueOrDefault(word) ?? word;
            }
        }
        return key is null ? null : (key, modifiers);
    }

    /// <summary>
    /// Shortcuts that act beyond the program's window: closing it, switching programs, and
    /// the system's own. Models reach for them when stuck.
    /// </summary>
    public static string? Escape(string key, IReadOnlyList<string> modifiers)
    {
        var held = modifiers.ToHashSet();
        if (held.Contains("win")) return "use a Windows shortcut";
        if (held.Contains("alt") && key is "f4") return "close the program";
        if (held.Contains("alt") && key is "tab" or "escape") return "switch programs";
        if (held.Contains("ctrl") && key is "escape") return "open the Start menu";
        if (held.Contains("ctrl") && held.Contains("alt") && key is "delete") return "open the security screen";
        if (held.Contains("ctrl") && held.Contains("shift") && key is "escape") return "open Task Manager";
        return null;
    }

    private static List<string> Target(PlanContext context)
    {
        var words = new List<string> { "--screen", context.Screen, "--pid", context.Pid.ToString(CultureInfo.InvariantCulture) };
        if (context.WindowId is { } id) words.AddRange(new[] { "--window-id", id.ToString(CultureInfo.InvariantCulture) });
        return words;
    }

    private static string Number(double value) => value.ToString(CultureInfo.InvariantCulture);

    public static List<Step> Plan(ParsedAction action, PlanContext context)
    {
        var start = Point(action.Boxes.GetValueOrDefault("start_box"), context.Frame);
        var end = Point(action.Boxes.GetValueOrDefault("end_box"), context.Frame);
        switch (action.Type)
        {
            case "click" or "left_click" or "left_single" or "left_double" or "double_click" or "right_single" or "right_click":
            {
                if (start is not { } point) return new() { new Step.Stop(false, $"{action.Type} without a point") };
                var words = new List<string> { "click" };
                words.AddRange(Target(context));
                words.AddRange(new[] { "--x", Number(point.X), "--y", Number(point.Y) });
                if (action.Type is "left_double" or "double_click") words.Add("--double");
                if (action.Type is "right_single" or "right_click") words.Add("--right");
                return new() { new Step.Run(words, point) };
            }

            case "drag" or "left_click_drag" or "select":
            {
                if (start is not { } from || end is not { } to) return new() { new Step.Stop(false, "drag without both points") };
                var words = new List<string> { "drag" };
                words.AddRange(Target(context));
                words.AddRange(new[] { "--from-x", Number(from.X), "--from-y", Number(from.Y), "--to-x", Number(to.X), "--to-y", Number(to.Y) });
                if (context.Foreground) words.Add("--foreground");
                return new() { new Step.Run(words, from) };
            }

            case "type":
            {
                // A trailing newline, literal or escaped, means "and submit".
                var text = action.Input("content");
                bool submit = false;
                foreach (var ending in new[] { "\\n", "\n" })
                {
                    if (!text.EndsWith(ending, StringComparison.Ordinal)) continue;
                    text = text[..^ending.Length];
                    submit = true;
                    break;
                }
                var steps = new List<Step>();
                if (text.Length > 0)
                {
                    var words = new List<string> { "type" };
                    words.AddRange(Target(context));
                    words.AddRange(new[] { "--value", text.Replace("\\n", "\n") });
                    steps.Add(new Step.Run(words));
                }
                if (submit)
                {
                    if (context.AllowSubmit)
                    {
                        var words = new List<string> { "key" };
                        words.AddRange(Target(context));
                        words.AddRange(new[] { "--key", "return" });
                        steps.Add(new Step.Run(words));
                    }
                    else
                    {
                        steps.Add(new Step.Stop(true, "stopped before submitting; the text is typed but not sent"));
                    }
                }
                return steps;
            }

            case "hotkey" or "press" or "keydown":
            {
                var spec = action.Input("key");
                if (spec.Length == 0) spec = action.Input("hotkey");
                if (Keys(spec) is not { } keys) return new();
                bool enterInMenu = keys.Key == "return" && keys.Modifiers.Count == 0 && context.MenuOpen;
                if (keys.Key == "return" && !context.AllowSubmit && !enterInMenu)
                    return new() { new Step.Stop(true, "stopped before pressing Enter, which would submit") };
                if (Escape(keys.Key, keys.Modifiers) is { } effect)
                    return new() { new Step.Stop(false, $"the model asked for {string.Join('+', keys.Modifiers.Append(keys.Key))}, which would {effect}; a person should look") };
                var words = new List<string> { "key" };
                words.AddRange(Target(context));
                words.AddRange(new[] { "--key", keys.Key });
                if (keys.Modifiers.Count > 0) words.AddRange(new[] { "--modifiers", string.Join(',', keys.Modifiers) });
                return new() { new Step.Run(words) };
            }

            case "scroll":
            {
                var direction = action.Input("direction").ToLowerInvariant();
                if (direction is not ("up" or "down" or "left" or "right")) return new();
                var words = new List<string> { "scroll" };
                words.AddRange(Target(context));
                words.AddRange(new[] { "--direction", direction, "--amount", "5" });
                if (start is { } point) words.AddRange(new[] { "--x", Number(point.X), "--y", Number(point.Y) });
                return new() { new Step.Run(words, start) };
            }

            case "wait":
                return new() { new Step.Wait(5000) };
            case "finished":
            {
                var content = action.Input("content");
                return new() { new Step.Stop(true, content.Length > 0 ? content : "finished") };
            }
            case "call_user" or "error_env" or "user_stop":
                return new() { new Step.Stop(false, action.Type) };
            case "hover" or "mouse_move":
                // Nothing to do: agents act without moving a pointer.
                return new();
            default:
                return new() { new Step.Stop(false, $"unsupported action {action.Type}") };
        }
    }
}
