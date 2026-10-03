using System.Xml.Linq;

namespace SecondScreen.App;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        Desktop.BecomeDpiAware();

        // --setup, run once as administrator if the driver's settings are not writable:
        // reserve the monitor pool and the common resolutions, then reload the driver.
        if (args.Contains("--setup")) return Setup();

        // One instance only: a second would compete for the same virtual outputs.
        using var mutex = new Mutex(true, $@"Local\2ndscreen-app-{Environment.UserName}", out bool first);
        if (!first) return 0;

        // A failure in a menu action or a timer is reported (see TrayApp) instead of
        // ending the app, which would leave its virtual screens attached.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApp());
        return 0;
    }

    private static int Setup()
    {
        try
        {
            var document = XDocument.Load(VddSettings.DefaultPath);
            VddSettings.Ensure(document, VirtualDisplayDriver.PoolSize, VddSettings.Common);
            document.Save(VddSettings.DefaultPath);
            VirtualDisplayDriver.Send("RELOAD_DRIVER");
            Console.WriteLine($"Reserved {VirtualDisplayDriver.PoolSize} virtual outputs in {VddSettings.DefaultPath}.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"setup failed: {error.Message}");
            return 1;
        }
    }
}
