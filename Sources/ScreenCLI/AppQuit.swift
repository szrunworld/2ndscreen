import AppKit
import Foundation

/// `2ndscreen app quit --pid PID --bundle BUNDLE_ID [--wait SECONDS]`: ask one app
/// process to quit the way ⌘Q does, and wait for it to be gone.
///
/// A runtime that launched an app for an agent ends it this way rather than with
/// a signal: some apps (BOSS直聘) take SIGTERM for a crash and relaunch themselves
/// onto the user's display. Only the process named is asked, and only when it is
/// that bundle, so a pid reused by another program is left alone. Answered in this
/// process; the 2ndscreen app is not involved.
enum AppQuitCommand {
    static func run(_ args: Arguments) -> Never {
        guard let pidText = args.value("--pid"), let pid = pid_t(pidText), pid > 0,
              let bundle = args.value("--bundle"), !bundle.isEmpty else {
            fail("app quit needs --pid PID and --bundle BUNDLE_ID")
        }
        let wait = min(max(args.value("--wait").flatMap(Double.init) ?? 10, 0), 60)
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            DriverCommands.emit(["ok": true, "pid": Int(pid), "running": false])
            exit(0)
        }
        guard app.bundleIdentifier == bundle else {
            fail("pid \(pid) is \(app.bundleIdentifier ?? "not an app"), not \(bundle)", code: 1)
        }
        let asked = app.terminate()
        let deadline = Date().addingTimeInterval(wait)
        while !app.isTerminated && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        var output: [String: Any] = ["ok": app.isTerminated, "pid": Int(pid), "asked": asked, "running": !app.isTerminated]
        if !app.isTerminated { output["error"] = "\(bundle) (pid \(pid)) did not quit within \(Int(wait)) s" }
        DriverCommands.emit(output)
        exit(app.isTerminated ? 0 : 1)
    }
}
