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

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(
            systemSymbolName: "display.2", accessibilityDescription: Self.displayName)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

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
                self.display = nil
            })
        if display == nil {
            presentError("macOS refused to create the virtual display.")
            return
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
        display = nil
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

    private func startPreview() {
        guard preview == nil, let display else { return }
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

        let showPreview = item("Show Preview", #selector(togglePreview), on: preview != nil)
        showPreview.isEnabled = display != nil
        menu.addItem(showPreview)
        menu.addItem(item("Keep Preview on Top", #selector(toggleFloat), on: preferences.floatPreview))
        menu.addItem(.separator())

        menu.addItem(item("Open Displays Settings…", #selector(openDisplaySettings), on: false))
        menu.addItem(NSMenuItem(
            title: "Quit 2ndscreen", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
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
            startPreview()
        } else {
            preferences.showPreview = false
            stopPreview()
        }
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
