import AppKit
import Carbon.HIToolbox
import SecondScreenCore
import SecondScreenRuntime

/// Persisted user choices. The app restores them on launch.
struct Preferences {
    private let defaults = UserDefaults.standard

    var enabled: Bool {
        get { defaults.object(forKey: "enabled") as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: "enabled") }
    }

    /// False until the user (or the first-launch default) picks a mode.
    var hasMode: Bool { defaults.data(forKey: "mode") != nil }

    var mode: VirtualDisplay.Mode {
        get {
            guard let data = defaults.data(forKey: "mode"),
                  let mode = try? JSONDecoder().decode(VirtualDisplay.Mode.self, from: data)
            else { return VirtualDisplay.Mode(width: 1920, height: 1080) }
            return mode
        }
        nonmutating set { defaults.set(try? JSONEncoder().encode(newValue), forKey: "mode") }
    }

    var hiDPI: Bool {
        get { defaults.bool(forKey: "hiDPI") }
        nonmutating set { defaults.set(newValue, forKey: "hiDPI") }
    }

    var showPreview: Bool {
        get { defaults.bool(forKey: "showPreview") }
        nonmutating set { defaults.set(newValue, forKey: "showPreview") }
    }

    /// Where Android phones were last connected, most recent first.
    var androidAddresses: [String] {
        get { defaults.stringArray(forKey: "androidAddresses") ?? [] }
        nonmutating set { defaults.set(newValue, forKey: "androidAddresses") }
    }

    var floatPreview: Bool {
        get { defaults.object(forKey: "floatPreview") as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: "floatPreview") }
    }
}

/// Owns the status item, the virtual display, and its optional preview.
@MainActor
final class AppController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private static let displayName = "2ndscreen"

    private let preferences = Preferences()
    private var statusItem: NSStatusItem!
    private var display: VirtualDisplay?
    private var preview: DisplayPreview?
    /// The agent cursor overlay on the primary screen, keyed by display ID;
    /// the runtime draws the ones on agent screens.
    private var cursorOverlays: [CGDirectDisplayID: AgentCursorOverlay] = [:]
    private var moveHotKey: HotKey?
    /// Agent screens, input into them, and the socket agents reach them on.
    private let runtime = AgentRuntime()
    private var agentScreens: AgentScreens { runtime.screens }
    /// Live previews of agent screens, keyed by screen name.
    private var agentPreviews: [String: DisplayPreview] = [:]
    /// Open Android mirror windows, keyed by adb serial.
    private var androidMirrors: [String: AndroidMirrorWindow] = [:]
    /// Control-only sessions, for agents typing on phones whose mirror is
    /// not open, keyed by serial.
    private var androidControls: [String: AndroidMirror] = [:]
    /// Serials whose mirror is starting, so a second request waits its turn.
    private var androidStarting: Set<String> = []
    private var androidPairing: AndroidPairingWindow?
    /// Filled when opened, so adb only runs for people who look at it.
    private lazy var androidMenu: NSMenu = {
        let menu = NSMenu()
        menu.delegate = self
        return menu
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if ControlProtocol.isSideInstance {
            // Kept off the menu bar, where the usual app lists it under
            // Test Copies; it quits once its agent has left it idle.
            quitWhenIdle()
        } else {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            statusItem.button?.image = NSImage(
                systemSymbolName: "display.2", accessibilityDescription: Self.displayName)
            let menu = NSMenu()
            menu.delegate = self
            statusItem.menu = menu
        }

        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(agentCursorEvent(_:)),
            name: AgentCursorEvent.notificationName, object: nil,
            suspensionBehavior: .deliverImmediately)

        if !ControlProtocol.isSideInstance {
            moveHotKey = HotKey(keyCode: kVK_ANSI_M, modifiers: controlKey | optionKey | cmdKey) { [weak self] in
                self?.moveFrontWindowToOtherScreen()
            }
        }

        // Default to the main display's size and scale: the full-screen
        // preview then fills it exactly, and windows keep their size when
        // they move between the two.
        if !preferences.hasMode, let main = DisplayMatch.connected(excluding: nil).first {
            preferences.mode = main.mode
            preferences.hiDPI = main.hiDPI
        }

        runtime.hostScreens = { [weak self] in self?.primaryScreenInfo().map { [$0] } ?? [] }
        runtime.excludedFromDefaultSize = { [weak self] in self?.display?.displayID }
        runtime.fallback = { [weak self] request in
            await self?.handleAppCommand(request) ?? .failure("2ndscreen is shutting down")
        }
        runtime.onScreensChanged = { [weak self] in self?.agentScreensChanged() }
        agentScreens.onResize = { [weak self] name in
            guard let preview = self?.agentPreviews[name] else { return }
            Task { @MainActor in try? await preview.restartStream() }
        }
        runtime.identity = HostIdentity.current(capabilities: HostIdentity.defaultCapabilities + ["android"])
        // The endpoint is taken before any display is made: a second copy
        // started at the same time finds it held and leaves without a trace.
        do {
            try runtime.start()
        } catch let error as EndpointError {
            FileHandle.standardError.write("2ndscreen: not starting: \(error.localizedDescription)\n".data(using: .utf8)!)
            exit(0)
        } catch {
            // Without its endpoint the app is of no use to agents or to the
            // menu that lists their screens: say so and leave, making no display.
            presentError("2ndscreen cannot start its control socket: \(error.localizedDescription)")
            exit(1)
        }

        if preferences.enabled, !ControlProtocol.isSideInstance {
            enableDisplay()
        }

        let known = preferences.androidAddresses
        DispatchQueue.global().async {
            ADB.restartStaleServer()
            Self.reconnect(known, keeping: [])
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        runtime.stop()
        // Stops each mirror's server on its phone.
        for window in androidMirrors.values {
            window.close()
        }
        for control in androidControls.values {
            control.stop()
        }
    }

    // MARK: Display lifecycle

    private func enableDisplay() {
        guard display == nil else { return }
        display = VirtualDisplay(
            name: Self.displayName,
            mode: preferences.mode,
            hiDPI: preferences.hiDPI,
            reserving: DisplayMatch.connected(excluding: nil).map(\.mode),
            onTerminate: { [weak self] in
                // Our own disable clears `display` first; anything else means
                // macOS removed the display behind our back.
                guard let self, self.display != nil else { return }
                self.stopPreview()
                self.removeCursorOverlay(for: self.display?.displayID)
                self.display = nil
            })
        guard let display else {
            presentError("macOS refused to create the virtual display.")
            return
        }
        // The overlay needs the display's NSScreen, which appears a moment
        // after creation.
        let displayID = display.displayID
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.display?.displayID == displayID else { return }
            self.cursorOverlays[displayID] = AgentCursorOverlay(displayID: displayID)
        }
        if preferences.showPreview {
            // Give WindowServer a moment to place the new display.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.startPreview()
            }
        }
    }

    private func disableDisplay() {
        stopPreview()
        removeCursorOverlay(for: display?.displayID)
        display = nil
    }

    private func removeCursorOverlay(for displayID: CGDirectDisplayID?) {
        guard let displayID else { return }
        cursorOverlays.removeValue(forKey: displayID)?.close()
    }

    /// Each overlay draws only points on its own display, so every event can
    /// go to all of them.
    @objc private func agentCursorEvent(_ notification: Notification) {
        guard let event = AgentCursorEvent(userInfo: notification.userInfo) else { return }
        for overlay in cursorOverlays.values {
            overlay.handle(event)
        }
    }

    // MARK: Agent screens

    /// Keep previews in step with the agent screens that exist; the runtime
    /// keeps their cursor overlays.
    private func agentScreensChanged() {
        let names = Set(agentScreens.screens.map(\.name))
        for (name, preview) in agentPreviews where !names.contains(name) {
            preview.stop()
            agentPreviews.removeValue(forKey: name)
        }
    }

    /// The primary screen as agents see it, while it is on.
    private func primaryScreenInfo() -> ScreenInfo? {
        guard let display else { return nil }
        return ScreenInfo(
            name: Self.displayName, kind: .primary, displayID: display.displayID,
            width: display.mode.width, height: display.mode.height, hiDPI: display.hiDPI,
            frame: Frame(display.bounds))
    }

    /// The primary screen and every agent screen, as agents see them.
    private func allScreens() -> [ScreenInfo] { runtime.allScreens() }

    /// Commands the runtime leaves to the app: phones.
    private func handleAppCommand(_ request: ControlRequest) async -> ControlResponse {
        func target() -> ScreenInfo? {
            guard let name = request.screen else { return nil }
            return allScreens().first { $0.name == name }
        }
        let missingScreen = ControlResponse.failure(
            request.screen.map { "no screen named \"\($0)\"" } ?? "give a screen with --screen")

        switch request.command {
        case .androidList:
            return await androidList()
        case .androidShow:
            if request.screen != nil, target() == nil { return missingScreen }
            // Agents never pull the user away from their work.
            return await showAndroid(serial: request.serial, on: target()?.displayID,
                                     maxSize: request.maxSize ?? Self.androidMaxSize, presentation: .background)
        case .androidHide:
            let serials = request.serial.map { [$0] } ?? Array(androidMirrors.keys)
            for serial in serials {
                androidMirrors[serial]?.close()
            }
            return await androidList()
        case .androidScreenshot, .androidTap, .androidSwipe, .androidType, .androidKey:
            return await androidAction(request)
        default:
            return .failure("\(request.command.rawValue) is not a 2ndscreen command")
        }
    }

    // MARK: Test copies

    /// A side instance quits after this long without requests, unless it
    /// still has an agent screen or a phone's mirror open.
    private static let sideInstanceIdleQuit: TimeInterval = 30 * 60

    private func quitWhenIdle() {
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, Date().timeIntervalSince(self.runtime.lastRequest) > Self.sideInstanceIdleQuit,
                      self.agentScreens.screens.isEmpty, self.androidMirrors.isEmpty else { return }
                NSApp.terminate(nil)
            }
        }
    }

    /// Side instances agents run to test builds of 2ndscreen, which keep off
    /// the menu bar; each can be quit from here.
    private func testCopiesItem() -> NSMenuItem? {
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let copies = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != ownPID }
        guard !copies.isEmpty else { return nil }
        let parent = NSMenuItem(title: "Test Copies (\(copies.count))", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        let note = NSMenuItem(title: "Run by agents to test their builds", action: nil, keyEquivalent: "")
        note.isEnabled = false
        submenu.addItem(note)
        for copy in copies {
            var title = "Quit " + Self.copyName(copy.bundleURL)
            if let launched = copy.launchDate {
                title += " (since \(launched.formatted(date: .omitted, time: .shortened)))"
            }
            let entry = item(title, #selector(quitTestCopy(_:)), on: false)
            entry.representedObject = copy.processIdentifier
            entry.toolTip = copy.bundleURL?.path
            submenu.addItem(entry)
        }
        parent.submenu = submenu
        return parent
    }

    /// "2ndscreen-uitars" for …/2ndscreen-uitars/build/2ndscreen.app, the
    /// folder it was built in; otherwise its folder and name.
    static func copyName(_ url: URL?) -> String {
        guard let url else { return "unknown" }
        let folder = url.deletingLastPathComponent()
        if folder.lastPathComponent == "build" {
            return folder.deletingLastPathComponent().lastPathComponent
        }
        return folder.lastPathComponent + "/" + url.deletingPathExtension().lastPathComponent
    }

    @objc private func quitTestCopy(_ sender: NSMenuItem) {
        guard let pid = sender.representedObject as? pid_t else { return }
        NSRunningApplication(processIdentifier: pid)?.terminate()
    }

    // MARK: Android

    private func addAndroidItems(to menu: NSMenu) {
        do {
            let devices = try ADB.devices()
            remember(devices)
            // Bring back remembered phones for the next look at the menu.
            let known = preferences.androidAddresses
            if known.contains(where: { address in !devices.contains { $0.serial == address } }) {
                let inUse = Set(androidMirrors.keys).union(androidControls.keys)
                DispatchQueue.global().async { Self.reconnect(known, keeping: inUse) }
            }
            if devices.isEmpty {
                let none = NSMenuItem(title: "No Phone Connected", action: nil, keyEquivalent: "")
                none.isEnabled = false
                menu.addItem(none)
            }
            for device in devices {
                let usable = device.state == "device"
                let title = usable ? "Show \(device.label)" : "\(device.label) (\(device.state))"
                let entry = item(title, #selector(showAndroidMirror(_:)), on: androidMirrors[device.serial] != nil)
                entry.representedObject = device.serial
                entry.toolTip = device.serial
                entry.isEnabled = usable
                menu.addItem(entry)
                if androidMirrors[device.serial] != nil {
                    let stop = item("Stop Mirroring \(device.label)", #selector(stopAndroidMirror(_:)), on: false)
                    stop.representedObject = device.serial
                    stop.indentationLevel = 1
                    menu.addItem(stop)
                }
            }
        } catch {
            let failed = NSMenuItem(title: error.localizedDescription, action: nil, keyEquivalent: "")
            failed.isEnabled = false
            menu.addItem(failed)
        }
        menu.addItem(.separator())
        menu.addItem(item("Connect Phone…", #selector(showAndroidPairing), on: false))
        menu.addItem(soundDelayItem())
    }

    /// How long the phone's sound is held back to match its picture; see
    /// `AndroidAudioPlayer.extraDelay`.
    private func soundDelayItem() -> NSMenuItem {
        let current = AndroidAudioPlayer.extraDelay
        func label(_ seconds: Double) -> String {
            seconds == 0 ? "None" : "\(seconds.formatted(.number.precision(.fractionLength(0...2)))) s"
        }
        let parent = NSMenuItem(title: "Sound Delay: \(label(current))", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        var choices: [Double] = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3]
        if !choices.contains(current) {
            choices.append(current)
            choices.sort()
        }
        for seconds in choices {
            var title = label(seconds)
            if seconds == 1 { title += " (default)" }
            if ![0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3].contains(seconds) { title += " (custom)" }
            let entry = item(title, #selector(setSoundDelay(_:)), on: seconds == current)
            entry.representedObject = seconds
            submenu.addItem(entry)
        }
        parent.submenu = submenu
        parent.toolTip = "Holds the phone's sound back to line it up with the picture. Takes effect at once."
        return parent
    }

    @objc private func setSoundDelay(_ sender: NSMenuItem) {
        guard let seconds = sender.representedObject as? Double else { return }
        AndroidAudioPlayer.extraDelay = seconds
    }

    /// Full screen on its own Space, opened or brought forward.
    @objc private func showAndroidMirror(_ sender: NSMenuItem) {
        guard let serial = sender.representedObject as? String else { return }
        Task { @MainActor in
            let response = await showAndroid(serial: serial, on: nil, maxSize: Self.androidMaxSize,
                                             presentation: .fullScreen)
            if let error = response.error { presentError(error) }
        }
    }

    @objc private func stopAndroidMirror(_ sender: NSMenuItem) {
        guard let serial = sender.representedObject as? String else { return }
        androidMirrors[serial]?.close()
    }

    @objc private func showAndroidPairing() {
        if let androidPairing {
            androidPairing.show()
            return
        }
        let pairing = AndroidPairingWindow()
        pairing.onClose = { [weak self] in self?.androidPairing = nil }
        pairing.onConnected = { [weak self] serial in
            Task { @MainActor in
                guard let self else { return }
                let response = await self.showAndroid(serial: serial, on: nil, maxSize: Self.androidMaxSize,
                                                      presentation: .fullScreen)
                if let error = response.error { self.presentError(error) }
            }
        }
        androidPairing = pairing
        pairing.show()
    }

    /// The longest side of the mirrored video. Full size can be 3200 pixels,
    /// more than Wi-Fi carries smoothly and more than a window shows.
    private static let androidMaxSize = 1920

    struct AndroidFailure: Error {
        let response: ControlResponse
        init(_ message: String) { response = .failure(message) }
    }

    /// The requested device, or the only usable one when none is named.
    private static func choose(serial: String?, from devices: [ADB.Device]) -> Result<String, AndroidFailure> {
        let usable = devices.filter { $0.state == "device" }
        guard !usable.isEmpty else {
            return .failure(AndroidFailure(
                "no Android device is connected; pair one with `2ndscreen android pair` or from the menu"))
        }
        guard let serial = serial ?? (usable.count == 1 ? usable[0].serial : nil) else {
            return .failure(AndroidFailure("several Android devices are connected; choose one with --serial"))
        }
        guard usable.contains(where: { $0.serial == serial }) else {
            return .failure(AndroidFailure("no connected device \"\(serial)\"; see `2ndscreen android devices`"))
        }
        return .success(serial)
    }

    /// Look at or act on a phone. With its mirror open, input goes through
    /// the mirror: at once, and with any text. Without it, through adb.
    /// Points are device pixels, as in the screenshot.
    private func androidAction(_ request: ControlRequest) async -> ControlResponse {
        let devices: [ADB.Device]
        do {
            devices = try await Task.detached { try ADB.devices() }.value
        } catch {
            return .failure(error.localizedDescription)
        }
        let serial: String
        let requested = request.serial
        let resolved = await Task.detached { requested.map(ADB.resolve) }.value
        switch Self.choose(serial: resolved, from: devices) {
        case .success(let chosen): serial = chosen
        case .failure(let failure): return failure.response
        }
        // The mirror keeps the serial it was opened with.
        let opened = androidMirrors.first { $0.key == serial || $0.key == requested }
        let mirror = opened?.value.mirror
        func adb(_ arguments: [String]) async -> ControlResponse {
            do {
                let result = try await Task.detached { try ADB.run(["-s", serial] + arguments) }.value
                return result.ok ? ControlResponse() : .failure(result.message)
            } catch {
                return .failure(error.localizedDescription)
            }
        }
        func point(_ x: Double?, _ y: Double?) -> CGPoint? {
            guard let x, let y else { return nil }
            return CGPoint(x: x, y: y)
        }

        switch request.command {
        case .androidScreenshot:
            guard let output = request.output else { return .failure("give a PNG path with --output") }
            do {
                let result = try await Task.detached { try ADB.screenshot(serial: serial, to: output) }.value
                guard result.ok else { return .failure("screenshot failed: \(result.message)") }
            } catch {
                return .failure(error.localizedDescription)
            }
            var response = ControlResponse()
            response.output = output
            return response
        case .androidTap:
            guard let target = point(request.x, request.y) else { return .failure("give the point with --x and --y") }
            if let mirror, let video = mirror.videoPoint(fromDevice: target) {
                mirror.touch(.down, at: video)
                mirror.touch(.up, at: video)
                await mirror.flush()
                return ControlResponse()
            }
            return await adb(["shell", "input", "tap", "\(Int(target.x))", "\(Int(target.y))"])
        case .androidSwipe:
            guard let start = point(request.x, request.y), let end = point(request.toX, request.toY) else {
                return .failure("give --x --y and --to-x --to-y")
            }
            let duration = request.duration ?? 0.3
            if let mirror, let from = mirror.videoPoint(fromDevice: start), let to = mirror.videoPoint(fromDevice: end) {
                await mirror.swipe(from: from, to: to, duration: duration)
                return ControlResponse()
            }
            return await adb(["shell", "input", "swipe", "\(Int(start.x))", "\(Int(start.y))",
                              "\(Int(end.x))", "\(Int(end.y))", "\(Int(duration * 1000))"])
        case .androidType:
            guard let text = request.text, !text.isEmpty else { return .failure("give the text with --text") }
            // Pasted, not keyed in: a Chinese keyboard on the phone would
            // take typed letters as pinyin, and adb types only ASCII.
            let session: AndroidMirror
            do {
                session = try await controlSession(serial: serial)
            } catch {
                return .failure(error.localizedDescription)
            }
            session.paste(text)
            await session.flush()
            return ControlResponse()
        case .androidKey:
            guard let name = request.key, let code = AndroidKey.code(named: name) else {
                return .failure("give a key such as back, home, recents, enter or delete, or a keycode")
            }
            if let mirror {
                mirror.press(code)
                await mirror.flush()
                return ControlResponse()
            }
            return await adb(["shell", "input", "keyevent", "\(code)"])
        default:
            return .failure("not an Android action")
        }
    }

    /// The open mirror's session, or a control-only one started for agents.
    private func controlSession(serial: String) async throws -> AndroidMirror {
        if let mirror = androidMirrors[serial]?.mirror { return mirror }
        if let control = androidControls[serial] { return control }
        let control = AndroidMirror(serial: serial)
        try await Task.detached { try control.start(maxSize: 0, video: false) }.value
        control.onEnd = { [weak self, weak control] _ in
            if self?.androidControls[serial] === control { self?.androidControls.removeValue(forKey: serial) }
        }
        control.startStreaming()
        androidControls[serial] = control
        return control
    }

    /// Remember where connected phones are, so they come back after adb
    /// restarts on networks that block the mDNS adb would find them by.
    private func remember(_ devices: [ADB.Device]) {
        let named = devices.contains { !$0.serial.contains(":") || $0.serial.hasSuffix("._tcp") }
        Task.detached { [weak self] in
            var addresses = devices.map(\.serial).filter { $0.range(of: #"^\d+\.\d+\.\d+\.\d+:\d+$"#, options: .regularExpression) != nil }
            if named {
                let services = (try? ADB.services()) ?? []
                addresses += services.filter { service in
                    service.type.contains("connect") && devices.contains { $0.serial.hasPrefix(service.name + ".") }
                }.map(\.address)
            }
            guard !addresses.isEmpty else { return }
            let found = addresses
            await MainActor.run { [weak self] in
                guard let self else { return }
                let kept = self.preferences.androidAddresses.filter { old in
                    // A phone gets a new port when wireless debugging restarts.
                    !found.contains { $0.split(separator: ":").first == old.split(separator: ":").first }
                }
                self.preferences.androidAddresses = Array((found + kept).prefix(8))
            }
        }
    }

    /// Connect to remembered addresses adb is not connected to. Quietly:
    /// a phone that is away just fails.
    nonisolated private static func reconnect(_ addresses: [String], keeping inUse: Set<String>) {
        guard !addresses.isEmpty, let devices = try? ADB.devices() else { return }
        for address in addresses where !devices.contains(where: { $0.serial == address }) {
            _ = try? ADB.run(["connect", address], timeout: 5)
        }
        // A failed connect leaves an offline entry.
        for device in (try? ADB.devices()) ?? [] where device.state == "offline" && addresses.contains(device.serial) {
            _ = try? ADB.run(["disconnect", device.serial], timeout: 5)
        }
        ADB.disconnectDuplicates(keeping: inUse)
    }

    private func androidList() async -> ControlResponse {
        let devices: [ADB.Device]
        do {
            devices = try await Task.detached { try ADB.devices() }.value
        } catch {
            return .failure(error.localizedDescription)
        }
        remember(devices)
        var response = ControlResponse()
        response.android = devices.map { device in
            var info = AndroidDeviceInfo(serial: device.serial, state: device.state, model: device.model,
                                         mirroring: androidMirrors[device.serial] != nil)
            if let window = androidMirrors[device.serial] {
                info.frame = Frame(window.frameOnScreen)
                info.width = Int(window.mirror.videoSize.width)
                info.height = Int(window.mirror.videoSize.height)
            }
            return info
        }
        return response
    }

    /// Open a mirror window for a device, or bring its window forward. With
    /// a display, the window fills it, such as an agent screen.
    private func showAndroid(serial requested: String?, on displayID: CGDirectDisplayID?, maxSize: Int,
                             presentation: AndroidMirrorWindow.Presentation) async -> ControlResponse {
        let devices: [ADB.Device]
        do {
            devices = try await Task.detached { try ADB.devices() }.value
        } catch {
            return .failure(error.localizedDescription)
        }
        let serial: String
        let resolved = await Task.detached { requested.map(ADB.resolve) }.value
        switch Self.choose(serial: resolved, from: devices) {
        case .success(let chosen): serial = chosen
        case .failure(let failure): return failure.response
        }
        if let existing = androidMirrors[serial] {
            if let displayID { existing.place(on: displayID) }
            existing.show(presentation)
        } else {
            guard androidStarting.insert(serial).inserted else {
                return .failure("the mirror of \"\(serial)\" is already starting")
            }
            defer { androidStarting.remove(serial) }
            let mirror = AndroidMirror(serial: serial)
            do {
                try await Task.detached { try mirror.start(maxSize: maxSize) }.value
            } catch {
                return .failure(error.localizedDescription)
            }
            // The mirror's own session takes over typing from a control-only one.
            androidControls.removeValue(forKey: serial)?.stop()
            let window = AndroidMirrorWindow(mirror: mirror)
            window.onClose = { [weak self] in self?.androidMirrors.removeValue(forKey: serial) }
            androidMirrors[serial] = window
            if let displayID { window.place(on: displayID) }
            window.show(presentation)
            // The window takes the video's shape once the first frame size arrives.
            try? await Task.sleep(for: .milliseconds(500))
        }
        return await androidList()
    }

    private func toggleAgentPreview(_ name: String) {
        if let preview = agentPreviews.removeValue(forKey: name) {
            preview.stop()
            return
        }
        guard let screen = agentScreens.screen(named: name) else { return }
        guard CGPreflightScreenCaptureAccess() else {
            requestScreenRecording()
            return
        }
        let preview = DisplayPreview(
            displayID: screen.display.displayID, title: "\(name) preview",
            framesPerSecond: 30, floating: preferences.floatPreview)
        preview.onClose = { [weak self] in self?.agentPreviews.removeValue(forKey: name) }
        preview.setToolbar(previewButtons(for: name))
        agentPreviews[name] = preview
        Task { @MainActor in
            do {
                try await preview.start()
            } catch {
                self.agentPreviews.removeValue(forKey: name)?.stop()
                self.presentError("Preview failed: \(error.localizedDescription)")
            }
        }
    }

    private func addAgentScreenItems(to menu: NSMenu) {
        let screens = agentScreens.screens
        let header = NSMenuItem(title: "Agent Screens (\(screens.count))", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        for screen in screens {
            let info = agentScreens.info(screen)
            let entry = NSMenuItem(
                title: "\(screen.name) — \(screen.display.mode)\(screen.display.hiDPI ? " HiDPI" : "")",
                action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            let previewItem = item("Show Preview", #selector(toggleAgentPreviewItem(_:)),
                                   on: agentPreviews[screen.name] != nil)
            previewItem.representedObject = screen.name
            submenu.addItem(previewItem)
            submenu.addItem(.separator())
            let fit = item("Fit to Window", #selector(toggleFitItem(_:)), on: agentScreens.fitsWindow(screen.name))
            fit.representedObject = screen.name
            fit.toolTip = "Keep the screen sized to its app's window, such as iPhone Mirroring turning landscape"
            if !agentScreens.hasPlacedApps(screen.name) { fit.action = nil }
            submenu.addItem(fit)
            let sizes = NSMenuItem(title: "Size", action: nil, keyEquivalent: "")
            let sizeMenu = NSMenu()
            // A size that cannot hold the app's window would cut it off:
            // iPhone Mirroring, for one, cannot be turned or resized to fit,
            // since the phone decides its orientation.
            let needed = agentScreens.mainWindow(on: screen.name).map { window -> CGSize in
                let bounds = screen.display.bounds
                let visible = WindowMover.visibleFrame(of: screen.display.displayID)
                return CGSize(width: window.frame.width,
                              height: window.frame.height + max(0, visible.minY - bounds.minY))
            }
            for (label, mode) in Self.agentScreenSizes {
                let choice = item("\(label) — \(mode)", #selector(resizeAgentScreenItem(_:)),
                                  on: screen.display.mode == mode && !agentScreens.fitsWindow(screen.name))
                choice.representedObject = [screen.name, "\(mode.width)x\(mode.height)"]
                if let needed, CGFloat(mode.width) < needed.width || CGFloat(mode.height) < needed.height {
                    choice.action = nil
                    choice.toolTip = "Too small for \(Int(needed.width))×\(Int(needed.height)), the window"
                        + " and the menu bar; the window cannot be turned or shrunk from here"
                }
                sizeMenu.addItem(choice)
            }
            sizes.submenu = sizeMenu
            submenu.addItem(sizes)
            let windows = WindowMover.windows(on: info.displayID)
            if !windows.isEmpty {
                submenu.addItem(.separator())
                for window in windows {
                    let back = item("Bring Back: \(window.label)", #selector(bringBack(_:)), on: false)
                    back.representedObject = window
                    submenu.addItem(back)
                }
            }
            submenu.addItem(.separator())
            let destroy = item("Destroy", #selector(destroyAgentScreenItem(_:)), on: false)
            destroy.representedObject = screen.name
            submenu.addItem(destroy)
            entry.submenu = submenu
            menu.addItem(entry)
        }
        if screens.count > 1 {
            menu.addItem(item("Destroy All Agent Screens", #selector(destroyAllAgentScreens), on: false))
        }
    }

    /// Sizes offered for agent screens in the menu.
    static let agentScreenSizes: [(String, VirtualDisplay.Mode)] = [
        // No landscape phone size: the phone decides its orientation, and
        // Fit to Window follows it when it turns.
        ("Phone", .init(width: 525, height: 1001)),
        ("Small", .init(width: 800, height: 600)),
        ("Laptop", .init(width: 1280, height: 800)),
        ("Desktop", .init(width: 1440, height: 900)),
        ("Full HD", .init(width: 1920, height: 1080)),
    ]

    @objc private func toggleFitItem(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        agentScreens.setFitsWindow(name, !agentScreens.fitsWindow(name))
    }

    @objc private func resizeAgentScreenItem(_ sender: NSMenuItem) {
        guard let parts = sender.representedObject as? [String], parts.count == 2 else { return }
        let size = parts[1].split(separator: "x").compactMap { Int($0) }
        guard size.count == 2 else { return }
        // A size chosen by hand would be undone by following the window.
        agentScreens.setFitsWindow(parts[0], false)
        Task { @MainActor in
            let response = await agentScreens.resize(name: parts[0], width: size[0], height: size[1])
            if !response.ok { self.presentError(response.error ?? "Resizing failed.") }
        }
    }

    /// The preview's title bar buttons: zoom the screen's app, and for
    /// iPhone Mirroring, its Home Screen and App Switcher.
    private func previewButtons(for name: String) -> [DisplayPreview.ToolbarButton] {
        func send(_ key: String, _ modifiers: [String]) {
            guard let window = agentScreens.mainWindow(on: name) else { NSSound.beep(); return }
            _ = try? BackgroundInput.key(key, modifiers: modifiers, in: window)
        }
        var buttons: [DisplayPreview.ToolbarButton] = [
            .init(symbol: "minus.magnifyingglass", help: "Smaller (⌘-)") { _ in send("-", ["cmd"]) },
            .init(symbol: "plus.magnifyingglass", help: "Larger (⌘=)") { _ in send("=", ["cmd"]) },
            .init(symbol: "rotate.right", help: "Turn the Picture (the phone keeps its own orientation)") {
                [weak self] _ in self?.agentPreviews[name]?.rotate()
            },
            .init(symbol: "speaker.wave.2", help: "Mac Volume") { [weak self] view in self?.showVolume(from: view) },
        ]
        let isMirroring = agentScreens.mainWindow(on: name).flatMap {
            NSRunningApplication(processIdentifier: $0.pid)?.bundleIdentifier
        } == "com.apple.ScreenContinuity"
        if isMirroring {
            buttons += [
                .init(symbol: "house", help: "Home Screen (⌘1)") { _ in send("1", ["cmd"]) },
                .init(symbol: "square.stack", help: "App Switcher (⌘2)") { _ in send("2", ["cmd"]) },
            ]
        }
        return buttons
    }

    private var volumePopover: NSPopover?
    /// A slider for the Mac's output volume, under the preview's button.
    /// iPhone Mirroring plays through it and has no volume of its own.
    private func showVolume(from anchor: NSView) {
        if let open = volumePopover, open.isShown {
            open.close()
            return
        }
        guard let level = SystemVolume.level else {
            presentError("The current sound output has no volume control.")
            return
        }
        let slider = NSSlider(value: Double(SystemVolume.muted == true ? 0 : level), minValue: 0, maxValue: 1,
                              target: self, action: #selector(volumeChanged(_:)))
        slider.isContinuous = true
        slider.frame = NSRect(x: 36, y: 10, width: 160, height: 24)
        let icon = NSImageView(image: NSImage(systemSymbolName: "speaker.wave.2", accessibilityDescription: nil)!)
        icon.frame = NSRect(x: 10, y: 12, width: 20, height: 20)
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 208, height: 44))
        content.addSubview(icon)
        content.addSubview(slider)
        let controller = NSViewController()
        controller.view = content
        let popover = NSPopover()
        popover.contentViewController = controller
        popover.behavior = .transient
        popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
        volumePopover = popover
    }

    @objc private func volumeChanged(_ sender: NSSlider) {
        SystemVolume.level = Float(sender.doubleValue)
        if sender.doubleValue == 0 { SystemVolume.muted = true }
    }

    @objc private func toggleAgentPreviewItem(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        toggleAgentPreview(name)
    }

    @objc private func destroyAgentScreenItem(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        _ = agentScreens.destroy(name: name)
    }

    @objc private func destroyAllAgentScreens() {
        agentScreens.destroyAll()
    }

    private func apply(mode: VirtualDisplay.Mode, hiDPI: Bool) {
        preferences.mode = mode
        preferences.hiDPI = hiDPI
        guard let display else { return }
        guard display.apply(mode, hiDPI: hiDPI) else {
            presentError("macOS rejected \(mode)\(hiDPI ? " HiDPI" : "").")
            return
        }
        // The preview's stream is sized for the old mode. Re-capture once the
        // new mode has taken effect, keeping the same window: replacing a
        // full-screen window would strand its Space.
        if let preview {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                // The preview may have been closed or replaced meanwhile.
                guard let self, self.preview === preview else { return }
                Task { @MainActor in
                    do {
                        try await preview.restartStream()
                    } catch {
                        self.presentError("Preview failed: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    // MARK: Preview

    /// - Parameter userInitiated: when the user asked for the preview, a
    ///   missing Screen Recording grant leads them to the system prompt and
    ///   settings pane. Automatic starts stay silent instead.
    private func startPreview(userInitiated: Bool = false) {
        guard preview == nil, let display else { return }
        guard CGPreflightScreenCaptureAccess() else {
            if userInitiated {
                requestScreenRecording()
            }
            return
        }
        let preview = DisplayPreview(
            displayID: display.displayID,
            title: "\(Self.displayName) preview",
            framesPerSecond: 30,
            floating: preferences.floatPreview)
        preview.onClose = { [weak self] in
            self?.preview = nil
            self?.preferences.showPreview = false
        }
        self.preview = preview
        Task { @MainActor in
            do {
                try await preview.start()
            } catch {
                self.stopPreview()
                self.presentError("Preview failed: \(error.localizedDescription)")
            }
        }
    }

    /// macOS shows its own prompt the first time; afterwards only the
    /// settings pane can change the grant, so open it as well. The grant
    /// takes effect after the app is relaunched.
    private func requestScreenRecording() {
        CGRequestScreenCaptureAccess()
        if let url = URL(string:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    private func stopPreview() {
        preview?.stop()
        preview = nil
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        if menu === androidMenu {
            addAndroidItems(to: menu)
            return
        }

        let status = NSMenuItem(title: statusLine(), action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())

        menu.addItem(item("Virtual Display", #selector(toggleDisplay), on: display != nil))

        let resolution = NSMenuItem(title: "Resolution", action: nil, keyEquivalent: "")
        let resolutions = NSMenu()
        for match in DisplayMatch.connected(excluding: display?.displayID) {
            let entry = item(match.title, #selector(selectMatch(_:)),
                             on: match.mode == preferences.mode && match.hiDPI == preferences.hiDPI)
            entry.representedObject = match
            resolutions.addItem(entry)
        }
        resolutions.addItem(.separator())
        for mode in VirtualDisplay.presets {
            let entry = item(mode.description, #selector(selectMode(_:)), on: mode == preferences.mode)
            entry.representedObject = mode
            resolutions.addItem(entry)
        }
        resolution.submenu = resolutions
        menu.addItem(resolution)
        menu.addItem(item("HiDPI (Retina)", #selector(toggleHiDPI), on: preferences.hiDPI))
        menu.addItem(.separator())

        let previewTitle = CGPreflightScreenCaptureAccess()
            ? "Show Preview" : "Show Preview (Grant Screen Recording…)"
        let showPreview = item(previewTitle, #selector(togglePreview), on: preview != nil)
        showPreview.isEnabled = display != nil
        menu.addItem(showPreview)
        menu.addItem(item("Keep Preview on Top", #selector(toggleFloat), on: preferences.floatPreview))
        let fullScreen = item(
            "Preview in Full Screen", #selector(togglePreviewFullScreen), on: preview?.isFullScreen ?? false)
        fullScreen.isEnabled = preview != nil
        menu.addItem(fullScreen)
        menu.addItem(.separator())

        addWindowItems(to: menu)
        menu.addItem(.separator())

        addAgentScreenItems(to: menu)
        menu.addItem(.separator())

        let android = NSMenuItem(title: "Android Phones", action: nil, keyEquivalent: "")
        android.submenu = androidMenu
        menu.addItem(android)
        menu.addItem(.separator())

        if let copies = testCopiesItem() {
            menu.addItem(copies)
            menu.addItem(.separator())
        }

        menu.addItem(item("Open Displays Settings…", #selector(openDisplaySettings), on: false))
        menu.addItem(NSMenuItem(
            title: "Quit 2ndscreen", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    /// Items for choosing which windows live on the virtual display. The
    /// display has no physical panel, so its windows cannot be dragged back.
    private func addWindowItems(to menu: NSMenu) {
        guard let display else { return }
        guard WindowMover.isTrusted else {
            menu.addItem(item("Grant Accessibility to Move Windows…", #selector(requestAccessibility), on: false))
            return
        }
        let move = item("Move Front Window to Other Screen", #selector(moveFrontWindowToOtherScreen), on: false)
        // Shown for discoverability; the global hot key works without the menu.
        move.keyEquivalent = "m"
        move.keyEquivalentModifierMask = [.control, .option, .command]
        menu.addItem(move)

        let windows = WindowMover.windows(on: display.displayID)
        let parent = NSMenuItem(title: "Windows on 2ndscreen (\(windows.count))", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for window in windows {
            let entry = item("Bring Back: \(window.label)", #selector(bringBack(_:)), on: false)
            entry.representedObject = window
            submenu.addItem(entry)
        }
        if windows.count > 1 {
            submenu.addItem(.separator())
            submenu.addItem(item("Bring All Back", #selector(bringAllBack), on: false))
        }
        parent.submenu = submenu
        parent.isEnabled = !windows.isEmpty
        menu.addItem(parent)
    }

    @objc private func requestAccessibility() {
        WindowMover.requestTrust()
    }

    /// Send the focused window to 2ndscreen, or back to the main display if
    /// it is already there. Bound to ⌃⌥⌘M.
    @objc private func moveFrontWindowToOtherScreen() {
        guard let display else { return }
        guard WindowMover.isTrusted else {
            WindowMover.requestTrust()
            return
        }
        guard let window = WindowMover.focusedWindow() else { return }
        let onVirtual = WindowMover.display(containing: window.frame) == display.displayID
        let target = onVirtual ? CGMainDisplayID() : display.displayID
        if !WindowMover.move(window, to: target) {
            presentError("Could not move \(window.label).")
        }
    }

    @objc private func bringBack(_ sender: NSMenuItem) {
        guard let window = sender.representedObject as? WindowInfo else { return }
        if !WindowMover.move(window, to: CGMainDisplayID()) {
            presentError("Could not move \(window.label).")
        }
    }

    @objc private func bringAllBack() {
        guard let display else { return }
        for window in WindowMover.windows(on: display.displayID) {
            WindowMover.move(window, to: CGMainDisplayID())
        }
    }

    private func statusLine() -> String {
        guard let display else { return "Virtual display off" }
        let origin = display.bounds.origin
        return "\(display.mode)\(display.hiDPI ? " HiDPI" : "") @ \(Int(display.refreshRate)) Hz"
            + " · at (\(Int(origin.x)), \(Int(origin.y)))"
    }

    private func item(_ title: String, _ action: Selector, on: Bool) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.state = on ? .on : .off
        return item
    }

    @objc private func toggleDisplay() {
        if display == nil {
            preferences.enabled = true
            enableDisplay()
        } else {
            preferences.enabled = false
            disableDisplay()
        }
    }

    @objc private func selectMode(_ sender: NSMenuItem) {
        guard let mode = sender.representedObject as? VirtualDisplay.Mode else { return }
        apply(mode: mode, hiDPI: preferences.hiDPI)
    }

    @objc private func selectMatch(_ sender: NSMenuItem) {
        guard let match = sender.representedObject as? DisplayMatch else { return }
        apply(mode: match.mode, hiDPI: match.hiDPI)
    }

    @objc private func toggleHiDPI() {
        apply(mode: preferences.mode, hiDPI: !preferences.hiDPI)
    }

    @objc private func togglePreview() {
        if preview == nil {
            preferences.showPreview = true
            startPreview(userInitiated: true)
        } else {
            preferences.showPreview = false
            stopPreview()
        }
    }

    @objc private func togglePreviewFullScreen() {
        preview?.toggleFullScreen()
    }

    @objc private func toggleFloat() {
        preferences.floatPreview.toggle()
        preview?.isFloating = preferences.floatPreview
    }

    @objc private func openDisplaySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Displays-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }

    private func presentError(_ message: String) {
        // A menu bar app is usually inactive; without this the alert can open
        // behind other windows and look like a hang.
        NSApp.activate()
        let alert = NSAlert()
        alert.messageText = "2ndscreen"
        alert.informativeText = message
        alert.runModal()
    }
}
