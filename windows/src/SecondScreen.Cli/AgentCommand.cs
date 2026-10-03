using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using SecondScreen.Tars;

namespace SecondScreen.Cli;

/// <summary>
/// <c>2ndscreen agent</c>: run an instruction with a UI-TARS vision model on an agent screen,
/// acting only on one program, through this command's own state, click, type and the rest.
/// </summary>
[SupportedOSPlatform("windows")]
public static class AgentCommand
{
    public static int Run(Arguments args)
    {
        var instruction = string.Join(' ', args.Positional.Skip(1)).Trim();
        if (args.Value("--screen") is not { } screen || !int.TryParse(args.Value("--pid"), out var pid) || instruction.Length == 0)
        {
            Console.Error.WriteLine("usage: 2ndscreen agent --screen NAME --pid PID [--window-id ID] [--allow-submit] [--foreground] [--no-learn] [--max-steps N] INSTRUCTION");
            return 2;
        }
        long? windowId = long.TryParse(args.Value("--window-id"), out var id) ? id : null;
        int maxSteps = 25;
        if (args.Value("--max-steps") is { } steps && (!int.TryParse(steps, out maxSteps) || maxSteps < 1))
        {
            Console.Error.WriteLine("--max-steps takes a positive number");
            return 2;
        }

        AgentResult result;
        try
        {
            var model = ChatCompletionsModel.FromEnvironment();
            var target = new ControlScreen(screen, pid, windowId);
            var agent = new Agent(target, model, new PlanContext(screen, pid, windowId, target.Frame()),
                new AgentOptions(maxSteps, args.Has("--allow-submit"), args.Has("--foreground"),
                    args.Has("--no-learn") ? null : FileProcedureStore.Standard, ProgramName(pid)),
                line => Console.Error.WriteLine(line));
            result = agent.Run(instruction);
        }
        catch (Exception error)
        {
            result = new AgentResult(false, error.Message, 0);
        }
        var output = new JsonObject
        {
            ["ok"] = result.Done, ["outcome"] = result.Done ? "done" : "user", ["reason"] = result.Reason, ["steps"] = result.Steps,
            ["modelCalls"] = result.ModelCalls, ["replayedSteps"] = result.Replayed,
        };
        if (result.Learned is { } learned) output["learned"] = learned;
        Console.WriteLine(output.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = ProtocolJson.Pretty.Encoder }));
        return result.Done ? 0 : 1;
    }

    /// <summary>Procedures are kept by program: its executable's name, such as CalculatorApp.</summary>
    private static string ProgramName(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.ProcessName;
        }
        catch (Exception)
        {
            return $"pid-{pid}";
        }
    }

    /// <summary>The agent's view of one program on one screen, through the tray app and this command.</summary>
    private sealed class ControlScreen : IAgentScreen
    {
        private readonly string screen;
        private readonly int pid;
        private readonly long? windowId;

        public ControlScreen(string screen, int pid, long? windowId)
        {
            this.screen = screen;
            this.pid = pid;
            this.windowId = windowId;
        }

        /// <summary>
        /// The screen's frame, checked to still hold the program: displays rearrange as
        /// screens come and go, and the model must not act on a screen without it.
        /// </summary>
        public Rect Frame()
        {
            var list = ControlPipe.Send(new ControlRequest { Command = ControlRequest.ScreenList, Screen = screen });
            var info = list.Screens?.FirstOrDefault(s => s.Name == screen) ?? throw new InvalidOperationException($"no screen named \"{screen}\"");
            var frame = info.Frame.ToRect();
            if (!Desktop.WindowsOf(pid).Any(w => (windowId is null || w.Id == windowId) && frame.ContainsCenterOf(w.Frame)))
                throw new InvalidOperationException($"pid {pid} has no window on screen \"{screen}\" any more");
            return frame;
        }

        /// <summary>The whole screen in its physical pixels, the space the model's boxes map onto.</summary>
        public byte[] Screenshot()
        {
            var path = Path.Combine(Path.GetTempPath(), $"2ndscreen-agent-{Environment.ProcessId}.png");
            try
            {
                var response = ControlPipe.Send(new ControlRequest { Command = ControlRequest.Screenshot, Screen = screen, Output = path });
                if (!response.Ok) throw new InvalidOperationException(response.Error ?? "screenshot failed");
                return File.ReadAllBytes(path);
            }
            finally
            {
                File.Delete(path);
            }
        }

        public JsonObject Run(IReadOnlyList<string> words)
        {
            var start = new ProcessStartInfo(Environment.ProcessPath!)
            {
                RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8, StandardErrorEncoding = System.Text.Encoding.UTF8,
            };
            foreach (var word in words) start.ArgumentList.Add(word);
            using var process = Process.Start(start)!;
            var stderr = process.StandardError.ReadToEndAsync();
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            try
            {
                if (JsonNode.Parse(output) is JsonObject json) return json;
            }
            catch (JsonException) { }
            return new JsonObject { ["ok"] = false, ["error"] = (output + stderr.Result).Trim() };
        }

        public IReadOnlyList<Element> Elements()
        {
            var words = new List<string> { "state", "--screen", screen, "--pid", pid.ToString() };
            if (windowId is { } id) words.AddRange(new[] { "--window-id", id.ToString() });
            var state = Run(words);
            if (state["elements"] is not JsonArray elements) return Array.Empty<Element>();
            return elements.OfType<JsonObject>().Select(e =>
            {
                Rect? frame = e["frame"] is JsonObject f
                    ? new Rect(f["x"]!.GetValue<int>(), f["y"]!.GetValue<int>(), f["width"]!.GetValue<int>(), f["height"]!.GetValue<int>())
                    : null;
                return new Element(e["index"]?.GetValue<int>() ?? -1, e["role"]?.ToString() ?? "", e["label"]?.ToString() ?? "",
                    e["value"]?.ToString() ?? "", Array.Empty<string>(), frame);
            }).ToList();
        }
    }
}
