using System.Xml.Linq;

namespace SecondScreen;

/// <summary>
/// Reads and edits the Virtual Display Driver's settings file
/// (C:\VirtualDisplayDriver\vdd_settings.xml). The driver reads the monitor count
/// and the resolution list from it when it (re)initialises; every other setting is
/// left as the user or installer configured it.
/// </summary>
public static class VddSettings
{
    public const string DefaultPath = @"C:\VirtualDisplayDriver\vdd_settings.xml";

    public readonly record struct Resolution(int Width, int Height, int RefreshRate = 60)
    {
        public override string ToString() => $"{Width}x{Height}";
    }

    /// <summary>Common sizes, reserved once so most agent screens need no driver reload.</summary>
    public static readonly IReadOnlyList<Resolution> Common = new Resolution[]
    {
        new(800, 600), new(1024, 768), new(1280, 720), new(1280, 800), new(1280, 1024),
        new(1366, 768), new(1440, 900), new(1536, 864), new(1600, 900), new(1680, 1050),
        new(1920, 1080), new(1920, 1200), new(2560, 1440), new(2560, 1600), new(2880, 1800),
        new(3840, 2160),
    };

    public static int MonitorCount(XDocument document) =>
        int.TryParse(document.Root?.Element("monitors")?.Element("count")?.Value, out var count) ? count : 1;

    public static List<Resolution> Resolutions(XDocument document) =>
        document.Root?.Element("resolutions")?.Elements("resolution")
            .Select(r => new Resolution(
                (int?)r.Element("width") ?? 0,
                (int?)r.Element("height") ?? 0,
                (int?)r.Element("refresh_rate") ?? 60))
            .Where(r => r.Width > 0 && r.Height > 0)
            .ToList() ?? new List<Resolution>();

    /// <summary>
    /// Set the monitor count and make sure every resolution in <paramref name="needed"/>
    /// is listed. Returns whether anything changed, so callers reload only then.
    /// </summary>
    public static bool Ensure(XDocument document, int count, IEnumerable<Resolution> needed)
    {
        var root = document.Root ?? throw new InvalidDataException("vdd_settings.xml has no root element");
        bool changed = false;

        var monitors = root.Element("monitors") ?? Add(root, new XElement("monitors"));
        var countElement = monitors.Element("count") ?? Add(monitors, new XElement("count", "1"));
        if (countElement.Value != count.ToString())
        {
            countElement.Value = count.ToString();
            changed = true;
        }

        // The driver multiplies every resolution by every global refresh rate and creates
        // no monitor at all once that passes about a hundred modes (16 resolutions x the
        // installer's six rates does). Agent screens only need 60 Hz.
        foreach (var rate in root.Element("global")?.Elements("g_refresh_rate").ToList() ?? new List<XElement>())
        {
            if (rate.Value.Trim() == "60") continue;
            rate.Remove();
            changed = true;
        }

        var list = root.Element("resolutions") ?? Add(root, new XElement("resolutions"));
        var present = new HashSet<(int, int)>(Resolutions(document).Select(r => (r.Width, r.Height)));
        foreach (var resolution in needed)
        {
            if (!present.Add((resolution.Width, resolution.Height))) continue;
            list.Add(new XElement("resolution",
                new XElement("width", resolution.Width),
                new XElement("height", resolution.Height),
                new XElement("refresh_rate", resolution.RefreshRate)));
            changed = true;
        }
        return changed;
    }

    private static XElement Add(XElement parent, XElement child)
    {
        parent.Add(child);
        return child;
    }
}
