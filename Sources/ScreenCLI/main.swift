import Foundation
import SecondScreenCore

// 2ndscreen — let agents create screens and run apps on them, through the
// running 2ndscreen.app. Every command prints one JSON object and exits
// non-zero on failure.

let usage = """
usage:
  2ndscreen screen create [--name NAME] [--size WxH] [--hidpi | --no-hidpi]
  2ndscreen screen list
  2ndscreen screen destroy NAME
  2ndscreen app launch --screen NAME (--bundle ID | --path APP) [--new-instance] [--fill]
  2ndscreen window move --screen NAME --pid PID [--window-id ID] [--fill]
  2ndscreen screenshot --screen NAME --output FILE.png

  2ndscreen state --screen NAME --pid PID [--window-id ID] [--query TEXT] [--screenshot FILE.png]
  2ndscreen click --screen NAME --pid PID (--index N | --text TEXT | --x X --y Y)
  2ndscreen type  --screen NAME --pid PID --value TEXT [--index N | --text TEXT]
  2ndscreen key   --screen NAME --pid PID --key NAME [--modifiers cmd,shift]

state, click, type and key act through cua-driver's background routes and
only on a window that is on the named screen. Indexes come from state; click
and type re-read the window, so run state again after the UI changes.

Sizes are in points. Without --size, a new screen matches the main display's
full-screen area, so its full-screen preview is pixel for pixel. Frames in
the output use global top-left coordinates, the same space as cua-driver.
"""

func fail(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

/// Splits `--flag value` and bare `--flag` options from positional words.
struct Arguments {
    var positional: [String] = []
    private var options: [String: String] = [:]
    private var flags: Set<String> = []

    /// Options that take a value; anything else starting with `--` is a flag.
    static let valued: Set<String> = ["--name", "--size", "--screen", "--bundle", "--path",
                                      "--pid", "--window-id", "--output", "--query", "--screenshot",
                                      "--index", "--text", "--x", "--y", "--value", "--key",
                                      "--modifiers"]

    init(_ words: [String]) {
        var iterator = words.makeIterator()
        while let word = iterator.next() {
            if Self.valued.contains(word) {
                guard let value = iterator.next() else { fail("\(word) needs a value") }
                options[word] = value
            } else if word.hasPrefix("--") {
                flags.insert(word)
            } else {
                positional.append(word)
            }
        }
    }

    func value(_ name: String) -> String? { options[name] }
    func has(_ name: String) -> Bool { flags.contains(name) }
}

let words = Array(CommandLine.arguments.dropFirst())
guard words.count >= 1, !words.contains("--help"), !words.contains("-h") else {
    print(usage)
    exit(words.isEmpty ? 2 : 0)
}
let args = Arguments(words)
if let first = args.positional.first, DriverCommands.verbs.contains(first) {
    DriverCommands.run(first, args)
}
let verb = args.positional.prefix(2).joined(separator: " ")

var request: ControlRequest
switch verb {
case "screen create":
    request = ControlRequest(command: .screenCreate)
    request.screen = args.value("--name")
    if let size = args.value("--size") {
        let parts = size.lowercased().split(separator: "x").compactMap { Int($0) }
        guard parts.count == 2 else { fail("--size takes WIDTHxHEIGHT, such as 1280x800") }
        request.width = parts[0]
        request.height = parts[1]
    }
    if args.has("--hidpi") { request.hiDPI = true }
    if args.has("--no-hidpi") { request.hiDPI = false }
case "screen list":
    request = ControlRequest(command: .screenList)
case "screen destroy":
    request = ControlRequest(command: .screenDestroy)
    guard let name = args.positional.dropFirst(2).first ?? args.value("--name") else {
        fail("screen destroy needs a screen name")
    }
    request.screen = name
case "app launch":
    request = ControlRequest(command: .appLaunch)
    request.screen = args.value("--screen")
    request.bundleID = args.value("--bundle")
    request.path = args.value("--path")
    request.newInstance = args.has("--new-instance")
    request.fill = args.has("--fill")
    guard request.bundleID != nil || request.path != nil else { fail("app launch needs --bundle or --path") }
case "window move":
    request = ControlRequest(command: .windowMove)
    request.screen = args.value("--screen")
    guard let pid = args.value("--pid").flatMap(Int32.init) else { fail("window move needs --pid") }
    request.pid = pid
    request.windowID = args.value("--window-id").flatMap(UInt32.init)
    request.fill = args.has("--fill")
default:
    if args.positional.first == "screenshot" {
        request = ControlRequest(command: .screenshot)
        request.screen = args.value("--screen")
        request.output = args.value("--output")
    } else {
        fail("unknown command\n\n" + usage)
    }
}

do {
    let response = try sendControlRequest(request)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    print(String(data: try encoder.encode(response), encoding: .utf8)!)
    exit(response.ok ? 0 : 1)
} catch {
    fail(error.localizedDescription, code: 1)
}
