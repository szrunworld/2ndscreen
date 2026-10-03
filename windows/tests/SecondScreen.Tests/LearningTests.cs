using System.Globalization;
using System.Text.Json.Nodes;
using SecondScreen.Tars;
using Xunit;

namespace SecondScreen.Tests;

public class LearningTests
{
    private static readonly Rect ScreenFrame = new(1920, 0, 1280, 800);
    private static readonly PlanContext Target = new("s", 7, null, ScreenFrame);

    private sealed class MemoryStore : IProcedureStore
    {
        public List<Procedure> Procedures { get; private set; } = new();
        public List<Procedure> Load(string app) => Procedures.ToList();
        public void Save(List<Procedure> procedures, string app) => Procedures = procedures.ToList();
    }

    /// <summary>A screen whose program reacts to the commands run on it.</summary>
    private sealed class FakeScreen : IAgentScreen
    {
        public List<List<string>> Ran { get; } = new();
        public List<Element> Fields { get; set; } = new();
        public Action<FakeScreen, List<string>>? AfterRun { get; set; }
        public Rect Frame() => ScreenFrame;
        public byte[] Screenshot() => new byte[] { 0x89, 0x50, 0x4E, 0x47 };
        public JsonObject Run(IReadOnlyList<string> words)
        {
            Ran.Add(words.ToList());
            AfterRun?.Invoke(this, words.ToList());
            return new JsonObject { ["ok"] = true };
        }
        public IReadOnlyList<Element> Elements() => Fields;

        public static (double X, double Y)? PointOf(List<string> words)
        {
            int x = words.IndexOf("--x"), y = words.IndexOf("--y");
            return x < 0 || y < 0 ? null
                : (double.Parse(words[x + 1], CultureInfo.InvariantCulture), double.Parse(words[y + 1], CultureInfo.InvariantCulture));
        }

        public Element? Under(List<string> words) =>
            PointOf(words) is { } p ? Fields.FirstOrDefault(e => e.Frame is { } f && f.Contains(p.X, p.Y)) : null;
    }

    private sealed class ScriptedModel : IVisionModel
    {
        private readonly Queue<string> replies;
        public List<List<Message>> Seen { get; } = new();
        public ScriptedModel(params string[] replies) => this.replies = new Queue<string>(replies);
        public string Complete(IReadOnlyList<Message> messages)
        {
            Seen.Add(messages.ToList());
            return replies.Count > 0 ? replies.Dequeue() : "Action: finished(content='out of script')";
        }
    }

    private static Element Button(int index, string label, int x, int y = 100, string value = "", string role = "Button") =>
        new(index, role, label, value, Array.Empty<string>(), new Rect(x, y, 100, 40));

    /// <summary>Buttons, and a display that shows what was pressed; = shows 15.</summary>
    private static FakeScreen Calculator(int shift = 0)
    {
        var screen = new FakeScreen();
        var pressed = new List<string>();
        List<Element> Layout(string shown) => new()
        {
            Button(1, "七", 2000 + shift, 300), Button(2, "八", 2200 + shift, 300), Button(3, "等于", 2400 + shift, 300),
            Button(4, "清除", 2600 + shift, 300), Button(5, "", 2000, 100, shown, "Text"),
        };
        screen.Fields = Layout("0");
        screen.AfterRun = (s, words) =>
        {
            if (words[0] != "click" || s.Under(words) is not { } button) return;
            pressed.Add(button.Label);
            s.Fields = Layout(button.Label == "等于" ? "15" : string.Concat(pressed));
        };
        return screen;
    }

    // Boxes on the 0-1000 scale for the buttons' centers on the 1280x800 screen.
    private static readonly string[] Script =
    {
        "Thought: 按七\nAction: click(start_box='[102, 400, 102, 400]')",
        "Thought: 按八\nAction: click(start_box='[258, 400, 258, 400]')",
        "Thought: 按等于\nAction: click(start_box='[414, 400, 414, 400]')",
        "Thought: 结果\nAction: finished(content='结果是 15')",
    };

    private static AgentOptions Options(IProcedureStore store) => new(Procedures: store, App: "test", ReplayPatienceMs: 0);

    private static AgentResult Run(FakeScreen screen, ScriptedModel model, IProcedureStore store, string instruction = "算七加八") =>
        new Agent(screen, model, Target, Options(store)).Run(instruction);

    [Fact]
    public void TheSecondRunNeedsNoModel()
    {
        var store = new MemoryStore();
        var first = Run(Calculator(), new ScriptedModel(Script), store);
        Assert.True(first.Done);
        Assert.Equal("saved", first.Learned);
        Assert.Equal(4, first.ModelCalls);
        Assert.Equal(ProcedureFinish.Element, Assert.Single(store.Procedures).Finish);

        var screen = Calculator();
        var silent = new ScriptedModel();
        var second = Run(screen, silent, store);
        // The answer is read off the display, not remembered.
        Assert.Equal("15", second.Reason);
        Assert.Equal(0, second.ModelCalls);
        Assert.Empty(silent.Seen);
        Assert.Equal(3, second.Replayed);
        Assert.Equal(new[] { "七", "八", "等于" }, screen.Ran.Select(w => Calculator().Under(w)?.Label ?? screen.Fields.First().Label));
        Assert.Equal(2, store.Procedures[0].Successes);
    }

    [Fact]
    public void AnAnswerWhoseLabelIsTheAnswerIsReadAgain()
    {
        // WinForms labels carry their text as their name: "Pressed 1", then "Pressed 2".
        var store = new MemoryStore();
        FakeScreen Counter()
        {
            int presses = 0;
            var screen = new FakeScreen { Fields = new() { Button(1, "Press me", 2000), Button(2, "Pressed 0", 2200, role: "Text") } };
            screen.AfterRun = (s, words) =>
            {
                if (s.Under(words)?.Label != "Press me") return;
                s.Fields[1] = Button(2, $"Pressed {++presses + 10}", 2200, role: "Text");
            };
            return screen;
        }
        Run(Counter(), new ScriptedModel("Action: click(start_box='[102, 150, 102, 150]')", "Action: finished(content='计数是 Pressed 11')"), store, "点按钮，读计数");
        Assert.Equal(ProcedureFinish.Element, store.Procedures[0].Finish);
        Assert.Equal("", store.Procedures[0].AnswerFrom!.Label);
        var again = Run(Counter(), new ScriptedModel(), store, "点按钮，读计数");
        Assert.Equal("Pressed 11", again.Reason);
        Assert.Equal(0, again.ModelCalls);
    }

    [Fact]
    public void ControlsAreFoundAgainWhereverTheyMoved()
    {
        var store = new MemoryStore();
        Run(Calculator(), new ScriptedModel(Script), store);
        var moved = Calculator(shift: 300);
        var result = Run(moved, new ScriptedModel(), store);
        Assert.Equal("15", result.Reason);
        Assert.Equal(0, result.ModelCalls);
        // The same spot in the button, where the button now is.
        Assert.InRange(FakeScreen.PointOf(moved.Ran[0])!.Value.X, 2349, 2352);
    }

    [Fact]
    public void AMissingControlHandsOverToTheModel()
    {
        var store = new MemoryStore();
        Run(Calculator(), new ScriptedModel(Script), store);

        // The program changed: 等于 is now "=".
        var screen = Calculator();
        var react = screen.AfterRun!;
        List<Element> Renamed(List<Element> fields) => fields.Select(e => e.Label == "等于" ? e with { Label = "=" } : e).ToList();
        screen.Fields = Renamed(screen.Fields);
        screen.AfterRun = (s, words) =>
        {
            var equals = s.Under(words)?.Label == "=";
            if (equals) s.Fields = s.Fields.Select(e => e.Label == "=" ? e with { Label = "等于" } : e).ToList();
            react(s, words);
            s.Fields = Renamed(s.Fields);
        };
        var model = new ScriptedModel("Thought: 按 =\nAction: click(start_box='[414, 400, 414, 400]')", "Action: finished(content='结果是 15')");
        var result = Run(screen, model, store);
        Assert.True(result.Done);
        Assert.Equal(2, result.Replayed);
        Assert.Equal(2, result.ModelCalls);
        // The model was told what had run, and the procedure now names the new control.
        Assert.Contains(model.Seen[0], m => m is Message.User u && u.Text.Contains("1. click → Button \"七\"") && u.Text.Contains("not on screen"));
        Assert.Equal(new[] { "七", "八", "=" }, Assert.Single(store.Procedures).Steps.Select(s => s.Target?.Label));
    }

    [Fact]
    public void AProcedureThatKeepsBreakingIsForgotten()
    {
        var store = new MemoryStore();
        Run(Calculator(), new ScriptedModel(Script), store);
        for (int attempt = 1; attempt <= 3; attempt++)
        {
            var result = Run(new FakeScreen(), new ScriptedModel("Action: call_user()"), store);
            Assert.False(result.Done);
            Assert.Equal(attempt < 3 ? 1 : 0, store.Procedures.Count);
        }
    }

    [Fact]
    public void StepsAimedBySightAloneAreNotLearned()
    {
        var store = new MemoryStore();
        var result = Run(new FakeScreen(), new ScriptedModel("Action: click(start_box='[500, 500, 500, 500]')", "Action: finished(content='ok')"), store, "点中间");
        Assert.True(result.Done);
        Assert.Empty(store.Procedures);
        Assert.Contains("no control names", result.Learned);
    }

    [Fact]
    public void TheAnswerIsNotTextTheInstructionGave()
    {
        // The sum shows above the result, and the model's answer names both.
        var store = new MemoryStore();
        var screen = Calculator();
        var react = screen.AfterRun!;
        screen.AfterRun = (s, words) =>
        {
            react(s, words);
            if (s.Fields.Any(e => e.Value == "15")) s.Fields.Add(Button(6, "", 2000, 50, "七加八", "Text"));
        };
        Run(screen, new ScriptedModel(Script[..3].Append("Action: finished(content='七加八 的结果是 15')").ToArray()), store);
        Assert.Equal(ProcedureFinish.Element, store.Procedures[0].Finish);
        // The result's display (y 0.15), not the sum above it (y 0.09).
        Assert.InRange(store.Procedures[0].AnswerFrom!.Y, 0.14, 0.16);
    }

    [Fact]
    public void SlotsCarryANewInstructionThroughTheSameSteps()
    {
        var store = new MemoryStore();
        FakeScreen Chat()
        {
            var screen = new FakeScreen
            {
                Fields = new()
                {
                    Button(1, "陈一 前端", 1950, 100), Button(2, "李四 后端", 1950, 200),
                    new(3, "Edit", "消息", "", Array.Empty<string>(), new Rect(2200, 600, 800, 60)),
                    Button(4, "发送", 3000, 700), Button(5, "表情", 2200, 720), Button(6, "简历", 2400, 720),
                },
            };
            screen.AfterRun = (s, words) =>
            {
                int at = words.IndexOf("--value");
                if (words[0] == "type" && at >= 0) s.Fields[2] = s.Fields[2] with { Value = words[at + 1] };
            };
            return screen;
        }
        var model = new ScriptedModel(
            "Thought: 打开陈一\nAction: click(start_box='[63, 150, 63, 150]')",
            "Thought: 点输入框\nAction: click(start_box='[500, 787, 500, 787]')",
            "Thought: 写草稿\nAction: type(content='你好，还在招')",
            "Thought: 点击发送按钮。\nAction: click(start_box='[877, 900, 877, 900]')");
        var first = Run(Chat(), model, store, "给陈一写：你好，还在招");
        Assert.Contains("sending", first.Reason);
        Assert.Equal("saved", first.Learned);
        Assert.Equal("给⟦0⟧写：⟦1⟧", store.Procedures[0].Template);

        var screen = Chat();
        var silent = new ScriptedModel();
        var second = Run(screen, silent, store, "给李四写：方便发份简历吗");
        Assert.True(second.Done);
        Assert.Equal(0, second.ModelCalls);
        Assert.Empty(silent.Seen);
        Assert.Equal("李四 后端", screen.Under(screen.Ran[0])!.Label);
        Assert.Contains("方便发份简历吗", screen.Ran[2]);
        Assert.Contains("sending", second.Reason);

        // Someone the list does not show: the model takes over rather than guess.
        var third = Run(Chat(), new ScriptedModel("Action: call_user()"), store, "给赵六写：在吗");
        Assert.False(third.Done);
        Assert.Equal(0, third.Replayed);
    }

    [Fact]
    public void SlotsAreFoundInInstructions()
    {
        var step = new LearnedStep { Verb = "type", Options = new() { "--value", "你好，还在招" } };
        var click = new LearnedStep { Verb = "click", Target = new ElementRef("Button", "陈一 前端工程师", 0.1, 0.1) };
        var found = Slots.Discover("给陈一写：你好，还在招", new[] { click, step }, new[] { "已给陈一写好草稿" });
        Assert.Equal("给⟦0⟧写：⟦1⟧", found.Template);
        Assert.Equal("⟦0⟧…", found.Steps[0].Target!.Label);
        Assert.Equal("⟦1⟧", found.Steps[1].Option("--value"));
        Assert.Equal(new[] { "已给⟦0⟧写好草稿" }, found.Texts);
        Assert.Equal(new[] { "李四", "在的" }, Slots.Match(found.Template, "给李四写：在的"));
        Assert.Null(Slots.Match(found.Template, "打开设置"));
        // One character matches by accident.
        Assert.Equal(0, Slots.Discover("计算 3 + 4", new[] { new LearnedStep { Verb = "click", Target = new ElementRef("Button", "3", 0, 0) } }, Array.Empty<string>()).Slots);
    }

    [Fact]
    public void ProceduresSurviveTheFile()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"2ndscreen-procedures-{Guid.NewGuid()}");
        try
        {
            var store = new FileProcedureStore(directory);
            Run(Calculator(), new ScriptedModel(Script), store);
            var loaded = Assert.Single(store.Load("test"));
            Assert.Equal(3, loaded.Steps.Count);
            Assert.Equal("Text", loaded.AnswerFrom!.Role);
            Assert.EndsWith("CalculatorApp.exe_x.json", store.FileFor("CalculatorApp.exe/x"));
            Assert.Equal("15", Run(Calculator(), new ScriptedModel(), store).Reason);
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }
}
