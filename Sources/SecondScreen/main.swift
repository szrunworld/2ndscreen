import AppKit
import SecondScreenCore

// One usual instance only: a second would try to create the same virtual
// display (macOS refuses a duplicate) and add a second preview. The endpoint
// is owned through a lock (EndpointOwnership): this early look keeps a
// second copy quiet when the usual one is plainly running or starting, and
// AppController takes the lock itself before it makes a display, so two
// copies started at once still end with one owner. Side instances, which
// agents run to test a build, keep to the background on their own sockets
// and do not count.
if !ControlProtocol.isSideInstance {
    switch EndpointOwnership.inspect(socketPath: ControlProtocol.primarySocketURL.path) {
    case .active(let record), .starting(let record):
        let owner = record.map { "\($0.identity.product) (pid \($0.identity.pid))" } ?? "another process"
        FileHandle.standardError.write("2ndscreen: \(owner) owns \(ControlProtocol.primarySocketURL.path); not starting\n".data(using: .utf8)!)
        exit(0)
    case .free, .stale:
        break
    }
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
