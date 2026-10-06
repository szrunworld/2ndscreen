import Foundation
import ImageIO
import UniformTypeIdentifiers

/// `2ndscreen mcp`: the CLI as a Model Context Protocol server over stdio.
///
/// Each tool call runs this same executable with the matching command-line
/// arguments, so the MCP tools behave exactly like the CLI, guards included.
/// Screenshots come back as image content, downscaled for the model.
enum MCPServer {
    static let protocolVersion = "2025-06-18"

    static func run() -> Never {
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty,
                  let data = line.data(using: .utf8),
                  let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            if let response = handle(message) {
                send(response)
            }
        }
        exit(0)
    }

    private static func handle(_ message: [String: Any]) -> [String: Any]? {
        let id = message["id"]
        let method = message["method"] as? String ?? ""
        let params = message["params"] as? [String: Any] ?? [:]
        // Notifications carry no id and get no response.
        guard let id else { return nil }

        switch method {
        case "initialize":
            let requested = params["protocolVersion"] as? String
            return result(id, [
                "protocolVersion": requested ?? protocolVersion,
                "capabilities": ["tools": [String: Any]()],
                "serverInfo": ["name": "2ndscreen", "version": "0.1.0"],
                "instructions": """
                    Private virtual screens for testing macOS apps without touching the user's \
                    screen, pointer, or focus. Create a screen, launch the app there, look with \
                    state or screenshot, act with click/type/key/scroll/drag, verify, then quit the app and \
                    destroy the screen. Only act on apps you launched.
                    """,
            ])
        case "ping":
            return result(id, [:])
        case "tools/list":
            return result(id, ["tools": tools.map(\.definition)])
        case "tools/call":
            guard let name = params["name"] as? String, let tool = tools.first(where: { $0.name == name }) else {
                return failure(id, code: -32602, "unknown tool")
            }
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            return result(id, call(tool, arguments))
        default:
            return failure(id, code: -32601, "method not found: \(method)")
        }
    }

    // MARK: Tools

    struct Tool {
        let name: String
        let description: String
        let properties: [String: [String: Any]]
        let required: [String]
        /// Command-line words for the given arguments.
        let words: ([String: Any]) -> [String]
        /// An argument naming a PNG to return as image content, if any.
        var image: (([String: Any]) -> String?)? = nil

        var definition: [String: Any] {
            ["name": name, "description": description,
             "inputSchema": ["type": "object", "properties": properties, "required": required]]
        }
    }

    private static let string: [String: Any] = ["type": "string"]
    private static let integer: [String: Any] = ["type": "integer"]
    private static let boolean: [String: Any] = ["type": "boolean"]
    private static let number: [String: Any] = ["type": "number"]

    private static func described(_ base: [String: Any], _ text: String) -> [String: Any] {
        base.merging(["description": text]) { $1 }
    }

    /// Properties naming the window, shared by the tools that act on one.
    private static let windowTarget: [String: [String: Any]] = [
        "screen": described(string, "Agent screen name"),
        "pid": described(integer, "Process ID of the app, from app_launch"),
        "window_id": described(integer, "Window ID; needed when the app has several windows"),
    ]

    private static let elementTarget: [String: [String: Any]] = [
        "index": described(integer, "Element index from the latest state"),
        "text": described(string, "Visible text or label of the element"),
    ]

    private static let pointTarget: [String: [String: Any]] = [
        "x": described(number, "Global x, if no element"),
        "y": described(number, "Global y, if no element"),
    ]

    static let tools: [Tool] = [
        Tool(name: "screen_create",
             description: "Create a private virtual screen. Without width and height it matches the main display's full-screen area.",
             properties: [
                "name": described(string, "Unique name, e.g. after your task"),
                "width": described(integer, "Width in points"),
                "height": described(integer, "Height in points"),
                "hidpi": described(boolean, "Render at 2x; defaults to the main display's scale. Needs at least 800 points on the long side and 525 on the short side"),
                "ttl": described(string, "Destroy after this long, e.g. 30m"),
                "idle_timeout": described(string, "Destroy after this long unused; default 60m, 0 for never"),
             ],
             required: [],
             words: { a in
                 var w = ["screen", "create"]
                 if let v = a["name"] as? String { w += ["--name", v] }
                 if let width = intValue(a["width"]), let height = intValue(a["height"]) { w += ["--size", "\(width)x\(height)"] }
                 if let v = a["hidpi"] as? Bool { w.append(v ? "--hidpi" : "--no-hidpi") }
                 if let v = a["ttl"] as? String { w += ["--ttl", v] }
                 if let v = a["idle_timeout"] as? String { w += ["--idle-timeout", v] }
                 return w
             }),
        Tool(name: "screen_list",
             description: "List screens with their global frames. Frames move when screens are added or removed.",
             properties: [:], required: [],
             words: { _ in ["screen", "list"] }),
        Tool(name: "screen_destroy",
             description: "Destroy an agent screen. Its windows move to the user's displays, so quit your app first.",
             properties: ["name": described(string, "Agent screen name")], required: ["name"],
             words: { a in ["screen", "destroy", a["name"] as? String ?? ""] }),
        Tool(name: "screen_resize",
             description: "Change an agent screen's size in place, keeping HiDPI where the size allows.",
             properties: [
                "name": described(string, "Screen name"),
                "width": described(integer, "Width in points"),
                "height": described(integer, "Height in points"),
             ],
             required: ["name", "width", "height"],
             words: { a in ["screen", "resize", a["name"] as? String ?? "",
                            "--size", "\(intValue(a["width"]) ?? 0)x\(intValue(a["height"]) ?? 0)"] }),
        Tool(name: "app_launch",
             description: "Launch an app onto a screen without activating it. Refuses an app that is already running unless new_instance is set.",
             properties: [
                "screen": described(string, "Screen name"),
                "bundle_id": described(string, "Bundle ID of an installed app"),
                "path": described(string, "Path to an .app bundle, such as a fresh build"),
                "new_instance": described(boolean, "Launch a separate instance"),
                "fill": described(boolean, "Size the window to the screen"),
                "fit_screen": described(boolean, "Keep the screen sized to the app's main window as it changes, e.g. iPhone Mirroring turning landscape"),
             ],
             required: ["screen"],
             words: { a in
                 var w = ["app", "launch", "--screen", a["screen"] as? String ?? ""]
                 if let v = a["bundle_id"] as? String { w += ["--bundle", v] }
                 if let v = a["path"] as? String { w += ["--path", v] }
                 if a["new_instance"] as? Bool == true { w.append("--new-instance") }
                 if a["fill"] as? Bool == true { w.append("--fill") }
                 if a["fit_screen"] as? Bool == true { w.append("--fit-screen") }
                 return w
             }),
        Tool(name: "window_move",
             description: "Move an app's windows onto a screen and keep its future windows there.",
             properties: [
                "screen": described(string, "Screen name"),
                "pid": described(integer, "Process ID"),
                "window_id": described(integer, "Only this window"),
                "fill": described(boolean, "Size the window to the screen"),
                "fit_screen": described(boolean, "Keep the screen sized to the app's main window as it changes, e.g. iPhone Mirroring turning landscape"),
             ],
             required: ["screen", "pid"],
             words: { a in
                 var w = ["window", "move", "--screen", a["screen"] as? String ?? "", "--pid", "\(intValue(a["pid"]) ?? 0)"]
                 if let v = intValue(a["window_id"]) { w += ["--window-id", "\(v)"] }
                 if a["fill"] as? Bool == true { w.append("--fill") }
                 if a["fit_screen"] as? Bool == true { w.append("--fit-screen") }
                 return w
             }),
        Tool(name: "window_release",
             description: "Give an app's windows on an agent screen back to the user's main display, and stop keeping its windows on the screen.",
             properties: [
                "screen": described(string, "Screen name"),
                "pid": described(integer, "Process ID"),
                "window_id": described(integer, "Only this window"),
             ],
             required: ["screen", "pid"],
             words: { a in
                 var w = ["window", "release", "--screen", a["screen"] as? String ?? "", "--pid", "\(intValue(a["pid"]) ?? 0)"]
                 if let v = intValue(a["window_id"]) { w += ["--window-id", "\(v)"] }
                 return w
             }),
        Tool(name: "screenshot",
             description: "Capture a screen. Returns the image.",
             properties: [
                "screen": described(string, "Screen name"),
                "output": described(string, "Also keep the full-size PNG at this path"),
             ],
             required: ["screen"],
             words: { a in ["screenshot", "--screen", a["screen"] as? String ?? "", "--output", a["output"] as? String ?? ""] },
             image: { a in a["output"] as? String }),
        Tool(name: "state",
             description: "Read a window's controls (indexes, labels, values, frames) and accessibility tree. Set screenshot to also get an image.",
             properties: windowTarget.merging([
                "query": described(string, "Only elements matching this text"),
                "screenshot": described(boolean, "Include a screenshot of the window"),
             ]) { $1 },
             required: ["screen", "pid"],
             words: { a in
                 var w = ["state"] + targetWords(a)
                 if let v = a["query"] as? String { w += ["--query", v] }
                 if let v = a["screenshot_path"] as? String { w += ["--screenshot", v] }
                 return w
             },
             image: { a in a["screenshot_path"] as? String }),
        Tool(name: "click",
             description: "Click an element in the background, by index or text, or a global point. Set button to right for a context menu, or double for a double-click.",
             properties: windowTarget.merging(elementTarget) { $1 }.merging(pointTarget) { $1 }.merging([
                "button": ["type": "string", "enum": ["left", "right"], "description": "Default left"],
                "double": described(boolean, "Double-click"),
             ]) { $1 },
             required: ["screen", "pid"],
             words: { a in
                 var w = ["click"] + targetWords(a) + elementWords(a) + pointWords(a)
                 if a["button"] as? String == "right" { w.append("--right") }
                 if a["double"] as? Bool == true { w.append("--double") }
                 return w
             }),
        Tool(name: "hover",
             description: "Rest the pointer on an element or global point in the background, without clicking, to open a menu or panel a page shows on hover. Then click its options as usual.",
             properties: windowTarget.merging(elementTarget) { $1 }.merging(pointTarget) { $1 },
             required: ["screen", "pid"],
             words: { a in ["hover"] + targetWords(a) + elementWords(a) + pointWords(a) }),
        Tool(name: "type",
             description: "Type text into an element (by index or text), or into the focused one.",
             properties: windowTarget.merging(elementTarget) { $1 }.merging([
                "value": described(string, "Text to type"),
                "replace": described(boolean, "Replace the field's text instead of adding to it; needs index or text"),
             ]) { $1 },
             required: ["screen", "pid", "value"],
             words: { a in
                 ["type"] + targetWords(a) + elementWords(a) + ["--value", a["value"] as? String ?? ""]
                     + (a["replace"] as? Bool == true ? ["--replace"] : [])
             }),
        Tool(name: "key",
             description: "Press a key, optionally with modifiers, e.g. key return, or key n with modifiers [cmd].",
             properties: windowTarget.merging([
                "key": described(string, "Key name, e.g. return, escape, tab, a"),
                "modifiers": ["type": "array", "items": string, "description": "cmd, shift, option, ctrl"],
             ]) { $1 },
             required: ["screen", "pid", "key"],
             words: { a in
                 var w = ["key"] + targetWords(a) + ["--key", a["key"] as? String ?? ""]
                 if let mods = a["modifiers"] as? [String], !mods.isEmpty { w += ["--modifiers", mods.joined(separator: ",")] }
                 return w
             }),
        Tool(name: "scroll",
             description: "Scroll with the mouse wheel over an element or global point, or without one, with arrow or page keys in the focused area.",
             properties: windowTarget.merging(elementTarget) { $1 }.merging(pointTarget) { $1 }.merging([
                "direction": ["type": "string", "enum": ["up", "down", "left", "right"]],
                "amount": described(integer, "Wheel notches or key presses, 1 to 50; default 3"),
                "by": ["type": "string", "enum": ["line", "page"], "description": "Step size; default line"],
             ]) { $1 },
             required: ["screen", "pid", "direction"],
             words: { a in
                 var w = ["scroll"] + targetWords(a) + elementWords(a) + pointWords(a)
                 w += ["--direction", a["direction"] as? String ?? ""]
                 if let v = intValue(a["amount"]) { w += ["--amount", "\(v)"] }
                 if let v = a["by"] as? String { w += ["--by", v] }
                 return w
             }),
        Tool(name: "drag",
             description: "Press at one global point, move to another, and release, e.g. to move a slider or drop an item. Both points must be in the window. macOS has no background drag: this brings the app to the front and moves the user's real pointer for about a second, so it runs only with foreground set, and it can miss; check the result.",
             properties: windowTarget.merging([
                "from_x": described(number, "Global x to press at"),
                "from_y": described(number, "Global y to press at"),
                "to_x": described(number, "Global x to release at"),
                "to_y": described(number, "Global y to release at"),
                "modifiers": ["type": "array", "items": string, "description": "Held throughout: cmd, shift, option, ctrl"],
                "duration_ms": described(integer, "How long the move takes; default 500"),
                "foreground": described(boolean, "Required: accept taking the user's pointer and focus briefly"),
             ]) { $1 },
             required: ["screen", "pid", "from_x", "from_y", "to_x", "to_y"],
             words: { a in
                 var w = ["drag"] + targetWords(a)
                 for name in ["from_x", "from_y", "to_x", "to_y"] {
                     w += ["--" + name.replacingOccurrences(of: "_", with: "-"), "\(doubleValue(a[name]) ?? 0)"]
                 }
                 if let mods = a["modifiers"] as? [String], !mods.isEmpty { w += ["--modifiers", mods.joined(separator: ",")] }
                 if let v = intValue(a["duration_ms"]) { w += ["--duration-ms", "\(v)"] }
                 if a["foreground"] as? Bool == true { w.append("--foreground") }
                 return w
             }),
    ]

    private static func pointWords(_ a: [String: Any]) -> [String] {
        guard let x = doubleValue(a["x"]), let y = doubleValue(a["y"]) else { return [] }
        return ["--x", "\(x)", "--y", "\(y)"]
    }

    private static func targetWords(_ a: [String: Any]) -> [String] {
        var w = ["--screen", a["screen"] as? String ?? "", "--pid", "\(intValue(a["pid"]) ?? 0)"]
        if let v = intValue(a["window_id"]) { w += ["--window-id", "\(v)"] }
        return w
    }

    private static func elementWords(_ a: [String: Any]) -> [String] {
        if let v = intValue(a["index"]) { return ["--index", "\(v)"] }
        if let v = a["text"] as? String { return ["--text", v] }
        return []
    }

    private static func intValue(_ value: Any?) -> Int? {
        (value as? Int) ?? (value as? Double).map(Int.init) ?? (value as? String).flatMap(Int.init)
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        (value as? Double) ?? (value as? Int).map(Double.init) ?? (value as? String).flatMap(Double.init)
    }

    // MARK: Calls

    private static func call(_ tool: Tool, _ arguments: [String: Any]) -> [String: Any] {
        var arguments = arguments
        // Images go through a scratch PNG unless the caller wants to keep one.
        var scratch: String?
        if tool.name == "screenshot", arguments["output"] == nil {
            scratch = NSTemporaryDirectory() + "2ndscreen-mcp-\(UUID().uuidString).png"
            arguments["output"] = scratch
        }
        if tool.name == "state", arguments["screenshot"] as? Bool == true {
            scratch = NSTemporaryDirectory() + "2ndscreen-mcp-\(UUID().uuidString).png"
            arguments["screenshot_path"] = scratch
        }
        defer { if let scratch { try? FileManager.default.removeItem(atPath: scratch) } }

        let (status, output) = runSelf(tool.words(arguments))
        var content: [[String: Any]] = [["type": "text", "text": output]]
        if status == 0, let path = tool.image?(arguments), let image = imageContent(path) {
            content.append(image)
        }
        return ["content": content, "isError": status != 0]
    }

    /// Run this executable with `words` and capture its output.
    private static func runSelf(_ words: [String]) -> (Int32, String) {
        let process = Process()
        process.executableURL = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
        process.arguments = words
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
        } catch {
            return (1, "{\"ok\": false, \"error\": \"\(error.localizedDescription)\"}")
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    /// The PNG at `path`, at most 1280 px wide, as JPEG image content.
    private static func imageContent(_ path: String, maxPixels: Int = 1280) -> [String: Any]? {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxPixels,
                  kCGImageSourceCreateThumbnailWithTransform: true,
              ] as CFDictionary)
        else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return ["type": "image", "data": (data as Data).base64EncodedString(), "mimeType": "image/jpeg"]
    }

    // MARK: JSON-RPC

    private static func result(_ id: Any, _ result: [String: Any]) -> [String: Any] {
        ["jsonrpc": "2.0", "id": id, "result": result]
    }

    private static func failure(_ id: Any, code: Int, _ message: String) -> [String: Any] {
        ["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]]
    }

    private static func send(_ message: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes])
        else { return }
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    }
}
