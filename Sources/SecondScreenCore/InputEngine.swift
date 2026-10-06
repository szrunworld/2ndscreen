import AppKit
import ApplicationServices

/// Serves `window.state` and `input` for windows on agent screens: finds
/// the window, checks it is on the named screen, so an agent never touches
/// the user's own windows, and picks a route for each action. Elements go
/// through accessibility where they can, since that needs no input event;
/// points and keys go through `BackgroundInput`.
public final class InputEngine {
    /// The last snapshot per window, so indexes from `window.state` stay
    /// valid for the actions that follow it.
    private var snapshots: [CGWindowID: AXSnapshot] = [:]
    private let lock = NSLock()

    public init() {}

    /// The app's window on `screen`: `windowID` if given, else its frontmost
    /// window whose center is on the screen.
    public static func window(pid: pid_t, windowID: CGWindowID?, on screen: ScreenInfo) throws -> WindowInfo {
        let bounds = CGRect(x: screen.frame.x, y: screen.frame.y, width: screen.frame.width, height: screen.frame.height)
        let windows = WindowMover.windows(ofPID: pid)
        let onScreen = windows.filter { bounds.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }
        if let windowID {
            guard windows.contains(where: { $0.windowID == windowID }) else {
                throw AccessibilityError("pid \(pid) has no on-screen window \(windowID)")
            }
            guard let window = onScreen.first(where: { $0.windowID == windowID }) else {
                throw AccessibilityError("window \(windowID) is not on screen \"\(screen.name)\"; move it there first")
            }
            return window
        }
        guard let window = onScreen.first else {
            throw AccessibilityError("pid \(pid) has no window on screen \"\(screen.name)\"; launch or move it there first")
        }
        return window
    }

    public func state(_ window: WindowInfo, query: String?) throws -> ControlResponse {
        let snapshot = try AXSnapshot.capture(window, query: query)
        // A filtered snapshot still indexes the whole tree, so it can serve
        // later actions too.
        store(snapshot)
        var response = ControlResponse()
        response.window = WindowSummary(window)
        response.elements = snapshot.elements.filter { $0.index >= 0 }
        response.tree = snapshot.tree
        return response
    }

    /// Points must be in the window, or in another window of the app on the
    /// same screen, such as an open menu or a dialog.
    public func perform(_ action: InputAction, in window: WindowInfo, on screen: ScreenInfo) throws -> ControlResponse {
        let bounds = CGRect(x: screen.frame.x, y: screen.frame.y, width: screen.frame.width, height: screen.frame.height)
        func reachable(_ point: CGPoint) -> Bool {
            window.frame.contains(point)
                || (bounds.contains(point) && BackgroundInput.topWindow(at: point, pid: window.pid) != nil)
        }
        var response = ControlResponse()
        response.window = WindowSummary(window)
        if action.kind == .accessibilityPress {
            // Only the element as the last state showed it; nothing is read afresh or resolved by text.
            try Self.checkAccessibilityPress(action)
            let snapshot = try cachedSnapshot(of: window)
            guard let index = action.index, let info = snapshot.element(index: index), snapshot.handle(index) != nil else {
                throw AccessibilityError("no element \(action.index ?? -1) in the window; run state again")
            }
            response.element = info
            response.route = try Self.pressExplicitly(info) { AXActions.press(snapshot, index: index) }
            return response
        }
        let element = try resolve(action, in: window)
        response.element = element?.info

        if let point = action.point, !reachable(point) {
            throw AccessibilityError("(\(point.x), \(point.y)) is outside the window \(Self.describe(window.frame))")
        }

        switch action.kind {
        case .click:
            let right = action.button == "right"
            let count = max(1, min(action.count ?? 1, 2))
            guard let point = action.point ?? element?.info.center else {
                // Menu bar items have no frame until their menu opens.
                throw AccessibilityError(element == nil ? "give --index N, --text TEXT, or --x X --y Y"
                    : "the element has no frame to click; for a menu item, press its keyboard shortcut with key")
            }
            cursor(.click, point)
            // A single left click on a pressable native element needs no event.
            let modifiers = action.modifiers ?? []
            if let element, !right, count == 1, modifiers.isEmpty, AXActions.canPress(element.info),
               !element.snapshot.isWeb(element.info.index),
               AXActions.press(element.snapshot, index: element.info.index) {
                response.route = "ax.press"
            } else {
                response.route = try BackgroundInput.click(at: point, in: window, button: right ? .right : .left,
                                                           count: count, modifiers: modifiers)
            }

        case .type:
            let replace = action.replace == true
            // Replacing with nothing clears the field.
            guard let text = action.value, !text.isEmpty || replace else { throw AccessibilityError("type needs --value TEXT") }
            if replace {
                guard let element else { throw AccessibilityError("--replace needs the field named with --index or --text") }
                let write = AXActions.replace(with: text, in: element.snapshot, index: element.info.index)
                guard write != .refused else {
                    throw AccessibilityError("the field does not take its text through accessibility")
                }
                if let center = element.info.center { cursor(.move, center) }
                // Unconfirmed: the app took the text but its tree lags; read
                // the field again with state before writing it again.
                response.route = write == .landed ? "ax.value" : "ax.value.unconfirmed"
            } else if let element, element.snapshot.isWeb(element.info.index), let center = element.info.center {
                // Web fields mostly take neither accessibility writes nor focus
                // from the background: type keys, clicking into the field first
                // unless it has focus, since a click would drop a selection.
                let before = AXActions.value(element.snapshot, index: element.info.index)
                if AXActions.isFocused(element.snapshot, index: element.info.index) {
                    cursor(.move, center)
                    response.route = try BackgroundInput.type(text, in: window)
                } else {
                    cursor(.click, center)
                    _ = try BackgroundInput.click(at: center, in: window, button: .left, count: 1, allowAX: false)
                    response.route = "event.click+" + (try BackgroundInput.type(text, in: window))
                }
                // Some Electron apps (BOSS直聘) drop background keys but take the
                // field's text set through accessibility, which the page sees as
                // input. Only when the field's text reads back unchanged by the
                // keys, so the text never lands twice.
                Thread.sleep(forTimeInterval: 0.2)
                if let before, AXActions.value(element.snapshot, index: element.info.index) == before {
                    switch AXActions.insert(text, into: element.snapshot, index: element.info.index) {
                    case .landed: response.route = "ax.insert"
                    case .unconfirmed: response.route = "ax.insert.unconfirmed"
                    case .refused: break
                    }
                }
            } else if let element, AXActions.isText(element.info),
                      case let write = AXActions.insert(text, into: element.snapshot, index: element.info.index),
                      write != .refused {
                if let center = element.info.center { cursor(.move, center) }
                // Unconfirmed counts as typed: typing the keys as well could
                // put the text in twice.
                response.route = write == .landed ? "ax.insert" : "ax.insert.unconfirmed"
            } else {
                response.route = try BackgroundInput.type(text, in: window)
            }

        case .key:
            guard let key = action.key, !key.isEmpty else { throw AccessibilityError("key needs --key NAME, such as return") }
            let modifiers = action.modifiers ?? []
            // Key names cover unshifted keys; a symbol such as "*" arrives
            // when typed as text.
            if key.count == 1, modifiers.isEmpty, BackgroundInput.keyCode(key) == nil {
                response.route = try BackgroundInput.type(key, in: window)
            } else {
                response.route = try BackgroundInput.key(key, modifiers: modifiers, in: window,
                                                         holdModifiers: action.holdModifiers ?? false)
            }

        case .hover:
            guard let point = action.point ?? element?.info.center else {
                throw AccessibilityError(element == nil ? "give --index N, --text TEXT, or --x X --y Y"
                    : "the element has no frame to hover over")
            }
            cursor(.move, point)
            response.route = try BackgroundInput.hover(at: point, in: window)

        case .scroll:
            let directions = ["up", "down", "left", "right"]
            guard let direction = action.direction?.lowercased(), directions.contains(direction) else {
                throw AccessibilityError("scroll needs --direction up, down, left or right")
            }
            let amount = action.amount ?? 3
            guard (1...50).contains(amount) else { throw AccessibilityError("--amount takes a number from 1 to 50") }
            // With no point or element, scroll the middle of the window.
            let point = action.point ?? element?.info.center
                ?? CGPoint(x: window.frame.midX, y: window.frame.midY)
            cursor(.move, point)
            response.route = try BackgroundInput.scroll(at: point, in: window, direction: direction,
                                                        notches: amount, byPage: action.by == "page")

        case .accessibilityPress:
            // Served above, before any element is resolved or any point checked.
            throw AccessibilityError("accessibilityPress is not an event action")

        case .drag:
            guard let from = action.point, let toX = action.toX, let toY = action.toY else {
                throw AccessibilityError("drag needs --from-x X --from-y Y --to-x X --to-y Y")
            }
            let to = CGPoint(x: toX, y: toY)
            guard reachable(to) else {
                throw AccessibilityError("(\(toX), \(toY)) is outside the window \(Self.describe(window.frame))")
            }
            guard action.foreground == true else {
                throw AccessibilityError("drag on macOS needs --foreground (foreground: true over MCP): it brings the app "
                    + "to the front and moves the real pointer for about a second, so ask the user first")
            }
            cursor(.move, from)
            Thread.sleep(forTimeInterval: 0.4)
            cursor(.move, to)
            response.route = try BackgroundInput.foregroundDrag(from: from, to: to, in: window,
                                                                modifiers: action.modifiers ?? [],
                                                                duration: Double(action.durationMs ?? 500) / 1000)
        }
        return response
    }

    // MARK: Explicit accessibility press

    /// The route an explicit accessibility press reports, distinct from the
    /// `ax.press` a default click may take on a native control.
    public static let explicitPressRoute = "ax.press.explicit"

    /// An explicit press names one element by index and nothing else: no
    /// text to resolve, no point, button, count, modifiers or other options.
    public static func checkAccessibilityPress(_ action: InputAction) throws {
        guard action.kind == .accessibilityPress else { throw AccessibilityError("not an accessibility press") }
        guard let index = action.index, index >= 0 else {
            throw AccessibilityError("an accessibility press needs --index N from state")
        }
        var extra: [String] = []
        if action.text != nil { extra.append("--text") }
        if action.x != nil || action.y != nil || action.toX != nil || action.toY != nil { extra.append("a point") }
        if action.button != nil { extra.append("--right") }
        if action.count != nil { extra.append("--double") }
        if action.modifiers != nil { extra.append("--modifiers") }
        if action.value != nil || action.replace != nil || action.key != nil || action.holdModifiers != nil
            || action.direction != nil || action.amount != nil || action.by != nil
            || action.foreground != nil || action.durationMs != nil { extra.append("options of other actions") }
        guard extra.isEmpty else {
            throw AccessibilityError("an accessibility press takes only --index; drop \(extra.joined(separator: ", "))")
        }
    }

    /// Press `element` through accessibility: it must advertise AXPress and
    /// the press must succeed. Nothing else is tried when it does not.
    public static func pressExplicitly(_ element: AXElementInfo, press: () -> Bool) throws -> String {
        guard AXActions.canPress(element) else {
            throw AccessibilityError("element \(element.index) does not advertise AXPress; nothing was pressed")
        }
        guard press() else {
            throw AccessibilityError("AXPress on element \(element.index) failed; no other input was sent")
        }
        return explicitPressRoute
    }

    // MARK: Helpers

    private struct Resolved {
        let snapshot: AXSnapshot
        let info: AXElementInfo
    }

    /// The element named by `index` (from the last state) or `text` (fresh).
    private func resolve(_ action: InputAction, in window: WindowInfo) throws -> Resolved? {
        if let index = action.index {
            let snapshot = try lastSnapshot(of: window)
            guard let info = snapshot.element(index: index), snapshot.handle(index) != nil else {
                throw AccessibilityError("no element \(index) in the window; run state again")
            }
            return Resolved(snapshot: snapshot, info: info)
        }
        if let text = action.text {
            var snapshot = try AXSnapshot.capture(window)
            if snapshot.element(text: text) == nil {
                // Electron and Chromium build a page's tree only once something
                // reads it, so the first read of a fresh window can come back
                // without its content. Read once more.
                Thread.sleep(forTimeInterval: 0.7)
                snapshot = try AXSnapshot.capture(window)
            }
            store(snapshot)
            guard let info = snapshot.element(text: text) else {
                throw AccessibilityError("no element matches \"\(text)\"; run state to see what is there")
            }
            return Resolved(snapshot: snapshot, info: info)
        }
        return nil
    }

    /// The snapshot the last `window.state` of this window stored, never a new one.
    private func cachedSnapshot(of window: WindowInfo) throws -> AXSnapshot {
        lock.lock()
        let cached = snapshots[window.windowID]
        lock.unlock()
        guard let cached else { throw AccessibilityError("no state of this window to take the index from; run state first") }
        return cached
    }

    private func lastSnapshot(of window: WindowInfo) throws -> AXSnapshot {
        lock.lock()
        let cached = snapshots[window.windowID]
        lock.unlock()
        if let cached { return cached }
        let snapshot = try AXSnapshot.capture(window)
        store(snapshot)
        return snapshot
    }

    private func store(_ snapshot: AXSnapshot) {
        lock.lock()
        snapshots[snapshot.windowID] = snapshot
        lock.unlock()
    }

    /// Show the agent cursor, and give it time to arrive before a click.
    private func cursor(_ action: AgentCursorEvent.Action, _ point: CGPoint) {
        AgentCursorEvent(action: action, point: point).post()
        if action == .click { Thread.sleep(forTimeInterval: 0.4) }
    }

    static func describe(_ rect: CGRect) -> String {
        "(\(Int(rect.minX)), \(Int(rect.minY)), \(Int(rect.width))x\(Int(rect.height)))"
    }
}
