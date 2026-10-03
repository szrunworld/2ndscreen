namespace SecondScreen;

/// <summary>Key names and the parameters of posted input messages. Pure, so it is tested anywhere.</summary>
public static class KeyCodes
{
    private static readonly Dictionary<string, (ushort Vk, bool Extended)> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        ["return"] = (0x0D, false), ["enter"] = (0x0D, false), ["tab"] = (0x09, false), ["space"] = (0x20, false),
        ["backspace"] = (0x08, false), ["delete"] = (0x2E, true), ["forwarddelete"] = (0x2E, true),
        ["escape"] = (0x1B, false), ["esc"] = (0x1B, false),
        ["home"] = (0x24, true), ["end"] = (0x23, true), ["pageup"] = (0x21, true), ["pagedown"] = (0x22, true),
        ["left"] = (0x25, true), ["up"] = (0x26, true), ["right"] = (0x27, true), ["down"] = (0x28, true),
        ["insert"] = (0x2D, true),
        ["f1"] = (0x70, false), ["f2"] = (0x71, false), ["f3"] = (0x72, false), ["f4"] = (0x73, false),
        ["f5"] = (0x74, false), ["f6"] = (0x75, false), ["f7"] = (0x76, false), ["f8"] = (0x77, false),
        ["f9"] = (0x78, false), ["f10"] = (0x79, false), ["f11"] = (0x7A, false), ["f12"] = (0x7B, false),
    };

    /// <summary>Unshifted punctuation on a US layout.</summary>
    private static readonly Dictionary<char, ushort> Punctuation = new()
    {
        [';'] = 0xBA, ['='] = 0xBB, [','] = 0xBC, ['-'] = 0xBD, ['.'] = 0xBE, ['/'] = 0xBF, ['`'] = 0xC0,
        ['['] = 0xDB, ['\\'] = 0xDC, [']'] = 0xDD, ['\''] = 0xDE,
    };

    /// <summary>
    /// The virtual key for a key name: return, a, 5, f5, down, and so on. Null for names
    /// with no key of their own, such as "*", which are typed as text instead.
    /// </summary>
    public static (ushort Vk, bool Extended)? VirtualKey(string name)
    {
        if (Named.TryGetValue(name, out var named)) return named;
        if (name.Length != 1) return null;
        char c = char.ToUpperInvariant(name[0]);
        if (c is >= 'A' and <= 'Z' or >= '0' and <= '9') return (c, false);
        return Punctuation.TryGetValue(name[0], out var vk) ? (vk, false) : null;
    }

    /// <summary>Modifier names as virtual keys: ctrl, shift, alt (or option), win (or cmd).</summary>
    public static ushort Modifier(string name) => name.ToLowerInvariant() switch
    {
        "ctrl" or "control" => 0x11,
        "shift" => 0x10,
        "alt" or "option" or "opt" => 0x12,
        "win" or "cmd" or "command" or "meta" or "super" => 0x5B,
        _ => throw new InvalidOperationException($"unknown modifier \"{name}\"; use ctrl, shift, alt or win"),
    };

    /// <summary>
    /// The lParam of WM_KEYDOWN and WM_KEYUP: repeat count 1, the scan code, the extended
    /// flag, and for a key-up the previous-state and transition bits.
    /// </summary>
    public static nint KeyLParam(uint scanCode, bool extended, bool up)
    {
        long value = 1 | ((long)(scanCode & 0xFF) << 16);
        if (extended) value |= 1L << 24;
        if (up) value |= (1L << 30) | (1L << 31);
        return (nint)value;
    }
}

public static class Messages
{
    public const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;
    public const uint WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
    public const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_LBUTTONDBLCLK = 0x0203;
    public const uint WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
    public const uint WM_MOUSEWHEEL = 0x020A, WM_MOUSEHWHEEL = 0x020E;
    public const uint EM_REPLACESEL = 0x00C2;
    public const int MK_LBUTTON = 0x1, MK_RBUTTON = 0x2, MK_SHIFT = 0x4, MK_CONTROL = 0x8;
    public const int WHEEL_DELTA = 120;

    /// <summary>Two 16-bit coordinates packed as mouse messages carry them; negatives survive.</summary>
    public static nint MakeLParam(int low, int high) => (nint)(int)(((uint)(ushort)(short)low) | ((uint)(ushort)(short)high << 16));

    /// <summary>
    /// The wParam of WM_MOUSEWHEEL and WM_MOUSEHWHEEL: the key state below, the signed
    /// distance above. Vertically, positive scrolls toward the top; horizontally, toward the right.
    /// </summary>
    public static nint WheelWParam(int delta, int keys = 0) => MakeLParam(keys, delta);

    /// <summary>
    /// The wheel distance for a direction: <c>up</c> and <c>right</c> are positive.
    /// Returns whether the wheel is the horizontal one.
    /// </summary>
    public static (int Delta, bool Horizontal) Wheel(string direction, int notches) => direction switch
    {
        "up" => (notches * WHEEL_DELTA, false),
        "down" => (-notches * WHEEL_DELTA, false),
        "right" => (notches * WHEEL_DELTA, true),
        "left" => (-notches * WHEEL_DELTA, true),
        _ => throw new InvalidOperationException("scroll needs --direction up, down, left or right"),
    };
}
