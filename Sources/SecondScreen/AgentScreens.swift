import AppKit
import ScreenCaptureKit
import SecondScreenCore
import UniformTypeIdentifiers

/// Virtual displays created on demand for agents, plus the operations an
/// agent needs on them: launching an app there, moving windows there, and
/// capturing what it shows.
@MainActor
final class AgentScreens {
    struct Screen {
        let name: String
        let display: VirtualDisplay
        let serialNumber: UInt32
    }

    /// Each display costs WindowServer memory and compositing time; this keeps
    /// a runaway agent from exhausting either.
    static let limit = 8
    /// Serials below this belong to the app's own display (1) and the
    /// vdisplay CLI (2). macOS remembers each serial's arrangement.
    private static let firstSerial: UInt32 = 100

    private(set) var screens: [Screen] = []
    /// Called after a screen is created or removed, so the app can add or
    /// drop its agent cursor overlay and preview.
    var onChange: (() -> Void)?

    func screen(named name: String) -> Screen? {
        screens.first { $0.name == name }
    }

    func info(_ screen: Screen) -> ScreenInfo {
        ScreenInfo(name: screen.name, kind: .agent, displayID: screen.display.displayID,
                   width: screen.display.mode.width, height: screen.display.mode.height,
                   hiDPI: screen.display.hiDPI, frame: Frame(screen.display.bounds))
    }

    func destroyAll() {
        screens.removeAll()
        onChange?()
    }

    // MARK: Requests

    func create(name requested: String?, width: Int, height: Int, hiDPI: Bool) async -> ControlResponse {
        guard screens.count < Self.limit else {
            return .failure("at most \(Self.limit) agent screens can exist at once")
        }
        let name = requested ?? nextName()
        guard !name.isEmpty, screen(named: name) == nil, name != "2ndscreen" else {
            return .failure("a screen named \"\(name)\" already exists")
        }
        guard (320...6016).contains(width), (240...3384).contains(height) else {
            return .failure("size must be between 320x240 and 6016x3384 points")
        }
        let serial = nextSerial()
        let mode = VirtualDisplay.Mode(width: width, height: height)
        guard let display = VirtualDisplay(
            name: name, mode: mode, hiDPI: hiDPI, reserving: [mode], serialNumber: serial,
            onTerminate: { [weak self] in self?.remove(named: name) })
        else {
            return .failure("macOS refused to create a \(mode)\(hiDPI ? " HiDPI" : "") display")
        }
        let screen = Screen(name: name, display: display, serialNumber: serial)
        screens.append(screen)
        onChange?()
        // macOS places a new display and settles its mode a moment after
        // creating it; agents need the final frame.
        for _ in 0..<60 where display.bounds.isEmpty || !display.isSettled {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        var response = ControlResponse()
        response.screen = info(screen)
        return response
    }

    func destroy(name: String) -> ControlResponse {
        guard screen(named: name) != nil else { return .failure("no agent screen named \"\(name)\"") }
        // Releasing the display removes it; macOS moves its windows elsewhere.
        remove(named: name)
        return ControlResponse()
    }

    /// Launch an app without activating it, wait for its first window, and
    /// move that window onto `target`, any screen the app knows.
    func launch(on target: ScreenInfo, bundleID: String?, path: String?, newInstance: Bool,
                fill: Bool) async -> ControlResponse {
        guard WindowMover.isTrusted else { return .failure("2ndscreen needs the Accessibility permission to place windows") }

        let url: URL
        if let path {
            url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
            guard FileManager.default.fileExists(atPath: url.path) else { return .failure("no app at \(url.path)") }
        } else if let bundleID, let found = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            url = found
        } else {
            return .failure("give a bundle ID of an installed app or a path to an .app")
        }

        // Moving the windows of an app the user already has open would
        // rearrange their work; require an explicit second instance.
        if !newInstance, let id = Bundle(url: url)?.bundleIdentifier,
           !NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty {
            return .failure("\(id) is already running; pass --new-instance, or use window move")
        }

        let previousFront = NSWorkspace.shared.frontmostApplication
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.createsNewApplicationInstance = newInstance
        let launched: Result<pid_t, Error> = await withCheckedContinuation { continuation in
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
                if let app {
                    continuation.resume(returning: .success(app.processIdentifier))
                } else {
                    continuation.resume(returning: .failure(error ?? CocoaError(.executableLoad)))
                }
            }
        }
        let pid: pid_t
        switch launched {
        case .success(let launchedPID): pid = launchedPID
        case .failure(let error): return .failure("launch failed: \(error.localizedDescription)")
        }

        // Many apps activate themselves once launched despite `activates`;
        // hand the foreground straight back to whoever had it.
        Self.restoreFront(previousFront, against: pid, for: 5)

        guard let window = await Self.firstWindow(of: pid, timeout: 15) else {
            var response = ControlResponse.failure("the app launched but showed no window within 15 seconds")
            response.pid = pid
            return response
        }
        let moved = WindowMover.move(window, to: target.displayID, fill: fill)
        var response = moved ? ControlResponse() : ControlResponse.failure("the app refused to move its window")
        response.pid = pid
        response.screen = target
        response.windows = await Self.settledSummaries(of: pid, on: target)
        return response
    }

    func moveWindows(to target: ScreenInfo, pid: pid_t, windowID: CGWindowID?, fill: Bool) async -> ControlResponse {
        guard WindowMover.isTrusted else { return .failure("2ndscreen needs the Accessibility permission to move windows") }
        let windows = WindowMover.windows(ofPID: pid).filter { windowID == nil || $0.windowID == windowID }
        guard !windows.isEmpty else { return .failure("pid \(pid) has no matching on-screen window") }
        let failed = windows.filter { !WindowMover.move($0, to: target.displayID, fill: fill) }
        var response = failed.isEmpty ? ControlResponse() : .failure("\(failed.count) window(s) refused to move")
        response.screen = target
        response.windows = await Self.settledSummaries(of: pid, on: target)
        return response
    }

    /// Capture `display` to a PNG at its full pixel size.
    func screenshot(displayID: CGDirectDisplayID, to output: String) async -> ControlResponse {
        guard CGPreflightScreenCaptureAccess() else {
            return .failure("2ndscreen needs the Screen Recording permission to take screenshots")
        }
        let url = URL(fileURLWithPath: (output as NSString).expandingTildeInPath)
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
                return .failure("display \(displayID) is not capturable")
            }
            let config = SCStreamConfiguration()
            let mode = CGDisplayCopyDisplayMode(displayID)
            config.width = mode?.pixelWidth ?? display.width
            config.height = mode?.pixelHeight ?? display.height
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config)
            guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
            else { return .failure("cannot write \(url.path)") }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { return .failure("cannot write \(url.path)") }
        } catch {
            return .failure("screenshot failed: \(error.localizedDescription)")
        }
        var response = ControlResponse()
        response.output = url.path
        return response
    }

    // MARK: Helpers

    private func remove(named name: String) {
        guard screens.contains(where: { $0.name == name }) else { return }
        screens.removeAll { $0.name == name }
        onChange?()
    }

    private func nextName() -> String {
        var index = 1
        while screen(named: "agent-\(index)") != nil { index += 1 }
        return "agent-\(index)"
    }

    private func nextSerial() -> UInt32 {
        var serial = Self.firstSerial
        while screens.contains(where: { $0.serialNumber == serial }) { serial += 1 }
        return serial
    }

    /// The window list lags a move by a few frames. Wait until one of the
    /// app's windows shows up on `target` (at most a second), then report.
    private static func settledSummaries(of pid: pid_t, on target: ScreenInfo) async -> [WindowSummary] {
        let bounds = CGDisplayBounds(target.displayID)
        for _ in 0..<10 {
            let windows = WindowMover.windows(ofPID: pid)
            if windows.contains(where: { bounds.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }) {
                return windows.map { WindowSummary($0) }
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return WindowMover.windows(ofPID: pid).map { WindowSummary($0) }
    }

    private static func firstWindow(of pid: pid_t, timeout: TimeInterval) async -> WindowInfo? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let window = WindowMover.windows(ofPID: pid).first { return window }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        return nil
    }

    /// Re-activate `previous` whenever `pid` takes the foreground during
    /// the next `seconds`.
    private static func restoreFront(_ previous: NSRunningApplication?, against pid: pid_t, for seconds: TimeInterval) {
        guard let previous, previous.processIdentifier != pid else { return }
        let center = NSWorkspace.shared.notificationCenter
        let token = center.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            if app?.processIdentifier == pid {
                previous.activate()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            center.removeObserver(token)
        }
        // It may already have activated before the observer was installed.
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
            previous.activate()
        }
    }
}
