import Foundation
import SecondScreenCore

/// Input and observation on agent screens, through cua-driver's background
/// routes. 2ndscreen adds the guard that the target window is on the named
/// screen, so an agent cannot act on the user's own windows, and the agent
/// cursor, so a person watching the preview can follow along.
struct Driver {
    let executable: String
    /// cua-driver element tokens are scoped to a session; one per screen lets
    /// a `state` call's indexes stay valid for the next `click`.
    let session: String

    init(screen: String) {
        executable = Self.locate()
        session = "2ndscreen-\(screen)"
    }

    /// `$CUA_DRIVER`, else the first of `cua-driver-local` and `cua-driver`
    /// on PATH or in ~/.local/bin. `cua-driver-local` is the patched build
    /// from scripts/build-patched-cua-driver.sh, which stops dragging the
    /// user back when they switch apps while an agent acts.
    private static func locate() -> String {
        if let explicit = ProcessInfo.processInfo.environment["CUA_DRIVER"], !explicit.isEmpty {
            return explicit
        }
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let directories = path.split(separator: ":").map(String.init) + [NSHomeDirectory() + "/.local/bin"]
        for name in ["cua-driver-local", "cua-driver"] {
            for directory in directories {
                let candidate = "\(directory)/\(name)"
                if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
            }
        }
        return NSHomeDirectory() + "/.local/bin/cua-driver"
    }

    /// Run one cua-driver tool and return its JSON object. Non-JSON output
    /// (cua-driver prints plain text for some failures) becomes `error`.
    /// cua-driver ends a session that has been idle, and rejects calls to it
    /// until it starts again; a screen's name, and so its session, can
    /// outlive that, so start it and retry once.
    func call(_ tool: String, _ arguments: [String: Any]) throws -> [String: Any] {
        let result = try callOnce(tool, arguments)
        guard Self.describe(result, fallback: "").contains("session has ended") else { return result }
        _ = try callOnce("start_session", [:])
        return try callOnce(tool, arguments)
    }

    private func callOnce(_ tool: String, _ arguments: [String: Any]) throws -> [String: Any] {
        guard FileManager.default.isExecutableFile(atPath: executable) else {
            throw DriverError("cua-driver not found; install it or set CUA_DRIVER")
        }
        var arguments = arguments
        arguments["session"] = session
        let payload = String(data: try JSONSerialization.data(withJSONObject: arguments), encoding: .utf8)!

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = [tool, payload]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return object
        }
        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return ["error": text.isEmpty ? "\(tool) exited with status \(process.terminationStatus)" : text]
    }

    /// A fresh accessibility snapshot of one window.
    func state(pid: Int32, windowID: UInt32, query: String? = nil, screenshot: String? = nil) throws -> Snapshot {
        var arguments: [String: Any] = ["pid": pid, "window_id": windowID, "timeout_ms": 5000]
        if let query { arguments["query"] = query }
        if let screenshot {
            arguments["screenshot_out_file"] = (screenshot as NSString).expandingTildeInPath
        } else {
            arguments["include_screenshot"] = false
        }
        let result = try call("get_window_state", arguments)
        guard let snapshotID = result["snapshot_id"] as? String,
              let elements = result["elements"] as? [[String: Any]]
        else {
            throw DriverError(Self.describe(result, fallback: "get_window_state failed"))
        }
        return Snapshot(id: snapshotID, raw: result, elements: elements.map(Element.init))
    }

    /// Run an action that cua-driver can fail transiently: AXPress returns
    /// kAXErrorCannotComplete (-25204) while the target app is busy.
    func act(_ tool: String, _ arguments: [String: Any], attempts: Int = 3) throws -> [String: Any] {
        var result: [String: Any] = [:]
        for attempt in 1...attempts {
            result = try call(tool, arguments)
            let error = (result["error"] as? String) ?? ""
            guard error.contains("-25204"), attempt < attempts else { break }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return result
    }

    static func describe(_ result: [String: Any], fallback: String) -> String {
        if let error = result["error"] as? String { return error }
        if let refusal = result["refusal"] as? [String: Any] {
            return [refusal["code"], refusal["message"]].compactMap { $0 as? String }.joined(separator: ": ")
        }
        if let code = result["code"] as? String { return code }
        return fallback
    }
}

struct DriverError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct Element {
    let index: Int
    let token: String
    let role: String
    let label: String
    let value: String
    let actions: [String]
    /// Global top-left-origin points.
    let frame: CGRect?

    init(_ raw: [String: Any]) {
        index = raw["element_index"] as? Int ?? -1
        token = raw["element_token"] as? String ?? ""
        role = raw["role"] as? String ?? ""
        label = (raw["label"] as? String) ?? (raw["title"] as? String) ?? (raw["description"] as? String) ?? ""
        value = (raw["value"] as? String) ?? ""
        actions = raw["actions"] as? [String] ?? []
        if let frame = raw["frame"] as? [String: Double], let x = frame["x"], let y = frame["y"],
           let w = frame["w"], let h = frame["h"] {
            self.frame = CGRect(x: x, y: y, width: w, height: h)
        } else {
            frame = nil
        }
    }

    var center: CGPoint? { frame.map { CGPoint(x: $0.midX, y: $0.midY) } }

    var json: [String: Any] {
        var object: [String: Any] = ["index": index, "role": role]
        if !label.isEmpty { object["label"] = label }
        if !value.isEmpty { object["value"] = value }
        if !actions.isEmpty { object["actions"] = actions }
        if let frame {
            object["frame"] = ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
        }
        return object
    }
}

struct Snapshot {
    let id: String
    let raw: [String: Any]
    let elements: [Element]

    var tree: String { raw["tree_markdown"] as? String ?? "" }

    func element(index: Int) -> Element? {
        elements.first { $0.index == index }
    }

    /// The element whose text best matches: an exact label or value first,
    /// then one containing the text, then the nearest indexed ancestor of a
    /// tree line containing it. Web and Electron apps often put the visible
    /// text in an unindexed child of the actionable link or row.
    func element(text: String) -> Element? {
        let needle = text.lowercased()
        let indexed = elements.filter { $0.index >= 0 }
        if let exact = indexed.first(where: { $0.label.lowercased() == needle || $0.value.lowercased() == needle }) {
            return exact
        }
        if let partial = indexed.first(where: {
            $0.label.lowercased().contains(needle) || $0.value.lowercased().contains(needle)
        }) {
            return partial
        }
        let lines = tree.components(separatedBy: "\n")
        for (number, line) in lines.enumerated() where line.lowercased().contains(needle) {
            let indent = line.prefix { $0 == " " }.count
            for candidate in lines[...number].reversed() {
                let candidateIndent = candidate.prefix { $0 == " " }.count
                guard candidate == line || candidateIndent < indent,
                      let index = Self.leadingIndex(candidate)
                else { continue }
                return element(index: index)
            }
        }
        return nil
    }

    /// The `[N]` index at the start of a tree line, if any.
    private static func leadingIndex(_ line: String) -> Int? {
        guard let open = line.firstIndex(of: "["), let close = line[open...].firstIndex(of: "]") else { return nil }
        return Int(line[line.index(after: open)..<close])
    }
}
