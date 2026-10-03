import AppKit
import ApplicationServices

// Resolves an AX window to its CGWindowID. Private but long-stable; window
// managers such as yabai and Rectangle rely on it.
@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: UnsafeMutablePointer<CGWindowID>) -> AXError

/// An on-screen window of another app.
public struct WindowInfo: Hashable {
    public let pid: pid_t
    public let windowID: CGWindowID
    public let appName: String
    public let title: String
    /// Global frame in points, top-left origin (CoreGraphics coordinates).
    public let frame: CGRect

    public var label: String {
        title.isEmpty || title == appName ? appName : "\(appName) — \(title)"
    }
}

/// Lists windows per display and moves them between displays through the
/// Accessibility API. Moving another app's windows needs the Accessibility
/// permission; listing does not.
public enum WindowMover {
    public static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Show the system prompt that sends the user to the Accessibility pane.
    public static func requestTrust() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    /// Normal windows whose center lies on `displayID`, front to back.
    public static func windows(on displayID: CGDirectDisplayID) -> [WindowInfo] {
        let bounds = CGDisplayBounds(displayID)
        return normalWindows().filter { bounds.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }
    }

    /// Normal on-screen windows owned by `pid`, front to back.
    public static func windows(ofPID pid: pid_t) -> [WindowInfo] {
        normalWindows().filter { $0.pid == pid }
    }

    /// Every normal on-screen window of other apps, front to back.
    public static func allWindows() -> [WindowInfo] {
        normalWindows()
    }

    /// IDs of every layer-0 window `pid` has, on screen or not: minimized,
    /// hidden, or on another Space.
    public static func allWindowIDs(ofPID pid: pid_t) -> Set<CGWindowID> {
        let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []
        return Set(list.compactMap { entry -> CGWindowID? in
            guard (entry[kCGWindowLayer as String] as? Int) == 0,
                  (entry[kCGWindowOwnerPID as String] as? pid_t) == pid
            else { return nil }
            return entry[kCGWindowNumber as String] as? CGWindowID
        })
    }

    /// On-screen, layer-0 windows of other apps, ignoring slivers such as
    /// menu bar extras.
    private static func normalWindows() -> [WindowInfo] {
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                              kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap { entry -> WindowInfo? in
            guard (entry[kCGWindowLayer as String] as? Int) == 0,
                  let pid = entry[kCGWindowOwnerPID as String] as? pid_t, pid != ownPID,
                  let id = entry[kCGWindowNumber as String] as? CGWindowID,
                  let rect = entry[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: rect),
                  frame.width > 50, frame.height > 50
            else { return nil }
            return WindowInfo(
                pid: pid,
                windowID: id,
                appName: entry[kCGWindowOwnerName as String] as? String ?? "pid \(pid)",
                // Titles are only visible with the Screen Recording permission.
                title: entry[kCGWindowName as String] as? String ?? "",
                frame: frame)
        }
    }

    /// The focused window of the frontmost app other than this one.
    public static func focusedWindow() -> WindowInfo? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier
        else { return nil }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        guard let window: AXUIElement = copyAttribute(appElement, kAXFocusedWindowAttribute),
              let frame = frame(of: window)
        else { return nil }
        var id: CGWindowID = 0
        _ = _AXUIElementGetWindow(window, &id)
        return WindowInfo(
            pid: app.processIdentifier,
            windowID: id,
            appName: app.localizedName ?? "pid \(app.processIdentifier)",
            title: copyAttribute(window, kAXTitleAttribute) ?? "",
            frame: frame)
    }

    /// The display containing the center of `frame`, if any.
    public static func display(containing frame: CGRect) -> CGDirectDisplayID? {
        let center = CGPoint(x: frame.midX, y: frame.midY)
        return activeDisplays().first { CGDisplayBounds($0).contains(center) }
    }

    /// Move `window` onto `displayID`, keeping its relative position and
    /// shrinking it if it does not fit, or with `fill`, sizing it to the
    /// display's visible area. Returns false without permission or if the
    /// app refuses the move.
    @discardableResult
    public static func move(_ window: WindowInfo, to displayID: CGDirectDisplayID, fill: Bool = false) -> Bool {
        guard isTrusted, let element = axWindow(for: window) else { return false }
        let destination = visibleFrame(of: displayID)
        let source = display(containing: window.frame).map(visibleFrame) ?? window.frame
        let target = fill ? destination : placement(of: window.frame, from: source, into: destination)
        return setFrame(element, from: window.frame, to: target)
    }

    /// Put `window` back at `frame`, for example where it was before a
    /// display change carried it off. Returns false without permission or if
    /// the app refuses.
    @discardableResult
    public static func restore(_ window: WindowInfo, to frame: CGRect) -> Bool {
        guard isTrusted, let element = axWindow(for: window) else { return false }
        return setFrame(element, from: window.frame, to: frame)
    }

    private static func setFrame(_ element: AXUIElement, from current: CGRect, to target: CGRect) -> Bool {
        // Position first so a shrink cannot push the window off the target.
        var origin = target.origin
        var size = target.size
        guard let position = AXValueCreate(.cgPoint, &origin),
              let dimensions = AXValueCreate(.cgSize, &size)
        else { return false }
        let moved = AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, position)
        if size != current.size {
            AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, dimensions)
        }
        return moved == .success
    }

    /// `frame` placed in `target` at the same relative offset it had in `source`.
    static func placement(of frame: CGRect, from source: CGRect, into target: CGRect) -> CGRect {
        let size = CGSize(width: min(frame.width, target.width), height: min(frame.height, target.height))
        func fraction(_ offset: CGFloat, _ room: CGFloat) -> CGFloat {
            room > 0 ? min(max(offset / room, 0), 1) : 0
        }
        let fx = fraction(frame.minX - source.minX, source.width - frame.width)
        let fy = fraction(frame.minY - source.minY, source.height - frame.height)
        return CGRect(x: target.minX + fx * (target.width - size.width),
                      y: target.minY + fy * (target.height - size.height),
                      width: size.width, height: size.height)
    }

    /// The display's area excluding the menu bar and Dock, in CG coordinates.
    public static func visibleFrame(of displayID: CGDirectDisplayID) -> CGRect {
        guard let screen = NSScreen.screens.first(where: { $0.displayID == displayID }),
              let primaryHeight = NSScreen.screens.first?.frame.height
        else { return CGDisplayBounds(displayID) }
        let visible = screen.visibleFrame
        // AppKit's origin is bottom-left of the primary display; CG's is top-left.
        let frame = CGRect(x: visible.minX, y: primaryHeight - visible.maxY,
                           width: visible.width, height: visible.height)
        // AppKit learns of display changes a run loop turn late, and until
        // then can describe another display under this ID (a --fill once came
        // out the width of a neighbouring screen). Trust CoreGraphics then.
        let bounds = CGDisplayBounds(displayID)
        return bounds.contains(frame) ? frame : bounds
    }

    private static func activeDisplays() -> [CGDirectDisplayID] {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(UInt32(ids.count), &ids, &count) == .success else { return [] }
        return Array(ids.prefix(Int(count)))
    }

    /// The AX element for `window`, matched by window ID, else by frame.
    static func axWindow(for window: WindowInfo) -> AXUIElement? {
        let app = AXUIElementCreateApplication(window.pid)
        guard let windows: [AXUIElement] = copyAttribute(app, kAXWindowsAttribute) else { return nil }
        if window.windowID != 0 {
            for element in windows {
                var id: CGWindowID = 0
                if _AXUIElementGetWindow(element, &id) == .success, id == window.windowID {
                    return element
                }
            }
        }
        return windows.first { frame(of: $0) == window.frame }
    }

    static func windowID(of element: AXUIElement) -> CGWindowID? {
        var id: CGWindowID = 0
        return _AXUIElementGetWindow(element, &id) == .success && id != 0 ? id : nil
    }

    static func frame(of element: AXUIElement) -> CGRect? {
        guard let positionValue: AXValue = copyAttribute(element, kAXPositionAttribute),
              let sizeValue: AXValue = copyAttribute(element, kAXSizeAttribute)
        else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &origin),
              AXValueGetValue(sizeValue, .cgSize, &size)
        else { return nil }
        return CGRect(origin: origin, size: size)
    }

    static func copyAttribute<T>(_ element: AXUIElement, _ attribute: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return nil }
        return value as? T
    }
}
