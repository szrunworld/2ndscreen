using System.Globalization;

namespace SecondScreen.Tars;

/// <summary>
/// Learning from a run that worked, and replaying what was learned: the model explores once,
/// its commands are kept with the controls they acted on, and the next run of the
/// instruction repeats them by finding those controls again, which needs no model. A step
/// whose control is missing, text that did not land, or an end unlike the learned one hands
/// the rest to the model, and what it then does becomes the procedure.
/// </summary>
public sealed partial class Agent
{
    /// <summary>Containers: a click inside one is aimed at something they do not name.</summary>
    private static readonly HashSet<string> ContainerRoles = new()
        { "Pane", "Window", "Group", "List", "Tree", "Table", "DataGrid", "TitleBar", "MenuBar", "ToolBar", "Tab", "Custom" };
    /// <summary>Options that say where a command acts, which a replay works out again.</summary>
    private static readonly HashSet<string> PlaceOptions = new() { "--screen", "--pid", "--window-id", "--x", "--y", "--index", "--text" };
    /// <summary>Fewer named controls than this say too little about where a run ended.</summary>
    private const int FewestEndControls = 3;
    /// <summary>The share of the learned end's controls a replay's end must show.</summary>
    private const double EndSimilarity = 0.6;

    private readonly List<LearnedStep> trace = new();
    private string? unlearnable;
    private Rect currentFrame;
    private Dictionary<string, string> startTexts = new();
    private int modelCalls;
    private string? finishedContent;

    private enum ReplayEnd { Finished, HandOver }

    // Recording

    /// <summary>
    /// A command as a procedure would repeat it, with the control it acts on: the field it
    /// typed into, or the smallest named control under its point. Marks the run unlearnable
    /// when no control says where the command went.
    /// </summary>
    private LearnedStep? Learn(IReadOnlyList<string> words, (double X, double Y)? point)
    {
        var verb = words[0];
        var options = new List<string>();
        for (int i = 1; i < words.Count; i++)
        {
            if (PlaceOptions.Contains(words[i])) { i++; continue; }
            options.Add(words[i]);
        }
        var step = new LearnedStep { Verb = verb, Options = options };
        if (verb == "drag")
        {
            unlearnable ??= "a drag takes the real pointer";
            return null;
        }
        int at = words.ToList().IndexOf("--index");
        if (at >= 0 && int.TryParse(words[at + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var index))
        {
            if (Elements().FirstOrDefault(e => e.Index == index) is { } field && ElementRef.Of(field, currentFrame) is { } reference)
                return step with { Target = reference };
            unlearnable ??= $"the field a {verb} went to is gone";
            return null;
        }
        if (point is not { } p) return step;  // keys, and typing to the focus
        var frame = currentFrame;
        var under = Elements()
            .Where(e => e.Index >= 0 && e.Frame is { } box && box.Contains(p.X, p.Y) && !ContainerRoles.Contains(e.Role)
                        && (long)box.Width * box.Height <= (long)frame.Width * frame.Height / 5
                        && (e.Label.Trim().Length > 0 || TextRoles.Contains(e.Role)))
            .OrderBy(e => (long)e.Frame!.Value.Width * e.Frame!.Value.Height)
            .FirstOrDefault();
        if (under is null || ElementRef.Of(under, frame) is not { } target)
        {
            unlearnable ??= $"a {verb} went to a point no control names";
            return null;
        }
        var b = under.Frame!.Value;
        return step with { Target = target, OffsetX = (p.X - b.X) / Math.Max(b.Width, 1), OffsetY = (p.Y - b.Y) / Math.Max(b.Height, 1) };
    }

    private static string Key(ElementRef reference) =>
        $"{reference.Role}|{(int)Math.Round(reference.X * 500)}|{(int)Math.Round(reference.Y * 500)}";

    private static string TextOf(Element element)
    {
        static string Clean(string text) =>
            new string(text.Where(c => CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.Format).ToArray()).Trim();
        var value = Clean(element.Value);
        return value.Length > 0 ? value : Clean(element.Label);
    }

    /// <summary>Letters and digits only, so "1,651" answers "1651".</summary>
    private static string Plain(string text) => new(text.Where(char.IsLetterOrDigit).ToArray());

    private Dictionary<string, string> Texts(IEnumerable<Element> elements, Rect frame)
    {
        var texts = new Dictionary<string, string>();
        foreach (var element in elements)
            if (ElementRef.Of(element, frame) is { } reference) texts[Key(reference)] = TextOf(element);
        return texts;
    }

    /// <summary>The named controls on screen as "role|label", less plain text and labels in <paramref name="except"/>.</summary>
    private static List<string> Controls(IEnumerable<Element> elements, Rect frame, IReadOnlyList<string> except) =>
        elements.Where(e => e.Index >= 0 && e.Role != "Text" && e.Frame is { } box && frame.Contains(box.CenterX, box.CenterY))
            .Select(e => (e.Role, Label: e.Label.Trim()))
            .Where(e => e.Label.Length > 0 && !except.Any(x => e.Label.StartsWith(x, StringComparison.Ordinal)))
            .Select(e => $"{e.Role}|{e.Label}").Distinct().ToList();

    // Learning

    /// <summary>Keep a run that worked as a procedure, and say on the result what became of it.</summary>
    private AgentResult Finish(AgentResult result, string instruction, IProcedureStore store)
    {
        if (!result.Done) return result with { Learned = "not learned: the run did not finish" };
        if (unlearnable is not null) return result with { Learned = $"not learned: {unlearnable}" };
        if (!trace.Any(s => s.Verb != "wait")) return result with { Learned = "not learned: nothing was done" };
        Rect frame;
        try { frame = screen.Frame(); } catch (Exception) { frame = currentFrame; }
        var elements = Elements();

        var finish = ProcedureFinish.Steps;
        ElementRef? answerFrom = null;
        if (finishedContent is { Length: > 0 } content)
        {
            string said = Plain(content), asked = Plain(instruction);
            var shown = elements.Select(e => (Ref: ElementRef.Of(e, frame), Text: TextOf(e)))
                .Where(s => s.Ref is not null && Plain(s.Text) is { Length: > 0 } bare && said.Contains(bare, StringComparison.Ordinal)
                            // Text the instruction already holds, such as the sum it gave, is not what the run found out.
                            && !asked.Contains(bare, StringComparison.Ordinal)
                            && (!startTexts.TryGetValue(Key(s.Ref), out var before) || before != s.Text))
                .OrderByDescending(s => Plain(s.Text).Length).FirstOrDefault();
            if (shown.Ref is { } found)
            {
                finish = ProcedureFinish.Element;
                // Found by place: its label is the answer, which changes.
                answerFrom = Plain(found.Label) == Plain(shown.Text) ? found with { Label = "" } : found;
            }
            else if (ReportsBack(instruction, content))
            {
                finish = ProcedureFinish.Model;
            }
        }

        var found2 = Slots.Discover(instruction, trace, new[] { result.Reason });
        var bound = Slots.Match(found2.Template, instruction) ?? new List<string>();
        var end = Controls(elements, frame, bound);
        // Nothing to check a replay's end against; let the model look.
        if (finish == ProcedureFinish.Steps && end.Count < FewestEndControls) finish = ProcedureFinish.Model;
        var procedure = new Procedure
        {
            App = options.App, Instruction = instruction, Template = found2.Template, Slots = found2.Slots,
            Steps = found2.Steps, Finish = finish, AnswerFrom = answerFrom, Reason = found2.Texts[0],
            EndControls = end, AllowSubmit = options.AllowSubmit, Learned = DateTime.UtcNow, Successes = 1,
        };
        var known = store.Load(options.App);
        known.RemoveAll(p => p.Template == procedure.Template && p.AllowSubmit == procedure.AllowSubmit);
        known.Add(procedure);
        store.Save(known, options.App);
        log($"~ learned {procedure.Steps.Count} step(s) for next time");
        return result with { ModelCalls = modelCalls, Learned = "saved" };
    }

    /// <summary>Whether the instruction asks for something to be read and reported: one short question to the model.</summary>
    private bool ReportsBack(string instruction, string content)
    {
        modelCalls++;
        var question = $"A GUI agent was given this task:\n{instruction}\n\nIt finished and reported:\n{content}\n\n" +
            "Does the task ask for information to be read from the screen and reported back, as opposed to only " +
            "carrying out actions? Answer with one word: yes or no.";
        try
        {
            var answer = model.Complete(new Message[] { new Message.User(question) }).ToLowerInvariant();
            return answer.Contains("yes") || answer.Contains('是');
        }
        catch (Exception)
        {
            return true;
        }
    }

    // Replay

    private (ReplayEnd End, AgentResult? Result, string? Why, bool Failed) Replay(Procedure procedure, IReadOnlyList<string> bindings, string instruction)
    {
        (ReplayEnd, AgentResult?, string?, bool) Broke(string why) => (ReplayEnd.HandOver, null, why, true);
        for (int number = 0; number < procedure.Steps.Count; number++)
        {
            var step = procedure.Steps[number];
            var what = $"step {number + 1} ({step.Summary(bindings)})";
            if (step.Verb == "wait")
            {
                // A wait only gave the program time, which finding the next control does better.
                if (procedure.Steps.ElementAtOrDefault(number + 1)?.Target is null)
                    Thread.Sleep(Math.Min(step.Milliseconds ?? 1000, options.ReplayPatienceMs));
                trace.Add(step);
                continue;
            }
            var words = new List<string> { step.Verb, "--screen", target.Screen, "--pid", target.Pid.ToString(CultureInfo.InvariantCulture) };
            if (target.WindowId is { } id) words.AddRange(new[] { "--window-id", id.ToString(CultureInfo.InvariantCulture) });
            words.AddRange(step.Options.Select(o => Slots.Fill(o, bindings)));

            Element? element = null;
            if (step.Target is { } wanted)
            {
                element = Eventually(es => wanted.Find(es, currentFrame, bindings));
                if (element?.Frame is not { } box) return Broke($"{what}: its control is not on screen");
                if (step.Verb == "type")
                {
                    words.AddRange(new[] { "--index", element.Index.ToString(CultureInfo.InvariantCulture) });
                }
                else
                {
                    double x = step.OffsetX is { } ox ? box.X + ox * box.Width : box.CenterX;
                    double y = step.OffsetY is { } oy ? box.Y + oy * box.Height : box.CenterY;
                    words.AddRange(new[] { "--x", Math.Round(x).ToString(CultureInfo.InvariantCulture), "--y", Math.Round(y).ToString(CultureInfo.InvariantCulture) });
                }
            }
            else
            {
                Thread.Sleep(Math.Min(300, options.ReplayPatienceMs));
            }

            // The guards a model's command goes through.
            if (!options.AllowSubmit)
            {
                if (step.Verb == "click" && element is not null && SubmitLabel.IsMatch(element.Label.Trim())) return Broke($"{what} would submit");
                if (step.Verb == "type" && (Slots.Fill(step.Option("--value") ?? "", bindings)).EndsWith('\n')) return Broke($"{what} would submit");
                if (step.Verb == "key" && step.Option("--key") is "return" or "enter" && step.Option("--modifiers") is null) return Broke($"{what} would submit");
            }

            log($"  $ 2ndscreen {string.Join(' ', words)}");
            try
            {
                var output = screen.Run(words);
                if (output["ok"]?.GetValue<bool>() != true) return Broke($"{what} failed: {output["error"]}");
            }
            catch (Exception error)
            {
                return Broke($"{what} failed: {error.Message}");
            }
            trace.Add(step);

            // Typed text shows in a field that reports its text.
            if (step.Verb == "type" && step.Target is { } field && element is not null && TextRoles.Contains(element.Role)
                && Slots.Fill(step.Option("--value") ?? "", bindings).TrimEnd('\n') is { Length: > 0 } text
                && Eventually(es => field.Find(es, currentFrame, bindings) is { } now && now.Value.Contains(text, StringComparison.Ordinal) ? now : null) is null)
                return Broke($"{what}: the text did not land");
        }

        // The same steps ending somewhere else did something else.
        if (procedure.EndControls.Count >= FewestEndControls)
        {
            var learned = procedure.EndControls.ToHashSet();
            if (Eventually(es => Controls(es, currentFrame, bindings).Count(learned.Contains) >= EndSimilarity * learned.Count ? es.FirstOrDefault() ?? new Element(-1, "", "", "", Array.Empty<string>(), null) : null) is null)
                return Broke("the screen does not end as it did when this was learned");
        }
        int steps = procedure.Steps.Count;
        switch (procedure.Finish)
        {
            case ProcedureFinish.Steps:
                return (ReplayEnd.Finished, new AgentResult(true, Slots.Fill(procedure.Reason, bindings), steps, modelCalls, steps), null, false);
            case ProcedureFinish.Element:
                if (procedure.AnswerFrom is not { } from || Eventually(es => from.Find(es, currentFrame, bindings, anyLabel: true)) is not { } shown)
                    return Broke("the control that held the answer is not on screen");
                var answer = TextOf(shown);
                if (answer.Length == 0) return Broke("the control that held the answer is empty");
                if (Plain(instruction).Contains(Plain(answer), StringComparison.Ordinal))
                    return Broke("the control that held the answer shows the instruction's own text");
                return (ReplayEnd.Finished, new AgentResult(true, answer, steps, modelCalls, steps), null, false);
            default:
                return (ReplayEnd.HandOver, null, "the steps ran; the answer takes a look at the screen", false);
        }
    }

    /// <summary>Wait until a fresh read of the window gives something, or patience runs out.</summary>
    private Element? Eventually(Func<IReadOnlyList<Element>, Element?> test)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(options.ReplayPatienceMs);
        while (true)
        {
            try { currentFrame = screen.Frame(); } catch (Exception) { }
            if (test(Elements()) is { } found) return found;
            if (DateTime.UtcNow >= deadline) return null;
            Thread.Sleep(400);
        }
    }
}
