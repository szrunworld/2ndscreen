using System.Text.Json;
using System.Xml.Linq;
using Xunit;

namespace SecondScreen.Tests;

public class ProtocolTests
{
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", name));

    [Fact]
    public void ReadsMacScreenCreateResponse()
    {
        var response = JsonSerializer.Deserialize<ControlResponse>(Fixture("mac-screen-create.json"))!;
        Assert.True(response.Ok);
        Assert.Equal("fixture", response.Screen!.Name);
        Assert.Equal(ScreenInfo.Agent, response.Screen.Kind);
        Assert.Equal(1280, response.Screen.Width);
        Assert.Equal(800, response.Screen.Frame.Height);
        Assert.Equal(3600, response.Screen.IdleTimeout);
        Assert.NotNull(response.Screen.ExpiresIn);
    }

    [Fact]
    public void ReadsMacScreenListAndErrors()
    {
        var list = JsonSerializer.Deserialize<ControlResponse>(Fixture("mac-screen-list.json"))!;
        Assert.Contains(list.Screens!, s => s.Kind == ScreenInfo.Primary);
        var error = JsonSerializer.Deserialize<ControlResponse>(Fixture("mac-error.json"))!;
        Assert.False(error.Ok);
        Assert.Contains("no screen named", error.Error);
    }

    [Fact]
    public void WritesRequestsWithMacFieldNames()
    {
        var request = new ControlRequest
        {
            Command = ControlRequest.ScreenCreate, Screen = "a", Width = 1280, Height = 800, HiDpi = true,
            Ttl = 60, IdleTimeout = 0, OwnerPid = 42, WindowId = 7,
        };
        var json = JsonDocument.Parse(JsonSerializer.Serialize(request, ProtocolJson.Wire)).RootElement;
        Assert.Equal("screen.create", json.GetProperty("command").GetString());
        Assert.True(json.GetProperty("hiDPI").GetBoolean());
        Assert.Equal(42, json.GetProperty("ownerPID").GetInt32());
        Assert.Equal(7, json.GetProperty("windowID").GetInt32());
        Assert.Equal(0, json.GetProperty("idleTimeout").GetDouble());
        Assert.False(json.TryGetProperty("path", out _), "unset fields stay off the wire");
    }

    [Fact]
    public void LineFramingRoundTrips()
    {
        var stream = new MemoryStream();
        ControlPipe.WriteLine(stream, "{\"ok\":true,\"error\":\"多字节 ✓\"}");
        stream.Position = 0;
        Assert.Equal("{\"ok\":true,\"error\":\"多字节 ✓\"}", ControlPipe.ReadLine(stream));
        Assert.Null(ControlPipe.ReadLine(stream));
    }
}

public class LogicTests
{
    [Theory]
    [InlineData("90s", 90)]
    [InlineData("30m", 1800)]
    [InlineData("2h", 7200)]
    [InlineData("45", 45)]
    [InlineData("0", 0)]
    [InlineData("1.5m", 90)]
    public void ParsesDurations(string text, double seconds) => Assert.Equal(seconds, Duration.Parse(text));

    [Theory]
    [InlineData("")]
    [InlineData("m")]
    [InlineData("ten minutes")]
    public void RejectsBadDurations(string text) => Assert.Null(Duration.Parse(text));

    [Fact]
    public void PlacementKeepsRelativePosition()
    {
        var source = new Rect(0, 0, 2000, 1000);
        var target = new Rect(3000, 0, 1000, 500);
        // Centred window stays centred.
        var placed = Placement.Relative(new Rect(750, 250, 500, 500), source, target);
        Assert.Equal(new Rect(3250, 0, 500, 500), placed);
    }

    [Fact]
    public void PlacementShrinksToFit()
    {
        var placed = Placement.Relative(new Rect(0, 0, 3000, 2000), new Rect(0, 0, 3000, 2000), new Rect(100, 100, 800, 600));
        Assert.Equal(new Rect(100, 100, 800, 600), placed);
    }

    [Fact]
    public void RectContainsCenter()
    {
        var display = new Rect(1920, 0, 1280, 800);
        Assert.True(display.ContainsCenterOf(new Rect(1900, 100, 400, 300)));
        Assert.False(display.ContainsCenterOf(new Rect(1500, 100, 400, 300)));
    }
}

public class SnapshotTests
{
    private static SnapshotNode Node(int depth, string role, string label = "", string value = "", bool offscreen = false,
                                     Rect? frame = null, params string[] actions) =>
        new(depth, role, label, value, actions, frame, offscreen);

    private static Snapshot Calculator() => Snapshot.Build(new[]
    {
        Node(0, "Window", "Calculator"),
        Node(1, "Pane"),
        Node(2, "Button", "All Clear", frame: new Rect(10, 20, 40, 40), actions: "invoke"),
        Node(2, "Button", "7", frame: new Rect(60, 20, 40, 40), actions: "invoke"),
        Node(2, "Button", "Multiply", frame: new Rect(110, 20, 40, 40), actions: "invoke"),
        Node(2, "Text", value: "42"),
    });

    [Fact]
    public void IndexesWhatOneActsOnAndSkipsBarePanes()
    {
        var snapshot = Calculator();
        Assert.Equal(new[] { 0, 1, 2, 3, 4 }, snapshot.Elements.Select(e => e.Index));
        Assert.DoesNotContain(snapshot.Elements, e => e.Role == "Pane");
        Assert.Equal("- [0] Window \"Calculator\"\n    - [1] Button \"All Clear\"", string.Join('\n', snapshot.Tree.Split('\n').Take(2)));
    }

    [Fact]
    public void FindsButtonsByExactLabel()
    {
        var snapshot = Calculator();
        var seven = snapshot.ByText("7")!;
        Assert.Equal("Button", seven.Role);
        Assert.Equal((80.0, 40.0), seven.Center);
        Assert.Equal("Multiply", snapshot.ByText("multiply")!.Label);
        Assert.Equal("42", snapshot.ByText("42")!.Value);
    }

    [Fact]
    public void PrefersExactOverPartialMatches()
    {
        // "Clear" is contained in "All Clear"; with no exact match the partial one wins.
        Assert.Equal("All Clear", Calculator().ByText("Clear")?.Label);
    }

    [Fact]
    public void FallsBackToNearestIndexedAncestorInTree()
    {
        var snapshot = Snapshot.Build(new[]
        {
            Node(0, "Window", "App"),
            Node(1, "Hyperlink", frame: new Rect(10, 20, 30, 40), actions: "invoke"),
            Node(2, "Group"),
            Node(3, "Image"),
        }.Append(new SnapshotNode(2, "Image", "", "消息", Array.Empty<string>(), null, false)));
        var link = snapshot.ByText("消息")!;
        Assert.Equal(1, link.Index);
        Assert.Equal((25.0, 40.0), link.Center);
        Assert.Null(snapshot.ByText("not there"));
    }

    [Fact]
    public void OffscreenAndFilteredNodesKeepTheNumbering()
    {
        var nodes = new[]
        {
            Node(0, "List", "Rows"),
            Node(1, "ListItem", "Row 1", offscreen: true),
            Node(1, "ListItem", "Row 2"),
        };
        var all = Snapshot.Build(nodes);
        Assert.Equal(new[] { 0, 2 }, all.Elements.Select(e => e.Index));
        Assert.Equal(2, Snapshot.Build(nodes, query: "row 2").Elements.Single().Index);
    }
}

public class InputLogicTests
{
    [Fact]
    public void KeyNames()
    {
        Assert.Equal(((ushort)0x0D, false), KeyCodes.VirtualKey("return"));
        Assert.Equal(((ushort)'A', false), KeyCodes.VirtualKey("a"));
        Assert.Equal(((ushort)0x28, true), KeyCodes.VirtualKey("down"));
        Assert.Equal(((ushort)0x74, false), KeyCodes.VirtualKey("F5"));
        Assert.Null(KeyCodes.VirtualKey("*"));
        Assert.Equal(0x11, KeyCodes.Modifier("ctrl"));
        Assert.Equal(0x5B, KeyCodes.Modifier("cmd"));
        Assert.Throws<InvalidOperationException>(() => KeyCodes.Modifier("hyper"));
    }

    [Fact]
    public void KeyParameters()
    {
        Assert.Equal((nint)0x001C0001, KeyCodes.KeyLParam(0x1C, extended: false, up: false));
        Assert.Equal(unchecked((nint)(long)0xC1500001), KeyCodes.KeyLParam(0x50, extended: true, up: true));
    }

    [Fact]
    public void MouseParameters()
    {
        Assert.Equal((nint)0x00C80064, Messages.MakeLParam(100, 200));
        // Points left of or above a window's client area stay negative.
        Assert.Equal(unchecked((nint)(int)0xFFFEFFFF), Messages.MakeLParam(-1, -2));
        Assert.Equal(unchecked((nint)(int)0xFE200000), Messages.WheelWParam(-480));
        Assert.Equal((-360, false), Messages.Wheel("down", 3));
        Assert.Equal((120, true), Messages.Wheel("right", 1));
    }
}

public class VddSettingsTests
{
    private const string Minimal = """
        <?xml version='1.0' encoding='utf-8'?>
        <vdd_settings>
            <monitors><count>1</count></monitors>
            <resolutions>
                <resolution><width>1920</width><height>1080</height><refresh_rate>60</refresh_rate></resolution>
            </resolutions>
            <logging><logging>false</logging></logging>
        </vdd_settings>
        """;

    [Fact]
    public void ReadsCountAndResolutions()
    {
        var doc = XDocument.Parse(Minimal);
        Assert.Equal(1, VddSettings.MonitorCount(doc));
        Assert.Equal(new[] { new VddSettings.Resolution(1920, 1080) }, VddSettings.Resolutions(doc));
    }

    [Fact]
    public void EnsureAddsMissingAndKeepsOtherSettings()
    {
        var doc = XDocument.Parse(Minimal);
        Assert.True(VddSettings.Ensure(doc, 8, new[] { new VddSettings.Resolution(1920, 1080), new VddSettings.Resolution(1280, 800) }));
        Assert.Equal(8, VddSettings.MonitorCount(doc));
        Assert.Equal(2, VddSettings.Resolutions(doc).Count);
        Assert.Equal("false", doc.Root!.Element("logging")!.Element("logging")!.Value);
        // A second pass with nothing new changes nothing, so no reload is needed.
        Assert.False(VddSettings.Ensure(doc, 8, new[] { new VddSettings.Resolution(1280, 800) }));
    }

    [Fact]
    public void EnsureKeepsOnlySixtyHertzGlobally()
    {
        var doc = XDocument.Parse("""
            <vdd_settings>
                <global><g_refresh_rate>60</g_refresh_rate><g_refresh_rate>90</g_refresh_rate><g_refresh_rate>244</g_refresh_rate></global>
            </vdd_settings>
            """);
        Assert.True(VddSettings.Ensure(doc, 1, Array.Empty<VddSettings.Resolution>()));
        Assert.Equal(new[] { "60" }, doc.Root!.Element("global")!.Elements("g_refresh_rate").Select(e => e.Value));
        Assert.False(VddSettings.Ensure(doc, 1, Array.Empty<VddSettings.Resolution>()));
    }

    [Fact]
    public void EnsureCreatesMissingSections()
    {
        var doc = XDocument.Parse("<vdd_settings/>");
        Assert.True(VddSettings.Ensure(doc, 2, VddSettings.Common));
        Assert.Equal(2, VddSettings.MonitorCount(doc));
        Assert.Equal(VddSettings.Common.Count, VddSettings.Resolutions(doc).Count);
    }
}
