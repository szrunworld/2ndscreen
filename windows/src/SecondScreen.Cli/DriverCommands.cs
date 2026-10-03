using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Automation;

namespace SecondScreen.Cli;

/// <summary>
/// The window an agent wants to act on, checked to be on the named screen so that
/// agents never touch windows on the user's own displays.
/// </summary>
[SupportedOSPlatform("windows")]
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

/// <summary>
/// <c>state</c>, <c>click</c>, <c>type</c>, <c>key</c>, <c>scroll</c> and <c>drag</c>: read and drive a
/// window on an agent screen, in the background. Elements go through UI Automation patterns
/// where they can, which need no input at all; points and keys are posted to the window.
/// </summary>
[SupportedOSPlatform("windows")]
public static class DriverCommands
{
    public static readonly HashSet<string> Verbs = new() { "state", "click", "type", "key", "scroll", "drag" };

    public static int Run(string verb, Arguments args)
    {
        JsonObject output;
        try
        {
            var target = new Target(args);
            if (Win32.IsIconic(target.Window.Handle)) throw new InvalidOperationException("the window is minimized; restore it first");
            output = verb switch
            {
                "state" => State(target, args),
                "click" => Click(target, args),
                "type" => Type(target, args),
                "scroll" => Scroll(target, args),
                "drag" => Drag(target, args),
                _ => Key(target, args),
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

    private static JsonObject State(Target target, Arguments args)
    {
        var walked = Automation.Walk(target.Window.Handle, args.Value("--query"));
        var output = target.Json();
        output["elements"] = JsonSerializer.SerializeToNode(walked.Snapshot.Elements.Where(e => e.Index >= 0).Select(e => e.ToJson()));
        output["tree"] = walked.Snapshot.Tree;
        if (args.Value("--screenshot") is { } shot)
        {
            WindowCapture.Save(target.Window.Handle, Path.GetFullPath(shot));
            output["screenshot"] = Path.GetFullPath(shot);
        }
        return output;
    }

    private static JsonObject Click(Target target, Arguments args)
    {
        if (args.Has("--right") && args.Has("--double")) throw new InvalidOperationException("give --right or --double, not both");
        bool right = args.Has("--right");
        int count = args.Has("--double") ? 2 : 1;
        var described = new JsonObject { ["button"] = right ? "right" : "left", ["count"] = count };
        var window = target.Window.Handle;

        if (GlobalPoint(args, "--x", "--y") is { } point)
        {
            RequireInWindow(target, point);
            described["point"] = new JsonObject { ["x"] = point.X, ["y"] = point.Y };
            return Report(target, described, Input.Click(window, point, right, count));
        }

        var (element, handle) = Resolve(target, args, required: true);
        described["element"] = JsonSerializer.SerializeToNode(element!.ToJson());
        // A single left click on a control with a pattern needs no input event.
        if (!right && count == 1 && handle is not null && Pattern(window, () => Automation.Press(handle)) is { } route)
            return Report(target, described, route);
        if (element.Center is not { } center)
            throw new InvalidOperationException("the element has no frame to click; for a menu item, press its keyboard shortcut with key");
        return Report(target, described, Input.Click(window, center, right, count));
    }

    private static JsonObject Type(Target target, Arguments args)
    {
        var text = args.Value("--value") ?? throw new InvalidOperationException("type needs --value TEXT");
        var described = new JsonObject();
        var window = target.Window.Handle;
        var (element, handle) = Resolve(target, args, required: false);
        if (element is null || handle is null) return Report(target, described, Input.Type(window, text));

        described["element"] = JsonSerializer.SerializeToNode(element.ToJson());
        // Edit controls insert at the caret, as typing would; other editable elements take
        // the text appended to their value. Either counts only if the value shows it.
        var before = Automation.ValueOf(handle);
        var native = Automation.NativeWindow(handle);
        if (native != 0 && native != window && Win32.ClassName(native).Contains("EDIT", StringComparison.OrdinalIgnoreCase))
        {
            Win32.SendMessageTimeout(native, Messages.EM_REPLACESEL, 1, text, Win32.SMTO_ABORTIFHUNG, 2000, out _);
            if (Landed(handle, before, text)) return Report(target, described, "edit.replacesel");
        }
        if (Automation.IsEditable(handle))
        {
            Pattern(window, () => { Automation.SetValue(handle, before + text); return "uia.value"; });
            if (Landed(handle, before, text)) return Report(target, described, "uia.value");
        }
        // Otherwise type keys into it: to its own window, else after focusing it.
        if (native != 0 && native != window) return Report(target, described, Input.Type(window, text, native));
        Pattern(window, () => { Automation.Focus(handle); return "uia.focus"; });
        Thread.Sleep(50);
        return Report(target, described, Input.Type(window, text));
    }

    private static bool Landed(AutomationElement element, string before, string text)
    {
        var after = Automation.ValueOf(element);
        return after != before && after.Contains(text.Replace("\r\n", "\n").Split('\n')[0], StringComparison.Ordinal);
    }

    private static JsonObject Key(Target target, Arguments args)
    {
        var key = args.Value("--key") ?? throw new InvalidOperationException("key needs --key NAME, such as return");
        var modifiers = ModifierList(args);
        var described = new JsonObject { ["key"] = key, ["modifiers"] = JsonSerializer.SerializeToNode(modifiers) };
        var window = target.Window.Handle;
        // A named control takes the key directly: its own window, else focus through UI Automation.
        nint control = 0;
        if (Resolve(target, args, required: false) is ({ } element, { } handle))
        {
            described["element"] = JsonSerializer.SerializeToNode(element.ToJson());
            control = Automation.NativeWindow(handle);
            if (control == window)
            {
                control = 0;
                Pattern(window, () => { Automation.Focus(handle); return "uia.focus"; });
                Thread.Sleep(50);
            }
        }
        // Symbols with no key of their own, such as "*", arrive when typed as text.
        if (KeyCodes.VirtualKey(key) is null && key.Length == 1 && modifiers.Count == 0)
            return Report(target, described, Input.Type(window, key, control));
        return Report(target, described, Input.Key(window, key, modifiers, control));
    }

    /// <summary>
    /// Scroll an element through UI Automation, else turn the wheel over it; or turn the
    /// wheel at a point, or with neither, over the window's middle. With --foreground the
    /// wheel goes through the real pointer, for programs that ignore a posted one.
    /// </summary>
    private static JsonObject Scroll(Target target, Arguments args)
    {
        var direction = args.Value("--direction")?.ToLowerInvariant();
        if (direction is not ("up" or "down" or "left" or "right"))
            throw new InvalidOperationException("scroll needs --direction up, down, left or right");
        int notches = 3;
        if (args.Value("--amount") is { } amount && (!int.TryParse(amount, out notches) || notches is < 1 or > 50))
            throw new InvalidOperationException("--amount takes a number from 1 to 50");
        var by = args.Value("--by") ?? "line";
        if (by is not ("line" or "page")) throw new InvalidOperationException("--by takes line or page");
        var described = new JsonObject { ["direction"] = direction, ["amount"] = notches, ["by"] = by };
        var window = target.Window.Handle;
        var frame = target.Window.Frame;

        (double X, double Y) point;
        if (GlobalPoint(args, "--x", "--y") is { } given)
        {
            RequireInWindow(target, given);
            point = given;
            described["point"] = new JsonObject { ["x"] = given.X, ["y"] = given.Y };
        }
        else if (Resolve(target, args, required: false) is ({ } element, { } handle))
        {
            described["element"] = JsonSerializer.SerializeToNode(element.ToJson());
            if (!args.Has("--foreground") && Pattern(window, () => Automation.Scroll(handle, direction, notches, by == "page")) is { } route)
                return Report(target, described, route);
            point = element.Center ?? (frame.CenterX, frame.CenterY);
        }
        else
        {
            point = (frame.CenterX, frame.CenterY);
        }

        if (!args.Has("--foreground")) return Report(target, described, Input.Wheel(window, point, direction, notches, by == "page"));
        var (delta, horizontal) = Messages.Wheel(direction, notches * (by == "page" ? 3 : 1));
        return Report(target, described, Input.Foreground(window, (move, send) =>
        {
            move((int)point.X, (int)point.Y);
            Thread.Sleep(20);
            send(horizontal ? Win32.MOUSEEVENTF_HWHEEL : Win32.MOUSEEVENTF_WHEEL, delta);
            Thread.Sleep(20);
        }));
    }

    /// <summary>
    /// Press at one point, move to another, release. Both ends must be in the window.
    /// In the background unless --foreground, for programs that ignore background drags.
    /// </summary>
    private static JsonObject Drag(Target target, Arguments args)
    {
        if (GlobalPoint(args, "--from-x", "--from-y") is not { } from || GlobalPoint(args, "--to-x", "--to-y") is not { } to)
            throw new InvalidOperationException("drag needs --from-x X --from-y Y --to-x X --to-y Y");
        RequireInWindow(target, from);
        RequireInWindow(target, to);
        int duration = 500;
        if (args.Value("--duration-ms") is { } text && (!int.TryParse(text, out duration) || duration is < 0 or > 10000))
            throw new InvalidOperationException("--duration-ms takes a number from 0 to 10000");
        var described = new JsonObject
        {
            ["from"] = new JsonObject { ["x"] = from.X, ["y"] = from.Y }, ["to"] = new JsonObject { ["x"] = to.X, ["y"] = to.Y },
        };
        var window = target.Window.Handle;
        if (!args.Has("--foreground")) return Report(target, described, Input.Drag(window, from, to, duration));
        return Report(target, described, Input.Foreground(window, (move, send) =>
        {
            move((int)from.X, (int)from.Y);
            Thread.Sleep(40);
            send(Win32.MOUSEEVENTF_LEFTDOWN, 0);
            const int steps = 20;
            for (int i = 1; i <= steps; i++)
            {
                move((int)(from.X + (to.X - from.X) * i / steps), (int)(from.Y + (to.Y - from.Y) * i / steps));
                Thread.Sleep(duration / steps);
            }
            send(Win32.MOUSEEVENTF_LEFTUP, 0);
        }));
    }

    // MARK: Helpers

    /// <summary>
    /// Run a UI Automation pattern call in the background. XAML and Chromium programs bring
    /// themselves forward from their handlers; a disabled window cannot become the
    /// foreground, while the call still arrives over accessibility, so disable it meanwhile.
    /// </summary>
    private static string? Pattern(nint window, Func<string?> call)
    {
        var root = Win32.GetAncestor(window, Win32.GA_ROOT);
        if (root == 0) root = window;
        var name = Win32.ClassName(root);
        bool disable = name.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal) || name.StartsWith("CefBrowser", StringComparison.Ordinal)
            || name is "ApplicationFrameWindow" or "WinUIDesktopWin32WindowClass" or "Windows.UI.Core.CoreWindow";
        bool wasEnabled = Win32.IsWindowEnabled(root);
        string? route = null;
        Input.Quietly(window, () =>
        {
            if (disable && wasEnabled) Win32.EnableWindow(root, false);
            try
            {
                route = call();
            }
            catch (Exception error) when (error is InvalidOperationException or ElementNotAvailableException or ElementNotEnabledException)
            {
                route = null;
            }
            finally
            {
                if (disable && wasEnabled) Win32.EnableWindow(root, true);
            }
        });
        return route;
    }

    private static void RequireInWindow(Target target, (double X, double Y) point)
    {
        if (!target.Window.Frame.Contains(point.X, point.Y))
            throw new InvalidOperationException($"({point.X}, {point.Y}) is outside the window");
    }

    /// <summary>The point in two options, null if neither is given.</summary>
    private static (double X, double Y)? GlobalPoint(Arguments args, string xName, string yName)
    {
        var (x, y) = (args.Value(xName), args.Value(yName));
        if (x is null && y is null) return null;
        if (!double.TryParse(x, out var px) || !double.TryParse(y, out var py))
            throw new InvalidOperationException($"give both {xName} and {yName} as numbers");
        return (px, py);
    }

    private static List<string> ModifierList(Arguments args) =>
        (args.Value("--modifiers") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(m => m.ToLowerInvariant()).ToList();

    /// <summary>The element named by --index or --text, from a fresh walk of the window.</summary>
    private static (Element? Element, AutomationElement? Handle) Resolve(Target target, Arguments args, bool required)
    {
        bool hasIndex = int.TryParse(args.Value("--index"), out var index);
        var text = args.Value("--text");
        if (!hasIndex && text is null)
        {
            if (required) throw new InvalidOperationException("give --index N, --text TEXT, or --x X --y Y");
            return (null, null);
        }
        var walked = Automation.Walk(target.Window.Handle);
        var element = hasIndex ? walked.Snapshot.ByIndex(index) : walked.Snapshot.ByText(text!);
        if (element is null)
        {
            throw new InvalidOperationException(hasIndex
                ? $"no element {index} in the window; run state again"
                : $"no element matches \"{text}\"; run state to see what is there");
        }
        return (element, walked.Handle(element.Index));
    }

    /// <summary>The target and what was done, with the route the action took.</summary>
    private static JsonObject Report(Target target, JsonObject described, string route)
    {
        var output = target.Json();
        foreach (var (key, value) in described) output[key] = value?.DeepClone();
        output["route"] = route;
        return output;
    }
}
