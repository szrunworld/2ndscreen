using System.Diagnostics;
using System.Text.Json;

namespace SecondScreen.App;

/// <summary>User choices, kept in %APPDATA%\2ndscreen\settings.json.</summary>
internal sealed class Preferences
{
    public bool Enabled { get; set; } = true;
    public int? Width { get; set; }
    public int? Height { get; set; }
    public bool? HiDpi { get; set; }
    public bool ShowPreview { get; set; }
    public bool PreviewOnTop { get; set; } = true;

    private static string FilePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "2ndscreen", "settings.json");

    public static Preferences Load()
    {
        try { return JsonSerializer.Deserialize<Preferences>(File.ReadAllText(FilePath)) ?? new(); }
        catch { return new(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}

/// <summary>The tray icon, its menu, and the control pipe's handler.</summary>
internal sealed class TrayApp : ApplicationContext
{
    private static readonly (int Width, int Height)[] Presets =
        { (1280, 720), (1280, 800), (1440, 900), (1920, 1080), (2560, 1440) };

    private readonly Preferences preferences = Preferences.Load();
    private readonly VirtualDisplayDriver driver = new();
    private readonly Screens screens;
    private readonly NotifyIcon tray;
    private readonly HotKeyWindow hotKey;
    private readonly ControlServer server;
    private readonly Dictionary<string, PreviewForm> previews = new();
    private readonly System.Windows.Forms.Timer reapTimer = new() { Interval = 5000 };
    private readonly System.Windows.Forms.Timer followTimer = new() { Interval = 300 };

    public TrayApp()
    {
        screens = new Screens(driver);
        screens.Changed += ClosePreviewsOfDestroyedScreens;

        tray = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "2ndscreen",
            Visible = true,
            ContextMenuStrip = new ContextMenuStrip(),
        };
        tray.ContextMenuStrip.Opening += (_, _) => BuildMenu(tray.ContextMenuStrip);

        hotKey = new HotKeyWindow(MoveFrontWindowToOtherScreen);
        reapTimer.Tick += (_, _) => screens.Reap();
        reapTimer.Start();
        followTimer.Tick += (_, _) => screens.FollowBindings();
        followTimer.Start();

        server = new ControlServer(Handle, SynchronizationContext.Current!);
        server.Start();

        if (preferences.Enabled) EnablePrimary(quiet: true);
    }

    // MARK: Primary screen

    private (int Width, int Height, bool HiDpi) PrimaryMode()
    {
        // By default match the main display, so the full-screen preview fills it pixel for pixel.
        var main = Desktop.Primary();
        return (preferences.Width ?? main.LogicalWidth, preferences.Height ?? main.LogicalHeight, preferences.HiDpi ?? main.HiDpi);
    }

    private void EnablePrimary(bool quiet = false)
    {
        if (screens.Primary is not null) return;
        var (width, height, hiDpi) = PrimaryMode();
        var response = screens.Create(Screens.PrimaryName, ScreenInfo.Primary, width, height, hiDpi, null, null, null);
        if (!response.Ok && !quiet) Notify(response.Error!);
        if (response.Ok && preferences.ShowPreview) TogglePreview(Screens.PrimaryName);
    }

    private void SetPrimaryMode(int width, int height, bool hiDpi)
    {
        preferences.Width = width;
        preferences.Height = height;
        preferences.HiDpi = hiDpi;
        preferences.Save();
        if (screens.Primary is null) return;
        bool showing = previews.ContainsKey(Screens.PrimaryName);
        screens.Destroy(Screens.PrimaryName);
        EnablePrimary();
        if (showing && !previews.ContainsKey(Screens.PrimaryName)) TogglePreview(Screens.PrimaryName);
    }

    // MARK: Control requests

    private async Task<ControlResponse> Handle(ControlRequest request)
    {
        if (request.Screen is { } named) screens.Touch(named);
        Screens.Screen? Target() => request.Screen is { } name ? screens.Named(name) : null;
        var missing = ControlResponse.Failure(request.Screen is { } n ? $"no screen named \"{n}\"" : "give a screen with --screen");

        switch (request.Command)
        {
            case ControlRequest.ScreenCreate:
            {
                var main = Desktop.Primary();
                return screens.Create(request.Screen, ScreenInfo.Agent,
                    request.Width ?? main.LogicalWidth, request.Height ?? main.LogicalHeight,
                    request.HiDpi ?? main.HiDpi, request.Ttl, request.IdleTimeout, request.OwnerPid);
            }
            case ControlRequest.ScreenList:
                return new ControlResponse { Screens = screens.All.Select(screens.Info).ToList() };
            case ControlRequest.ScreenDestroy:
                if (request.Screen is null) return missing;
                if (request.Screen == Screens.PrimaryName) return ControlResponse.Failure("the primary screen is managed from the tray menu");
                return screens.Destroy(request.Screen);
            case ControlRequest.AppLaunch:
                return Target() is { } launchOn
                    ? await screens.Launch(launchOn, request.Path, request.Arguments, request.NewInstance ?? false, request.Fill ?? false)
                    : missing;
            case ControlRequest.WindowMove:
                if (Target() is not { } moveTo) return missing;
                if (request.Pid is not int pid) return ControlResponse.Failure("give the window's program with --pid");
                return await screens.Move(moveTo, pid, request.WindowId, request.Fill ?? false);
            case ControlRequest.Screenshot:
                if (Target() is not { } shot) return missing;
                if (request.Output is null) return ControlResponse.Failure("give a PNG path with --output");
                return Screens.Screenshot(shot.Bounds, request.Output);
            default:
                return ControlResponse.Failure($"unknown command {request.Command}");
        }
    }

    // MARK: Previews

    private void ClosePreviewsOfDestroyedScreens()
    {
        var names = screens.All.Select(s => s.Name).ToHashSet();
        foreach (var name in previews.Keys.Where(n => !names.Contains(n)).ToList())
        {
            previews[name].Close();
        }
    }

    private void TogglePreview(string name)
    {
        if (previews.TryGetValue(name, out var open))
        {
            open.Close();
            return;
        }
        if (screens.Named(name) is not { } screen) return;
        var preview = new PreviewForm(name, screen.Device, preferences.PreviewOnTop);
        preview.FormClosed += (_, _) =>
        {
            previews.Remove(name);
            if (name == Screens.PrimaryName) { preferences.ShowPreview = false; preferences.Save(); }
        };
        previews[name] = preview;
        if (name == Screens.PrimaryName) { preferences.ShowPreview = true; preferences.Save(); }
        // Show without stealing the foreground from whatever the user is doing.
        AppLauncher.GuardForeground(Desktop.Foreground(), Environment.ProcessId, TimeSpan.FromSeconds(1));
        preview.Show();
    }

    // MARK: Windows

    /// <summary>Send the focused window to 2ndscreen, or back to the main display. Ctrl+Alt+Win+M.</summary>
    private void MoveFrontWindowToOtherScreen()
    {
        if (screens.Primary is not { } primary) return;
        var front = Desktop.Foreground();
        if (Desktop.Windows(w => w.Handle == front).FirstOrDefault() is not { } window) return;
        bool onVirtual = primary.Bounds.ContainsCenterOf(window.Frame);
        Desktop.Move(window, onVirtual ? Desktop.Primary().WorkArea : primary.WorkArea, fill: false);
    }

    private void BringBack(WindowInfo window) => Desktop.Move(window, Desktop.Primary().WorkArea, fill: false);

    // MARK: Menu

    private void BuildMenu(ContextMenuStrip menu)
    {
        menu.Items.Clear();
        var primary = screens.Primary;
        menu.Items.Add(new ToolStripMenuItem(StatusLine(primary)) { Enabled = false });
        menu.Items.Add(new ToolStripSeparator());

        if (!driver.IsInstalled)
        {
            menu.Items.Add("Install Virtual Display Driver…", null, (_, _) => Open("https://github.com/VirtualDrivers/Virtual-Display-Driver/releases"));
            menu.Items.Add(new ToolStripSeparator());
        }

        menu.Items.Add(Check("Virtual Display", primary is not null, () =>
        {
            preferences.Enabled = primary is null;
            preferences.Save();
            if (primary is null) EnablePrimary(); else screens.Destroy(Screens.PrimaryName);
        }));

        var (width, height, hiDpi) = PrimaryMode();
        var resolution = new ToolStripMenuItem("Resolution");
        foreach (var display in Desktop.Displays().Where(d => !d.IsVirtual))
        {
            var label = $"Match {display.Device.TrimStart('\\', '.')} — {display.LogicalWidth}x{display.LogicalHeight}{(display.HiDpi ? " HiDPI" : "")}";
            bool matches = display.LogicalWidth == width && display.LogicalHeight == height && display.HiDpi == hiDpi;
            resolution.DropDownItems.Add(Check(label, matches, () => SetPrimaryMode(display.LogicalWidth, display.LogicalHeight, display.HiDpi)));
        }
        resolution.DropDownItems.Add(new ToolStripSeparator());
        foreach (var (w, h) in Presets)
        {
            resolution.DropDownItems.Add(Check($"{w}x{h}", w == width && h == height, () => SetPrimaryMode(w, h, hiDpi)));
        }
        menu.Items.Add(resolution);
        menu.Items.Add(Check("HiDPI (200%)", hiDpi, () => SetPrimaryMode(width, height, !hiDpi)));
        menu.Items.Add(new ToolStripSeparator());

        var preview = Check("Show Preview", previews.ContainsKey(Screens.PrimaryName), () => TogglePreview(Screens.PrimaryName));
        preview.Enabled = primary is not null;
        menu.Items.Add(preview);
        menu.Items.Add(Check("Keep Preview on Top", preferences.PreviewOnTop, () =>
        {
            preferences.PreviewOnTop = !preferences.PreviewOnTop;
            preferences.Save();
            foreach (var form in previews.Values) form.TopMost = preferences.PreviewOnTop;
        }));
        var fullScreen = Check("Preview Full Screen", previews.TryGetValue(Screens.PrimaryName, out var p) && p.IsFullScreen,
            () => { if (previews.TryGetValue(Screens.PrimaryName, out var form)) form.ToggleFullScreen(); });
        fullScreen.Enabled = previews.ContainsKey(Screens.PrimaryName);
        menu.Items.Add(fullScreen);
        menu.Items.Add(new ToolStripSeparator());

        if (primary is not null)
        {
            menu.Items.Add(new ToolStripMenuItem("Move Front Window to Other Screen", null, (_, _) => MoveFrontWindowToOtherScreen())
            {
                ShortcutKeyDisplayString = "Ctrl+Alt+Win+M",
            });
            AddWindows(menu, "Windows on 2ndscreen", primary.Bounds);
            menu.Items.Add(new ToolStripSeparator());
        }

        var agents = screens.Agents.ToList();
        menu.Items.Add(new ToolStripMenuItem($"Agent Screens ({agents.Count})") { Enabled = false });
        foreach (var agent in agents)
        {
            var item = new ToolStripMenuItem($"{agent.Name} — {agent.Width}x{agent.Height}{(agent.HiDpi ? " HiDPI" : "")}");
            item.DropDownItems.Add(Check("Show Preview", previews.ContainsKey(agent.Name), () => TogglePreview(agent.Name)));
            foreach (var window in Desktop.WindowsOn(agent.Bounds))
            {
                item.DropDownItems.Add($"Bring Back: {window.Label}", null, (_, _) => BringBack(window));
            }
            item.DropDownItems.Add(new ToolStripSeparator());
            item.DropDownItems.Add("Destroy", null, (_, _) => screens.Destroy(agent.Name));
            menu.Items.Add(item);
        }
        if (agents.Count > 1) menu.Items.Add("Destroy All Agent Screens", null, (_, _) => screens.DestroyAgents());
        menu.Items.Add(new ToolStripSeparator());

        menu.Items.Add("Open Display Settings…", null, (_, _) => Open("ms-settings:display"));
        menu.Items.Add("Quit 2ndscreen", null, (_, _) => ExitThread());
    }

    private void AddWindows(ContextMenuStrip menu, string title, Rect bounds)
    {
        var windows = Desktop.WindowsOn(bounds);
        var parent = new ToolStripMenuItem($"{title} ({windows.Count})") { Enabled = windows.Count > 0 };
        foreach (var window in windows) parent.DropDownItems.Add($"Bring Back: {window.Label}", null, (_, _) => BringBack(window));
        if (windows.Count > 1)
        {
            parent.DropDownItems.Add(new ToolStripSeparator());
            parent.DropDownItems.Add("Bring All Back", null, (_, _) => windows.ForEach(BringBack));
        }
        menu.Items.Add(parent);
    }

    private string StatusLine(Screens.Screen? primary)
    {
        if (!driver.IsInstalled) return driver.Status();
        if (primary?.Display is not { } display) return "Virtual display off";
        return $"{primary.Width}x{primary.Height}{(display.HiDpi ? " HiDPI" : "")} · at ({display.Bounds.X}, {display.Bounds.Y})";
    }

    private static ToolStripMenuItem Check(string text, bool on, Action action) =>
        new(text, null, (_, _) => action()) { Checked = on };

    private static void Open(string target) => Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });

    private void Notify(string message) => tray.ShowBalloonTip(5000, "2ndscreen", message, ToolTipIcon.Warning);

    protected override void ExitThreadCore()
    {
        server.Stop();
        hotKey.Dispose();
        foreach (var form in previews.Values.ToList()) form.Close();
        // Detach every virtual screen; Windows moves their windows to the real displays.
        foreach (var screen in screens.All.ToList()) screens.Destroy(screen.Name);
        tray.Visible = false;
        tray.Dispose();
        base.ExitThreadCore();
    }
}

/// <summary>Receives the global Ctrl+Alt+Win+M hot key.</summary>
internal sealed class HotKeyWindow : NativeWindow, IDisposable
{
    private const int WM_HOTKEY = 0x0312, Id = 1;
    private const uint MOD_ALT = 1, MOD_CONTROL = 2, MOD_WIN = 8, MOD_NOREPEAT = 0x4000;
    private readonly Action action;

    public HotKeyWindow(Action action)
    {
        this.action = action;
        CreateHandle(new CreateParams());
        RegisterHotKey(Handle, Id, MOD_CONTROL | MOD_ALT | MOD_WIN | MOD_NOREPEAT, (uint)Keys.M);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && m.WParam == Id) action();
        base.WndProc(ref m);
    }

    public void Dispose()
    {
        UnregisterHotKey(Handle, Id);
        DestroyHandle();
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool RegisterHotKey(nint hwnd, int id, uint modifiers, uint key);
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool UnregisterHotKey(nint hwnd, int id);
}
