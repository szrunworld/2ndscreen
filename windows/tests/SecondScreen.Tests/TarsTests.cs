using System.Text.Json.Nodes;
using SecondScreen.Tars;
using Xunit;

namespace SecondScreen.Tests;

public class TarsParsingTests
{
    private static ParsedAction Action(string text) => ActionParser.Parse($"Thought: t\nAction: {text}").Actions[0];

    [Fact]
    public void ThoughtAndAction()
    {
        var prediction = ActionParser.Parse("Thought: 点击文件传输助手。\nAction: click(start_box='[100, 200, 300, 400]')");
        Assert.Equal("点击文件传输助手。", prediction.Thought);
        Assert.Equal("click", prediction.Actions.Single().Type);
        Assert.Equal(new[] { 0.1, 0.2, 0.3, 0.4 }, prediction.Actions[0].Boxes["start_box"]);
    }

    [Fact]
    public void PointsAndOddBoxes()
    {
        Assert.Equal(new[] { 0.5, 0.25, 0.5, 0.25 }, Action("click(start_box='(500,250)')").Boxes["start_box"]);
        Assert.Equal(new[] { 0.383, 0.117, 0.383, 0.117 }, Action("click(point='<point>383 117</point>')").Boxes["start_box"]);
        Assert.Equal(new[] { 0.383, 0.117, 0.383, 0.117 }, Action("click(start_box='[383 117]')").Boxes["start_box"]);
    }

    [Fact]
    public void TextArguments()
    {
        Assert.Equal("你好，世界\\n", Action("type(content='你好，世界\\n')").Input("content"));
        Assert.Equal("down", Action("scroll(start_box='[500, 500, 500, 500]', direction='down')").Input("direction"));
        Assert.Equal("done, really", Action("finished(content='done, really')").Input("content"));
        Assert.Equal("wait", ActionParser.Parse("Action：wait()").Actions.Single().Type);
        Assert.Empty(ActionParser.Parse("not an action at all").Actions);
    }

    [Fact]
    public void RecoveringBoxes()
    {
        Assert.Equal(new[] { 0.383, 0.117, 0.383, 0.117 }, ActionParser.RecoverBox("Action: click(start_box='[383 117]')", "start_box"));
        Assert.Equal(new[] { 0.3, 0.4, 0.3, 0.4 }, ActionParser.RecoverBox("drag(start_box='(100,200)', end_box='(300,400)')", "end_box"));
        Assert.Null(ActionParser.RecoverBox("click(start_box='[383]')", "start_box"));
    }
}

public class TarsPlanningTests
{
    private static readonly Rect Frame = new(1920, 0, 1280, 800);
    private static readonly PlanContext Context = new("s", 7, null, Frame);
    private static ParsedAction Action(string text) => ActionParser.Parse($"Action: {text}").Actions[0];
    private static List<string>? Words(List<Step> steps, int i = 0) => (steps.ElementAtOrDefault(i) as Step.Run)?.Words.ToList();

    [Fact]
    public void BoxesMapOntoTheScreen()
    {
        Assert.Equal((2560.0, 200.0), Planner.Point(new[] { 0.5, 0.25, 0.5, 0.25 }, Frame));
        Assert.Equal((3200.0, 0.0), Planner.Point(new[] { 2.0, -1.0 }, Frame));
        Assert.Null(Planner.Point(null, Frame));
    }

    [Fact]
    public void ClicksCarryThePointAndButton()
    {
        var right = Words(Planner.Plan(Action("right_single(start_box='[500, 500, 500, 500]')"), Context))!;
        Assert.Equal(new[] { "click", "--screen", "s", "--pid", "7", "--x", "2560", "--y", "400", "--right" }, right);
        Assert.Contains("--double", Words(Planner.Plan(Action("left_double(start_box='[0, 0, 0, 0]')"), Context))!);
    }

    [Fact]
    public void TypingThatWouldSubmitStops()
    {
        var steps = Planner.Plan(Action("type(content='好的，明天见\\n')"), Context);
        Assert.Equal("好的，明天见", Words(steps)![^1]);
        Assert.True(Assert.IsType<Step.Stop>(steps[1]).Done);
        var sent = Planner.Plan(Action("type(content='hi\\n')"), Context with { AllowSubmit = true });
        Assert.Equal(new[] { "key", "--screen", "s", "--pid", "7", "--key", "return" }, Words(sent, 1));
    }

    [Fact]
    public void EnterStopsUnlessAllowedOrInAMenu()
    {
        Assert.IsType<Step.Stop>(Planner.Plan(Action("hotkey(key='enter')"), Context).Single());
        Assert.IsType<Step.Stop>(Planner.Plan(Action("hotkey(key='ctrl enter')"), Context).Single());
        Assert.IsType<Step.Run>(Planner.Plan(Action("hotkey(key='Enter')"), Context with { AllowSubmit = true }).Single());
        Assert.IsType<Step.Run>(Planner.Plan(Action("hotkey(key='enter')"), Context with { MenuOpen = true }).Single());
    }

    [Fact]
    public void KeysStayWindowsKeys()
    {
        static string Spell((string Key, List<string> Modifiers)? keys) => keys is { } k ? string.Join('+', k.Modifiers.Append(k.Key)) : "";
        Assert.Equal("ctrl+c", Spell(Planner.Keys("ctrl c")));
        Assert.Equal("ctrl+shift+n", Spell(Planner.Keys("ctrl+shift+n")));
        Assert.Equal("pagedown", Spell(Planner.Keys("page down")));
        Assert.Equal("win+d", Spell(Planner.Keys("cmd d")));
        Assert.Null(Planner.Keys("ctrl"));
        Assert.Equal(new[] { "key", "--screen", "s", "--pid", "7", "--key", "a", "--modifiers", "ctrl" },
            Words(Planner.Plan(Action("hotkey(key='ctrl a')"), Context)));
    }

    [Fact]
    public void ShortcutsBeyondTheWindowStop()
    {
        foreach (var keys in new[] { "alt f4", "alt tab", "win d", "cmd space", "ctrl esc", "ctrl shift esc", "ctrl alt delete" })
            Assert.False(Assert.IsType<Step.Stop>(Planner.Plan(Action($"hotkey(key='{keys}')"), Context).Single()).Done);
        foreach (var keys in new[] { "ctrl a", "ctrl c", "esc", "ctrl shift n", "alt f" })
            Assert.IsType<Step.Run>(Planner.Plan(Action($"hotkey(key='{keys}')"), Context).Single());
    }

    [Fact]
    public void DragsRunInTheBackground()
    {
        var words = Words(Planner.Plan(Action("drag(start_box='[100, 100, 100, 100]', end_box='[200, 200, 200, 200]')"), Context))!;
        Assert.Equal(new[] { "drag", "--screen", "s", "--pid", "7", "--from-x", "2048", "--from-y", "80", "--to-x", "2176", "--to-y", "160" }, words);
    }

    [Fact]
    public void FinishedCarriesTheAnswer()
    {
        var stop = Assert.IsType<Step.Stop>(Planner.Plan(Action("finished(content='最新消息是：你好')"), Context).Single());
        Assert.True(stop.Done);
        Assert.Equal("最新消息是：你好", stop.Reason);
        Assert.False(Assert.IsType<Step.Stop>(Planner.Plan(Action("call_user()"), Context).Single()).Done);
    }
}

public class TarsLoopTests
{
    private sealed class FakeScreen : IAgentScreen
    {
        public List<List<string>> Ran { get; } = new();
        public List<Element> Fields { get; } = new();
        public Rect Frame() => new(1920, 0, 1280, 800);
        public byte[] Screenshot() => new byte[] { 0x89, 0x50, 0x4E, 0x47 };
        public JsonObject Run(IReadOnlyList<string> words)
        {
            Ran.Add(words.ToList());
            return new JsonObject { ["ok"] = true };
        }
        public IReadOnlyList<Element> Elements() => Fields;
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

    private static readonly PlanContext Target = new("s", 7, null, new Rect(0, 0, 1, 1));

    private static Element Field(int index, Rect frame, string label = "", string role = "Edit") =>
        new(index, role, label, "", Array.Empty<string>(), frame);

    [Fact]
    public void ClickTypeFinish()
    {
        var screen = new FakeScreen();
        screen.Fields.Add(Field(4, new Rect(1920, 600, 1280, 200)));
        var model = new ScriptedModel(
            "Thought: 点输入框\nAction: click(start_box='[500, 875, 500, 875]')",
            "Thought: 输入\nAction: type(content='明天见')",
            "Thought: 完成\nAction: finished(content='typed')");
        var result = new Agent(screen, model, Target).Run("在输入框里写明天见");
        Assert.True(result.Done);
        Assert.Equal("typed", result.Reason);
        Assert.Equal(new[] { "click", "type" }, screen.Ran.Select(r => r[0]));
        // Typing goes to the field the model clicked, by its index.
        Assert.Equal(new[] { "--index", "4" }, screen.Ran[1].TakeLast(2));
        Assert.Contains("## User Instruction\n在输入框里写明天见", Assert.IsType<Message.User>(model.Seen[0][0]).Text.Replace("\r\n", "\n"));
    }

    [Fact]
    public void ClickOnSendStops()
    {
        var screen = new FakeScreen();
        screen.Fields.Add(Field(9, new Rect(3000, 700, 100, 40), "发送", "Button"));
        var result = new Agent(screen, new ScriptedModel("Thought: 点按钮\nAction: click(start_box='[900, 900, 900, 900]')"), Target).Run("x");
        Assert.True(result.Done);
        Assert.Contains("submits", result.Reason);
        Assert.Empty(screen.Ran);
    }

    [Fact]
    public void APlanThatSendsLaterStillClicksIntoTheField()
    {
        var screen = new FakeScreen();
        screen.Fields.Add(Field(3, new Rect(1920, 700, 1200, 60)));
        var model = new ScriptedModel(
            "Thought: 先点击输入框，输入回复后再发送。现在点击底部的输入框。\nAction: click(start_box='[500, 900, 500, 900]')",
            "Thought: 输入回复。\nAction: type(content='好的')",
            "Thought: 现在点击发送按钮。\nAction: click(start_box='[990, 950, 990, 950]')");
        var result = new Agent(screen, model, Target).Run("x");
        Assert.Equal(new[] { "click", "type" }, screen.Ran.Select(r => r[0]));
        Assert.Contains("sending", result.Reason);
    }

    [Fact]
    public void AnAnswerInTheThoughtIsKept()
    {
        var result = new Agent(new FakeScreen(), new ScriptedModel("Thought: 结果是 1776。\nAction: finished()"), Target).Run("x");
        Assert.True(result.Done);
        Assert.Equal("结果是 1776。", result.Reason);
    }

    [Fact]
    public void ProseTwiceInARowIsTheAnswer()
    {
        var model = new ScriptedModel("已经发送了。", "任务完成，消息已发送。");
        var result = new Agent(new FakeScreen(), model, Target).Run("x");
        Assert.True(result.Done);
        Assert.Equal("任务完成，消息已发送。", result.Reason);
        Assert.Equal(2, result.Steps);
        Assert.Contains(model.Seen[1], m => m is Message.User u && u.Text.Contains("finished"));
    }

    [Fact]
    public void OldScreenshotsLeaveTheHistory()
    {
        var model = new ScriptedModel(Enumerable.Repeat("Action: hover(start_box='[1, 1, 1, 1]')", 8).ToArray());
        var result = new Agent(new FakeScreen(), model, Target, new AgentOptions(MaxSteps: 8)).Run("x");
        Assert.False(result.Done);
        Assert.Equal(Agent.MaxImages, model.Seen[^1].Count(m => m is Message.Screenshot));
    }
}
