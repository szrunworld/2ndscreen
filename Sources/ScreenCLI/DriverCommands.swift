import Foundation
import SecondScreenCore

/// `state`, `click`, `type` and `key`: observe and drive a window on an
/// agent screen. Each prints one JSON object and exits non-zero on failure.
enum DriverCommands {
    static let verbs: Set<String> = ["state", "click", "type", "key"]

    static func run(_ verb: String, _ args: Arguments) -> Never {
        do {
            let target = try Target(args)
            let driver = Driver(screen: target.screen.name)
            var output: [String: Any]
            switch verb {
            case "state": output = try state(target, driver, args)
            case "click": output = try click(target, driver, args)
            case "type": output = try type(target, driver, args)
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
        var arguments: [String: Any] = ["pid": target.pid, "window_id": target.window.windowID]
        let point: CGPoint
        var described: [String: Any]

        if let x = args.value("--x").flatMap(Double.init), let y = args.value("--y").flatMap(Double.init) {
            // A global point. cua-driver's pixel route wants coordinates in
            // the window screenshot it captured last, so take one to learn
            // its scale.
            point = CGPoint(x: x, y: y)
            guard target.window.frame.contains(point) else {
                throw DriverError("(\(x), \(y)) is outside the window \(frameString(target.window.frame))")
            }
            let scratch = NSTemporaryDirectory() + "2ndscreen-click-\(getpid()).png"
            defer { try? FileManager.default.removeItem(atPath: scratch) }
            let snapshot = try driver.state(pid: target.pid, windowID: target.window.windowID, screenshot: scratch)
            let width = snapshot.raw["screenshot_width"] as? Double ?? Double(target.window.frame.width)
            let scale = width / Double(target.window.frame.width)
            arguments["x"] = (x - Double(target.window.frame.minX)) * scale
            arguments["y"] = (y - Double(target.window.frame.minY)) * scale
            described = ["point": ["x": x, "y": y]]
        } else {
            let (element, snapshot) = try resolve(target, driver, args, required: true)
            guard let element, let center = element.center else {
                throw DriverError("the element has no frame to click")
            }
            point = center
            arguments["element_token"] = element.token
            described = ["element": element.json, "snapshot": snapshot.id]
        }

        AgentCursorEvent(action: .click, point: point).post()
        Thread.sleep(forTimeInterval: 0.4)  // let the cursor arrive first
        let result = try driver.act("click", arguments)
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
        let modifiers = args.value("--modifiers")?
            .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? []
        let base: [String: Any] = ["pid": target.pid, "window_id": target.window.windowID]
        let result: [String: Any]
        if modifiers.isEmpty {
            result = try driver.act("press_key", base.merging(["key": key]) { $1 })
        } else {
            result = try driver.act("hotkey", base.merging(["keys": modifiers + [key]]) { $1 })
        }
        return report(result, target, ["key": key, "modifiers": modifiers])
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

        let list = try sendControlRequest(ControlRequest(command: .screenList))
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
