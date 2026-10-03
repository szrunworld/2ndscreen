using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SecondScreen.Tars;

/// <summary>What the agent sees and acts on: one program on one agent screen.</summary>
public interface IAgentScreen
{
    /// <summary>The screen's current frame. Frames move when screens come and go, so it is read every step.</summary>
    Rect Frame();
    /// <summary>The whole screen as a PNG, in the same pixels as <see cref="Frame"/>.</summary>
    byte[] Screenshot();
    /// <summary>Run a 2ndscreen command and return its JSON.</summary>
    JsonObject Run(IReadOnlyList<string> words);
    /// <summary>The program window's elements, from <c>state</c>.</summary>
    IReadOnlyList<Element> Elements();
}

/// <summary>
/// With <paramref name="Procedures"/>, a run that worked is kept as a procedure for
/// <paramref name="App"/>, and the next run of the same instruction replays it without the model.
/// </summary>
public sealed record AgentOptions(int MaxSteps = 25, bool AllowSubmit = false, bool Foreground = false,
                                  IProcedureStore? Procedures = null, string App = "", int ReplayPatienceMs = 6000);

/// <summary>
/// How a run ended. <paramref name="ModelCalls"/> counts requests to the model, none when a
/// learned procedure ran through; <paramref name="Replayed"/> the steps taken from one;
/// <paramref name="Learned"/> what became of the run as a procedure.
/// </summary>
public sealed record AgentResult(bool Done, string Reason, int Steps, int ModelCalls = 0, int Replayed = 0, string? Learned = null);

/// <summary>
/// Runs an instruction with a UI-TARS model: screenshot, ask the model, act, repeat, until
/// it finishes, asks for help, or a guard stops it.
/// </summary>
public sealed partial class Agent
{
    public const string ActionSpaces = """
        click(start_box='[x1, y1, x2, y2]')
        left_double(start_box='[x1, y1, x2, y2]')
        right_single(start_box='[x1, y1, x2, y2]')
        drag(start_box='[x1, y1, x2, y2]', end_box='[x3, y3, x4, y4]')
        hotkey(key='')
        type(content='') #If you want to submit your input, use "\n" at the end of `content`.
        scroll(start_box='[x1, y1, x2, y2]', direction='down or up or right or left')
        wait() #Sleep for 5s and take a screenshot to check for any changes.
        finished(content='') #Use this when the task is done; put any answer in content.
        call_user() # Submit the task and call the user when the task is unsolvable, or when you need the user's help.
        """;

    /// <summary>UI-TARS's prompt (<c>@ui-tars/sdk</c>, Apache-2.0, ByteDance), with this agent's action space.</summary>
    public static string Prompt(string instruction) => $"""
        You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

        ## Output Format
        ```
        Thought: ...
        Action: ...
        ```

        ## Action Space
        {ActionSpaces}

        ## Note
        - Write a small plan and finally summarize your next action (with its target element) in one sentence in `Thought` part.

        ## User Instruction
        {instruction}
        """;

    /// <summary>Screenshots the model sees at once; older ones leave the history.</summary>
    public const int MaxImages = 5;
    private static readonly Regex SubmitIntent = new(@"发送|發送|提交|\bsend\b|\bsubmit\b", RegexOptions.IgnoreCase);
    private static readonly Regex SubmitLabel = new(@"^(发送|發送|send)(\s*\(s\))?$", RegexOptions.IgnoreCase);
    private static readonly HashSet<string> TextRoles = new() { "Edit", "Document", "ComboBox" };

    private readonly IAgentScreen screen;
    private readonly IVisionModel model;
    private readonly AgentOptions options;
    private readonly Action<string> log;
    private readonly PlanContext target;
    /// <summary>Where the model last clicked, to find the field it then types into.</summary>
    private (double X, double Y)? lastClick;

    public Agent(IAgentScreen screen, IVisionModel model, PlanContext target, AgentOptions? options = null, Action<string>? log = null)
    {
        this.screen = screen;
        this.model = model;
        this.target = target;
        this.options = options ?? new AgentOptions();
        this.log = log ?? (_ => { });
    }

    public AgentResult Run(string instruction)
    {
        instruction = instruction.Trim();
        trace.Clear();
        unlearnable = null;
        modelCalls = 0;
        finishedContent = null;
        startTexts = new();
        if (options.Procedures is not { } store) return Explore(instruction, null);

        var known = store.Load(options.App);
        try
        {
            currentFrame = screen.Frame();
            startTexts = Texts(Elements(), currentFrame);
        }
        catch (Exception) { }
        if (Procedure.Best(instruction, known, options.AllowSubmit) is not { } best)
            return Finish(Explore(instruction, null), instruction, store);
        var (procedure, bindings) = best;
        int position = known.FindIndex(p => p.Template == procedure.Template && p.AllowSubmit == procedure.AllowSubmit);

        log($"~ replaying {procedure.Steps.Count} learned step(s)");
        var (end, result, why, failed) = Replay(procedure, bindings, instruction);
        if (end == ReplayEnd.Finished)
        {
            known[position].Successes++;
            known[position].Failures = 0;
            store.Save(known, options.App);
            return result! with { Learned = "replayed" };
        }
        log($"~ {why}; the model takes over");
        int replayed = trace.Count;
        if (failed)
        {
            // Three replays in a row that broke off: it no longer fits.
            if (++known[position].Failures >= 3) known.RemoveAt(position);
            store.Save(known, options.App);
        }
        return Finish(Explore(instruction, (procedure, bindings, why!)), instruction, store) with { Replayed = replayed };
    }

    /// <summary>Run the instruction with the model, from the screen as it is; <paramref name="alreadyDone"/> says what a replay did before it stopped.</summary>
    private AgentResult Explore(string instruction, (Procedure Procedure, List<string> Bindings, string Why)? alreadyDone)
    {
        var messages = new List<Message> { new Message.User(Prompt(instruction)) };
        if (alreadyDone is var (procedure, bindings, why))
        {
            var done = string.Join('\n', trace.Select((s, i) => $"{i + 1}. {s.Summary(bindings)}"));
            messages.Add(new Message.User("These steps of a procedure learned for this task were just performed on this screen:\n" +
                (done.Length == 0 ? "(none)" : done) + $"\nIt stopped there: {why}. Look at the screenshot and carry on from where " +
                "things stand; do not repeat a step whose effect already shows." +
                (procedure.Steps.Count == trace.Count ? " If the task is done, finish with the answer." : "")));
        }
        int failedShots = 0;
        bool replyWithoutAction = false;
        for (int step = 1; step <= Math.Max(options.MaxSteps, 1); step++)
        {
            Rect frame;
            try
            {
                frame = screen.Frame();
                currentFrame = frame;
                messages.Add(new Message.Screenshot(screen.Screenshot()));
            }
            catch (Exception error)
            {
                log($"  ! screenshot: {error.Message}");
                if (++failedShots >= 3) return new AgentResult(false, $"screenshots keep failing: {error.Message}", step, modelCalls);
                Thread.Sleep(1000);
                continue;
            }
            TrimImages(messages);

            string reply;
            try
            {
                modelCalls++;
                reply = model.Complete(messages);
            }
            catch (Exception error)
            {
                return new AgentResult(false, error.Message, step, modelCalls);
            }
            messages.Add(new Message.Assistant(ActionParser.Summary(reply)));
            var prediction = ActionParser.Parse(reply);
            if (prediction.Thought.Length > 0) log($"· {prediction.Thought}");
            foreach (var action in prediction.Actions)
                log($"  → {action.Type}({string.Join(", ", action.Inputs.Select(i => $"{i.Key}={i.Value}"))})");

            if (prediction.Actions.Count == 0)
            {
                log($"  ! no action in the reply: {reply}");
                // Models that consider the task done tend to answer in prose. Remind once;
                // a second answer without an action is final.
                if (replyWithoutAction)
                {
                    finishedContent = reply.Trim();
                    return new AgentResult(true, finishedContent, step, modelCalls);
                }
                replyWithoutAction = true;
                messages.Add(new Message.User("Answer in the format `Thought: ...` then `Action: ...`, " +
                    "using one action from the action space; use finished(content='...') when the task is done."));
                continue;
            }
            replyWithoutAction = false;

            var context = target with { Frame = frame, AllowSubmit = options.AllowSubmit, Foreground = options.Foreground };
            foreach (var parsed in prediction.Actions)
            {
                var action = parsed;
                foreach (var name in new[] { "start_box", "end_box" })
                {
                    if (!action.Inputs.ContainsKey(name) || action.Boxes.ContainsKey(name)) continue;
                    if (ActionParser.RecoverBox(reply, name) is { } box)
                    {
                        action.Boxes[name] = box;
                        log($"  ! read {name} [{string.Join(", ", box)}] from the raw reply");
                    }
                }
                // Models often finish with the answer in the thought only.
                if (action.Type == "finished" && action.Input("content").Length == 0 && prediction.Thought.Length > 0)
                    action.Inputs["content"] = prediction.Thought;
                foreach (var planned in Planner.Plan(action, context))
                {
                    if (Execute(planned, prediction.Thought.Length > 0 ? prediction.Thought : reply) is { } end)
                    {
                        if (action.Type == "finished" && end.Done) finishedContent = end.Reason;
                        return end with { Steps = step, ModelCalls = modelCalls };
                    }
                }
            }
        }
        return new AgentResult(false, $"reached {options.MaxSteps} steps", options.MaxSteps, modelCalls);
    }

    /// <summary>Run one step; returns how the run ends, if it does.</summary>
    private AgentResult? Execute(Step step, string thought)
    {
        switch (step)
        {
            case Step.Stop stop:
                log($"  stop: {stop.Reason}");
                return new AgentResult(stop.Done, stop.Reason, 0);
            case Step.Wait wait:
                log($"  wait {wait.Milliseconds / 1000} s");
                Thread.Sleep(wait.Milliseconds);
                if (options.Procedures is not null) trace.Add(new LearnedStep { Verb = "wait", Milliseconds = wait.Milliseconds });
                return null;
            case Step.Run run:
            {
                var words = run.Words.ToList();
                bool click = words[0] == "click";
                if (click && !options.AllowSubmit)
                {
                    // Programs that draw their own controls hide a Send button from UI Automation,
                    // so also go by what the model says this step does: the thought's last sentence,
                    // where UI-TARS states the next action. A click into a text field never sends.
                    if (SubmitIntent.IsMatch(NextActionSentence(thought)) && run.Point is { } point && Field(point) is null)
                    {
                        const string reason = "stopped before a click the model describes as sending";
                        log($"  stop: {reason}");
                        return new AgentResult(true, reason, 0);
                    }
                    if (run.Point is { } at && Elements().Any(e => SubmitLabel.IsMatch(e.Label.Trim()) && Contains(e.Frame, at)))
                    {
                        const string reason = "stopped before clicking a control that submits";
                        log($"  stop: {reason}");
                        return new AgentResult(true, reason, 0);
                    }
                }
                if (click) lastClick = run.Point;
                // Type into the field the model clicked by naming it, since a program that was
                // never activated has no focused control to take keys.
                if (words[0] == "type" && lastClick is { } clicked && Field(clicked) is { } field)
                    words.AddRange(new[] { "--index", field.Index.ToString(System.Globalization.CultureInfo.InvariantCulture) });
                log($"  $ 2ndscreen {string.Join(' ', words)}");
                var learned = options.Procedures is null ? null : Learn(words, run.Point);
                try
                {
                    var output = screen.Run(words);
                    if (output["ok"]?.GetValue<bool>() != true) log($"  ! {output["error"]}");
                    // Only what worked is worth repeating.
                    else if (learned is not null) trace.Add(learned);
                }
                catch (Exception error)
                {
                    // Carry on: the next screenshot shows the model nothing changed.
                    log($"  ! {error.Message}");
                }
                return null;
            }
            default:
                return null;
        }
    }

    private IReadOnlyList<Element> Elements()
    {
        try { return screen.Elements(); }
        catch (Exception) { return Array.Empty<Element>(); }
    }

    /// <summary>The smallest text field containing the point.</summary>
    private Element? Field((double X, double Y) point) =>
        Elements().Where(e => e.Index >= 0 && TextRoles.Contains(e.Role) && Contains(e.Frame, point))
            .OrderBy(e => (long)e.Frame!.Value.Width * e.Frame!.Value.Height).FirstOrDefault();

    private static bool Contains(Rect? frame, (double X, double Y) point) =>
        frame is { } f && point.X >= f.X && point.X <= f.X + f.Width && point.Y >= f.Y && point.Y <= f.Y + f.Height;

    /// <summary>The last sentence of a thought, where UI-TARS summarises the action it is about to take.</summary>
    public static string NextActionSentence(string thought) =>
        thought.Split(new[] { '。', '！', '？', '.', '!', '?', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .LastOrDefault() ?? thought;

    public static void TrimImages(List<Message> messages)
    {
        int images = messages.Count(m => m is Message.Screenshot);
        for (int i = 0; i < messages.Count && images > MaxImages; i++)
        {
            if (messages[i] is not Message.Screenshot) continue;
            messages.RemoveAt(i--);
            images--;
        }
    }
}
