import AppKit
import Carbon.HIToolbox
import SecondScreenCore

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

    var floatPreview: Bool {
        get { defaults.object(forKey: "floatPreview") as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: "floatPreview") }
    }
}

/// The area a full-screen window gets on a physical display, offered as a
/// match target so the full-screen preview shows the virtual display pixel
/// for pixel. On displays with a camera housing that area excludes the strip
/// beside it, so it is shorter than the display itself.
struct DisplayMatch {
    let name: String
    let mode: VirtualDisplay.Mode
    let hiDPI: Bool

    var title: String { "Match \(name) Full Screen — \(mode)\(hiDPI ? " HiDPI" : "")" }

    /// Every connected display except `excluding` (the virtual display itself).
    static func connected(excluding displayID: CGDirectDisplayID?) -> [DisplayMatch] {
        NSScreen.screens.compactMap { screen in
            guard screen.displayID != displayID else { return nil }
            return DisplayMatch(
                name: screen.localizedName,
                mode: VirtualDisplay.Mode(
                    width: Int(screen.frame.width),
                    height: Int(screen.frame.height - screen.safeAreaInsets.top)),
                hiDPI: screen.backingScaleFactor > 1)
        }
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
    /// One agent cursor overlay per screen, keyed by display ID.
    private var cursorOverlays: [CGDirectDisplayID: AgentCursorOverlay] = [:]
    private var moveHotKey: HotKey?
    private let agentScreens = AgentScreens()
    /// Live previews of agent screens, keyed by screen name.
    private var agentPreviews: [String: DisplayPreview] = [:]
    private var controlServer: ControlServer?
    /// Open Android mirror windows, keyed by adb serial.
    private var androidMirrors: [String: AndroidMirrorWindow] = [:]
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
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(
            systemSymbolName: "display.2", accessibilityDescription: Self.displayName)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(agentCursorEvent(_:)),
            name: AgentCursorEvent.notificationName, object: nil,
            suspensionBehavior: .deliverImmediately)

        moveHotKey = HotKey(keyCode: kVK_ANSI_M, modifiers: controlKey | optionKey | cmdKey) { [weak self] in
            self?.moveFrontWindowToOtherScreen()
        }

        // Default to the main display's size and scale: the full-screen
        // preview then fills it exactly, and windows keep their size when
        // they move between the two.
        if !preferences.hasMode, let main = DisplayMatch.connected(excluding: nil).first {
            preferences.mode = main.mode
            preferences.hiDPI = main.hiDPI
        }

        if preferences.enabled {
            enableDisplay()
        }

        agentScreens.onChange = { [weak self] in self?.agentScreensChanged() }
        let server = ControlServer { [weak self] request in
            await self?.handle(request) ?? .failure("2ndscreen is shutting down")
        }
        do {
            try server.start()
            controlServer = server
        } catch {
            presentError("Agents cannot reach 2ndscreen: \(error.localizedDescription)")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        controlServer?.stop()
        // Stops each mirror's server on its phone.
        for window in androidMirrors.values {
            window.close()
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

    /// Keep overlays and previews in step with the agent screens that exist.
    private func agentScreensChanged() {
        let live = Set(agentScreens.screens.map(\.display.displayID))
        let primary = display?.displayID
        for id in cursorOverlays.keys where id != primary && !live.contains(id) {
            removeCursorOverlay(for: id)
        }
        let names = Set(agentScreens.screens.map(\.name))
        for (name, preview) in agentPreviews where !names.contains(name) {
            preview.stop()
            agentPreviews.removeValue(forKey: name)
        }
        // The overlay needs the display's NSScreen, which appears a moment
        // after creation.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self else { return }
            for screen in self.agentScreens.screens where self.cursorOverlays[screen.display.displayID] == nil {
                self.cursorOverlays[screen.display.displayID] = AgentCursorOverlay(displayID: screen.display.displayID)
            }
        }
    }

    /// The primary screen and every agent screen, as agents see them.
    private func allScreens() -> [ScreenInfo] {
        var screens: [ScreenInfo] = []
        if let display {
            screens.append(ScreenInfo(
                name: Self.displayName, kind: .primary, displayID: display.displayID,
                width: display.mode.width, height: display.mode.height, hiDPI: display.hiDPI,
                frame: Frame(display.bounds)))
        }
        return screens + agentScreens.screens.map(agentScreens.info)
    }

    private func handle(_ request: ControlRequest) async -> ControlResponse {
        func target() -> ScreenInfo? {
            guard let name = request.screen else { return nil }
            return allScreens().first { $0.name == name }
        }
        let missingScreen = ControlResponse.failure(
            request.screen.map { "no screen named \"\($0)\"" } ?? "give a screen with --screen")
        if let name = request.screen {
            agentScreens.touch(name)
        }

        switch request.command {
        case .screenCreate:
            // By default, match the main display's full-screen area, so a
            // full-screen preview of the new screen is pixel for pixel.
            let main = DisplayMatch.connected(excluding: display?.displayID).first
            return await agentScreens.create(
                name: request.screen,
                width: request.width ?? main?.mode.width ?? 1440,
                height: request.height ?? main?.mode.height ?? 900,
                hiDPI: request.hiDPI ?? main?.hiDPI ?? false,
                ttl: request.ttl, idleTimeout: request.idleTimeout, ownerPID: request.ownerPID)
        case .screenList:
            var response = ControlResponse()
            response.screens = allScreens()
            return response
        case .screenDestroy:
            guard let name = request.screen else { return missingScreen }
            if name == Self.displayName {
                return .failure("the primary screen is managed from the menu bar")
            }
            return agentScreens.destroy(name: name)
        case .appLaunch:
            guard let screen = target() else { return missingScreen }
            return await agentScreens.launch(
                on: screen, bundleID: request.bundleID, path: request.path,
                newInstance: request.newInstance ?? false, fill: request.fill ?? false)
        case .windowMove:
            guard let screen = target() else { return missingScreen }
            guard let pid = request.pid else { return .failure("give the window's app with --pid") }
            return await agentScreens.moveWindows(to: screen, pid: pid, windowID: request.windowID,
                                            fill: request.fill ?? false)
        case .screenshot:
            guard let screen = target() else { return missingScreen }
            guard let output = request.output else { return .failure("give a PNG path with --output") }
            return await agentScreens.screenshot(displayID: screen.displayID, to: output)
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
        }
    }

    // MARK: Android

    private func addAndroidItems(to menu: NSMenu) {
        do {
            let devices = try ADB.devices()
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

    private func androidList() async -> ControlResponse {
        let devices: [ADB.Device]
        do {
            devices = try await Task.detached { try ADB.devices() }.value
        } catch {
            return .failure(error.localizedDescription)
        }
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
    private func showAndroid(serial: String?, on displayID: CGDirectDisplayID?, maxSize: Int,
                             presentation: AndroidMirrorWindow.Presentation) async -> ControlResponse {
        let devices: [ADB.Device]
        do {
            devices = try await Task.detached { try ADB.devices() }.value.filter { $0.state == "device" }
        } catch {
            return .failure(error.localizedDescription)
        }
        guard !devices.isEmpty else {
            return .failure("no Android device is connected; pair one with `2ndscreen android pair` or from the menu")
        }
        guard let serial = serial ?? (devices.count == 1 ? devices[0].serial : nil) else {
            return .failure("several Android devices are connected; choose one with --serial")
        }
        guard devices.contains(where: { $0.serial == serial }) else {
            return .failure("no connected device \"\(serial)\"; see `2ndscreen android devices`")
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
