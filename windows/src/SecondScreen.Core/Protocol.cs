using System.Text.Json;
using System.Text.Json.Serialization;

namespace SecondScreen;

// The request/response protocol between the 2ndscreen CLI and the tray app,
// which owns every screen. It matches the macOS version field for field, so
// agents see the same JSON on both platforms. Each connection carries one
// JSON request line and one JSON response line.

public sealed class ControlRequest
{
    public const string ScreenCreate = "screen.create";
    public const string ScreenList = "screen.list";
    public const string ScreenDestroy = "screen.destroy";
    public const string AppLaunch = "app.launch";
    public const string WindowMove = "window.move";
    public const string Screenshot = "screenshot";
    public const string CursorEvent = "cursor";

    [JsonPropertyName("command")] public string Command { get; set; } = "";
    /// <summary>The screen to create, destroy, or act on.</summary>
    [JsonPropertyName("screen")] public string? Screen { get; set; }
    [JsonPropertyName("width")] public int? Width { get; set; }
    [JsonPropertyName("height")] public int? Height { get; set; }
    [JsonPropertyName("hiDPI")] public bool? HiDpi { get; set; }
    /// <summary>macOS only; Windows launches by <see cref="Path"/>.</summary>
    [JsonPropertyName("bundleID")] public string? BundleId { get; set; }
    /// <summary>The executable to launch.</summary>
    [JsonPropertyName("path")] public string? Path { get; set; }
    /// <summary>Command-line arguments for the launched executable.</summary>
    [JsonPropertyName("arguments")] public string[]? Arguments { get; set; }
    [JsonPropertyName("newInstance")] public bool? NewInstance { get; set; }
    [JsonPropertyName("fill")] public bool? Fill { get; set; }
    [JsonPropertyName("pid")] public int? Pid { get; set; }
    [JsonPropertyName("windowID")] public long? WindowId { get; set; }
    [JsonPropertyName("output")] public string? Output { get; set; }
    [JsonPropertyName("ttl")] public double? Ttl { get; set; }
    [JsonPropertyName("idleTimeout")] public double? IdleTimeout { get; set; }
    [JsonPropertyName("ownerPID")] public int? OwnerPid { get; set; }
    /// <summary>For <see cref="CursorEvent"/>: move, click or hide.</summary>
    [JsonPropertyName("action")] public string? Action { get; set; }
    [JsonPropertyName("x")] public double? X { get; set; }
    [JsonPropertyName("y")] public double? Y { get; set; }
}

public sealed class Frame
{
    [JsonPropertyName("x")] public double X { get; set; }
    [JsonPropertyName("y")] public double Y { get; set; }
    [JsonPropertyName("width")] public double Width { get; set; }
    [JsonPropertyName("height")] public double Height { get; set; }

    public Frame() { }

    public Frame(Rect rect)
    {
        X = rect.X;
        Y = rect.Y;
        Width = rect.Width;
        Height = rect.Height;
    }

    public Rect ToRect() => new((int)X, (int)Y, (int)Width, (int)Height);
}

public sealed class ScreenInfo
{
    public const string Primary = "primary";
    public const string Agent = "agent";

    [JsonPropertyName("name")] public string Name { get; set; } = "";
    /// <summary><see cref="Primary"/> (managed from the tray menu) or <see cref="Agent"/>.</summary>
    [JsonPropertyName("kind")] public string Kind { get; set; } = Agent;
    [JsonPropertyName("displayID")] public uint DisplayId { get; set; }
    /// <summary>The Windows display device, such as \\.\DISPLAY3.</summary>
    [JsonPropertyName("device")] public string? Device { get; set; }
    /// <summary>Size in logical pixels (pixels divided by the scale).</summary>
    [JsonPropertyName("width")] public int Width { get; set; }
    [JsonPropertyName("height")] public int Height { get; set; }
    [JsonPropertyName("hiDPI")] public bool HiDpi { get; set; }
    /// <summary>Virtual-screen frame in physical pixels, the space Win32 and cua-driver use.</summary>
    [JsonPropertyName("frame")] public Frame Frame { get; set; } = new();
    [JsonPropertyName("expiresIn")] public int? ExpiresIn { get; set; }
    [JsonPropertyName("idleTimeout")] public int? IdleTimeout { get; set; }
    [JsonPropertyName("ownerPID")] public int? OwnerPid { get; set; }
}

public sealed class WindowSummary
{
    [JsonPropertyName("pid")] public int Pid { get; set; }
    [JsonPropertyName("windowID")] public long WindowId { get; set; }
    [JsonPropertyName("app")] public string App { get; set; } = "";
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("frame")] public Frame Frame { get; set; } = new();
}

public sealed class ControlResponse
{
    [JsonPropertyName("ok")] public bool Ok { get; set; } = true;
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("screen")] public ScreenInfo? Screen { get; set; }
    [JsonPropertyName("screens")] public List<ScreenInfo>? Screens { get; set; }
    [JsonPropertyName("pid")] public int? Pid { get; set; }
    [JsonPropertyName("windows")] public List<WindowSummary>? Windows { get; set; }
    [JsonPropertyName("output")] public string? Output { get; set; }

    public static ControlResponse Failure(string message) => new() { Ok = false, Error = message };
}

public static class ProtocolJson
{
    /// <summary>Compact, null-free JSON for the wire.</summary>
    public static readonly JsonSerializerOptions Wire = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Indented JSON with sorted-looking stable output for people and agents.</summary>
    public static readonly JsonSerializerOptions Pretty = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
}

/// <summary>An integer rectangle in physical pixels, top-left origin.</summary>
public readonly record struct Rect(int X, int Y, int Width, int Height)
{
    public int Right => X + Width;
    public int Bottom => Y + Height;
    public double CenterX => X + Width / 2.0;
    public double CenterY => Y + Height / 2.0;
    public bool IsEmpty => Width <= 0 || Height <= 0;

    public bool Contains(double x, double y) => x >= X && x < Right && y >= Y && y < Bottom;

    public bool ContainsCenterOf(Rect other) => Contains(other.CenterX, other.CenterY);
}
