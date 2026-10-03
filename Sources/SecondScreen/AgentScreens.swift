import AppKit
import ScreenCaptureKit
import SecondScreenCore
import UniformTypeIdentifiers

/// Virtual displays created on demand for agents, plus the operations an
/// agent needs on them: launching an app there, moving windows there, and
/// capturing what it shows.
@MainActor
final class AgentScreens {
    final class Screen {
        let name: String
        let display: VirtualDisplay
        let serialNumber: UInt32
        let deadline: Date?
        let idleTimeout: TimeInterval?
        let ownerPID: pid_t?
        var lastUsed = Date()

        init(name: String, display: VirtualDisplay, serialNumber: UInt32,
             deadline: Date?, idleTimeout: TimeInterval?, ownerPID: pid_t?) {
            self.name = name
            self.display = display
            self.serialNumber = serialNumber
            self.deadline = deadline
            self.idleTimeout = idleTimeout
            self.ownerPID = ownerPID
        }
    }

    /// Agents forget to clean up. Unless told otherwise, a screen nobody has
    /// named in a request for this long is destroyed.
    static let defaultIdleTimeout: TimeInterval = 60 * 60

    /// Each display costs WindowServer memory and compositing time; this keeps
    /// a runaway agent from exhausting either.
    static let limit = 8
    /// Serials below this belong to the app's own display (1) and the
    /// vdisplay CLI (2). macOS remembers each serial's arrangement.
    private static let firstSerial: UInt32 = 100
    /// Serials to try before giving up on a unit number of its own.
    private static let serialAttempts = 8

    private(set) var screens: [Screen] = []
    /// Apps an agent placed on a screen. Apps open later windows wherever
    /// they like, usually on the main display, in front of the user; these
    /// get moved onto the app's screen as they appear.
    private var bindings: [pid_t: String] = [:]
    private var followTimer: Timer?
    private var reapTimer: Timer?
    /// Called after a screen is created or removed, so the app can add or
    /// drop its agent cursor overlay and preview.
    var onChange: (() -> Void)?

    func screen(named name: String) -> Screen? {
        screens.first { $0.name == name }
    }

    func info(_ screen: Screen) -> ScreenInfo {
        var info = ScreenInfo(name: screen.name, kind: .agent, displayID: screen.display.displayID,
                              width: screen.display.mode.width, height: screen.display.mode.height,
                              hiDPI: screen.display.hiDPI, frame: Frame(screen.display.bounds))
        info.expiresIn = screen.deadline.map { max(0, Int($0.timeIntervalSinceNow)) }
        info.idleTimeout = screen.idleTimeout.map { Int($0) }
        info.ownerPID = screen.ownerPID
        return info
    }

    /// Note that an agent is still using `name`, postponing its idle timeout.
    func touch(_ name: String) {
        screen(named: name)?.lastUsed = Date()
    }

    func destroyAll() {
        screens.removeAll()
        onChange?()
    }

    // MARK: Requests

    /// - Parameters:
    ///   - hiDPI: what the agent asked for, or nil to use `defaultHiDPI`
    ///     where macOS allows 2x at this size.
    func create(name requested: String?, width: Int, height: Int, hiDPI requestedHiDPI: Bool?,
                defaultHiDPI: Bool, ttl: TimeInterval?, idleTimeout: TimeInterval?, ownerPID: pid_t?) async -> ControlResponse {
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
        if let ownerPID, kill(ownerPID, 0) != 0, errno == ESRCH {
            return .failure("owner pid \(ownerPID) is not running")
        }
        if let ttl, ttl <= 0 { return .failure("--ttl must be positive") }
        let mode = VirtualDisplay.Mode(width: width, height: height)
        let hiDPIAllowed = VirtualDisplay.supportsHiDPI(mode)
        if requestedHiDPI == true, !hiDPIAllowed {
            return .failure("macOS runs a screen at HiDPI only when it is at least 800 points"
                + " on its long side and 525 on its short side; use --no-hidpi or a larger --size")
        }
        let hiDPI = requestedHiDPI ?? (defaultHiDPI && hiDPIAllowed)
        // A serial whose remembered unit number is already taken gives a
        // screen that captures as another one; try the next serial instead.
        var tried: Set<UInt32> = []
        var created: (VirtualDisplay, UInt32)?
        while created == nil, tried.count < Self.serialAttempts {
            let serial = nextSerial(excluding: tried)
            tried.insert(serial)
            guard let display = VirtualDisplay(
                name: name, mode: mode, hiDPI: hiDPI, reserving: [mode], serialNumber: serial,
                onTerminate: { [weak self] in self?.remove(named: name) })
            else {
                return .failure("macOS refused to create a \(mode)\(hiDPI ? " HiDPI" : "") display")
            }
            if !VirtualDisplay.sharesUnitNumber(display.displayID) { created = (display, serial) }
        }
        guard let (display, serial) = created else {
            return .failure("macOS gave every new display the unit number of an existing one;"
                + " destroy a screen and try again")
        }
        let idle = idleTimeout ?? Self.defaultIdleTimeout
        let screen = Screen(name: name, display: display, serialNumber: serial,
                            deadline: ttl.map { Date().addingTimeInterval($0) },
                            idleTimeout: idle > 0 ? idle : nil, ownerPID: ownerPID)
        screens.append(screen)
        startReaping()
        onChange?()
        // macOS places a new display and settles its mode a moment after
        // creating it; agents need the final frame.
        for _ in 0..<60 where display.bounds.isEmpty || !display.isSettled {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        // macOS can accept the settings yet run the display in another mode.
        // A screen of the wrong size breaks every frame an agent computes.
        guard display.isSettled else {
            let actual = CGDisplayCopyDisplayMode(display.displayID)
                .map { "\($0.width)×\($0.height)\($0.pixelWidth > $0.width ? " HiDPI" : "")" } ?? "no mode"
            remove(named: name)
            return .failure("macOS ran the screen at \(actual) instead of \(mode)\(hiDPI ? " HiDPI" : "")")
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
        bind(pid, to: target)
        var response = moved ? ControlResponse() : ControlResponse.failure("the app refused to move its window")
        response.pid = pid
        response.screen = target
        response.windows = await Self.settledSummaries(of: pid, on: target.displayID)
        return response
    }

    func moveWindows(to target: ScreenInfo, pid: pid_t, windowID: CGWindowID?, fill: Bool) async -> ControlResponse {
        guard WindowMover.isTrusted else { return .failure("2ndscreen needs the Accessibility permission to move windows") }
        let windows = WindowMover.windows(ofPID: pid).filter { windowID == nil || $0.windowID == windowID }
        guard !windows.isEmpty else { return .failure("pid \(pid) has no matching on-screen window") }
        let failed = windows.filter { !WindowMover.move($0, to: target.displayID, fill: fill) }
        bind(pid, to: target)
        var response = failed.isEmpty ? ControlResponse() : .failure("\(failed.count) window(s) refused to move")
        response.screen = target
        response.windows = await Self.settledSummaries(of: pid, on: target.displayID)
        return response
    }

    /// Move an app's windows from `source` to the main display and stop
    /// pulling its windows back onto `source`. Without this, the only way to
    /// give a window back to the user is destroying the screen.
    func releaseWindows(from source: ScreenInfo, pid: pid_t, windowID: CGWindowID?) async -> ControlResponse {
        guard WindowMover.isTrusted else { return .failure("2ndscreen needs the Accessibility permission to move windows") }
        let bounds = CGDisplayBounds(source.displayID)
        let windows = WindowMover.windows(ofPID: pid).filter {
            (windowID == nil || $0.windowID == windowID)
                && bounds.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY))
        }
        guard !windows.isEmpty else { return .failure("pid \(pid) has no matching window on screen \"\(source.name)\"") }
        // Unbind first, or the follow timer pulls the windows straight back.
        if bindings[pid] == source.name { bindings.removeValue(forKey: pid) }
        let main = CGMainDisplayID()
        let failed = windows.filter { !WindowMover.move($0, to: main) }
        var response = failed.isEmpty ? ControlResponse() : .failure("\(failed.count) window(s) refused to move")
        response.pid = pid
        let moved = Set(windows.map(\.windowID))
        response.windows = await Self.settledSummaries(of: pid, on: main).filter { moved.contains($0.windowID) }
        return response
    }

    /// Capture `display` to a PNG at its full pixel size.
    func screenshot(displayID: CGDirectDisplayID, to output: String) async -> ControlResponse {
        guard CGPreflightScreenCaptureAccess() else {
            return .failure("2ndscreen needs the Screen Recording permission to take screenshots")
        }
        guard !VirtualDisplay.sharesUnitNumber(displayID) else {
            return .failure("macOS gave this screen the same unit number as another display, so a"
                + " screenshot would show the wrong screen; destroy it and create a new one")
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
        bindings = bindings.filter { $0.value != name }
        onChange?()
    }

    // MARK: Expiry

    private func startReaping() {
        guard reapTimer == nil else { return }
        reapTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.reapExpired() }
        }
    }

    /// Destroy screens past their TTL, idle too long, or whose owner exited.
    private func reapExpired() {
        let now = Date()
        for screen in screens {
            let expired = screen.deadline.map { now >= $0 } ?? false
            let idle = screen.idleTimeout.map { now.timeIntervalSince(screen.lastUsed) >= $0 } ?? false
            let orphaned = screen.ownerPID.map { kill($0, 0) != 0 && errno == ESRCH } ?? false
            if expired || idle || orphaned {
                remove(named: screen.name)
            }
        }
        if screens.isEmpty {
            reapTimer?.invalidate()
            reapTimer = nil
        }
    }

    // MARK: Following new windows

    /// Keep `pid`'s windows on `target`. Agent screens only: the primary
    /// screen is the user's, so windows moved there stay where they are put.
    private func bind(_ pid: pid_t, to target: ScreenInfo) {
        guard target.kind == .agent else {
            bindings.removeValue(forKey: pid)
            return
        }
        bindings[pid] = target.name
        guard followTimer == nil else { return }
        followTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.followWindows() }
        }
    }

    private func followWindows() {
        for (pid, name) in bindings {
            guard NSRunningApplication(processIdentifier: pid) != nil, let screen = screen(named: name) else {
                bindings.removeValue(forKey: pid)
                continue
            }
            let bounds = screen.display.bounds
            for window in WindowMover.windows(ofPID: pid)
            where !bounds.contains(CGPoint(x: window.frame.midX, y: window.frame.midY)) {
                WindowMover.move(window, to: screen.display.displayID)
            }
        }
        if bindings.isEmpty {
            followTimer?.invalidate()
            followTimer = nil
        }
    }

    private func nextName() -> String {
        var index = 1
        while screen(named: "agent-\(index)") != nil { index += 1 }
        return "agent-\(index)"
    }

    private func nextSerial(excluding tried: Set<UInt32> = []) -> UInt32 {
        var serial = Self.firstSerial
        while tried.contains(serial) || screens.contains(where: { $0.serialNumber == serial }) { serial += 1 }
        return serial
    }

    /// The window list lags a move by a few frames. Wait until one of the
    /// app's windows shows up on `target` (at most a second), then report.
    private static func settledSummaries(of pid: pid_t, on displayID: CGDirectDisplayID) async -> [WindowSummary] {
        let bounds = CGDisplayBounds(displayID)
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
