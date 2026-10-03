using System.Diagnostics;
using System.Text.Json;

namespace SecondScreen.App;

/// <summary>User choices, kept in %APPDATA%\2ndscreen\settings.json.</summary>
internal sealed class Preferences
{
    public bool Enabled { get; set; } = true;
    /// <summary>The 2ndscreen display's physical size and scale; unset matches the main display.</summary>
    public int? PixelWidth { get; set; }
    public int? PixelHeight { get; set; }
    public int? Scale { get; set; }
    /// <summary>Older settings: a logical size, at 200% when HiDpi.</summary>
    public int? Width { get; set; }
    public int? Height { get; set; }
    public bool? HiDpi { get; set; }
    public bool ShowPreview { get; set; }
    public bool PreviewOnTop { get; set; } = true;
    public bool PreviewOnOwnDesktop { get; set; }
    /// <summary>The desktop the preview is on, so one left by a crash can be removed.</summary>
    public Guid? PreviewDesktop { get; set; }

    private static string Folder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "2ndscreen");
    private static string FilePath => Path.Combine(Folder, "settings.json");
    public static string ErrorLog => Path.Combine(Folder, "errors.log");

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
        Application.ThreadException += (_, e) => Report(e.Exception);
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

        if (preferences.PreviewDesktop is { } leftover)
        {
            VirtualDesktops.Remove(leftover);
            preferences.PreviewDesktop = null;
            preferences.Save();
        }
        if (preferences.Enabled) EnablePrimary(quiet: true);
    }

    // MARK: Primary screen

    private Screens.Mode PrimaryMode()
    {
        if (preferences is { PixelWidth: int w, PixelHeight: int h, Scale: int scale }) return new(w, h, scale);
        if (preferences is { Width: int width, Height: int height }) return Screens.Mode.Logical(width, height, preferences.HiDpi ?? false);
        // By default match the main display, so the full-screen preview fills it pixel for pixel.
        return Screens.Mode.Of(Desktop.Primary());
    }

    private void EnablePrimary(bool quiet = false)
    {
        if (screens.Primary is not null) return;
        var response = screens.Create(Screens.PrimaryName, ScreenInfo.Primary, PrimaryMode(), null, null, null);
        if (!response.Ok && !quiet) Notify(response.Error!);
        if (response.Ok && preferences.ShowPreview) TogglePreview(Screens.PrimaryName);
    }

    private void SetPrimaryMode(Screens.Mode mode)
    {
        preferences.PixelWidth = mode.PixelWidth;
        preferences.PixelHeight = mode.PixelHeight;
        preferences.Scale = mode.Scale;
        preferences.Width = preferences.Height = null;
        preferences.HiDpi = null;
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
                var mode = request.Width is null && request.Height is null && request.HiDpi is null
                    ? Screens.Mode.Of(main)
                    : Screens.Mode.Logical(request.Width ?? main.LogicalWidth, request.Height ?? main.LogicalHeight, request.HiDpi ?? main.HiDpi);
                return screens.Create(request.Screen, ScreenInfo.Agent, mode, request.Ttl, request.IdleTimeout, request.OwnerPid);
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
            if (preview.DesktopId is { } desktop)
            {
                VirtualDesktops.Remove(desktop);
                preferences.PreviewDesktop = null;
            }
            if (name == Screens.PrimaryName) { preferences.ShowPreview = false; preferences.Save(); }
        };
        previews[name] = preview;
        if (name == Screens.PrimaryName) { preferences.ShowPreview = true; preferences.Save(); }
        // Show without stealing the foreground from whatever the user is doing.
        AppLauncher.GuardForeground(Desktop.Foreground(), Environment.ProcessId, TimeSpan.FromSeconds(1));
        if (name == Screens.PrimaryName && preferences.PreviewOnOwnDesktop && ShowOnOwnDesktop(preview)) return;
        preview.Opacity = 1;
        preview.Show();
    }

    /// <summary>
    /// Like a full-screen window on macOS: a desktop of its own, after the user's, with
    /// the preview covering the main display there. Swiping to it shows the screen.
    /// </summary>
    private bool ShowOnOwnDesktop(PreviewForm preview)
    {
        if (VirtualDesktops.Create(out var problem) is not { } desktop)
        {
            Notify($"Showing the preview here instead: {problem}");
            return false;
        }
        // Invisible and inactive until it is on its desktop, so it neither flashes here
        // nor pulls the user over there.
        preview.OpenInactive = true;
        preview.Opacity = 0;
        preview.Show();
        var main = Desktop.Primary().Bounds;
        preview.Cover(new Rectangle(main.X, main.Y, main.Width, main.Height));
        if (!VirtualDesktops.MoveWindow(preview.Handle, desktop))
        {
            VirtualDesktops.Remove(desktop);
            Notify("Showing the preview here instead: Windows would not move it to its desktop");
            return false;
        }
        preview.DesktopId = desktop;
        preferences.PreviewDesktop = desktop;
        preferences.Save();
        preview.Opacity = 1;
        return true;
    }

    /// <summary>Show the second screen's preview on its own desktop, in a window, or not at all.</summary>
    private void SetView(bool showPreview, bool ownDesktop)
    {
        preferences.PreviewOnOwnDesktop = ownDesktop;
        preferences.Save();
        if (previews.TryGetValue(Screens.PrimaryName, out var open)) open.Close();
        if (showPreview) TogglePreview(Screens.PrimaryName);
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
        if (!driver.IsInstalled)
        {
            menu.Items.Add(new ToolStripMenuItem(driver.Status()) { Enabled = false });
            menu.Items.Add(L("Install Virtual Display Driver…", "安装虚拟显示驱动…"), null,
                (_, _) => Open("https://github.com/VirtualDrivers/Virtual-Display-Driver/releases"));
            menu.Items.Add(new ToolStripSeparator());
        }

        // Your second screen: a display to the right of the main one, for your own windows.
        AddHeader(menu, L("My Second Screen", "我的第二屏"), StatusLine(primary));
        menu.Items.Add(Check(L("On", "开启"), primary is not null, () =>
        {
            preferences.Enabled = primary is null;
            preferences.Save();
            if (primary is null) EnablePrimary(); else screens.Destroy(Screens.PrimaryName);
        }));

        var current = PrimaryMode();
        var resolution = new ToolStripMenuItem(L("Resolution", "分辨率") + $"  ({current})");
        foreach (var display in Desktop.Displays().Where(d => !d.IsVirtual))
        {
            var match = Screens.Mode.Of(display);
            var name = display.IsPrimary ? L("the main display", "主屏幕") : display.Device.TrimStart('\\', '.');
            resolution.DropDownItems.Add(Check(L($"Match {name} — {match} (pixel for pixel)", $"与{name}一致 — {match}（逐像素）"),
                match == current, () => SetPrimaryMode(match)));
        }
        resolution.DropDownItems.Add(new ToolStripSeparator());
        foreach (var (w, h) in Presets)
        {
            var preset = Screens.Mode.Logical(w, h, current.Scale >= 200);
            resolution.DropDownItems.Add(Check($"{w}x{h}", preset == current, () => SetPrimaryMode(preset)));
        }
        resolution.DropDownItems.Add(new ToolStripSeparator());
        resolution.DropDownItems.Add(Check("HiDPI (200%)", current.Scale >= 200,
            () => SetPrimaryMode(Screens.Mode.Logical(current.Width, current.Height, current.Scale < 200))));
        menu.Items.Add(resolution);

        var view = new ToolStripMenuItem(L("View", "查看方式")) { Enabled = primary is not null };
        var showing = previews.TryGetValue(Screens.PrimaryName, out var open);
        view.DropDownItems.Add(Check(L("Full Screen on Its Own Desktop (swipe four fingers)", "独立桌面全屏（四指滑动切换）"),
            showing && preferences.PreviewOnOwnDesktop, () => SetView(showPreview: true, ownDesktop: true)));
        view.DropDownItems.Add(Check(L("Preview Window", "预览窗口"),
            showing && !preferences.PreviewOnOwnDesktop, () => SetView(showPreview: true, ownDesktop: false)));
        view.DropDownItems.Add(Check(L("Don't Show", "不显示"), !showing, () => SetView(showPreview: false, ownDesktop: preferences.PreviewOnOwnDesktop)));
        if (showing && !preferences.PreviewOnOwnDesktop)
        {
            view.DropDownItems.Add(new ToolStripSeparator());
            view.DropDownItems.Add(Check(L("Keep Preview Window on Top", "预览窗口置顶"), preferences.PreviewOnTop, () =>
            {
                preferences.PreviewOnTop = !preferences.PreviewOnTop;
                preferences.Save();
                foreach (var form in previews.Values) form.TopMost = preferences.PreviewOnTop;
            }));
            view.DropDownItems.Add(Check(L("Preview Window Full Screen", "预览窗口全屏"), open!.IsFullScreen, open.ToggleFullScreen));
        }
        menu.Items.Add(view);

        if (primary is not null)
        {
            menu.Items.Add(new ToolStripMenuItem(L("Send Front Window There / Bring It Back", "把当前窗口送过去 / 拿回来"), null,
                (_, _) => MoveFrontWindowToOtherScreen()) { ShortcutKeyDisplayString = "Ctrl+Alt+Win+M" });
            AddWindows(menu, L("Windows on It", "第二屏上的窗口"), primary.Bounds);
        }
        menu.Items.Add(new ToolStripSeparator());

        // Agent screens: created and removed by agents through the 2ndscreen command or MCP.
        var agents = screens.Agents.ToList();
        AddHeader(menu, L($"Agent Screens ({agents.Count}/{Screens.AgentLimit})", $"Agent 屏幕（{agents.Count}/{Screens.AgentLimit}）"),
            L("Agents create these with the 2ndscreen command; they go away when done", "agent 通过 2ndscreen 命令临时创建，用完自动关闭"));
        if (agents.Count == 0) menu.Items.Add(new ToolStripMenuItem(L("None right now", "目前没有")) { Enabled = false });
        foreach (var agent in agents)
        {
            var item = new ToolStripMenuItem($"{agent.Name} — {agent.Width}x{agent.Height}{(agent.HiDpi ? " HiDPI" : "")}");
            item.DropDownItems.Add(Check(L("Show Preview Window", "显示预览窗口"), previews.ContainsKey(agent.Name), () => TogglePreview(agent.Name)));
            foreach (var window in Desktop.WindowsOn(agent.Bounds))
            {
                item.DropDownItems.Add(L($"Bring Back: {window.Label}", $"拿回：{window.Label}"), null, (_, _) => BringBack(window));
            }
            item.DropDownItems.Add(new ToolStripSeparator());
            item.DropDownItems.Add(L("Close This Screen", "关闭这个屏幕"), null, (_, _) => screens.Destroy(agent.Name));
            menu.Items.Add(item);
        }
        if (agents.Count > 1) menu.Items.Add(L("Close All Agent Screens", "关闭全部 Agent 屏幕"), null, (_, _) => screens.DestroyAgents());
        menu.Items.Add(new ToolStripSeparator());

        menu.Items.Add(L("Open Display Settings…", "打开显示设置…"), null, (_, _) => Open("ms-settings:display"));
        menu.Items.Add(L("Quit 2ndscreen", "退出 2ndscreen"), null, (_, _) => ExitThread());
    }

    /// <summary>A bold section title with a grey explanation under it.</summary>
    private static void AddHeader(ContextMenuStrip menu, string title, string detail)
    {
        var heading = new ToolStripLabel(title) { ForeColor = SystemColors.MenuText };
        heading.Font = new Font(heading.Font, FontStyle.Bold);
        menu.Items.Add(heading);
        menu.Items.Add(new ToolStripLabel(detail) { ForeColor = SystemColors.GrayText });
    }

    private void AddWindows(ContextMenuStrip menu, string title, Rect bounds)
    {
        var windows = Desktop.WindowsOn(bounds);
        var parent = new ToolStripMenuItem($"{title} ({windows.Count})") { Enabled = windows.Count > 0 };
        foreach (var window in windows) parent.DropDownItems.Add(L($"Bring Back: {window.Label}", $"拿回：{window.Label}"), null, (_, _) => BringBack(window));
        if (windows.Count > 1)
        {
            parent.DropDownItems.Add(new ToolStripSeparator());
            parent.DropDownItems.Add(L("Bring All Back", "全部拿回"), null, (_, _) => windows.ForEach(BringBack));
        }
        menu.Items.Add(parent);
    }

    private string StatusLine(Screens.Screen? primary)
    {
        if (primary?.Display is not { } display) return L("Off", "已关闭");
        var size = $"{display.Bounds.Width}x{display.Bounds.Height} @{display.ScalePercent}%";
        return L($"{size}, to the right of the main display", $"{size}，在主屏幕右侧");
    }

    /// <summary>English, or Chinese when Windows is in Chinese.</summary>
    private static string L(string english, string chinese) =>
        System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh" ? chinese : english;

    private static ToolStripMenuItem Check(string text, bool on, Action action) =>
        new(text, null, (_, _) => action()) { Checked = on };

    private static void Open(string target) => Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });

    private void Notify(string message) => tray.ShowBalloonTip(5000, "2ndscreen", message, ToolTipIcon.Warning);

    /// <summary>Show an unexpected failure and keep its details in %APPDATA%\2ndscreen\errors.log.</summary>
    private void Report(Exception error)
    {
        try
        {
            File.AppendAllText(Preferences.ErrorLog, $"{DateTime.Now:O} {error}{Environment.NewLine}{Environment.NewLine}");
        }
        catch (IOException) { }
        Notify($"Something went wrong: {error.Message} (details in {Preferences.ErrorLog})");
    }

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
