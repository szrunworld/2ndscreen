import CoreGraphics
import Foundation
import SecondScreenCore

/// `state`, `click`, `type`, `key`, `scroll`, `drag`, `hover` and `ax-press`: observe
/// and drive a window on an agent screen through the running app, which holds
/// the Accessibility permission and checks the window is on the named screen.
/// `ax-press --index N` presses one element of the last state through
/// accessibility only; a verb of its own, so a CLI that predates it stops
/// with an unknown command instead of clicking.
/// Each prints one JSON object and exits non-zero on failure.
enum DriverCommands {
    static let verbs: Set<String> = ["state", "click", "type", "key", "scroll", "drag", "hover", "ax-press"]

    static func run(_ verb: String, _ args: Arguments) -> Never {
        do {
            var request = try target(args, command: verb == "state" ? .windowState : .input)
            if verb == "state" {
                request.query = args.value("--query")
            } else {
                request.input = try action(verb, args)
            }
            let response = try sendControlRequest(request)
            guard response.ok else { throw CommandError(response.error ?? "\(verb) failed") }
            var output = describe(response, screen: request.screen ?? "")
            if verb == "state", let screenshot = args.value("--screenshot") {
                output["screenshot"] = try self.screenshot(response, to: screenshot)
            }
            emit(output)
            exit(0)
        } catch {
            emit(["ok": false, "error": error.localizedDescription])
            exit(1)
        }
    }

    private static func target(_ args: Arguments, command: ControlRequest.Command) throws -> ControlRequest {
        guard let screen = args.value("--screen") else { throw CommandError("give the screen with --screen NAME") }
        guard let pid = args.value("--pid").flatMap(Int32.init) else { throw CommandError("give the app with --pid PID") }
        var request = ControlRequest(command: command)
        request.screen = screen
        request.pid = pid
        if let id = args.value("--window-id") {
            guard let windowID = UInt32(id) else { throw CommandError("--window-id takes a window number") }
            request.windowID = windowID
        }
        return request
    }

    private static func action(_ verb: String, _ args: Arguments) throws -> InputAction {
        // `ax-press` is its own kind on the wire too, so an app that does not
        // know it refuses the request instead of clicking with events.
        let kind: InputAction.Kind = switch verb {
        case "ax-press": .accessibilityPress
        case "click": .click
        case "type": .type
        case "key": .key
        case "scroll": .scroll
        case "hover": .hover
        default: .drag
        }
        var action = InputAction(kind)
        if let index = args.value("--index") {
            guard let number = Int(index) else { throw CommandError("--index takes a number from state") }
            action.index = number
        }
        action.text = args.value("--text")
        action.modifiers = args.value("--modifiers")?
            .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }

        switch kind {
        case .accessibilityPress:
            // Exactly one element from the last state, pressed through accessibility and nothing else.
            var extra: [String] = []
            if action.text != nil { extra.append("--text") }
            if args.value("--x") != nil || args.value("--y") != nil { extra.append("--x/--y") }
            for flag in ["--right", "--double"] where args.has(flag) { extra.append(flag) }
            if action.modifiers != nil { extra.append("--modifiers") }
            guard extra.isEmpty else {
                throw CommandError("ax-press takes only --index N; drop \(extra.joined(separator: ", "))")
            }
            guard action.index != nil else { throw CommandError("ax-press needs --index N from state") }
        case .click:
            guard !(args.has("--right") && args.has("--double")) else {
                throw CommandError("give --right or --double, not both")
            }
            if args.has("--right") { action.button = "right" }
            if args.has("--double") { action.count = 2 }
            try setPoint(&action, args, "--x", "--y")
            guard action.point != nil || action.index != nil || action.text != nil else {
                throw CommandError("give --index N, --text TEXT, or --x X --y Y")
            }
        case .type:
            guard let value = args.value("--value") else { throw CommandError("type needs --value TEXT") }
            action.value = value
            if args.has("--replace") { action.replace = true }
        case .key:
            guard let key = args.value("--key") else { throw CommandError("key needs --key NAME, such as return") }
            action.key = key
        case .scroll:
            action.direction = args.value("--direction")?.lowercased()
            if let amount = args.value("--amount") {
                guard let notches = Int(amount) else { throw CommandError("--amount takes a number from 1 to 50") }
                action.amount = notches
            }
            if let by = args.value("--by") {
                guard ["line", "page"].contains(by) else { throw CommandError("--by takes line or page") }
                action.by = by
            }
            try setPoint(&action, args, "--x", "--y")
        case .hover:
            try setPoint(&action, args, "--x", "--y")
            guard action.point != nil || action.index != nil || action.text != nil else {
                throw CommandError("give --index N, --text TEXT, or --x X --y Y")
            }
        case .drag:
            try setPoint(&action, args, "--from-x", "--from-y")
            guard let to = try point(args, "--to-x", "--to-y"), action.point != nil else {
                throw CommandError("drag needs --from-x X --from-y Y --to-x X --to-y Y")
            }
            action.toX = to.x
            action.toY = to.y
            action.foreground = args.has("--foreground")
            if let duration = args.value("--duration-ms") {
                guard let milliseconds = Int(duration), (0...10000).contains(milliseconds) else {
                    throw CommandError("--duration-ms takes a number from 0 to 10000")
                }
                action.durationMs = milliseconds
            }
        }
        return action
    }

    private static func setPoint(_ action: inout InputAction, _ args: Arguments, _ x: String, _ y: String) throws {
        guard let point = try point(args, x, y) else { return }
        action.x = point.x
        action.y = point.y
    }

    /// The global point in two options, nil if neither is given.
    private static func point(_ args: Arguments, _ xName: String, _ yName: String) throws -> CGPoint? {
        let (x, y) = (args.value(xName), args.value(yName))
        if x == nil, y == nil { return nil }
        guard let x = x.flatMap(Double.init), let y = y.flatMap(Double.init) else {
            throw CommandError("give both \(xName) and \(yName) as numbers")
        }
        return CGPoint(x: x, y: y)
    }

    /// The window's part of a screenshot of its screen.
    private static func screenshot(_ response: ControlResponse, to path: String) throws -> String {
        guard let window = response.window else { throw CommandError("no window to capture") }
        var request = ControlRequest(command: .screenshot)
        request.screen = try screenName(containing: window.frame)
        let scratch = NSTemporaryDirectory() + "2ndscreen-state-\(getpid()).png"
        request.output = scratch
        request.windowsOnly = true
        defer { try? FileManager.default.removeItem(atPath: scratch) }
        let shot = try sendControlRequest(request)
        guard shot.ok else { throw CommandError(shot.error ?? "screenshot failed") }
        let output = (path as NSString).expandingTildeInPath
        try Images.crop(scratch, to: output, frame: window.frame, screenFrame: try screenFrame(request.screen!))
        return output
    }

    private static func screenName(containing frame: Frame) throws -> String {
        let center = CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
        let screens = try sendControlRequest(ControlRequest(command: .screenList)).screens ?? []
        guard let screen = screens.first(where: { CGRect($0.frame).contains(center) }) else {
            throw CommandError("the window is on no screen")
        }
        return screen.name
    }

    private static func screenFrame(_ name: String) throws -> Frame {
        let screens = try sendControlRequest(ControlRequest(command: .screenList)).screens ?? []
        guard let screen = screens.first(where: { $0.name == name }) else { throw CommandError("no screen \(name)") }
        return screen.frame
    }

    private static func describe(_ response: ControlResponse, screen: String) -> [String: Any] {
        var output: [String: Any] = ["ok": true, "screen": screen]
        if let window = response.window {
            output["pid"] = window.pid
            output["windowID"] = window.windowID
            output["app"] = window.app
            output["windowFrame"] = json(window.frame)
        }
        if let elements = response.elements { output["elements"] = elements.map(json) }
        if let tree = response.tree { output["tree"] = tree }
        if let route = response.route { output["route"] = route }
        if let element = response.element { output["element"] = json(element) }
        return output
    }

    static func json(_ frame: Frame) -> [String: Any] {
        ["x": frame.x, "y": frame.y, "width": frame.width, "height": frame.height]
    }

    static func json(_ element: AXElementInfo) -> [String: Any] {
        var object: [String: Any] = ["index": element.index, "role": element.role]
        if let label = element.label { object["label"] = label }
        if let value = element.value { object["value"] = value }
        if let actions = element.actions { object["actions"] = actions }
        if let frame = element.frame { object["frame"] = json(frame) }
        return object
    }

    static func emit(_ object: [String: Any]) {
        let data = try! JSONSerialization.data(
            withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        print(String(data: data, encoding: .utf8)!)
    }
}

struct CommandError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
