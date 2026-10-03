import CoreGraphics
import Foundation
import SecondScreenCore

/// `state`, `click`, `type`, `key`, `scroll` and `drag`: observe and drive a
/// window on an agent screen. Each prints one JSON object and exits non-zero
/// on failure.
enum DriverCommands {
    static let verbs: Set<String> = ["state", "click", "type", "key", "scroll", "drag"]

    static func run(_ verb: String, _ args: Arguments) -> Never {
        do {
            let target = try Target(args)
            let driver = Driver(screen: target.screen.name)
            var output: [String: Any]
            switch verb {
            case "state": output = try state(target, driver, args)
            case "click": output = try click(target, driver, args)
            case "type": output = try type(target, driver, args)
            case "scroll": output = try scroll(target, driver, args)
            case "drag": output = try drag(target, driver, args)
            default: output = try key(target, driver, args)
            }
            output["ok"] = output["ok"] ?? true
            emit(output)
            exit((output["ok"] as? Bool) == true ? 0 : 1)
        } catch {
            emit(["ok": false, "error": error.localizedDescription])
            exit(1)
        }
    }

    // MARK: Commands

    private static func state(_ target: Target, _ driver: Driver, _ args: Arguments) throws -> [String: Any] {
        let snapshot = try driver.state(pid: target.pid, windowID: target.window.windowID,
                                        query: args.value("--query"), screenshot: args.value("--screenshot"))
        var output = target.json
        output["snapshot"] = snapshot.id
        output["elements"] = snapshot.elements.filter { $0.index >= 0 }.map(\.json)
        output["tree"] = snapshot.tree
        if let screenshot = args.value("--screenshot") {
            output["screenshot"] = (screenshot as NSString).expandingTildeInPath
        }
        return output
    }

    private static func click(_ target: Target, _ driver: Driver, _ args: Arguments) throws -> [String: Any] {
        guard !(args.has("--right") && args.has("--double")) else {
            throw DriverError("give --right or --double, not both")
        }
        let tool = args.has("--right") ? "right_click" : args.has("--double") ? "double_click" : "click"
        var arguments: [String: Any] = ["pid": target.pid, "window_id": target.window.windowID]
        let point: CGPoint
        var described: [String: Any] = ["button": args.has("--right") ? "right" : "left",
                                        "count": args.has("--double") ? 2 : 1]

        if let global = try globalPoint(args, "--x", "--y") {
            point = global
            let local = try windowPixels([global], target, driver)[0]
            arguments["x"] = local.x
            arguments["y"] = local.y
            described["point"] = ["x": global.x, "y": global.y]
        } else {
            let (element, snapshot) = try resolve(target, driver, args, required: true)
            guard let element, let center = element.center else {
                // Menu bar items have no frame until their menu opens, and
                // cua-driver refuses them as outside the window.
                throw DriverError("the element has no frame to click; for a menu item, press its keyboard shortcut with key")
            }
            point = center
            arguments["element_token"] = element.token
            described["element"] = element.json
            described["snapshot"] = snapshot.id
        }

        AgentCursorEvent(action: .click, point: point).post()
        Thread.sleep(forTimeInterval: 0.4)  // let the cursor arrive first
        let result = try driver.act(tool, arguments)
        return report(result, target, described)
    }

    private static func type(_ target: Target, _ driver: Driver, _ args: Arguments) throws -> [String: Any] {
        guard let text = args.value("--value") else { throw DriverError("type needs --value TEXT") }
        var arguments: [String: Any] = ["pid": target.pid, "window_id": target.window.windowID, "text": text]
        var described: [String: Any] = [:]
        // Without a target, the text goes to the focused element.
        let (element, snapshot) = try resolve(target, driver, args, required: false)
        if let element {
            arguments["element_token"] = element.token
            described = ["element": element.json, "snapshot": snapshot.id]
            if let center = element.center {
                AgentCursorEvent(action: .move, point: center).post()
            }
        }
        let result = try driver.act("type_text", arguments)
        return report(result, target, described)
    }

    private static func key(_ target: Target, _ driver: Driver, _ args: Arguments) throws -> [String: Any] {
        guard let key = args.value("--key") else { throw DriverError("key needs --key NAME, such as return") }
        let modifiers = modifierList(args)
        let base: [String: Any] = ["pid": target.pid, "window_id": target.window.windowID]
        let result: [String: Any]
        if modifiers.isEmpty {
            let pressed = try driver.act("press_key", base.merging(["key": key]) { $1 })
            // press_key knows key names, not shifted symbols such as "*";
            // a single character still arrives when typed as text.
            if key.count == 1, Driver.describe(pressed, fallback: "").contains("delivery_failed") {
                result = try driver.act("type_text", base.merging(["text": key]) { $1 })
            } else {
                result = pressed
            }
        } else {
            result = try driver.act("hotkey", base.merging(["keys": modifiers + [key]]) { $1 })
        }
        return report(result, target, ["key": key, "modifiers": modifiers])
    }

    /// A mouse wheel over an element or point, or with neither, arrow or page
    /// keys to the focused scroller.
    private static func scroll(_ target: Target, _ driver: Driver, _ args: Arguments) throws -> [String: Any] {
        let directions = ["up", "down", "left", "right"]
        guard let direction = args.value("--direction")?.lowercased(), directions.contains(direction) else {
            throw DriverError("scroll needs --direction up, down, left or right")
        }
        var arguments: [String: Any] = ["pid": target.pid, "window_id": target.window.windowID, "direction": direction]
        var described: [String: Any] = ["direction": direction]
        if let amount = args.value("--amount") {
            guard let notches = Int(amount), (1...50).contains(notches) else {
                throw DriverError("--amount takes a number from 1 to 50")
            }
            arguments["amount"] = notches
            described["amount"] = notches
        }
        if let by = args.value("--by") {
            guard ["line", "page"].contains(by) else { throw DriverError("--by takes line or page") }
            arguments["by"] = by
            described["by"] = by
        }

        // Where a wheel goes if 2ndscreen has to turn it itself.
        var wheelPoint: CGPoint?
        if let global = try globalPoint(args, "--x", "--y") {
            wheelPoint = global
            let local = try windowPixels([global], target, driver)[0]
            arguments["x"] = local.x
            arguments["y"] = local.y
            // cua-driver's background wheel (0.32) scrolls opposite to the
            // direction it is given, in AppKit and WebKit alike, whatever the
            // natural scrolling setting; its element and key routes do not.
            let opposite = ["up": "down", "down": "up", "left": "right", "right": "left"]
            arguments["direction"] = opposite[direction]
            described["point"] = ["x": global.x, "y": global.y]
            AgentCursorEvent(action: .move, point: global).post()
        } else {
            let (element, snapshot) = try resolve(target, driver, args, required: false)
            if let element {
                arguments["element_token"] = element.token
                described["element"] = element.json
                described["snapshot"] = snapshot.id
                wheelPoint = element.center
                if let center = element.center { AgentCursorEvent(action: .move, point: center).post() }
            }
        }
        let result = try driver.act("scroll", arguments)
        // cua-driver will not scroll Electron and Chromium windows in the
        // background; a wheel posted to the app does, so send one, at the
        // point or element, else mid-window.
        if Driver.describe(result, fallback: "").contains("background_unavailable") {
            let frame = target.window.frame
            let point = wheelPoint ?? CGPoint(x: frame.midX, y: frame.midY)
            let notches = (arguments["amount"] as? Int ?? 3) * (arguments["by"] as? String == "page" ? 10 : 1)
            AgentCursorEvent(action: .move, point: point).post()
            try BackgroundWheel.scroll(pid: target.pid, window: target.window, at: point, direction: direction, notches: notches)
            return report(["effect": "unverifiable", "route": "2ndscreen_wheel",
                           "summary": "posted \(notches) wheel line(s) \(direction) to the app at (\(Int(point.x)), \(Int(point.y)))"],
                          target, described)
        }
        return report(result, target, described)
    }

    /// Press at one global point, move to another, release. Both ends must be
    /// in the window.
    private static func drag(_ target: Target, _ driver: Driver, _ args: Arguments) throws -> [String: Any] {
        guard let from = try globalPoint(args, "--from-x", "--from-y"), let to = try globalPoint(args, "--to-x", "--to-y") else {
            throw DriverError("drag needs --from-x X --from-y Y --to-x X --to-y Y")
        }
        // cua-driver has no background drag on macOS. Its foreground drag
        // brings the app to the front and moves the real pointer for the
        // gesture, so it is the agent's explicit choice, never a fallback.
        guard args.has("--foreground") else {
            throw DriverError("drag on macOS needs --foreground (foreground: true over MCP): it brings the app to the front and moves "
                + "the real pointer for about a second, so ask the user first")
        }
        let local = try windowPixels([from, to], target, driver)
        var arguments: [String: Any] = ["pid": target.pid, "window_id": target.window.windowID,
                                        "from_x": local[0].x, "from_y": local[0].y,
                                        "to_x": local[1].x, "to_y": local[1].y,
                                        "delivery_mode": "foreground"]
        let modifiers = modifierList(args)
        if !modifiers.isEmpty { arguments["modifier"] = modifiers }
        if let duration = args.value("--duration-ms") {
            guard let milliseconds = Int(duration), (0...10000).contains(milliseconds) else {
                throw DriverError("--duration-ms takes a number from 0 to 10000")
            }
            arguments["duration_ms"] = milliseconds
        }

        AgentCursorEvent(action: .move, point: from).post()
        Thread.sleep(forTimeInterval: 0.4)
        AgentCursorEvent(action: .move, point: to).post()
        // cua-driver restores the frontmost app but leaves the real pointer
        // where the drag ended, on a screen the user may not be watching.
        let pointer = CGEvent(source: nil)?.location
        defer { if let pointer { CGWarpMouseCursorPosition(pointer) } }
        let result = try driver.act("drag", arguments)
        return report(result, target, ["from": ["x": from.x, "y": from.y], "to": ["x": to.x, "y": to.y],
                                       "modifiers": modifiers])
    }

    // MARK: Helpers

    /// The element named by `--index` or `--text`, from a fresh snapshot.
    private static func resolve(_ target: Target, _ driver: Driver, _ args: Arguments,
                                required: Bool) throws -> (Element?, Snapshot) {
        let index = args.value("--index").flatMap(Int.init)
        let text = args.value("--text")
        let snapshot = try driver.state(pid: target.pid, windowID: target.window.windowID)
        if let index {
            guard let element = snapshot.element(index: index) else {
                throw DriverError("no element \(index) in the window; run state again")
            }
            return (element, snapshot)
        }
        if let text {
            guard let element = snapshot.element(text: text) else {
                throw DriverError("no element matches \"\(text)\"; run state to see what is there")
            }
            return (element, snapshot)
        }
        if required { throw DriverError("give --index N, --text TEXT, or --x X --y Y") }
        return (nil, snapshot)
    }

    /// The global point in two options, nil if neither is given.
    private static func globalPoint(_ args: Arguments, _ xName: String, _ yName: String) throws -> CGPoint? {
        let (x, y) = (args.value(xName), args.value(yName))
        if x == nil, y == nil { return nil }
        guard let x = x.flatMap(Double.init), let y = y.flatMap(Double.init) else {
            throw DriverError("give both \(xName) and \(yName) as numbers")
        }
        return CGPoint(x: x, y: y)
    }

    /// Global points as pixels in the window screenshot cua-driver captured
    /// last, which its pixel routes take. Takes one to learn its scale.
    private static func windowPixels(_ points: [CGPoint], _ target: Target, _ driver: Driver) throws -> [CGPoint] {
        let frame = target.window.frame
        for point in points where !frame.contains(point) {
            throw DriverError("(\(point.x), \(point.y)) is outside the window \(frameString(frame))")
        }
        let scratch = NSTemporaryDirectory() + "2ndscreen-pixels-\(getpid()).png"
        defer { try? FileManager.default.removeItem(atPath: scratch) }
        let snapshot = try driver.state(pid: target.pid, windowID: target.window.windowID, screenshot: scratch)
        let width = snapshot.raw["screenshot_width"] as? Double ?? Double(frame.width)
        let scale = width / Double(frame.width)
        return points.map { CGPoint(x: (Double($0.x) - Double(frame.minX)) * scale,
                                    y: (Double($0.y) - Double(frame.minY)) * scale) }
    }

    private static func modifierList(_ args: Arguments) -> [String] {
        args.value("--modifiers")?
            .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? []
    }

    /// Fold cua-driver's result into the output. `effect` says how sure the
    /// driver is that the action landed; "unverifiable" is normal for
    /// pixel clicks and web content, so confirm with `state` or a screenshot.
    private static func report(_ result: [String: Any], _ target: Target, _ described: [String: Any]) -> [String: Any] {
        var output = target.json.merging(described) { $1 }
        let effect = result["effect"] as? String
        output["effect"] = effect
        output["route"] = result["route"]
        if let summary = result["summary"] { output["summary"] = summary }
        if effect == nil || effect == "refused" {
            output["ok"] = false
            var error = Driver.describe(result, fallback: "the action was refused")
            // Background key events address a process, not a window, so with
            // several windows open the driver cannot tell which one to hit.
            if error.contains("same_pid_keyboard_ambiguity") {
                error += "; the app has several windows, so name the field with --index or --text"
            }
            output["error"] = error
        }
        return output
    }

    static func emit(_ object: [String: Any]) {
        let data = try! JSONSerialization.data(
            withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        print(String(data: data, encoding: .utf8)!)
    }
}

/// The window an agent wants to act on, checked to be on the named agent
/// screen so that agents never touch windows on the user's own displays.
struct Target {
    let screen: ScreenInfo
    let pid: Int32
    let window: WindowInfo

    init(_ args: Arguments) throws {
        guard let name = args.value("--screen") else { throw DriverError("give the screen with --screen NAME") }
        guard let pid = args.value("--pid").flatMap(Int32.init) else { throw DriverError("give the app with --pid PID") }

        // Naming the screen also tells the app it is still in use.
        var listRequest = ControlRequest(command: .screenList)
        listRequest.screen = name
        let list = try sendControlRequest(listRequest)
        guard let screen = list.screens?.first(where: { $0.name == name }) else {
            throw DriverError("no screen named \"\(name)\"")
        }
        let bounds = CGRect(x: screen.frame.x, y: screen.frame.y, width: screen.frame.width, height: screen.frame.height)
        let windows = WindowMover.windows(ofPID: pid)
        let wanted = args.value("--window-id").flatMap(UInt32.init)
        let onScreen = windows.filter { bounds.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }

        if let wanted {
            guard let window = windows.first(where: { $0.windowID == wanted }) else {
                throw DriverError("pid \(pid) has no on-screen window \(wanted)")
            }
            guard onScreen.contains(where: { $0.windowID == wanted }) else {
                throw DriverError("window \(wanted) is not on screen \"\(name)\"; move it there first")
            }
            self.window = window
        } else {
            guard let window = onScreen.first else {
                throw DriverError("pid \(pid) has no window on screen \"\(name)\"; launch or move it there first")
            }
            self.window = window
        }
        self.screen = screen
        self.pid = pid
    }

    var json: [String: Any] {
        ["screen": screen.name, "pid": pid, "windowID": window.windowID, "app": window.appName,
         "windowFrame": ["x": window.frame.minX, "y": window.frame.minY,
                         "width": window.frame.width, "height": window.frame.height]]
    }
}

func frameString(_ rect: CGRect) -> String {
    "(\(Int(rect.minX)), \(Int(rect.minY)), \(Int(rect.width))x\(Int(rect.height)))"
}
