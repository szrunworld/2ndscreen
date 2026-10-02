import AppKit
import SecondScreenCore

/// Persisted user choices. The app restores them on launch.
struct Preferences {
    private let defaults = UserDefaults.standard

    var enabled: Bool {
        get { defaults.object(forKey: "enabled") as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: "enabled") }
    }

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

/// Owns the status item, the virtual display, and its optional preview.
@MainActor
final class AppController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private static let displayName = "2ndscreen"

    private let preferences = Preferences()
    private var statusItem: NSStatusItem!
    private var display: VirtualDisplay?
    private var preview: DisplayPreview?
    private var agentCursor: AgentCursorOverlay?

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

        if preferences.enabled {
            enableDisplay()
        }
    }

    // MARK: Display lifecycle

    private func enableDisplay() {
        guard display == nil else { return }
        display = VirtualDisplay(
            name: Self.displayName,
            mode: preferences.mode,
            hiDPI: preferences.hiDPI,
            onTerminate: { [weak self] in
                // Our own disable clears `display` first; anything else means
                // macOS removed the display behind our back.
                guard let self, self.display != nil else { return }
                self.stopPreview()
                self.agentCursor?.close()
                self.agentCursor = nil
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
            self.agentCursor = AgentCursorOverlay(displayID: displayID)
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
        agentCursor?.close()
        agentCursor = nil
        display = nil
    }

    @objc private func agentCursorEvent(_ notification: Notification) {
        guard let event = AgentCursorEvent(userInfo: notification.userInfo) else { return }
        agentCursor?.handle(event)
    }

    private func apply(mode: VirtualDisplay.Mode, hiDPI: Bool) {
        preferences.mode = mode
        preferences.hiDPI = hiDPI
        guard let display else { return }
        guard display.apply(mode, hiDPI: hiDPI) else {
            presentError("macOS rejected \(mode)\(hiDPI ? " HiDPI" : "").")
            return
        }
        // The preview's stream is sized for the old mode; rebuild it once the
        // new mode has taken effect.
        if preview != nil {
            stopPreview()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.startPreview()
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
            framesPerSecond: 15,
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

        let status = NSMenuItem(title: statusLine(), action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())

        menu.addItem(item("Virtual Display", #selector(toggleDisplay), on: display != nil))

        let resolution = NSMenuItem(title: "Resolution", action: nil, keyEquivalent: "")
        let resolutions = NSMenu()
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
        menu.addItem(item("Send Front Window to 2ndscreen", #selector(sendFrontWindow), on: false))

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

    @objc private func sendFrontWindow() {
        guard let display, let window = WindowMover.focusedWindow() else { return }
        if !WindowMover.move(window, to: display.displayID) {
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
        let alert = NSAlert()
        alert.messageText = "2ndscreen"
        alert.informativeText = message
        alert.runModal()
    }
}
