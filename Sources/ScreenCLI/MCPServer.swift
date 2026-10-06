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
    /// The version agreed in initialize; resource_link content needs 2025-06-18 or later.
    private static var negotiatedVersion = protocolVersion

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
            negotiatedVersion = requested ?? protocolVersion
            return result(id, [
                "protocolVersion": negotiatedVersion,
                "capabilities": ["tools": [String: Any](), "resources": [String: Any]()],
                "serverInfo": ["name": "2ndscreen", "version": "0.1.0"],
                "instructions": """
                    Private virtual screens for testing macOS apps without touching the user's \
                    screen, pointer, or focus. Create a screen, launch the app there, look with \
                    state or screenshot, act with click/type/key/scroll/drag, verify, then quit the app and \
                    destroy the screen. Only act on apps you launched. \
                    The task_* tools run whole skill tasks (such as boss.collect-resumes) in the \
                    background through the bundled task runtime; they are the same as `2ndscreen task`. \
                    Their results link the task as 2ndscreen://tasks/TASK_ID (its status) and \
                    2ndscreen://tasks/TASK_ID/artifacts (its saved files); read those with resources/read.
                    """,
            ])
        case "ping":
            return result(id, [:])
        case "resources/list":
            // Tasks are not enumerated; each task_* result links its own.
            return result(id, ["resources": [[String: Any]]()])
        case "resources/templates/list":
            return result(id, ["resourceTemplates": TaskResource.templates])
        case "resources/read":
            guard let uri = params["uri"] as? String, let resource = TaskResource(uri: uri) else {
                return failure(id, code: -32602, "unknown resource: expected 2ndscreen://tasks/TASK_ID or 2ndscreen://tasks/TASK_ID/artifacts")
            }
            switch resource.read(runSelf) {
            case .success(let contents):
                return result(id, ["contents": [contents]])
            case .failure(let problem):
                return ["jsonrpc": "2.0", "id": id,
                        "error": ["code": problem.code, "message": problem.message, "data": problem.data]]
            }
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
        /// For strict tools: a problem with the arguments' names or types,
        /// reported without running anything. Values are left to the CLI.
        var check: (([String: Any]) -> String?)? = nil

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
    ] + taskTools

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

        if let problem = tool.check?(arguments) {
            let line: [String: Any] = ["ok": false, "command": NSNull(),
                                       "error": ["code": "invalid_input", "message": problem]]
            let data = (try? JSONSerialization.data(withJSONObject: line, options: [.withoutEscapingSlashes])) ?? Data()
            return ["content": [["type": "text", "text": String(data: data, encoding: .utf8) ?? ""]], "isError": true]
        }
        let (status, output) = runSelf(tool.words(arguments), closeInput: tool.check != nil)
        var content: [[String: Any]] = [["type": "text", "text": output]]
        if status == 0, let path = tool.image?(arguments), let image = imageContent(path) {
            content.append(image)
        }
        if status == 0, let taskID = TaskResource.taskID(tool: tool.name, arguments: arguments, output: output) {
            content += TaskResource.links(taskID, asResourceLinks: negotiatedVersion >= "2025-06-18")
        }
        return ["content": content, "isError": status != 0]
    }

    /// Run this executable with `words` and capture its output.
    /// `closeInput` keeps the child off this server's stdin, which carries the protocol.
    static func runSelf(_ words: [String], closeInput: Bool = false) -> (Int32, String) {
        let process = Process()
        process.executableURL = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
        process.arguments = words
        if closeInput { process.standardInput = FileHandle.nullDevice }
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

// MARK: Task tools

/// The `2ndscreen task` commands as tools. Each builds exactly the words a
/// person would type and runs them through the same CLI; the runtime's own
/// parser checks the values. Here only names and JSON types are checked, so
/// that nothing is guessed: an unknown argument, a string for a number, a
/// fraction or a 1 for true is refused before anything runs.
extension MCPServer {
    enum ArgumentKind { case string, integer, boolean, budget }

    static let taskTools: [Tool] = {
        let id: [String: Any] = described(string, "Task ID returned by task_run")
        let simple: [(String, String, String)] = [
            ("task_status", "status", "A task's state: target and committed counts, phase, why it waits, model use and the output folder."),
            ("task_pause", "pause", "Pause a task after the step under way."),
            ("task_resume", "resume", "Resume a paused task, or one waiting for the user once they have logged in or solved a captcha."),
            ("task_cancel", "cancel", "Cancel a task. It stops after the step under way; committed resumes stay."),
            ("task_artifacts", "artifacts", "The files a task saved, with their completeness."),
        ]
        var tools = [Tool(
            name: "task_run",
            description: "Start a skill task in the background and return its taskId at once, e.g. skill_id boss.collect-resumes: save up to limit resumes of candidates already in BOSS直聘 conversations for job into output. Read-only: it never greets, requests resumes or sends anything. Follow it with task_status.",
            properties: [
                "skill_id": described(string, "Skill task ID, e.g. boss.collect-resumes"),
                "job": described(string, "Job title to match in BOSS直聘's job filter; several matches stop the task to ask"),
                "limit": described(integer, "How many resumes must be saved, 1 to 10000"),
                "output": described(string, "Absolute folder; the task writes under output/TASK_ID"),
                "source": ["type": "string", "enum": ["conversations", "recommend"], "description": "Default conversations, the only source supported now"],
                "mode": ["type": "string", "enum": ["available", "original-only"], "description": "Default available: page captures count when no original file can be saved"],
                "browse_limit": described(integer, "Candidates to look at before stopping; not below limit"),
                "deadline": described(string, "ISO time with a zone after which no new candidate is started"),
                "budget": ["type": "object", "additionalProperties": integer,
                           "description": "Budget fields to whole numbers, e.g. {\"taskModelCalls\": 0}"],
                "take_over": described(boolean, "Use a BOSS直聘 window the runtime did not launch"),
                "keep_window": described(boolean, "Leave the window on the agent screen when the task ends"),
                "analysis": ["type": "string", "enum": ["off", "on"]],
                "account": described(string, "The BOSS直聘 account the task works in, a key the user chose such as hr-zhang. The runtime cannot read it from the window; without it the task waits until task_bind_account names it"),
            ],
            required: ["skill_id", "job", "limit", "output"],
            words: { a in
                var w = ["task", "run"]
                if let v = a["skill_id"] as? String { w.append(v) }
                for (name, flag) in [("job", "--job"), ("output", "--output"), ("source", "--source"), ("mode", "--mode"),
                                     ("deadline", "--deadline"), ("analysis", "--analysis"), ("account", "--account")] {
                    if let v = a[name] as? String { w += [flag, v] }
                }
                if let v = exactInteger(a["limit"]) { w += ["--limit", String(v)] }
                if let v = exactInteger(a["browse_limit"]) { w += ["--browse-limit", String(v)] }
                if let budget = a["budget"] as? [String: Any] {
                    for field in budget.keys.sorted() {
                        if let v = exactInteger(budget[field]) { w += ["--budget", "\(field)=\(v)"] }
                    }
                }
                if a["take_over"] as? Bool == true, isBool(a["take_over"]) { w.append("--take-over") }
                if a["keep_window"] as? Bool == true, isBool(a["keep_window"]) { w.append("--keep-window") }
                return w
            },
            check: checker(["skill_id": .string, "job": .string, "limit": .integer, "output": .string, "source": .string,
                            "mode": .string, "browse_limit": .integer, "deadline": .string, "budget": .budget,
                            "take_over": .boolean, "keep_window": .boolean, "analysis": .string, "account": .string]))]
        for (name, verb, text) in simple {
            tools.append(Tool(name: name, description: text, properties: ["task_id": id], required: ["task_id"],
                              words: { a in ["task", verb] + ((a["task_id"] as? String).map { [$0] } ?? []) },
                              check: checker(["task_id": .string])))
        }
        tools.append(Tool(name: "task_inspect_procedure",
                          description: "A learned or seeded procedure version by ID: its steps, status and success counters.",
                          properties: ["procedure_id": described(string, "Procedure ID")], required: ["procedure_id"],
                          words: { a in ["task", "inspect-procedure"] + ((a["procedure_id"] as? String).map { [$0] } ?? []) },
                          check: checker(["procedure_id": .string])))
        tools.append(Tool(name: "task_bind_account",
                          description: "Name the BOSS直聘 account of a task that waits for one (waiting_user, account_changed) or is paused, then task_resume it. The key is the user's own name for the account; a task keeps its account for good.",
                          properties: ["task_id": id, "account": described(string, "Account key, e.g. hr-zhang: letters, digits, '.', '_' or '-'")],
                          required: ["task_id", "account"],
                          words: { a in ["task", "bind-account"] + [a["task_id"], a["account"]].compactMap { $0 as? String } },
                          check: checker(["task_id": .string, "account": .string])))
        tools.append(Tool(name: "task_agents",
                          description: "Agent runs, blocked ones first, each with its state (working, idle, blocked, paused, done, failed) and, when blocked, what it waits for: an approval, an answer from the user, or something the agent reported. Use it to find the run that needs a person.",
                          properties: ["all": described(boolean, "Also list finished runs")], required: [],
                          words: { a in ["task", "agents"] + (a["all"] as? Bool == true && isBool(a["all"]) ? ["--all"] : []) },
                          check: checker(["all": .boolean])))
        tools.append(Tool(name: "task_usage",
                          description: "Provider calls, tokens and cost summed per agent, provider, model or task, over the last 24 hours or since a time. Unknown token counts stay unknown, and calls without a price are counted apart.",
                          properties: ["by": ["type": "string", "enum": ["agent", "provider", "model", "task"], "description": "Default agent"],
                                       "since": described(string, "ISO time with a zone; default 24 hours ago")],
                          required: [],
                          words: { a in
                              var w = ["task", "usage"]
                              if let v = a["by"] as? String { w += ["--by", v] }
                              if let v = a["since"] as? String { w += ["--since", v] }
                              return w
                          },
                          check: checker(["by": .string, "since": .string])))
        return tools
    }()

    static func checker(_ kinds: [String: ArgumentKind]) -> ([String: Any]) -> String? {
        { arguments in
            for name in arguments.keys.sorted() {
                let value = arguments[name]!
                guard let kind = kinds[name] else { return "unknown argument \(name)" }
                switch kind {
                case .string:
                    guard value is String, !isBool(value), !(value is NSNumber) else { return "\(name) must be a string" }
                case .integer:
                    guard exactInteger(value) != nil else { return "\(name) must be a whole number" }
                case .boolean:
                    guard isBool(value) else { return "\(name) must be true or false" }
                case .budget:
                    guard let fields = value as? [String: Any], fields.values.allSatisfy({ exactInteger($0) != nil })
                    else { return "\(name) must map budget fields to whole numbers" }
                }
            }
            return nil
        }
    }

    /// A JSON true or false, not a number that happens to be 0 or 1.
    static func isBool(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    /// A JSON number that is exactly a whole number; never a bool, string or fraction.
    static func exactInteger(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, !isBool(number) else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double.rounded() == double, abs(double) <= 9_007_199_254_740_991 else { return nil }
        return number.int64Value
    }
}

// MARK: Task resources

/// A task as an MCP resource, read through the same `2ndscreen task` commands
/// as the tools: 2ndscreen://tasks/TASK_ID is `task status`, and
/// 2ndscreen://tasks/TASK_ID/artifacts is `task artifacts`. Nothing else can
/// be named: no files, no other commands, and reading writes nothing.
struct TaskResource {
    enum Kind { case status, artifacts }

    let taskID: String
    let kind: Kind

    /// The runtime's own task ID rule (packages/task-runtime/src/cli.ts):
    /// 1-128 ASCII letters, digits, '.', '_', ':' or '-', starting with a letter
    /// or digit. Checked character by character over the whole string, so no
    /// trailing newline or other character can slip past an anchor.
    static func validID(_ id: String) -> Bool {
        let scalars = Array(id.unicodeScalars)
        guard (1...128).contains(scalars.count) else { return false }
        func alphanumeric(_ c: Unicode.Scalar) -> Bool {
            ("a"..."z").contains(c) || ("A"..."Z").contains(c) || ("0"..."9").contains(c)
        }
        return alphanumeric(scalars[0]) && scalars.allSatisfy { alphanumeric($0) || ".:_-".unicodeScalars.contains($0) }
    }

    static func uri(_ id: String, _ kind: Kind) -> String {
        "2ndscreen://tasks/\(id)" + (kind == .artifacts ? "/artifacts" : "")
    }

    /// Exactly 2ndscreen://tasks/ID or 2ndscreen://tasks/ID/artifacts: no
    /// other host, path, query, fragment, user, port or percent-encoding.
    init?(uri: String) {
        let prefix = "2ndscreen://tasks/"
        guard uri.utf8.count <= 256, uri.hasPrefix(prefix) else { return nil }
        let rest = String(uri.dropFirst(prefix.count))
        let parts = rest.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        switch parts.count {
        case 1: kind = .status
        case 2 where parts[1] == "artifacts": kind = .artifacts
        default: return nil
        }
        guard Self.validID(parts[0]) else { return nil }
        taskID = parts[0]
    }

    struct Problem: Error {
        let code: Int
        let message: String
        let data: [String: Any]
    }

    /// The current status report or artifact index, as the CLI prints its `result`.
    func read(_ runSelf: ([String], Bool) -> (Int32, String)) -> Result<[String: Any], Problem> {
        let uri = Self.uri(taskID, kind)
        let (status, output) = runSelf(["task", kind == .status ? "status" : "artifacts", taskID], true)
        guard let line = output.split(separator: "\n").last.map(String.init),
              let data = line.data(using: .utf8),
              let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return .failure(Problem(code: -32603, message: "the task runtime gave no readable answer", data: ["uri": uri]))
        }
        guard status == 0, reply["ok"] as? Bool == true, let value = reply["result"] else {
            let error = reply["error"] as? [String: Any] ?? [:]
            let code = error["code"] as? String ?? "internal"
            // MCP's resource-not-found code for a task the ledger does not have.
            return .failure(Problem(code: code == "not_found" ? -32002 : -32603,
                                    message: error["message"] as? String ?? "the task runtime refused",
                                    data: ["uri": uri, "error": error]))
        }
        guard let text = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes, .sortedKeys]) else {
            return .failure(Problem(code: -32603, message: "the task runtime's answer is not JSON", data: ["uri": uri]))
        }
        return .success(["uri": uri, "mimeType": "application/json", "text": String(decoding: text, as: UTF8.self)])
    }

    static let templates: [[String: Any]] = [
        ["uriTemplate": "2ndscreen://tasks/{taskId}", "name": "task",
         "title": "Task status", "mimeType": "application/json",
         "description": "A task's current status report, as task_status returns it"],
        ["uriTemplate": "2ndscreen://tasks/{taskId}/artifacts", "name": "task-artifacts",
         "title": "Task artifacts", "mimeType": "application/json",
         "description": "The artifacts a task has recorded, as task_artifacts returns them"],
    ]

    /// The task a successful task_* call is about: from the runtime's own answer
    /// (run's taskId, a status or record's id) or, for artifacts, the argument it was given.
    static func taskID(tool: String, arguments: [String: Any], output: String) -> String? {
        guard tool.hasPrefix("task_"), tool != "task_inspect_procedure",
              let line = output.split(separator: "\n").last.map(String.init),
              let data = line.data(using: .utf8),
              let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              reply["ok"] as? Bool == true
        else { return nil }
        let result = reply["result"] as? [String: Any]
        let candidate: String?
        switch tool {
        case "task_run": candidate = result?["taskId"] as? String
        case "task_status": candidate = (result?["task"] as? [String: Any])?["id"] as? String
        case "task_artifacts": candidate = arguments["task_id"] as? String
        default: candidate = result?["id"] as? String
        }
        return candidate.flatMap { validID($0) ? $0 : nil }
    }

    /// resource_link items on 2025-06-18 and later; before that, one text line naming the URIs.
    static func links(_ id: String, asResourceLinks: Bool) -> [[String: Any]] {
        let status = uri(id, .status)
        let artifacts = uri(id, .artifacts)
        guard asResourceLinks else {
            return [["type": "text", "text": "resources: \(status) \(artifacts)"]]
        }
        return [
            ["type": "resource_link", "uri": status, "name": "task \(id)", "title": "Task status",
             "mimeType": "application/json", "description": "Current status report; read with resources/read"],
            ["type": "resource_link", "uri": artifacts, "name": "task \(id) artifacts", "title": "Task artifacts",
             "mimeType": "application/json", "description": "Recorded artifacts and their completeness; read with resources/read"],
        ]
    }
}
