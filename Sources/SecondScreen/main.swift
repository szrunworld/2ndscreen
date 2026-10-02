import AppKit

// Menu bar only: no Dock icon, no main window. Top-level code runs on the
// main thread, so it may assume main-actor isolation.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let controller = AppController()
    app.delegate = controller
    app.setActivationPolicy(.accessory)
    app.run()
}
