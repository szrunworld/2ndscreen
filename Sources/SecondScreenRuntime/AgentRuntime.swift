import AppKit
import SecondScreenCore

/// Everything an app needs to give agents screens of their own: the agent
/// screens, input into the apps on them, the agent cursor drawn over them,
/// and the Unix socket the `2ndscreen` command reaches all of it on.
///
/// The 2ndscreen menu bar app is one host; an app that embeds 2ndscreen as
/// its agent runtime is another. A host adds its own screens through
/// `hostScreens` and answers the commands the runtime leaves to it (phones,
/// its own screens) through `fallback`.
@MainActor
public final class AgentRuntime {
    public let screens: AgentScreens
    public let input = InputEngine()

    /// Screens the host owns besides the agent screens, such as the user's
    /// own second screen; agents see them in `screen list` and can place
    /// windows on them, but cannot destroy or resize them.
    public var hostScreens: @MainActor () -> [ScreenInfo] = { [] }
    /// Commands the runtime does not handle itself.
    public var fallback: @MainActor (ControlRequest) async -> ControlResponse = { request in
        .failure("\(request.command.rawValue) is not available here")
    }
    /// A display left out when a new screen takes the main display's size:
    /// the host's own virtual display, which is never the one to match.
    public var excludedFromDefaultSize: @MainActor () -> CGDirectDisplayID? = { nil }
    /// Called after an agent screen is created or removed.
    public var onScreensChanged: (() -> Void)?
    /// When an agent last sent a request.
    public private(set) var lastRequest = Date()

    private var server: ControlServer?
    /// One agent cursor overlay per agent screen, keyed by display ID.
    private var overlays: [CGDirectDisplayID: AgentCursorOverlay] = [:]
    private var cursorObserver: NSObjectProtocol?

    public init(serialBase: UInt32 = ControlProtocol.isSideInstance ? 900 : 100) {
        screens = AgentScreens(serialBase: serialBase)
        screens.onChange = { [weak self] in self?.screensChanged() }
    }

    /// Listen for agents on `socketPath`; the `2ndscreen` command finds it
    /// through `$SECONDSCREEN_SOCKET` when it is not the usual one.
    public func start(socketPath: String = ControlProtocol.socketURL.path) throws {
        let server = ControlServer(path: socketPath) { [weak self] request in
            await self?.handle(request) ?? .failure("the agent runtime is shutting down")
        }
        try server.start()
        self.server = server
        cursorObserver = DistributedNotificationCenter.default().addObserver(
            forName: AgentCursorEvent.notificationName, object: nil, queue: .main
        ) { [weak self] notification in
            guard let event = AgentCursorEvent(userInfo: notification.userInfo) else { return }
            MainActor.assumeIsolated {
                // Each overlay draws only points on its own display.
                self?.overlays.values.forEach { $0.handle(event) }
            }
        }
    }

    /// Stop listening and destroy every agent screen.
    public func stop() {
        server?.stop()
        server = nil
        if let cursorObserver {
            DistributedNotificationCenter.default().removeObserver(cursorObserver)
            self.cursorObserver = nil
        }
        screens.destroyAll()
    }

    /// The host's screens and every agent screen, as agents see them.
    public func allScreens() -> [ScreenInfo] {
        hostScreens() + screens.screens.map(screens.info)
    }

    public func handle(_ request: ControlRequest) async -> ControlResponse {
        lastRequest = Date()
        func target() -> ScreenInfo? {
            guard let name = request.screen else { return nil }
            return allScreens().first { $0.name == name }
        }
        func hostOwned(_ name: String) -> Bool { hostScreens().contains { $0.name == name } }
        let missingScreen = ControlResponse.failure(
            request.screen.map { "no screen named \"\($0)\"" } ?? "give a screen with --screen")
        if let name = request.screen {
            screens.touch(name)
        }

        switch request.command {
        case .screenCreate:
            // By default, match the main display's full-screen area, so a
            // full-screen preview of the new screen is pixel for pixel.
            let main = DisplayMatch.connected(excluding: excludedFromDefaultSize()).first
            return await screens.create(
                name: request.screen,
                width: request.width ?? main?.mode.width ?? 1440,
                height: request.height ?? main?.mode.height ?? 900,
                hiDPI: request.hiDPI, defaultHiDPI: main?.hiDPI ?? false,
                ttl: request.ttl, idleTimeout: request.idleTimeout, ownerPID: request.ownerPID)
        case .screenList:
            var response = ControlResponse()
            response.screens = allScreens()
            return response
        case .screenDestroy:
            guard let name = request.screen else { return missingScreen }
            if hostOwned(name) {
                return .failure("\"\(name)\" is the host's own screen, not an agent screen")
            }
            return screens.destroy(name: name)
        case .screenResize:
            guard let name = request.screen else { return missingScreen }
            guard let width = request.width, let height = request.height else {
                return .failure("give the new size with --size WIDTHxHEIGHT")
            }
            if hostOwned(name) {
                return .failure("\"\(name)\" is the host's own screen, not an agent screen")
            }
            return await screens.resize(name: name, width: width, height: height)
        case .appLaunch:
            guard let screen = target() else { return missingScreen }
            return await screens.launch(
                on: screen, bundleID: request.bundleID, path: request.path,
                newInstance: request.newInstance ?? false, fill: request.fill ?? false,
                fitScreen: request.fitScreen ?? false)
        case .windowMove:
            guard let screen = target() else { return missingScreen }
            guard let pid = request.pid else { return .failure("give the window's app with --pid") }
            return await screens.moveWindows(to: screen, pid: pid, windowID: request.windowID,
                                             fill: request.fill ?? false, fitScreen: request.fitScreen ?? false)
        case .windowRelease:
            guard let screen = target() else { return missingScreen }
            guard screen.kind == .agent else {
                return .failure("window release works on agent screens; \"\(screen.name)\" is the host's own")
            }
            guard let pid = request.pid else { return .failure("give the window's app with --pid") }
            return await screens.releaseWindows(from: screen, pid: pid, windowID: request.windowID)
        case .screenshot:
            guard let screen = target() else { return missingScreen }
            guard let output = request.output else { return .failure("give a PNG path with --output") }
            if request.windowsOnly == true {
                return await screens.windowsScreenshot(of: screen, to: output)
            }
            return await screens.screenshot(displayID: screen.displayID, to: output)
        case .windowState, .input:
            guard let screen = target() else { return missingScreen }
            guard let pid = request.pid else { return .failure("give the app with --pid PID") }
            // Input sleeps between events; keep the main actor, which draws
            // the agent cursor, free while it runs.
            let input = input
            return await Task.detached {
                do {
                    let window = try InputEngine.window(pid: pid, windowID: request.windowID, on: screen)
                    var response: ControlResponse
                    if request.command == .windowState {
                        response = try input.state(window, query: request.query)
                    } else {
                        guard let action = request.input else { return .failure("input needs an action") }
                        response = try input.perform(action, in: window, on: screen)
                    }
                    response.windowOnScreen = WindowContainment.contains(CGRect(screen.frame), window.frame)
                    return response
                } catch {
                    return .failure(error.localizedDescription)
                }
            }.value
        default:
            return await fallback(request)
        }
    }

    /// Keep one agent cursor overlay per agent screen that exists.
    private func screensChanged() {
        let live = Set(screens.screens.map(\.display.displayID))
        for id in overlays.keys where !live.contains(id) {
            overlays.removeValue(forKey: id)?.close()
        }
        // The overlay needs the display's NSScreen, which appears a moment
        // after creation.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self else { return }
            for screen in self.screens.screens where self.overlays[screen.display.displayID] == nil {
                self.overlays[screen.display.displayID] = AgentCursorOverlay(displayID: screen.display.displayID)
            }
        }
        onScreensChanged?()
    }
}
