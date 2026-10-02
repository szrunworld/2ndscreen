using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SecondScreen.Cli;

/// <summary>
/// cua-driver, found as <c>%CUA_DRIVER%</c>, else <c>cua-driver-local</c> or <c>cua-driver</c>
/// on PATH, else the installer's default location. Tokens are scoped to a session;
/// one per screen keeps a <c>state</c> call's indexes valid for the next <c>click</c>.
/// </summary>
public sealed class Driver
{
    public string Executable { get; } = Locate();
    public string Session { get; }

    public Driver(string screen) => Session = $"2ndscreen-{screen}";

    private static string Locate()
    {
        if (Environment.GetEnvironmentVariable("CUA_DRIVER") is { Length: > 0 } explicitPath) return explicitPath;
        var directories = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries).ToList();
        directories.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Cua\cua-driver\bin"));
        foreach (var name in new[] { "cua-driver-local", "cua-driver" })
        {
            foreach (var directory in directories)
            {
                foreach (var candidate in new[] { Path.Combine(directory, name + ".exe"), Path.Combine(directory, name) })
                {
                    if (File.Exists(candidate)) return candidate;
                }
            }
        }
        return "cua-driver";
    }

    /// <summary>
    /// Run one tool. Non-JSON output (some failures print text) becomes <c>error</c>.
    /// On Windows, tool calls go through cua-driver's daemon, which does not start
    /// itself; start it once and retry.
    /// </summary>
    public JsonObject Call(string tool, JsonObject arguments)
    {
        var result = CallOnce(tool, (JsonObject)arguments.DeepClone());
        if (result["error"]?.ToString() is { } error && error.Contains("daemon is not running", StringComparison.OrdinalIgnoreCase)
            && StartDaemon())
        {
            result = CallOnce(tool, arguments);
        }
        return result;
    }

    /// <summary>Start <c>cua-driver serve</c> in the background and wait until it answers.</summary>
    private bool StartDaemon()
    {
        try
        {
            Process.Start(new ProcessStartInfo(Executable, "serve") { UseShellExecute = false, CreateNoWindow = true });
        }
        catch (Exception)
        {
            return false;
        }
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            Thread.Sleep(300);
            var status = new ProcessStartInfo(Executable, "status")
            {
                RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
            };
            using var probe = Process.Start(status)!;
            var text = probe.StandardOutput.ReadToEnd() + probe.StandardError.ReadToEnd();
            probe.WaitForExit();
            if (probe.ExitCode == 0 && !text.Contains("not running", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private JsonObject CallOnce(string tool, JsonObject arguments)
    {
        arguments["session"] = Session;
        var start = new ProcessStartInfo(Executable)
        {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
        };
        start.ArgumentList.Add(tool);
        start.ArgumentList.Add(arguments.ToJsonString());
        string output;
        int status;
        try
        {
            using var process = Process.Start(start)!;
            var stderr = process.StandardError.ReadToEndAsync();
            output = process.StandardOutput.ReadToEnd() + stderr.Result;
            process.WaitForExit();
            status = process.ExitCode;
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or FileNotFoundException)
        {
            throw new InvalidOperationException("cua-driver not found; install it or set CUA_DRIVER");
        }
        try
        {
            if (JsonNode.Parse(output) is JsonObject json) return json;
        }
        catch (JsonException) { }
        var text = output.Trim();
        return new JsonObject { ["error"] = text.Length > 0 ? text : $"{tool} exited with status {status}" };
    }

    public Snapshot State(long windowId, int pid, string? query = null, string? screenshot = null)
    {
        var arguments = new JsonObject { ["pid"] = pid, ["window_id"] = windowId, ["timeout_ms"] = 5000 };
        if (query is not null) arguments["query"] = query;
        if (screenshot is not null) arguments["screenshot_out_file"] = Path.GetFullPath(screenshot);
        else arguments["include_screenshot"] = false;
        var result = Call("get_window_state", arguments);
        if (result["snapshot_id"] is null || result["elements"] is null)
            throw new InvalidOperationException(Describe(result, "get_window_state failed"));
        return new Snapshot(JsonDocument.Parse(result.ToJsonString()).RootElement);
    }

    /// <summary>AX-style presses fail transiently while the target is busy; retry those.</summary>
    public JsonObject Act(string tool, JsonObject arguments, int attempts = 3)
    {
        JsonObject result = new();
        for (int attempt = 1; attempt <= attempts; attempt++)
        {
            result = Call(tool, (JsonObject)arguments.DeepClone());
            var error = result["error"]?.ToString() ?? "";
            if (!error.Contains("-25204") || attempt == attempts) break;
            Thread.Sleep(300);
        }
        return result;
    }

    public static string Describe(JsonObject result, string fallback)
    {
        if (result["error"] is JsonNode error) return error.ToString();
        if (result["refusal"] is JsonObject refusal)
            return string.Join(": ", new[] { refusal["code"]?.ToString(), refusal["message"]?.ToString() }.Where(s => s is not null));
        return result["code"]?.ToString() ?? fallback;
    }
}

/// <summary>
/// The window an agent wants to act on, checked to be on the named screen so that
/// agents never touch windows on the user's own displays.
/// </summary>
public sealed class Target
{
    public ScreenInfo Screen { get; }
    public int Pid { get; }
    public WindowInfo Window { get; }

    public Target(Arguments args)
    {
        var name = args.Value("--screen") ?? throw new InvalidOperationException("give the screen with --screen NAME");
        if (!int.TryParse(args.Value("--pid"), out var pid)) throw new InvalidOperationException("give the program with --pid PID");

        // Naming the screen also tells the app it is still in use.
        var list = ControlPipe.Send(new ControlRequest { Command = ControlRequest.ScreenList, Screen = name });
        Screen = list.Screens?.FirstOrDefault(s => s.Name == name) ?? throw new InvalidOperationException($"no screen named \"{name}\"");
        var bounds = Screen.Frame.ToRect();
        var windows = Desktop.WindowsOf(pid);
        var onScreen = windows.Where(w => bounds.ContainsCenterOf(w.Frame)).ToList();

        if (long.TryParse(args.Value("--window-id"), out var wanted))
        {
            var window = windows.FirstOrDefault(w => w.Id == wanted) ?? throw new InvalidOperationException($"pid {pid} has no on-screen window {wanted}");
            if (!onScreen.Contains(window)) throw new InvalidOperationException($"window {wanted} is not on screen \"{name}\"; move it there first");
            Window = window;
        }
        else
        {
            Window = onScreen.FirstOrDefault() ?? throw new InvalidOperationException($"pid {pid} has no window on screen \"{name}\"; launch or move it there first");
        }
        Pid = pid;
    }

    public JsonObject Json() => new()
    {
        ["screen"] = Screen.Name, ["pid"] = Pid, ["windowID"] = Window.Id, ["app"] = Window.App,
        ["windowFrame"] = new JsonObject { ["x"] = Window.Frame.X, ["y"] = Window.Frame.Y, ["width"] = Window.Frame.Width, ["height"] = Window.Frame.Height },
    };
}

/// <summary><c>state</c>, <c>click</c>, <c>type</c> and <c>key</c>.</summary>
public static class DriverCommands
{
    public static readonly HashSet<string> Verbs = new() { "state", "click", "type", "key" };

    public static int Run(string verb, Arguments args)
    {
        JsonObject output;
        try
        {
            var target = new Target(args);
            var driver = new Driver(target.Screen.Name);
            output = verb switch
            {
                "state" => State(target, driver, args),
                "click" => Click(target, driver, args),
                "type" => Type(target, driver, args),
                _ => Key(target, driver, args),
            };
            output["ok"] ??= true;
        }
        catch (Exception error)
        {
            output = new JsonObject { ["ok"] = false, ["error"] = error.Message };
        }
        Console.WriteLine(output.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = ProtocolJson.Pretty.Encoder }));
        return output["ok"]?.GetValue<bool>() == true ? 0 : 1;
    }

    private static JsonObject State(Target target, Driver driver, Arguments args)
    {
        var snapshot = driver.State(target.Window.Id, target.Pid, args.Value("--query"), args.Value("--screenshot"));
        var output = target.Json();
        output["snapshot"] = snapshot.Id;
        output["elements"] = JsonSerializer.SerializeToNode(snapshot.Elements.Where(e => e.Index >= 0).Select(e => e.ToJson()));
        output["tree"] = snapshot.Tree;
        if (args.Value("--screenshot") is { } shot) output["screenshot"] = Path.GetFullPath(shot);
        return output;
    }

    private static JsonObject Click(Target target, Driver driver, Arguments args)
    {
        var arguments = new JsonObject { ["pid"] = target.Pid, ["window_id"] = target.Window.Id };
        (double X, double Y) point;
        var described = new JsonObject();

        if (double.TryParse(args.Value("--x"), out var x) && double.TryParse(args.Value("--y"), out var y))
        {
            // A global point. cua-driver's pixel route wants coordinates in the window
            // screenshot it captured last, so take one to learn its scale.
            if (!target.Window.Frame.Contains(x, y)) throw new InvalidOperationException($"({x}, {y}) is outside the window");
            var scratch = Path.Combine(Path.GetTempPath(), $"2ndscreen-click-{Environment.ProcessId}.png");
            try
            {
                var snapshot = driver.State(target.Window.Id, target.Pid, screenshot: scratch);
                double width = snapshot.Raw.TryGetProperty("screenshot_width", out var w) ? w.GetDouble() : target.Window.Frame.Width;
                double scale = width / target.Window.Frame.Width;
                arguments["x"] = (x - target.Window.Frame.X) * scale;
                arguments["y"] = (y - target.Window.Frame.Y) * scale;
            }
            finally
            {
                File.Delete(scratch);
            }
            point = (x, y);
            described["point"] = new JsonObject { ["x"] = x, ["y"] = y };
        }
        else
        {
            var (element, snapshot) = Resolve(target, driver, args, required: true);
            if (element is null || snapshot is null || element.Center is not { } center)
                throw new InvalidOperationException("the element has no frame to click");
            point = center;
            arguments["element_token"] = element.Token;
            described["element"] = JsonSerializer.SerializeToNode(element.ToJson());
            described["snapshot"] = snapshot.Id;
        }

        Cursor("click", point);
        Thread.Sleep(400); // let the cursor arrive first
        return Report(driver.Act("click", arguments), target, described);
    }

    private static JsonObject Type(Target target, Driver driver, Arguments args)
    {
        var text = args.Value("--value") ?? throw new InvalidOperationException("type needs --value TEXT");
        var arguments = new JsonObject { ["pid"] = target.Pid, ["window_id"] = target.Window.Id, ["text"] = text };
        var described = new JsonObject();
        // Without a target, the text goes to the focused element.
        var (element, snapshot) = Resolve(target, driver, args, required: false);
        if (element is not null)
        {
            arguments["element_token"] = element.Token;
            described["element"] = JsonSerializer.SerializeToNode(element.ToJson());
            described["snapshot"] = snapshot!.Id;
            if (element.Center is { } center) Cursor("move", center);
        }
        return Report(driver.Act("type_text", arguments), target, described);
    }

    private static JsonObject Key(Target target, Driver driver, Arguments args)
    {
        var key = args.Value("--key") ?? throw new InvalidOperationException("key needs --key NAME, such as return");
        var modifiers = (args.Value("--modifiers") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(m => m.ToLowerInvariant()).ToList();
        var arguments = new JsonObject { ["pid"] = target.Pid, ["window_id"] = target.Window.Id };
        JsonObject result;
        if (modifiers.Count == 0)
        {
            arguments["key"] = key;
            result = driver.Act("press_key", arguments);
        }
        else
        {
            arguments["keys"] = JsonSerializer.SerializeToNode(modifiers.Append(key).ToList());
            result = driver.Act("hotkey", arguments);
        }
        return Report(result, target, new JsonObject { ["key"] = key, ["modifiers"] = JsonSerializer.SerializeToNode(modifiers) });
    }

    /// <summary>The element named by --index or --text, from a fresh snapshot.</summary>
    private static (Element? Element, Snapshot? Snapshot) Resolve(Target target, Driver driver, Arguments args, bool required)
    {
        bool hasIndex = int.TryParse(args.Value("--index"), out var index);
        var text = args.Value("--text");
        if (!hasIndex && text is null)
        {
            if (required) throw new InvalidOperationException("give --index N, --text TEXT, or --x X --y Y");
            return (null, null);
        }
        var snapshot = driver.State(target.Window.Id, target.Pid);
        var element = hasIndex ? snapshot.ByIndex(index) : snapshot.ByText(text!);
        if (element is null)
        {
            throw new InvalidOperationException(hasIndex
                ? $"no element {index} in the window; run state again"
                : $"no element matches \"{text}\"; run state to see what is there");
        }
        return (element, snapshot);
    }

    /// <summary>Fold cua-driver's result into the output; <c>effect</c> says how sure it is.</summary>
    private static JsonObject Report(JsonObject result, Target target, JsonObject described)
    {
        var output = target.Json();
        foreach (var (key, value) in described) output[key] = value?.DeepClone();
        var effect = result["effect"]?.ToString();
        output["effect"] = effect;
        output["route"] = result["route"]?.DeepClone();
        if (result["summary"] is JsonNode summary) output["summary"] = summary.DeepClone();
        if (effect is null or "refused")
        {
            output["ok"] = false;
            var error = Driver.Describe(result, "the action was refused");
            if (error.Contains("same_pid_keyboard_ambiguity"))
                error += "; the program has several windows, so name the field with --index or --text";
            output["error"] = error;
        }
        return output;
    }

    /// <summary>Show the app's agent cursor; best effort, the action proceeds either way.</summary>
    private static void Cursor(string action, (double X, double Y) point)
    {
        try
        {
            ControlPipe.Send(new ControlRequest { Command = ControlRequest.CursorEvent, Action = action, X = point.X, Y = point.Y });
        }
        catch (Exception) { }
    }
}
