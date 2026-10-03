using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using static SecondScreen.Messages;

namespace SecondScreen.Cli;

/// <summary>
/// Mouse and keyboard input posted to one program's window, without moving the user's
/// pointer or taking the foreground. Points are physical screen pixels. Each call returns
/// the route it took. Nothing reads back whether a message landed; check with state.
/// </summary>
[SupportedOSPlatform("windows")]
public static class Input
{
    // MARK: Mouse

    /// <summary>
    /// Click at a point: a move, then button down and up, posted to the deepest child
    /// window there. Posting to the frame would make many programs bring themselves forward.
    /// </summary>
    public static string Click(nint window, (double X, double Y) point, bool right, int count)
    {
        var (target, client) = DeepestChild(window, point);
        uint down = right ? WM_RBUTTONDOWN : WM_LBUTTONDOWN, up = right ? WM_RBUTTONUP : WM_LBUTTONUP;
        nint button = right ? MK_RBUTTON : MK_LBUTTON;
        var lParam = MakeLParam(client.X, client.Y);
        // Windows turns a second press into a double click only for real input, and only
        // for window classes that ask for double clicks.
        bool doubleClicks = (Win32.GetClassLongPtr(target, Win32.GCL_STYLE) & Win32.CS_DBLCLKS) != 0;
        Quietly(window, () =>
        {
            for (int i = 0; i < Math.Clamp(count, 1, 2); i++)
            {
                if (i > 0) Thread.Sleep(80);
                Win32.PostMessage(target, WM_MOUSEMOVE, 0, lParam);
                Win32.PostMessage(target, i == 1 && doubleClicks && !right ? WM_LBUTTONDBLCLK : down, button, lParam);
                Thread.Sleep(35);
                Win32.PostMessage(target, up, 0, lParam);
            }
        });
        return right ? "post.right" : count > 1 ? "post.double" : "post.click";
    }

    /// <summary>
    /// Press at one point, move in steps, release at another, all to the child window under
    /// the start, which holds the gesture as a captured window would. Programs that poll the
    /// button state rather than read messages (WPF thumbs) do not follow it.
    /// </summary>
    public static string Drag(nint window, (double X, double Y) from, (double X, double Y) to, int durationMs)
    {
        var (target, start) = DeepestChild(window, from);
        var end = ClientPoint(target, to);
        const int steps = 20;
        Quietly(window, () =>
        {
            Win32.PostMessage(target, WM_MOUSEMOVE, 0, MakeLParam(start.X, start.Y));
            Win32.PostMessage(target, WM_LBUTTONDOWN, MK_LBUTTON, MakeLParam(start.X, start.Y));
            Thread.Sleep(35);
            for (int i = 1; i <= steps; i++)
            {
                int x = start.X + (end.X - start.X) * i / steps, y = start.Y + (end.Y - start.Y) * i / steps;
                Win32.PostMessage(target, WM_MOUSEMOVE, MK_LBUTTON, MakeLParam(x, y));
                Thread.Sleep(Math.Max(durationMs, 0) / steps);
            }
            Win32.PostMessage(target, WM_LBUTTONUP, 0, MakeLParam(end.X, end.Y));
        });
        return "post.drag";
    }

    /// <summary>
    /// Turn the wheel at a point, posted to the child window there. Unlike other mouse
    /// messages, the wheel's coordinates are screen coordinates.
    /// </summary>
    public static string Wheel(nint window, (double X, double Y) point, string direction, int notches, bool byPage)
    {
        var (target, _) = DeepestChild(window, point);
        var (delta, horizontal) = Messages.Wheel(direction, notches * (byPage ? 3 : 1));
        var lParam = MakeLParam((int)point.X, (int)point.Y);
        Quietly(window, () =>
        {
            // One message per notch, as a wheel sends them.
            int step = Math.Sign(delta) * WHEEL_DELTA;
            for (int i = 0; i < Math.Abs(delta) / WHEEL_DELTA; i++)
            {
                Win32.PostMessage(target, horizontal ? WM_MOUSEHWHEEL : WM_MOUSEWHEEL, WheelWParam(step), lParam);
                Thread.Sleep(10);
            }
        });
        return "post.wheel";
    }

    // MARK: Keyboard

    /// <summary>
    /// Type text as characters to the focused control, one UTF-16 unit a message, so any
    /// script works without an input method. Line breaks become the Enter key.
    /// </summary>
    public static string Type(nint window, string text, nint control = 0)
    {
        var target = control != 0 ? control : FocusedControl(window);
        Quietly(window, () =>
        {
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c is '\r' or '\n')
                {
                    if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                    PostKey(target, 0x0D, extended: false);
                    Thread.Sleep(24);
                    continue;
                }
                Win32.PostMessage(target, WM_CHAR, c, 1);
                Thread.Sleep(4);
            }
        });
        return "post.char";
    }

    /// <summary>
    /// Press a key with modifiers to the focused control. Posted modifier keys do not
    /// change what the program reads from GetKeyState, which is how most programs tell a
    /// shortcut from a plain key; so for the moment of the key, this process joins the
    /// program's input queue and marks the modifiers held there.
    /// </summary>
    /// <param name="control">The control to send to; else the focused one. A program that
    /// was never activated has no focused control, and keys to its frame go nowhere.</param>
    public static string Key(nint window, string name, IReadOnlyList<string> modifiers, nint control = 0)
    {
        var key = KeyCodes.VirtualKey(name) ?? throw new InvalidOperationException($"unknown key \"{name}\"");
        var held = modifiers.Select(KeyCodes.Modifier).Distinct().ToList();
        var target = control != 0 ? control : FocusedControl(window);
        bool alt = held.Contains(0x12);
        string route = held.Count == 0 ? "post.key" : "post.key+state";
        Quietly(window, () =>
        {
            if (held.Count == 0)
            {
                PostKey(target, key.Vk, key.Extended);
                return;
            }
            uint thread = Win32.GetWindowThreadProcessId(target, out _);
            uint own = Win32.GetCurrentThreadId();
            bool attached = Win32.AttachThreadInput(own, thread, true);
            var saved = new byte[256];
            try
            {
                if (attached)
                {
                    Win32.GetKeyboardState(saved);
                    var state = (byte[])saved.Clone();
                    foreach (var vk in held) state[vk] |= 0x80;
                    Win32.SetKeyboardState(state);
                }
                else
                {
                    route = "post.key";
                }
                foreach (var vk in held) Post(target, alt ? WM_SYSKEYDOWN : WM_KEYDOWN, vk, extended: false, up: false);
                Post(target, alt ? WM_SYSKEYDOWN : WM_KEYDOWN, key.Vk, key.Extended, up: false);
                Thread.Sleep(4);
                Post(target, alt ? WM_SYSKEYUP : WM_KEYUP, key.Vk, key.Extended, up: true);
                // The program reads the state when it handles the message, not when it is
                // posted; hold it until it has had a chance to.
                Thread.Sleep(60);
                for (int i = held.Count - 1; i >= 0; i--) Post(target, alt ? WM_SYSKEYUP : WM_KEYUP, held[i], extended: false, up: true);
            }
            finally
            {
                if (attached)
                {
                    Win32.SetKeyboardState(saved);
                    Win32.AttachThreadInput(own, thread, false);
                }
            }
        });
        return route;
    }

    private static void PostKey(nint target, ushort vk, bool extended)
    {
        Post(target, WM_KEYDOWN, vk, extended, up: false);
        Thread.Sleep(4);
        Post(target, WM_KEYUP, vk, extended, up: true);
    }

    private static void Post(nint target, uint message, ushort vk, bool extended, bool up) =>
        Win32.PostMessage(target, message, vk, KeyCodes.KeyLParam(Win32.MapVirtualKey(vk, Win32.MAPVK_VK_TO_VSC), extended, up));

    // MARK: Foreground

    /// <summary>
    /// For programs that ignore posted input: bring the window forward, move the real
    /// pointer through the gesture with SendInput, then put the pointer and the user's
    /// window back. Only on the agent's explicit request.
    /// </summary>
    public static string Foreground(nint window, Action<Action<int, int>, Action<uint, int>> gesture)
    {
        Win32.GetCursorPos(out var pointer);
        var previous = Win32.GetForegroundWindow();
        TakeForeground(window);
        try
        {
            void Move(int x, int y) => Win32.SetCursorPos(x, y);
            void Send(uint flags, int data)
            {
                var input = new Win32.INPUT { type = Win32.INPUT_MOUSE };
                input.u.mi = new Win32.MOUSEINPUT { dwFlags = flags, mouseData = data };
                Win32.SendInput(1, new[] { input }, Marshal.SizeOf<Win32.INPUT>());
            }
            gesture(Move, Send);
            Thread.Sleep(40);
        }
        finally
        {
            Win32.SetCursorPos(pointer.X, pointer.Y);
            if (previous != 0) TakeForeground(previous);
            RestoreForeground(Win32.GetAncestor(window, Win32.GA_ROOT), previous, 1000);
        }
        return "sendinput";
    }

    /// <summary>
    /// Press a key with modifiers as real keyboard input, with the window brought forward
    /// for the moment and the user's window put back after. For programs that read the
    /// keyboard's state rather than their messages (WPF, Chromium). <paramref name="focus"/>
    /// runs once the window is in front, to put the keys in the right control.
    /// </summary>
    public static string ForegroundKey(nint window, string name, IReadOnlyList<string> modifiers, Action? focus = null)
    {
        var key = KeyCodes.VirtualKey(name) ?? throw new InvalidOperationException($"unknown key \"{name}\"");
        var held = modifiers.Select(KeyCodes.Modifier).Distinct().ToList();
        var previous = Win32.GetForegroundWindow();
        TakeForeground(window);
        try
        {
            Thread.Sleep(60);
            focus?.Invoke();
            Thread.Sleep(40);
            var inputs = new List<Win32.INPUT>();
            void Add(ushort vk, bool up, bool extended)
            {
                var input = new Win32.INPUT { type = Win32.INPUT_KEYBOARD };
                input.u.ki = new Win32.KEYBDINPUT
                {
                    wVk = vk, wScan = (ushort)Win32.MapVirtualKey(vk, Win32.MAPVK_VK_TO_VSC),
                    dwFlags = (up ? Win32.KEYEVENTF_KEYUP : 0) | (extended ? Win32.KEYEVENTF_EXTENDEDKEY : 0),
                };
                inputs.Add(input);
            }
            foreach (var vk in held) Add(vk, up: false, extended: false);
            Add(key.Vk, up: false, key.Extended);
            Add(key.Vk, up: true, key.Extended);
            for (int i = held.Count - 1; i >= 0; i--) Add(held[i], up: true, extended: false);
            Win32.SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<Win32.INPUT>());
            Thread.Sleep(80);
        }
        finally
        {
            if (previous != 0) TakeForeground(previous);
            RestoreForeground(Win32.GetAncestor(window, Win32.GA_ROOT), previous, 1000);
        }
        return "sendinput.key";
    }

    // MARK: Helpers

    /// <summary>
    /// Run posted input with the program kept in the background: its window may not
    /// activate while the messages arrive, and if it brings itself forward anyway, the
    /// user's window goes back in front.
    /// </summary>
    public static void Quietly(nint window, Action action)
    {
        var root = Win32.GetAncestor(window, Win32.GA_ROOT);
        if (root == 0) root = window;
        var previous = Win32.GetForegroundWindow();
        var style = Win32.GetWindowLongPtr(root, Win32.GWL_EXSTYLE);
        bool added = (style & (nint)Win32.WS_EX_NOACTIVATE) == 0
            && Win32.SetWindowLongPtr(root, Win32.GWL_EXSTYLE, style | (nint)Win32.WS_EX_NOACTIVATE) != 0;
        try
        {
            action();
            Thread.Sleep(50);
        }
        finally
        {
            if (added)
            {
                var now = Win32.GetWindowLongPtr(root, Win32.GWL_EXSTYLE);
                Win32.SetWindowLongPtr(root, Win32.GWL_EXSTYLE, now & ~(nint)Win32.WS_EX_NOACTIVATE);
            }
        }
        RestoreForeground(root, previous, WatchMs(root));
    }

    /// <summary>
    /// Put the user's window back in front if the program takes the foreground, watching for
    /// <paramref name="watchMs"/>: Chromium and WPF bring themselves forward a moment after
    /// the input that prompted it, past a single check.
    /// </summary>
    public static void RestoreForeground(nint root, nint previous, int watchMs = 0)
    {
        if (previous == 0 || previous == root) return;
        var deadline = Environment.TickCount64 + watchMs;
        do
        {
            if (Win32.GetAncestor(Win32.GetForegroundWindow(), Win32.GA_ROOT) == root)
            {
                TakeForeground(previous);
                Thread.Sleep(12);
                continue;
            }
            Thread.Sleep(25);
        }
        while (Environment.TickCount64 < deadline);
    }

    /// <summary>How long to watch for a program bringing itself forward after input.</summary>
    private static int WatchMs(nint root)
    {
        var name = Win32.ClassName(root);
        return name.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal) || name.StartsWith("HwndWrapper", StringComparison.Ordinal)
            || name.StartsWith("CefBrowser", StringComparison.Ordinal) ? 400 : 0;
    }

    /// <summary>
    /// SetForegroundWindow from a background process is refused unless it shares the
    /// foreground's input queue for the moment.
    /// </summary>
    private static void TakeForeground(nint window)
    {
        uint foreground = Win32.GetWindowThreadProcessId(Win32.GetForegroundWindow(), out _);
        uint own = Win32.GetCurrentThreadId();
        bool attached = foreground != 0 && foreground != own && Win32.AttachThreadInput(own, foreground, true);
        Win32.SetForegroundWindow(window);
        if (attached) Win32.AttachThreadInput(own, foreground, false);
    }

    /// <summary>The deepest visible, enabled child window at a screen point, and the point in its client area.</summary>
    public static (nint Window, (int X, int Y) Client) DeepestChild(nint window, (double X, double Y) point)
    {
        var current = window;
        for (int depth = 0; depth < 16; depth++)
        {
            var client = new Win32.POINT { X = (int)point.X, Y = (int)point.Y };
            Win32.ScreenToClient(current, ref client);
            var child = Win32.ChildWindowFromPointEx(current, client,
                Win32.CWP_SKIPINVISIBLE | Win32.CWP_SKIPDISABLED | Win32.CWP_SKIPTRANSPARENT);
            if (child == 0 || child == current || !Win32.IsChild(window, child)) break;
            current = child;
        }
        return (current, ClientPoint(current, point));
    }

    private static (int X, int Y) ClientPoint(nint window, (double X, double Y) point)
    {
        var client = new Win32.POINT { X = (int)point.X, Y = (int)point.Y };
        Win32.ScreenToClient(window, ref client);
        return (client.X, client.Y);
    }

    /// <summary>
    /// The control with keyboard focus in the program's window. A window's children can
    /// run on other threads (web view renderers do), so ask each thread, and take the
    /// deepest focused control that belongs to this window. Else the window itself.
    /// </summary>
    public static nint FocusedControl(nint window)
    {
        var threads = new HashSet<uint> { Win32.GetWindowThreadProcessId(window, out _) };
        Win32.EnumChildWindows(window, (child, unused) =>
        {
            threads.Add(Win32.GetWindowThreadProcessId(child, out _));
            return true;
        }, 0);
        nint best = 0;
        int bestDepth = -1;
        foreach (var thread in threads)
        {
            var info = new Win32.GUITHREADINFO { cbSize = Marshal.SizeOf<Win32.GUITHREADINFO>() };
            if (!Win32.GetGUIThreadInfo(thread, ref info) || info.hwndFocus == 0) continue;
            if (info.hwndFocus != window && !Win32.IsChild(window, info.hwndFocus)) continue;
            int depth = 0;
            for (var node = info.hwndFocus; node != window && node != 0; node = Win32.GetAncestor(node, 1 /* GA_PARENT */)) depth++;
            if (depth > bestDepth) (best, bestDepth) = (info.hwndFocus, depth);
        }
        return best != 0 ? best : window;
    }
}
