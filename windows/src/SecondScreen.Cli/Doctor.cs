using System.Text.Json;
using System.Text.Json.Nodes;

namespace SecondScreen.Cli;

/// <summary><c>2ndscreen doctor</c>: what 2ndscreen can see, for setup and bug reports.</summary>
public static class Doctor
{
    public static int Run()
    {
        var report = new JsonObject();

        report["displays"] = new JsonArray(Desktop.Displays().Select(d => (JsonNode)new JsonObject
        {
            ["device"] = d.Device, ["virtual"] = d.IsVirtual, ["primary"] = d.IsPrimary, ["scale"] = d.ScalePercent,
            ["frame"] = new JsonObject { ["x"] = d.Bounds.X, ["y"] = d.Bounds.Y, ["width"] = d.Bounds.Width, ["height"] = d.Bounds.Height },
        }).ToArray());

        report["adapterOutputs"] = new JsonArray(Desktop.AllDevices().Select(d => (JsonNode)new JsonObject
        {
            ["device"] = d.Device, ["adapter"] = d.Adapter, ["attached"] = d.Attached,
        }).ToArray());
        report["virtualOutputs"] = new JsonArray(Desktop.VirtualDevices().Select(d => (JsonNode)new JsonObject
        {
            ["device"] = d.Device, ["attached"] = d.Attached,
            ["modes"] = Desktop.Modes(d.Device).Count,
        }).ToArray());

        var settings = VddSettings.DefaultPath;
        if (File.Exists(settings))
        {
            try
            {
                var document = System.Xml.Linq.XDocument.Load(settings);
                report["driverSettings"] = $"{settings}: {VddSettings.MonitorCount(document)} monitors, {VddSettings.Resolutions(document).Count} resolutions";
            }
            catch (Exception error)
            {
                report["driverSettings"] = $"{settings}: unreadable ({error.Message})";
            }
        }
        else
        {
            report["driverSettings"] = $"{settings} missing: the Virtual Display Driver is not installed";
        }

        report["cuaDriver"] = new Driver("doctor").Executable;
        try
        {
            var list = ControlPipe.Send(new ControlRequest { Command = ControlRequest.ScreenList });
            report["app"] = list.Ok ? $"running, {list.Screens?.Count ?? 0} screens" : list.Error;
        }
        catch (Exception error)
        {
            report["app"] = error.Message;
        }

        Console.WriteLine(report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }
}
