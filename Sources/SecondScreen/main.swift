import AppKit
import SecondScreenCore

// One usual instance only: a second would try to create the same virtual
// display (macOS refuses a duplicate) and add a second preview. Side
// instances, which agents run to test a build, do not count: they keep to
// the background, and the usual app starts beside them.
if !ControlProtocol.isSideInstance, ControlProtocol.isListening(ControlProtocol.primarySocketURL) {
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
