using System.IO.Pipes;
using System.Text;
using System.Xml.Linq;

namespace SecondScreen.App;

/// <summary>
/// Drives the Virtual Display Driver (github.com/VirtualDrivers/Virtual-Display-Driver).
///
/// The driver builds its monitors from vdd_settings.xml whenever it reloads, and a
/// reload tears every virtual monitor down. So 2ndscreen reserves a fixed pool once
/// (<see cref="PoolSize"/> monitors with the common resolutions) and then attaches and
/// detaches pool monitors through the ordinary display settings API, which leaves the
/// other screens alone. Only a resolution missing from the list needs another reload.
/// </summary>
internal sealed class VirtualDisplayDriver
{
    /// <summary>The app's own screen plus up to eight agent screens.</summary>
    public const int PoolSize = 9;

    private const string PipeName = "MTTVirtualDisplayPipe";
    private readonly string settingsPath;
    private readonly HashSet<string> reserved = new(StringComparer.OrdinalIgnoreCase);

    public VirtualDisplayDriver(string settingsPath = VddSettings.DefaultPath) => this.settingsPath = settingsPath;

    public bool IsInstalled => File.Exists(settingsPath) && Desktop.VirtualDevices().Count > 0;

    public string Status()
    {
        if (!File.Exists(settingsPath)) return "Virtual Display Driver not installed";
        var devices = Desktop.VirtualDevices();
        return $"{devices.Count} virtual outputs, {devices.Count(d => d.Attached)} attached";
    }

    /// <summary>
    /// Make sure the pool exists and lists <paramref name="needed"/>. Reloads the driver
    /// only when the settings change; <paramref name="allowReload"/> false refuses instead,
    /// because a reload detaches every virtual monitor.
    /// </summary>
    public string? Prepare(IEnumerable<VddSettings.Resolution> needed, bool allowReload)
    {
        if (!File.Exists(settingsPath)) return "the Virtual Display Driver is not installed; see the 2ndscreen README";
        XDocument document;
        try
        {
            document = XDocument.Load(settingsPath);
        }
        catch (Exception error)
        {
            return $"cannot read {settingsPath}: {error.Message}";
        }

        var wanted = VddSettings.Common.Concat(needed).ToList();
        bool poolReady = Desktop.VirtualDevices().Count >= PoolSize;
        if (!VddSettings.Ensure(document, PoolSize, wanted) && poolReady) return null;
        if (!allowReload)
        {
            return "that resolution needs a driver reload, which would detach the other screens; destroy them first";
        }

        try
        {
            document.Save(settingsPath);
        }
        catch (UnauthorizedAccessException)
        {
            return $"cannot write {settingsPath}; run 'SecondScreen.exe --setup' once as administrator";
        }
        Send("RELOAD_DRIVER");

        // The driver re-creates its outputs asynchronously.
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            if (Desktop.VirtualDevices().Count >= PoolSize) return null;
            Thread.Sleep(250);
        }
        return $"the driver did not provide {PoolSize} outputs after reloading";
    }

    /// <summary>A detached pool output that no screen has claimed, reserved for the caller.</summary>
    public string? Claim()
    {
        var free = Desktop.VirtualDevices().FirstOrDefault(d => !d.Attached && !reserved.Contains(d.Device));
        if (free.Device is null) return null;
        reserved.Add(free.Device);
        return free.Device;
    }

    public void Release(string device)
    {
        Desktop.Detach(device);
        reserved.Remove(device);
    }

    /// <summary>
    /// Attach <paramref name="device"/> at the given physical size, to the right of the
    /// existing desktop, and wait until Windows reports it.
    /// </summary>
    public DisplayInfo? Attach(string device, int width, int height)
    {
        var displays = Desktop.Displays();
        int x = displays.Count == 0 ? 0 : displays.Max(d => d.Bounds.Right);
        int top = displays.FirstOrDefault(d => d.IsPrimary)?.Bounds.Y ?? 0;
        int result = Desktop.Attach(device, width, height, x, top);
        if (result != 0) return null;

        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            var display = Desktop.Display(device);
            if (display is not null && display.Bounds.Width == width && display.Bounds.Height == height) return display;
            Thread.Sleep(100);
        }
        return Desktop.Display(device);
    }

    /// <summary>Send one command string to the driver's control pipe.</summary>
    public static bool Send(string command)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut);
            pipe.Connect(2000);
            var bytes = Encoding.Unicode.GetBytes(command);
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
            return true;
        }
        catch
        {
            return false;
        }
    }
}
