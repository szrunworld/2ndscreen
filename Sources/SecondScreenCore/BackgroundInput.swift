import AppKit
import ApplicationServices

/// Mouse and keyboard input posted to one app's window, without moving the
/// user's pointer or bringing the app to the front. Each call returns the
/// route it took. Points are global, top-left-origin points.
///
/// Nothing reads back whether an event landed; check with a screenshot or
/// `state`.
public enum BackgroundInput {
    public enum Button { case left, right }

    /// Roles a left click may press through accessibility instead of with
    /// events. Pop-up buttons are left out: their menu closes at once in a
    /// background window.
    static let pressable: Set<String> = ["AXButton", "AXCheckBox", "AXRadioButton", "AXLink", "AXMenuItem",
                                         "AXMenuButton", "AXTab", "AXDisclosureTriangle"]

    // MARK: Click

    /// `modifiers` are held for a left click, as for shift-click to extend
    /// a selection.
    public static func click(at point: CGPoint, in window: WindowInfo, button: Button, count: Int,
                             modifiers: [String] = [], allowAX: Bool = true) throws -> String {
        try requireTrust()
        let flags = try flags(modifiers)
        // A popup menu, sheet or dialog above the window takes the click.
        let hit = topWindow(at: point, pid: window.pid) ?? window
        let overlay = hit.windowID != window.windowID
        if button == .right {
            FocusGuard.shared.protect(target: window.pid) { rightClick(at: point, in: hit) }
            return overlay ? "event.right.overlay" : "event.right"
        }
        if allowAX, count == 1, flags.isEmpty, pressElement(at: point, in: hit) { return "ax.press" }
        let user = NSWorkspace.shared.frontmostApplication
        FocusGuard.shared.protect(target: nil, allowing: window.pid) {
            // Moving focus to the main window would close an open menu.
            let focused = !overlay && SkyLight.focusWithoutRaise(windowID: window.windowID, pid: window.pid)
            Thread.sleep(forTimeInterval: 0.05)
            leftClick(at: point, in: hit, count: count, flags: flags)
            Thread.sleep(forTimeInterval: 0.05)
            guard let user, user.processIdentifier != window.pid else { return }
            let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
            if front == window.pid {
                // The click brought the app forward; unless the user just
                // switched to it, put theirs back.
                if !FocusGuard.shared.userActedRecently() { user.activate(options: []) }
            } else if focused, front == user.processIdentifier {
                SkyLight.restoreFocus(after: window.windowID, pid: window.pid, user: user)
            }
        }
        return (count == 2 ? "event.double" : "event.click") + (overlay ? ".overlay" : "")
    }

    /// The app's frontmost window under the point. Popup menus, sheets and
    /// dialogs are windows of their own above the main one, and an event
    /// stamped with the main window's number goes through them to whatever
    /// lies beneath.
    public static func topWindow(at point: CGPoint, pid: pid_t) -> WindowInfo? {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        for entry in list {  // front to back
            guard (entry[kCGWindowOwnerPID as String] as? pid_t) == pid,
                  (entry[kCGWindowLayer as String] as? Int ?? -1) >= 0,
                  let id = entry[kCGWindowNumber as String] as? CGWindowID,
                  let bounds = entry[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds),
                  frame.width > 2, frame.height > 2, frame.contains(point)
            else { continue }
            return WindowInfo(pid: pid, windowID: id, appName: entry[kCGWindowOwnerName as String] as? String ?? "",
                              title: "", frame: frame)
        }
        return nil
    }

    /// Whether the app has a popup menu open, such as a select's list.
    public static func hasOpenMenu(pid: pid_t) -> Bool {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.contains {
            ($0[kCGWindowOwnerPID as String] as? pid_t) == pid
                && ($0[kCGWindowLayer as String] as? Int) == Int(CGWindowLevelForKey(.popUpMenuWindow))
        }
    }

    /// AXPress on the pressable native element at the point, if it is in the
    /// window. Web content is left to events: Chromium reports AXPress there
    /// as done while a background page never sees it.
    private static func pressElement(at point: CGPoint, in window: WindowInfo) -> Bool {
        let app = AXUIElementCreateApplication(window.pid)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success,
              let element = hit,
              let role: String = WindowMover.copyAttribute(element, kAXRoleAttribute), pressable.contains(role)
        else { return false }
        var windowElement: AXUIElement? = WindowMover.copyAttribute(element, kAXWindowAttribute)
        if windowElement == nil { windowElement = WindowMover.copyAttribute(element, kAXTopLevelUIElementAttribute) }
        guard let windowElement, WindowMover.windowID(of: windowElement) == window.windowID,
              !isInWebArea(element)
        else { return false }
        return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
    }

    private static func isInWebArea(_ element: AXUIElement) -> Bool {
        var current: AXUIElement? = element
        for _ in 0..<64 {
            guard let node = current else { return false }
            if let role: String = WindowMover.copyAttribute(node, kAXRoleAttribute), role == "AXWebArea" { return true }
            current = WindowMover.copyAttribute(node, kAXParentAttribute)
        }
        return false
    }

    /// A move to wake the window's pointer tracking, an off-screen press that
    /// satisfies Chromium's user-activation gate without hitting anything,
    /// then the click, all through SkyLight. The window location is the
    /// screen point here; WindowServer works out the local one.
    private static func leftClick(at point: CGPoint, in window: WindowInfo, count: Int, flags: CGEventFlags) {
        let group = clickGroup()
        let source = CGEventSource(stateID: .hidSystemState)
        func post(_ type: CGEventType, _ at: CGPoint, phase: Int64, clicks: Int64, pause: Double) {
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at,
                                      mouseButton: .left) else { return }
            // Always set: the HID state source would carry the user's modifiers.
            event.flags = at == point ? flags : []
            SkyLight.set(event, .mouseEventNumber, phase)
            stamp(event, window: window, group: group, clicks: clicks, button: 0, subtype: 3, location: point)
            SkyLight.postMouse(event, to: window.pid, alsoPublic: false)
            Thread.sleep(forTimeInterval: pause)
        }
        let offscreen = CGPoint(x: -1, y: -1)
        post(.mouseMoved, point, phase: 2, clicks: 0, pause: 0.015)
        post(.leftMouseDown, offscreen, phase: 1, clicks: 1, pause: 0.001)
        post(.leftMouseUp, offscreen, phase: 2, clicks: 1, pause: 0.1)
        for click in 1...max(1, min(count, 2)) {
            post(.leftMouseDown, point, phase: 3, clicks: Int64(click), pause: 0.001)
            post(.leftMouseUp, point, phase: 3, clicks: Int64(click), pause: click < count ? 0.08 : 0)
        }
    }

    /// Without the window numbers, WindowServer hit-tests by location and
    /// skips windows that are not key, so the click would go nowhere.
    private static func rightClick(at point: CGPoint, in window: WindowInfo) {
        let local = localPoint(point, in: window)
        let group = clickGroup()
        let source = CGEventSource(stateID: .hidSystemState)
        primer(at: point, in: window, source: source)
        for type in [CGEventType.rightMouseDown, .rightMouseUp] {
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point,
                                      mouseButton: .right) else { continue }
            stamp(event, window: window, group: group, clicks: 1, button: 1, subtype: 3, location: local)
            SkyLight.postMouse(event, to: window.pid, alsoPublic: true)
            if type == .rightMouseDown { Thread.sleep(forTimeInterval: 0.028) }
        }
    }

    // MARK: Scroll

    /// Wheel notches at a point. A line notch is one wheel line, a page five.
    public static func scroll(at point: CGPoint, in window: WindowInfo, direction: String, notches: Int,
                              byPage: Bool) throws -> String {
        try requireTrust()
        let window = topWindow(at: point, pid: window.pid) ?? window
        let local = localPoint(point, in: window)
        let step: Int32 = byPage ? 5 : 1
        // Line-unit wheel events posted to a process scroll the view by the
        // sign as given, the reverse of a hardware wheel's convention, so
        // "up" (toward the top) is negative, in AppKit and WebKit alike.
        let (dy, dx): (Int32, Int32) = switch direction {
        case "up": (-step, 0)
        case "down": (step, 0)
        case "left": (0, -step)
        default: (0, step)
        }
        FocusGuard.shared.protect(target: window.pid) {
            let source = CGEventSource(stateID: .hidSystemState)
            primer(at: point, in: window, source: source)
            for _ in 0..<notches {
                guard let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
                                          wheel1: dy, wheel2: dx, wheel3: 0) else { continue }
                event.location = point
                SkyLight.setWindowLocation?(event, local)
                for field in [SkyLight.Field.windowNumber, .windowUnderPointer, .windowUnderPointerThatCanHandle] {
                    SkyLight.set(event, field, Int64(window.windowID))
                }
                SkyLight.set(event, .targetPID, Int64(window.pid))
                SkyLight.postMouse(event, to: window.pid, alsoPublic: true)
                Thread.sleep(forTimeInterval: 0.03)
            }
        }
        return "event.wheel"
    }

    // MARK: Keyboard

    /// Type text as Unicode key events, one character at a time, so any
    /// script works whatever the keyboard layout or input method.
    public static func type(_ text: String, in window: WindowInfo) throws -> String {
        try requireTrust()
        FocusGuard.shared.protect(target: window.pid) {
            for character in text {
                let units = Array(String(character).utf16)
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState),
                                              virtualKey: 0, keyDown: down) else { continue }
                    event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                    // Chromium reads modifiers from the flags; an uppercase
                    // letter would otherwise arrive as Shift held.
                    event.flags = []
                    SkyLight.postKey(event, to: window.pid)
                    Thread.sleep(forTimeInterval: down ? 0.008 : 0.03)
                }
            }
        }
        return "event.unicode"
    }

    /// Press a key with modifiers. With cmd, the app is made front for the
    /// instant the event is queued, since menu key equivalents (cmd+a,
    /// cmd+v) only reach NSMenu by the HID path. With `holdModifiers`, the
    /// app stays in the background and gets each modifier pressed as a key
    /// around it instead.
    public static func key(_ name: String, modifiers: [String], in window: WindowInfo,
                           holdModifiers: Bool = false) throws -> String {
        try requireTrust()
        guard let code = keyCode(name) else { throw AccessibilityError("unknown key \"\(name)\"") }
        let flags = try flags(modifiers)
        if holdModifiers, !flags.isEmpty {
            FocusGuard.shared.protect(target: window.pid) { chord(code, modifiers: modifiers, pid: window.pid) }
            return "event.key.held"
        }
        let viaMenu = flags.contains(.maskCommand)
        FocusGuard.shared.protect(target: window.pid, allowing: viaMenu ? window.pid : nil) {
            func press() {
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState),
                                              virtualKey: code, keyDown: down) else { continue }
                    // Always set, even when empty: the HID state source would
                    // otherwise carry modifiers the user is holding.
                    event.flags = flags
                    if viaMenu {
                        SkyLight.postKeyWithoutAuth(event, to: window.pid)
                    } else {
                        SkyLight.postKey(event, to: window.pid)
                    }
                    if down { Thread.sleep(forTimeInterval: 0.008) }
                }
            }
            if viaMenu {
                SkyLight.withMenuShortcutActivation(windowID: window.windowID, pid: window.pid, press)
            } else {
                press()
            }
        }
        return viaMenu ? "event.key.menu" : "event.key"
    }

    /// Modifier key-downs as flagsChanged events, the key, then the
    /// key-ups, the way a keyboard sends a chord.
    private static func chord(_ code: CGKeyCode, modifiers: [String], pid: pid_t) {
        let keys: [(CGKeyCode, CGEventFlags)] = modifiers.compactMap {
            switch $0.lowercased() {
            case "cmd", "command", "meta": (55, .maskCommand)
            case "shift": (56, .maskShift)
            case "option", "alt", "opt": (58, .maskAlternate)
            case "ctrl", "control": (59, .maskControl)
            default: nil
            }
        }
        func post(_ code: CGKeyCode, down: Bool, flags: CGEventFlags, modifier: Bool) {
            guard let event = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState),
                                      virtualKey: code, keyDown: down) else { return }
            if modifier { event.type = .flagsChanged }
            event.flags = flags
            SkyLight.postKey(event, to: pid)
            Thread.sleep(forTimeInterval: 0.02)
        }
        var held = CGEventFlags()
        for (key, flag) in keys {
            held.insert(flag)
            post(key, down: true, flags: held, modifier: true)
        }
        post(code, down: true, flags: held, modifier: false)
        post(code, down: false, flags: held, modifier: false)
        for (key, flag) in keys.reversed() {
            held.remove(flag)
            post(key, down: false, flags: held, modifier: true)
        }
    }

    // MARK: Drag

    /// The one action that takes the real pointer: bring the app front, warp
    /// the pointer through the gesture at the HID tap, then put the pointer
    /// and the previous app back. Only on the agent's explicit request.
    public static func foregroundDrag(from: CGPoint, to: CGPoint, in window: WindowInfo, modifiers: [String],
                                      duration: Double) throws -> String {
        try requireTrust()
        let pointer = CGEvent(source: nil)?.location
        guard let previous = SkyLight.bringToFront(windowID: window.windowID, pid: window.pid) else {
            throw AccessibilityError("could not bring \(window.appName) to the front for the drag")
        }
        defer {
            Thread.sleep(forTimeInterval: 0.1)
            SkyLight.setFront(previous)
            if let pointer { CGWarpMouseCursorPosition(pointer) }
        }
        // Wait for the window to become key, up to 400 ms.
        let app = AXUIElementCreateApplication(window.pid)
        for _ in 0..<40 {
            if let focused: AXUIElement = WindowMover.copyAttribute(app, kAXFocusedWindowAttribute),
               WindowMover.windowID(of: focused) == window.windowID { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        var flags = CGEventFlags()
        for modifier in modifiers {
            switch modifier.lowercased() {
            case "cmd", "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "option", "alt": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: break
            }
        }
        func post(_ type: CGEventType, _ at: CGPoint) {
            CGWarpMouseCursorPosition(at)
            CGAssociateMouseAndMouseCursorPosition(1)
            guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at,
                                      mouseButton: .left) else { return }
            if !flags.isEmpty { event.flags = flags }
            event.post(tap: .cghidEventTap)
        }
        post(.mouseMoved, from)
        Thread.sleep(forTimeInterval: 0.04)
        post(.leftMouseDown, from)
        Thread.sleep(forTimeInterval: 0.016)
        let steps = 20
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            post(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
            Thread.sleep(forTimeInterval: max(duration, 0) / Double(steps))
        }
        Thread.sleep(forTimeInterval: 0.05)
        post(.leftMouseUp, to)
        return "hid.drag"
    }

    // MARK: Helpers

    static func flags(_ modifiers: [String]) throws -> CGEventFlags {
        var flags = CGEventFlags()
        for modifier in modifiers {
            switch modifier.lowercased() {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "option", "alt", "opt": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            default: throw AccessibilityError("unknown modifier \"\(modifier)\"; use cmd, shift, option or ctrl")
            }
        }
        return flags
    }

    private static func requireTrust() throws {
        guard AXIsProcessTrusted() else {
            throw AccessibilityError("2ndscreen needs the Accessibility permission to drive apps; "
                + "choose Grant Accessibility in its menu")
        }
    }

    /// A move to the target first: a background window that never got one
    /// has stale tracking state, and a press lands "outside" its control.
    private static func primer(at point: CGPoint, in window: WindowInfo, source: CGEventSource?) {
        guard let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point,
                                  mouseButton: .left) else { return }
        stamp(event, window: window, group: clickGroup(), clicks: 0, button: 0, subtype: 3,
              location: localPoint(point, in: window))
        SkyLight.postMouse(event, to: window.pid, alsoPublic: true)
        Thread.sleep(forTimeInterval: 0.012)
    }

    private static func stamp(_ event: CGEvent, window: WindowInfo, group: Int64, clicks: Int64, button: Int64,
                              subtype: Int64, location: CGPoint) {
        SkyLight.setWindowLocation?(event, location)
        SkyLight.set(event, .clickState, clicks)
        SkyLight.set(event, .buttonNumber, button)
        SkyLight.set(event, .subtype, subtype)
        if window.windowID != 0 {
            SkyLight.set(event, .windowNumber, Int64(window.windowID))
            SkyLight.set(event, .windowUnderPointer, Int64(window.windowID))
            SkyLight.set(event, .windowUnderPointerThatCanHandle, Int64(window.windowID))
        }
        SkyLight.set(event, .clickGroup, group)
        // Chromium drops synthetic events not addressed to its process.
        SkyLight.set(event, .targetPID, Int64(window.pid))
    }

    private static func localPoint(_ point: CGPoint, in window: WindowInfo) -> CGPoint {
        CGPoint(x: point.x - window.frame.minX, y: point.y - window.frame.minY)
    }

    /// An id tying a gesture's events together.
    private static func clickGroup() -> Int64 {
        Int64(Calendar.current.component(.nanosecond, from: Date()))
    }

    /// Virtual key codes on the ANSI layout.
    static func keyCode(_ name: String) -> CGKeyCode? {
        let named: [String: CGKeyCode] = [
            "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
            "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
            "left": 123, "right": 124, "down": 125, "up": 126,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
            "f10": 109, "f11": 103, "f12": 111,
        ]
        let characters: [Character: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
            "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
            "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
            "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
            ".": 47, "`": 50,
        ]
        let key = name.lowercased()
        if let code = named[key] { return code }
        if key.count == 1, let character = key.first { return characters[character] }
        return nil
    }
}
