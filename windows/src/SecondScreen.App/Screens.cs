using System.Drawing;
using System.Drawing.Imaging;

namespace SecondScreen.App;

/// <summary>
/// Every virtual screen the app owns: its own (kind primary, from the tray menu) and
/// agents' (created through the control pipe), plus the operations agents need on
/// them. Runs on the UI thread.
/// </summary>
internal sealed class Screens
{
    /// <summary>A screen's size in physical pixels and its scale, such as 1920x1080 at 150%.</summary>
    public readonly record struct Mode(int PixelWidth, int PixelHeight, int Scale)
    {
        public int Width => PixelWidth * 100 / Scale;
        public int Height => PixelHeight * 100 / Scale;

        /// <summary>A logical size at 100%, or at 200% for HiDPI.</summary>
        public static Mode Logical(int width, int height, bool hiDpi) =>
            hiDpi ? new(width * 2, height * 2, 200) : new(width, height, 100);

        /// <summary>The same pixels and scale as <paramref name="display"/>, so a full-screen preview on it is one to one.</summary>
        public static Mode Of(DisplayInfo display) =>
            new(display.Bounds.Width, display.Bounds.Height, Math.Max(display.ScalePercent, 100));

        public override string ToString() => $"{PixelWidth}x{PixelHeight}" + (Scale == 100 ? "" : $" at {Scale}%");
    }

    public sealed class Screen
    {
        public required string Name { get; init; }
        public required string Kind { get; init; }
        public required string Device { get; init; }
        public required int Width { get; init; }
        public required int Height { get; init; }
        public required int Scale { get; init; }
        public bool HiDpi => Scale >= 200;
        public DateTime? Deadline { get; init; }
        public TimeSpan? IdleTimeout { get; init; }
        public int? OwnerPid { get; init; }
        public DateTime LastUsed { get; set; } = DateTime.UtcNow;
        /// <summary>An existing display standing in for a virtual one (SECONDSCREEN_TEST_DISPLAY).</summary>
        public bool TestStandIn { get; init; }

        public DisplayInfo? Display => Desktop.Display(Device);
        public Rect Bounds => Display?.Bounds ?? default;
        public Rect WorkArea => Display?.WorkArea ?? default;
    }

    public const string PrimaryName = "2ndscreen";
    public const int AgentLimit = 8;
    public static readonly TimeSpan DefaultIdleTimeout = TimeSpan.FromHours(1);

    private readonly VirtualDisplayDriver driver;
    private readonly List<Screen> screens = new();
    /// <summary>Apps an agent placed on a screen; their later windows follow them there.</summary>
    private readonly Dictionary<int, string> bindings = new();

    public event Action? Changed;

    public Screens(VirtualDisplayDriver driver) => this.driver = driver;

    public IReadOnlyList<Screen> All => screens;
    public IEnumerable<Screen> Agents => screens.Where(s => s.Kind == ScreenInfo.Agent);
    public Screen? Primary => screens.FirstOrDefault(s => s.Kind == ScreenInfo.Primary);

    public Screen? Named(string name) => screens.FirstOrDefault(s => s.Name == name);

    public void Touch(string name)
    {
        if (Named(name) is { } screen) screen.LastUsed = DateTime.UtcNow;
    }

    public ScreenInfo Info(Screen screen)
    {
        var display = screen.Display;
        return new ScreenInfo
        {
            Name = screen.Name, Kind = screen.Kind, Device = screen.Device,
            DisplayId = (uint)Math.Max(0, Desktop.VirtualDevices().FindIndex(d => d.Device == screen.Device)),
            Width = screen.Width, Height = screen.Height,
            HiDpi = display?.HiDpi ?? screen.HiDpi,
            Frame = new Frame(display?.Bounds ?? default),
            ExpiresIn = screen.Deadline is { } deadline ? Math.Max(0, (int)(deadline - DateTime.UtcNow).TotalSeconds) : null,
            IdleTimeout = screen.IdleTimeout is { } idle ? (int)idle.TotalSeconds : null,
            OwnerPid = screen.OwnerPid,
        };
    }

    // MARK: Lifecycle

    public ControlResponse Create(string? requestedName, string kind, Mode mode,
                                  double? ttl, double? idleTimeout, int? ownerPid)
    {
        if (kind == ScreenInfo.Agent && Agents.Count() >= AgentLimit)
            return ControlResponse.Failure($"at most {AgentLimit} agent screens can exist at once");
        var name = requestedName ?? NextName();
        if (name.Length == 0 || Named(name) is not null || (kind == ScreenInfo.Agent && name == PrimaryName))
            return ControlResponse.Failure($"a screen named \"{name}\" already exists");
        if (mode.PixelWidth is < 320 or > 7680 || mode.PixelHeight is < 240 or > 4320)
            return ControlResponse.Failure("size must be between 320x240 and 7680x4320");
        if (ownerPid is int owner && !IsRunning(owner))
            return ControlResponse.Failure($"owner pid {owner} is not running");
        if (ttl is <= 0) return ControlResponse.Failure("--ttl must be positive");

        // Test only: machines whose GPU cannot host virtual monitors (such as CI virtual
        // machines) can still exercise everything else against an existing display.
        if (Environment.GetEnvironmentVariable("SECONDSCREEN_TEST_DISPLAY") is { Length: > 0 } testDevice)
        {
            if (Desktop.Display(testDevice) is not { } existing) return ControlResponse.Failure($"no display {testDevice}");
            var standIn = new Screen
            {
                Name = name, Kind = kind, Device = testDevice, Width = existing.LogicalWidth, Height = existing.LogicalHeight,
                Scale = existing.ScalePercent, Deadline = ttl is double s ? DateTime.UtcNow.AddSeconds(s) : null,
                IdleTimeout = idleTimeout is double i && i > 0 ? TimeSpan.FromSeconds(i) : null, OwnerPid = ownerPid,
                TestStandIn = true,
            };
            screens.Add(standIn);
            Changed?.Invoke();
            return new ControlResponse { Screen = Info(standIn) };
        }

        var physical = new VddSettings.Resolution(mode.PixelWidth, mode.PixelHeight);
        // A reload detaches every virtual monitor, so only allow one while none is in use.
        if (driver.Prepare(new[] { physical }, allowReload: screens.Count == 0) is { } problem)
            return ControlResponse.Failure(problem);
        if (driver.Claim() is not { } device)
            return ControlResponse.Failure("no free virtual output; destroy a screen first");

        var display = driver.Attach(device, physical.Width, physical.Height, out var attachProblem);
        if (display is null)
        {
            driver.Release(device);
            return ControlResponse.Failure(attachProblem ?? $"Windows refused to attach a {physical} display");
        }
        if (mode.Scale != 100 && !DisplayScale.Set(device, mode.Scale))
        {
            // Without its scale everything would look too small; fall back to the logical size at 100%.
            mode = new Mode(mode.Width, mode.Height, 100);
            driver.Attach(device, mode.PixelWidth, mode.PixelHeight, out _);
        }

        var screen = new Screen
        {
            Name = name, Kind = kind, Device = device, Width = mode.Width, Height = mode.Height, Scale = mode.Scale,
            Deadline = ttl is double seconds ? DateTime.UtcNow.AddSeconds(seconds) : null,
            IdleTimeout = kind == ScreenInfo.Primary ? null
                : idleTimeout is double idle ? (idle > 0 ? TimeSpan.FromSeconds(idle) : null) : DefaultIdleTimeout,
            OwnerPid = ownerPid,
        };
        screens.Add(screen);
        Changed?.Invoke();
        return new ControlResponse { Screen = Info(screen) };
    }

    public ControlResponse Destroy(string name)
    {
        if (Named(name) is not { } screen) return ControlResponse.Failure($"no screen named \"{name}\"");
        Remove(screen);
        return new ControlResponse();
    }

    public void DestroyAgents()
    {
        foreach (var screen in Agents.ToList()) Remove(screen);
    }

    private void Remove(Screen screen)
    {
        screens.Remove(screen);
        foreach (var pid in bindings.Where(b => b.Value == screen.Name).Select(b => b.Key).ToList()) bindings.Remove(pid);
        // Detaching moves the screen's windows onto the remaining displays.
        if (!screen.TestStandIn) driver.Release(screen.Device);
        Changed?.Invoke();
    }

    /// <summary>Destroy screens past their TTL, idle too long, or whose owner exited. Call periodically.</summary>
    public void Reap()
    {
        var now = DateTime.UtcNow;
        foreach (var screen in Agents.ToList())
        {
            bool expired = screen.Deadline is { } deadline && now >= deadline;
            bool idle = screen.IdleTimeout is { } timeout && now - screen.LastUsed >= timeout;
            bool orphaned = screen.OwnerPid is int owner && !IsRunning(owner);
            if (expired || idle || orphaned) Remove(screen);
        }
    }

    // MARK: Windows

    public async Task<ControlResponse> Launch(Screen screen, string? path, string[]? arguments, bool newInstance, bool fill)
    {
        if (path is null) return ControlResponse.Failure("give the program with --path; Windows has no bundle IDs");
        if (AppLauncher.Resolve(path) is not { } resolved) return ControlResponse.Failure($"no program at {path}");
        // Moving the windows of a program the user already has open would rearrange
        // their work; require an explicit second instance.
        if (!newInstance && AppLauncher.IsRunning(resolved))
            return ControlResponse.Failure($"{Path.GetFileName(resolved)} is already running; pass --new-instance, or use window move");

        int pid;
        try
        {
            pid = AppLauncher.Start(resolved, arguments ?? Array.Empty<string>());
        }
        catch (Exception error)
        {
            return ControlResponse.Failure($"launch failed: {error.Message}");
        }

        var window = await FirstWindow(pid, TimeSpan.FromSeconds(15));
        if (window is null)
        {
            return new ControlResponse
            {
                Ok = false, Pid = pid,
                Error = "the program started but showed no window within 15 seconds (some programs hand off to another process)",
            };
        }
        bool moved = Desktop.Move(window, screen.WorkArea, fill);
        if (screen.Kind == ScreenInfo.Agent) bindings[pid] = screen.Name;
        return new ControlResponse
        {
            Ok = moved, Error = moved ? null : "the program refused to move its window",
            Pid = pid, Screen = Info(screen), Windows = await Settled(pid, screen),
        };
    }

    public async Task<ControlResponse> Move(Screen screen, int pid, long? windowId, bool fill)
    {
        var windows = Desktop.WindowsOf(pid).Where(w => windowId is null || w.Id == windowId).ToList();
        if (windows.Count == 0) return ControlResponse.Failure($"pid {pid} has no matching on-screen window");
        int failed = windows.Count(w => !Desktop.Move(w, screen.WorkArea, fill));
        if (screen.Kind == ScreenInfo.Agent) bindings[pid] = screen.Name;
        return new ControlResponse
        {
            Ok = failed == 0, Error = failed == 0 ? null : $"{failed} window(s) refused to move",
            Screen = Info(screen), Windows = await Settled(pid, screen),
        };
    }

    /// <summary>Move windows that bound programs opened elsewhere back onto their screens. Call often.</summary>
    public void FollowBindings()
    {
        foreach (var (pid, name) in bindings.ToList())
        {
            if (!IsRunning(pid) || Named(name) is not { } screen)
            {
                bindings.Remove(pid);
                continue;
            }
            var bounds = screen.Bounds;
            foreach (var window in Desktop.WindowsOf(pid).Where(w => !bounds.ContainsCenterOf(w.Frame)))
            {
                Desktop.Move(window, screen.WorkArea, fill: false);
            }
        }
    }

    public static ControlResponse Screenshot(Rect bounds, string output)
    {
        if (bounds.IsEmpty) return ControlResponse.Failure("the screen is not attached");
        var path = Path.GetFullPath(Environment.ExpandEnvironmentVariables(output));
        try
        {
            // RGB: BitBlt leaves alpha at zero, which would make an ARGB image transparent.
            using var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppRgb);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                ScreenCapture.Copy(graphics, bounds);
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            bitmap.Save(path, ImageFormat.Png);
        }
        catch (Exception error)
        {
            return ControlResponse.Failure($"screenshot failed: {error.Message}");
        }
        return new ControlResponse { Output = path };
    }

    // MARK: Helpers

    private string NextName()
    {
        int index = 1;
        while (Named($"agent-{index}") is not null) index++;
        return $"agent-{index}";
    }

    private static bool IsRunning(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static async Task<WindowInfo?> FirstWindow(int pid, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (Desktop.WindowsOf(pid).FirstOrDefault() is { } window) return window;
            await Task.Delay(200);
        }
        return null;
    }

    /// <summary>Window positions lag a move by a few frames; wait until one is on the screen.</summary>
    private static async Task<List<WindowSummary>> Settled(int pid, Screen screen)
    {
        for (int i = 0; i < 10; i++)
        {
            var windows = Desktop.WindowsOf(pid);
            if (windows.Any(w => screen.Bounds.ContainsCenterOf(w.Frame))) return windows.Select(w => w.ToSummary()).ToList();
            await Task.Delay(100);
        }
        return Desktop.WindowsOf(pid).Select(w => w.ToSummary()).ToList();
    }
}
