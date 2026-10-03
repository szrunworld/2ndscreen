import AppKit
import SecondScreenCore

// One instance only, unless this is a side instance for testing: a second
// copy would try to create the same virtual display (macOS refuses a
// duplicate) and add a second preview.
let bundleID = Bundle.main.bundleIdentifier ?? "io.github.szrunworld.2ndscreen"
let ownPID = ProcessInfo.processInfo.processIdentifier
if !ControlProtocol.isSideInstance, NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    .contains(where: { $0.processIdentifier != ownPID }) {
    exit(0)
}

// Menu bar only: no Dock icon, no main window. Top-level code runs on the
// main thread, so it may assume main-actor isolation.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let controller = AppController()
    app.delegate = controller
    app.setActivationPolicy(.accessory)
    app.run()
}
