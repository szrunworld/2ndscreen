using System.Text.Json;
using SecondScreen;
using SecondScreen.Cli;

// 2ndscreen — let agents create screens and run programs on them, through the
// running SecondScreen tray app. Every command prints one JSON object and exits
// non-zero on failure. Mirrors the macOS command.

const string Usage = """
usage:
  2ndscreen screen create [--name NAME] [--size WxH] [--hidpi | --no-hidpi]
                          [--ttl DURATION] [--idle-timeout DURATION] [--owner-pid PID]
  2ndscreen screen list
  2ndscreen screen destroy NAME
  2ndscreen app launch --screen NAME --path PROGRAM [--arg ARG]... [--new-instance] [--fill]
  2ndscreen window move --screen NAME --pid PID [--window-id ID] [--fill]
  2ndscreen screenshot --screen NAME --output FILE.png

  2ndscreen state --screen NAME --pid PID [--window-id ID] [--query TEXT] [--screenshot FILE.png]
  2ndscreen click --screen NAME --pid PID (--index N | --text TEXT | --x X --y Y)
  2ndscreen type  --screen NAME --pid PID --value TEXT [--index N | --text TEXT]
  2ndscreen key   --screen NAME --pid PID --key NAME [--modifiers ctrl,shift]

  2ndscreen mcp      serve these commands as MCP tools over stdio
  2ndscreen doctor   report displays, the virtual display driver, and cua-driver

Durations take s, m or h (90s, 30m, 2h). A screen is destroyed when its TTL
passes, when no command has named it for its idle timeout (default 60m; 0
turns it off), or when its owner process exits.

Sizes are logical pixels; with --hidpi the screen has twice as many physical
pixels at 200% scale. Without --size, a screen matches the main display.
Frames in the output are physical pixels on the virtual desktop, the same
space as cua-driver.

state, click, type and key act through cua-driver's background routes and
only on a window that is on the named screen. Indexes come from state; click
and type re-read the window, so run state again after the UI changes.
""";

if (OperatingSystem.IsWindows()) Desktop.BecomeDpiAware();
// Whatever reads a pipe gets UTF-8, not the console code page (such as GBK on a Chinese Windows).
if (Console.IsOutputRedirected)
{
    Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
}

if (args.Length == 0 || args.Contains("--help") || args.Contains("-h"))
{
    Console.WriteLine(Usage);
    return args.Length == 0 ? 2 : 0;
}
if (args is ["mcp"]) return Mcp.Run();
if (args is ["doctor"]) return Doctor.Run();

var parsed = new Arguments(args);
var first = parsed.Positional.FirstOrDefault() ?? "";
if (DriverCommands.Verbs.Contains(first)) return DriverCommands.Run(first, parsed);

var request = new ControlRequest();
switch (string.Join(' ', parsed.Positional.Take(2)))
{
    case "screen create":
        request.Command = ControlRequest.ScreenCreate;
        request.Screen = parsed.Value("--name");
        if (parsed.Value("--size") is { } size)
        {
            var parts = size.ToLowerInvariant().Split('x');
            if (parts.Length != 2 || !int.TryParse(parts[0], out var w) || !int.TryParse(parts[1], out var h))
                return Fail("--size takes WIDTHxHEIGHT, such as 1280x800");
            request.Width = w;
            request.Height = h;
        }
        if (parsed.Has("--hidpi")) request.HiDpi = true;
        if (parsed.Has("--no-hidpi")) request.HiDpi = false;
        if (parsed.Value("--ttl") is { } ttl)
        {
            if (Duration.Parse(ttl) is not double seconds) return Fail("--ttl takes a duration such as 30m");
            request.Ttl = seconds;
        }
        if (parsed.Value("--idle-timeout") is { } idle)
        {
            if (Duration.Parse(idle) is not double seconds) return Fail("--idle-timeout takes a duration such as 20m, or 0");
            request.IdleTimeout = seconds;
        }
        if (parsed.Value("--owner-pid") is { } owner)
        {
            if (!int.TryParse(owner, out var pid)) return Fail("--owner-pid takes a process ID");
            request.OwnerPid = pid;
        }
        break;
    case "screen list":
        request.Command = ControlRequest.ScreenList;
        break;
    case "screen destroy":
        request.Command = ControlRequest.ScreenDestroy;
        request.Screen = parsed.Positional.Skip(2).FirstOrDefault() ?? parsed.Value("--name");
        if (request.Screen is null) return Fail("screen destroy needs a screen name");
        break;
    case "app launch":
        request.Command = ControlRequest.AppLaunch;
        request.Screen = parsed.Value("--screen");
        request.Path = parsed.Value("--path");
        request.BundleId = parsed.Value("--bundle");
        request.Arguments = parsed.Values("--arg").ToArray();
        request.NewInstance = parsed.Has("--new-instance");
        request.Fill = parsed.Has("--fill");
        if (request.Path is null) return Fail("app launch needs --path PROGRAM (bundle IDs are macOS only)");
        // The app resolves paths in its own working directory; make relative ones absolute here.
        if (File.Exists(request.Path)) request.Path = Path.GetFullPath(request.Path);
        break;
    case "window move":
        request.Command = ControlRequest.WindowMove;
        request.Screen = parsed.Value("--screen");
        if (!int.TryParse(parsed.Value("--pid"), out var movePid)) return Fail("window move needs --pid");
        request.Pid = movePid;
        if (long.TryParse(parsed.Value("--window-id"), out var windowId)) request.WindowId = windowId;
        request.Fill = parsed.Has("--fill");
        break;
    default:
        if (first != "screenshot") return Fail("unknown command\n\n" + Usage);
        request.Command = ControlRequest.Screenshot;
        request.Screen = parsed.Value("--screen");
        request.Output = parsed.Value("--output") is { } output ? Path.GetFullPath(output) : null;
        break;
}

try
{
    var response = ControlPipe.Send(request);
    Console.WriteLine(JsonSerializer.Serialize(response, ProtocolJson.Pretty));
    return response.Ok ? 0 : 1;
}
catch (Exception error)
{
    Console.WriteLine(JsonSerializer.Serialize(ControlResponse.Failure(error.Message), ProtocolJson.Pretty));
    return 1;
}

static int Fail(string message)
{
    Console.Error.WriteLine(message);
    return 2;
}

namespace SecondScreen.Cli
{
    /// <summary>Splits <c>--flag value</c> options and bare <c>--flag</c>s from positional words.</summary>
    public sealed class Arguments
    {
        public static readonly HashSet<string> Valued = new()
        {
            "--name", "--size", "--screen", "--bundle", "--path", "--arg", "--pid", "--window-id", "--output",
            "--query", "--screenshot", "--index", "--text", "--x", "--y", "--value", "--key", "--modifiers",
            "--ttl", "--idle-timeout", "--owner-pid",
        };

        public List<string> Positional { get; } = new();
        private readonly List<(string Name, string Value)> options = new();
        private readonly HashSet<string> flags = new();

        public Arguments(IEnumerable<string> words)
        {
            using var e = words.GetEnumerator();
            while (e.MoveNext())
            {
                var word = e.Current;
                if (Valued.Contains(word))
                {
                    if (!e.MoveNext()) throw new ArgumentException($"{word} needs a value");
                    options.Add((word, e.Current));
                }
                else if (word.StartsWith("--")) flags.Add(word);
                else Positional.Add(word);
            }
        }

        public string? Value(string name) => options.LastOrDefault(o => o.Name == name).Value;
        public IEnumerable<string> Values(string name) => options.Where(o => o.Name == name).Select(o => o.Value);
        public bool Has(string name) => flags.Contains(name);
    }
}
