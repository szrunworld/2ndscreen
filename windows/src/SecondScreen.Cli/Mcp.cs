using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SecondScreen.Cli;

/// <summary>
/// <c>2ndscreen mcp</c>: the CLI as a Model Context Protocol server over stdio. Each
/// tool call runs this executable with the matching arguments, so the tools behave
/// exactly like the CLI, guards included. Screenshots come back as image content,
/// downscaled for the model. Mirrors the macOS server.
/// </summary>
public static class Mcp
{
    private sealed record Tool(string Name, string Description, JsonObject Properties, string[] Required,
                               Func<JsonObject, List<string>> Words, string? ImageArgument = null);

    public static int Run()
    {
        Console.InputEncoding = System.Text.Encoding.UTF8;
        var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true, NewLine = "\n" };
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            JsonObject? message;
            try { message = JsonNode.Parse(line) as JsonObject; } catch (JsonException) { continue; }
            if (message is null || Handle(message) is not { } response) continue;
            stdout.WriteLine(response.ToJsonString());
        }
        return 0;
    }

    private static JsonObject? Handle(JsonObject message)
    {
        // Notifications carry no id and get no response.
        if (message["id"] is not JsonNode id) return null;
        var method = message["method"]?.ToString() ?? "";
        var parameters = message["params"] as JsonObject ?? new JsonObject();
        switch (method)
        {
            case "initialize":
                return Result(id, new JsonObject
                {
                    ["protocolVersion"] = parameters["protocolVersion"]?.ToString() ?? "2025-06-18",
                    ["capabilities"] = new JsonObject { ["tools"] = new JsonObject() },
                    ["serverInfo"] = new JsonObject { ["name"] = "2ndscreen", ["version"] = "0.1.0" },
                    ["instructions"] = "Private virtual screens for testing Windows programs without touching the user's screen, pointer, or focus. " +
                        "Create a screen, launch the program there, look with state or screenshot, act with click/type/key/scroll/drag, verify, " +
                        "then close the program and destroy the screen. Only act on programs you launched.",
                });
            case "ping":
                return Result(id, new JsonObject());
            case "tools/list":
                return Result(id, new JsonObject
                {
                    ["tools"] = new JsonArray(Tools.Select(t => (JsonNode)new JsonObject
                    {
                        ["name"] = t.Name, ["description"] = t.Description,
                        ["inputSchema"] = new JsonObject
                        {
                            ["type"] = "object", ["properties"] = t.Properties.DeepClone(),
                            ["required"] = new JsonArray(t.Required.Select(r => (JsonNode)JsonValue.Create(r)!).ToArray()),
                        },
                    }).ToArray()),
                });
            case "tools/call":
                var name = parameters["name"]?.ToString();
                if (Tools.FirstOrDefault(t => t.Name == name) is not { } tool) return Error(id, -32602, "unknown tool");
                return Result(id, Call(tool, parameters["arguments"] as JsonObject ?? new JsonObject()));
            default:
                return Error(id, -32601, $"method not found: {method}");
        }
    }

    private static JsonObject Prop(string type, string description) => new() { ["type"] = type, ["description"] = description };

    private static JsonObject Merge(params JsonObject[] parts)
    {
        var merged = new JsonObject();
        foreach (var part in parts) foreach (var (key, value) in part) merged[key] = value?.DeepClone();
        return merged;
    }

    private static readonly JsonObject WindowTarget = new()
    {
        ["screen"] = Prop("string", "Agent screen name"),
        ["pid"] = Prop("integer", "Process ID of the program, from app_launch"),
        ["window_id"] = Prop("integer", "Window ID; needed when the program has several windows"),
    };

    private static readonly JsonObject ElementTarget = new()
    {
        ["index"] = Prop("integer", "Element index from the latest state"),
        ["text"] = Prop("string", "Visible text or label of the element"),
    };

    private static readonly JsonObject PointTarget = new()
    {
        ["x"] = Prop("number", "Screen x, if no element"),
        ["y"] = Prop("number", "Screen y, if no element"),
    };

    private static readonly JsonObject Foreground = new()
    {
        ["foreground"] = Prop("boolean", "Accept bringing the program to the front and moving the user's real pointer briefly"),
    };

    private static List<string> PointWords(JsonObject a) =>
        a["x"] is not null && a["y"] is not null ? new() { "--x", S(a, "x"), "--y", S(a, "y") } : new();

    private static string S(JsonObject a, string key) => a[key]?.ToString() ?? "";
    private static bool B(JsonObject a, string key) => a[key] is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    private static List<string> TargetWords(JsonObject a)
    {
        var words = new List<string> { "--screen", S(a, "screen"), "--pid", S(a, "pid") };
        if (a["window_id"] is not null) words.AddRange(new[] { "--window-id", S(a, "window_id") });
        return words;
    }

    private static List<string> ElementWords(JsonObject a) =>
        a["index"] is not null ? new() { "--index", S(a, "index") }
        : a["text"] is not null ? new() { "--text", S(a, "text") }
        : new();

    private static readonly Tool[] Tools =
    {
        new("screen_create", "Create a private virtual screen. Without width and height it matches the main display.",
            new JsonObject
            {
                ["name"] = Prop("string", "Unique name, e.g. after your task"),
                ["width"] = Prop("integer", "Width in logical pixels"),
                ["height"] = Prop("integer", "Height in logical pixels"),
                ["hidpi"] = Prop("boolean", "200% scale; defaults to the main display's"),
                ["ttl"] = Prop("string", "Destroy after this long, e.g. 30m"),
                ["idle_timeout"] = Prop("string", "Destroy after this long unused; default 60m, 0 for never"),
            }, Array.Empty<string>(),
            a =>
            {
                var w = new List<string> { "screen", "create" };
                if (a["name"] is not null) w.AddRange(new[] { "--name", S(a, "name") });
                if (a["width"] is not null && a["height"] is not null) w.AddRange(new[] { "--size", $"{S(a, "width")}x{S(a, "height")}" });
                if (a["hidpi"] is not null) w.Add(B(a, "hidpi") ? "--hidpi" : "--no-hidpi");
                if (a["ttl"] is not null) w.AddRange(new[] { "--ttl", S(a, "ttl") });
                if (a["idle_timeout"] is not null) w.AddRange(new[] { "--idle-timeout", S(a, "idle_timeout") });
                return w;
            }),
        new("screen_list", "List screens with their frames. Frames move when screens are added or removed.",
            new JsonObject(), Array.Empty<string>(), _ => new() { "screen", "list" }),
        new("screen_destroy", "Destroy an agent screen. Its windows move to the user's displays, so close your program first.",
            new JsonObject { ["name"] = Prop("string", "Agent screen name") }, new[] { "name" },
            a => new() { "screen", "destroy", S(a, "name") }),
        new("app_launch", "Start a program on a screen without activating it. Refuses one that is already running unless new_instance is set.",
            new JsonObject
            {
                ["screen"] = Prop("string", "Screen name"),
                ["path"] = Prop("string", "Path to the .exe, or a program on PATH such as notepad.exe"),
                ["arguments"] = new JsonObject { ["type"] = "array", ["items"] = new JsonObject { ["type"] = "string" }, ["description"] = "Command-line arguments" },
                ["new_instance"] = Prop("boolean", "Start another instance even if one is running"),
                ["fill"] = Prop("boolean", "Size the window to the screen"),
            }, new[] { "screen", "path" },
            a =>
            {
                var w = new List<string> { "app", "launch", "--screen", S(a, "screen"), "--path", S(a, "path") };
                if (a["arguments"] is JsonArray arguments) foreach (var argument in arguments) w.AddRange(new[] { "--arg", argument?.ToString() ?? "" });
                if (B(a, "new_instance")) w.Add("--new-instance");
                if (B(a, "fill")) w.Add("--fill");
                return w;
            }),
        new("window_move", "Move a program's windows onto a screen and keep its future windows there.",
            new JsonObject
            {
                ["screen"] = Prop("string", "Screen name"), ["pid"] = Prop("integer", "Process ID"),
                ["window_id"] = Prop("integer", "Only this window"), ["fill"] = Prop("boolean", "Size the window to the screen"),
            }, new[] { "screen", "pid" },
            a =>
            {
                var w = new List<string> { "window", "move" };
                w.AddRange(TargetWords(a));
                if (B(a, "fill")) w.Add("--fill");
                return w;
            }),
        new("screenshot", "Capture a screen. Returns the image.",
            new JsonObject { ["screen"] = Prop("string", "Screen name"), ["output"] = Prop("string", "Also keep the full-size PNG at this path") },
            new[] { "screen" },
            a => new() { "screenshot", "--screen", S(a, "screen"), "--output", S(a, "output") }, "output"),
        new("state", "Read a window's controls (indexes, labels, values, frames) and accessibility tree. Set screenshot to also get an image.",
            Merge(WindowTarget, new JsonObject
            {
                ["query"] = Prop("string", "Only elements matching this text"),
                ["screenshot"] = Prop("boolean", "Include a screenshot of the window"),
            }), new[] { "screen", "pid" },
            a =>
            {
                var w = new List<string> { "state" };
                w.AddRange(TargetWords(a));
                if (a["query"] is not null) w.AddRange(new[] { "--query", S(a, "query") });
                if (a["screenshot_path"] is not null) w.AddRange(new[] { "--screenshot", S(a, "screenshot_path") });
                return w;
            }, "screenshot_path"),
        new("click", "Click an element in the background, by index or text, or a point on the screen. Set button to right for a context menu, or double for a double-click.",
            Merge(WindowTarget, ElementTarget, PointTarget, new JsonObject
            {
                ["button"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("left", "right"), ["description"] = "Default left" },
                ["double"] = Prop("boolean", "Double-click"),
            }),
            new[] { "screen", "pid" },
            a =>
            {
                var w = new List<string> { "click" };
                w.AddRange(TargetWords(a));
                w.AddRange(ElementWords(a));
                w.AddRange(PointWords(a));
                if (S(a, "button") == "right") w.Add("--right");
                if (B(a, "double")) w.Add("--double");
                return w;
            }),
        new("type", "Type text into an element (by index or text), or into the focused one.",
            Merge(WindowTarget, ElementTarget, new JsonObject { ["value"] = Prop("string", "Text to type") }),
            new[] { "screen", "pid", "value" },
            a =>
            {
                var w = new List<string> { "type" };
                w.AddRange(TargetWords(a));
                w.AddRange(ElementWords(a));
                w.AddRange(new[] { "--value", S(a, "value") });
                return w;
            }),
        new("key", "Press a key, optionally with modifiers, e.g. key enter, or key s with modifiers [ctrl].",
            Merge(WindowTarget, new JsonObject
            {
                ["key"] = Prop("string", "Key name, e.g. enter, escape, tab, a"),
                ["modifiers"] = new JsonObject { ["type"] = "array", ["items"] = new JsonObject { ["type"] = "string" }, ["description"] = "ctrl, shift, alt, win" },
            }), new[] { "screen", "pid", "key" },
            a =>
            {
                var w = new List<string> { "key" };
                w.AddRange(TargetWords(a));
                w.AddRange(new[] { "--key", S(a, "key") });
                if (a["modifiers"] is JsonArray mods && mods.Count > 0) w.AddRange(new[] { "--modifiers", string.Join(',', mods.Select(m => m?.ToString())) });
                return w;
            }),
        new("scroll", "Scroll an element, or turn the mouse wheel at a point, in the background; without either, the window's middle. " +
            "If the program ignores that, retry with foreground, which moves the user's pointer briefly.",
            Merge(WindowTarget, ElementTarget, PointTarget, Foreground, new JsonObject
            {
                ["direction"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("up", "down", "left", "right") },
                ["amount"] = Prop("integer", "Wheel notches or key presses, 1 to 50; default 3"),
                ["by"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("line", "page"), ["description"] = "Step size; default line" },
            }), new[] { "screen", "pid", "direction" },
            a =>
            {
                var w = new List<string> { "scroll" };
                w.AddRange(TargetWords(a));
                w.AddRange(ElementWords(a));
                w.AddRange(PointWords(a));
                w.AddRange(new[] { "--direction", S(a, "direction") });
                if (a["amount"] is not null) w.AddRange(new[] { "--amount", S(a, "amount") });
                if (a["by"] is not null) w.AddRange(new[] { "--by", S(a, "by") });
                if (B(a, "foreground")) w.Add("--foreground");
                return w;
            }),
        new("drag", "Press at one screen point, move to another, and release, e.g. to move a slider or drop an item. Both points must be in the window. " +
            "Runs in the background; if the program ignores that, retry with foreground, which moves the user's pointer briefly.",
            Merge(WindowTarget, Foreground, new JsonObject
            {
                ["from_x"] = Prop("number", "Screen x to press at"), ["from_y"] = Prop("number", "Screen y to press at"),
                ["to_x"] = Prop("number", "Screen x to release at"), ["to_y"] = Prop("number", "Screen y to release at"),
                ["modifiers"] = new JsonObject { ["type"] = "array", ["items"] = new JsonObject { ["type"] = "string" }, ["description"] = "Held throughout: ctrl, shift, alt" },
                ["duration_ms"] = Prop("integer", "How long the move takes; default 500"),
            }), new[] { "screen", "pid", "from_x", "from_y", "to_x", "to_y" },
            a =>
            {
                var w = new List<string> { "drag" };
                w.AddRange(TargetWords(a));
                foreach (var name in new[] { "from_x", "from_y", "to_x", "to_y" }) w.AddRange(new[] { "--" + name.Replace('_', '-'), S(a, name) });
                if (a["modifiers"] is JsonArray mods && mods.Count > 0) w.AddRange(new[] { "--modifiers", string.Join(',', mods.Select(m => m?.ToString())) });
                if (a["duration_ms"] is not null) w.AddRange(new[] { "--duration-ms", S(a, "duration_ms") });
                if (B(a, "foreground")) w.Add("--foreground");
                return w;
            }),
    };

    private static JsonObject Call(Tool tool, JsonObject arguments)
    {
        arguments = (JsonObject)arguments.DeepClone();
        // Images go through a scratch PNG unless the caller wants to keep one.
        string? scratch = null;
        if (tool.Name == "screenshot" && arguments["output"] is null)
        {
            scratch = Path.Combine(Path.GetTempPath(), $"2ndscreen-mcp-{Guid.NewGuid():N}.png");
            arguments["output"] = scratch;
        }
        if (tool.Name == "state" && B(arguments, "screenshot"))
        {
            scratch = Path.Combine(Path.GetTempPath(), $"2ndscreen-mcp-{Guid.NewGuid():N}.png");
            arguments["screenshot_path"] = scratch;
        }
        try
        {
            var (status, output) = RunSelf(tool.Words(arguments));
            var content = new JsonArray { new JsonObject { ["type"] = "text", ["text"] = output } };
            if (status == 0 && tool.ImageArgument is { } key && arguments[key]?.ToString() is { } path && Jpeg(path) is { } image)
            {
                content.Add(new JsonObject { ["type"] = "image", ["data"] = image, ["mimeType"] = "image/jpeg" });
            }
            return new JsonObject { ["content"] = content, ["isError"] = status != 0 };
        }
        finally
        {
            if (scratch is not null) File.Delete(scratch);
        }
    }

    private static (int Status, string Output) RunSelf(List<string> words)
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!)
        {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8, StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        foreach (var word in words) start.ArgumentList.Add(word);
        using var process = Process.Start(start)!;
        var stderr = process.StandardError.ReadToEndAsync();
        var output = process.StandardOutput.ReadToEnd() + stderr.Result;
        process.WaitForExit();
        return (process.ExitCode, output);
    }

    /// <summary>The PNG at <paramref name="path"/>, at most 1280 px wide, as base64 JPEG.</summary>
    private static string? Jpeg(string path, int maxPixels = 1280)
    {
        if (!OperatingSystem.IsWindows() || !File.Exists(path)) return null;
        using var source = new Bitmap(path);
        double scale = Math.Min(1.0, (double)maxPixels / Math.Max(source.Width, source.Height));
        using var scaled = new Bitmap(Math.Max(1, (int)(source.Width * scale)), Math.Max(1, (int)(source.Height * scale)));
        using (var g = Graphics.FromImage(scaled))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.DrawImage(source, 0, 0, scaled.Width, scaled.Height);
        }
        var encoder = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(Encoder.Quality, 80L);
        using var stream = new MemoryStream();
        scaled.Save(stream, encoder, parameters);
        return Convert.ToBase64String(stream.ToArray());
    }

    private static JsonObject Result(JsonNode id, JsonObject result) =>
        new() { ["jsonrpc"] = "2.0", ["id"] = id.DeepClone(), ["result"] = result };

    private static JsonObject Error(JsonNode id, int code, string message) =>
        new() { ["jsonrpc"] = "2.0", ["id"] = id.DeepClone(), ["error"] = new JsonObject { ["code"] = code, ["message"] = message } };
}
