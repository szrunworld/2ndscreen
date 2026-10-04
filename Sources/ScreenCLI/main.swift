import Foundation
import SecondScreenCore

// 2ndscreen — let agents create screens and run apps on them, through the
// running 2ndscreen.app. Every command prints one JSON object and exits
// non-zero on failure.

let usage = """
usage:
  2ndscreen screen create [--name NAME] [--size WxH] [--hidpi | --no-hidpi]
                          [--ttl DURATION] [--idle-timeout DURATION] [--owner-pid PID]
  2ndscreen screen list
  2ndscreen screen destroy NAME
  2ndscreen screen resize NAME --size WxH
  2ndscreen app launch --screen NAME (--bundle ID | --path APP) [--new-instance] [--fill | --fit-screen]
  2ndscreen window move --screen NAME --pid PID [--window-id ID] [--fill | --fit-screen]
  2ndscreen window release --screen NAME --pid PID [--window-id ID]
  2ndscreen screenshot --screen NAME --output FILE.png [--windows]

  2ndscreen state --screen NAME --pid PID [--window-id ID] [--query TEXT] [--screenshot FILE.png]
  2ndscreen click --screen NAME --pid PID (--index N | --text TEXT | --x X --y Y) [--right | --double]
  2ndscreen ax-press --screen NAME --pid PID [--window-id ID] --index N
  2ndscreen type  --screen NAME --pid PID --value TEXT [--index N | --text TEXT] [--replace]
  2ndscreen key   --screen NAME --pid PID --key NAME [--modifiers cmd,shift]
  2ndscreen scroll --screen NAME --pid PID --direction up|down|left|right [--amount N] [--by line|page]
                   [--index N | --text TEXT | --x X --y Y]
  2ndscreen drag  --screen NAME --pid PID --from-x X --from-y Y --to-x X --to-y Y --foreground
                  [--modifiers shift] [--duration-ms MS]

  2ndscreen agent --screen NAME --pid PID [--window-id ID] [--allow-submit] [--foreground] [--no-elements]
                  [--no-learn] [--max-steps N] INSTRUCTION
  2ndscreen agent --android [--serial SERIAL] [--allow-submit] [--max-steps N] INSTRUCTION
  2ndscreen mcp      serve these commands as MCP tools over stdio

  2ndscreen task run SKILL_ID --job TEXT --limit N --output DIR [...]   see 2ndscreen task --help
  2ndscreen task status|pause|resume|cancel|artifacts TASK_ID
  2ndscreen task inspect-procedure PROCEDURE_ID
  2ndscreen task bind-account TASK_ID ACCOUNT_KEY
  2ndscreen vision          on-device OCR, compare and stitch: one JSON request on stdin
  2ndscreen agent-bridge    one task-runtime unit with the UI-TARS agent, JSON lines (for the runtime)

  2ndscreen android devices
  2ndscreen android pair HOST:PORT CODE
  2ndscreen android connect HOST:PORT
  2ndscreen android disconnect [HOST:PORT]
  2ndscreen android show [--serial SERIAL] [--screen NAME] [--max-size PIXELS]
  2ndscreen android hide [--serial SERIAL]
  2ndscreen android screenshot [--serial SERIAL] --output FILE.png
  2ndscreen android tap   [--serial SERIAL] --x X --y Y
  2ndscreen android swipe [--serial SERIAL] --x X --y Y --to-x X --to-y Y [--duration SECONDS]
  2ndscreen android type  [--serial SERIAL] --text TEXT
  2ndscreen android key   [--serial SERIAL] --key back|home|recents|enter|delete|KEYCODE
  2ndscreen android adb ARGS...   run the bundled adb with these arguments

  2ndscreen iphone show [--screen NAME]   iPhone Mirroring on an agent screen ("phone")
  2ndscreen iphone hide
  2ndscreen iphone screenshot [--screen NAME] --output FILE.png
  2ndscreen iphone tap  [--screen NAME] --x X --y Y
  2ndscreen iphone type [--screen NAME] --text TEXT
  2ndscreen iphone key  [--screen NAME] --key home|switcher|spotlight|return|delete|KEY

Android points are device pixels, as in the screenshot. With the phone's
mirror open, tap, swipe and key go through it at once; without it, through
adb. type pastes through the phone's clipboard, so it takes any text and a
Chinese keyboard on the phone cannot turn it into pinyin.

iPhone points are the screenshot's pixels, two to a window point. tap and
key reach iPhone Mirroring in the background; type pastes, bringing it to
the front for about a second once you leave the Mac idle. It cannot swipe or
scroll. hide quits iPhone Mirroring, handing the phone back.

state, click, type, key, scroll and drag act in the background, through
accessibility or input events posted to the app, and only on a window that is
on the named screen. drag is the exception: macOS offers no background drag,
so it brings the app to the front and moves the real pointer, and runs only
with --foreground. Indexes come from the window's last state; run state again
after the UI changes.

ax-press presses one element from the last state through accessibility only
(AXPress); it never moves the pointer, takes focus or sends events, and fails
if the element does not advertise AXPress.

agent runs INSTRUCTION with a UI-TARS vision model, which reads screenshots of
the screen and the app's controls, acting on a listed control by its number
and on anything else by sight; --no-elements leaves the controls out. Without --allow-submit it stops before anything
that would send: Enter, typed text ending in a newline, or a click on Send.
With --android it works on a phone instead, by its screenshots, through the
android commands. When it stops before sending, the result's "pending" holds
the 2ndscreen arguments that would send. It reads ARK_API_KEY, ARK_MODEL and
ARK_BASE_URL from the environment or ~/.config/2ndscreen/ark.env.

A run that worked is kept as a procedure for its app, under
~/.config/2ndscreen/procedures: the next run of the same instruction repeats
its steps by finding their controls again, without the model, and hands the
rest to the model if a control is missing or the screen ends up elsewhere.
The result's modelCalls says how many requests a run made. --no-learn
neither uses nor keeps procedures.

Durations take s, m or h (90s, 30m, 2h). A screen is destroyed when its TTL
passes, when no command has named it for its idle timeout (default 60m; 0
turns it off), or when its owner process exits.

screenshot --windows composes the screen from its windows, each captured on its
own, instead of capturing the display; agent and state --screenshot use it.

Sizes are in points. Without --size, a new screen matches the main display's
full-screen area, so its full-screen preview is pixel for pixel. Frames in
the output use global top-left coordinates.
HiDPI follows the main display. macOS allows it only from 800 points on the
long side and 525 on the short side; smaller screens are created at 1x.
screen resize changes a screen's size in place, up to the largest size it
was created to allow (2560x1440 or its own size, whichever is larger).
--fit-screen keeps the screen sized to the app's main window, plus the menu
bar, as the window changes: iPhone Mirroring turning landscape, or resized.
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
                                      "--modifiers", "--ttl", "--idle-timeout", "--owner-pid",
                                      "--serial", "--max-size", "--duration",
                                      "--direction", "--amount", "--by", "--from-x", "--from-y",
                                      "--to-x", "--to-y", "--duration-ms", "--max-steps"]

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

/// "90s", "30m", "2h", or bare seconds.
func parseDuration(_ text: String) -> Double? {
    let units: [Character: Double] = ["s": 1, "m": 60, "h": 3600]
    if let unit = text.last.flatMap({ units[$0] }), let value = Double(text.dropLast()) {
        return value * unit
    }
    return Double(text)
}

let words = Array(CommandLine.arguments.dropFirst())
if words == ["mcp"] {
    MCPServer.run()
}
// Before the help check, so `android adb ... -h` reaches adb.
if words.first == "android", words.count > 1 {
    AndroidCommands.run(Array(words.dropFirst()))
}
// These take their own words and answer --help themselves.
if words.first == "vision" {
    runLocalVision(Array(words.dropFirst()))
}
if words.first == "task" {
    TaskCommand.run(Array(words.dropFirst()))
}
guard words.count >= 1, !words.contains("--help"), !words.contains("-h") else {
    print(usage)
    exit(words.isEmpty ? 2 : 0)
}
let args = Arguments(words)
if let first = args.positional.first, DriverCommands.verbs.contains(first) {
    DriverCommands.run(first, args)
}
if args.positional.first == "agent" {
    AgentCommand.run(args)
}
if args.positional.first == "agent-bridge" {
    AgentBridgeCommand.run(args)
}
if args.positional.first == "iphone" {
    IPhoneCommands.run(args)
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
    if let ttl = args.value("--ttl") {
        guard let seconds = parseDuration(ttl) else { fail("--ttl takes a duration such as 30m") }
        request.ttl = seconds
    }
    if let idle = args.value("--idle-timeout") {
        guard let seconds = parseDuration(idle) else { fail("--idle-timeout takes a duration such as 20m, or 0") }
        request.idleTimeout = seconds
    }
    if let owner = args.value("--owner-pid") {
        guard let pid = Int32(owner) else { fail("--owner-pid takes a process ID") }
        request.ownerPID = pid
    }
case "screen list":
    request = ControlRequest(command: .screenList)
case "screen destroy":
    request = ControlRequest(command: .screenDestroy)
    guard let name = args.positional.dropFirst(2).first ?? args.value("--name") else {
        fail("screen destroy needs a screen name")
    }
    request.screen = name
case "screen resize":
    request = ControlRequest(command: .screenResize)
    guard let name = args.positional.dropFirst(2).first ?? args.value("--name") else {
        fail("screen resize needs a screen name")
    }
    request.screen = name
    let parts = (args.value("--size") ?? "").lowercased().split(separator: "x").compactMap { Int($0) }
    guard parts.count == 2 else { fail("screen resize needs --size WIDTHxHEIGHT, such as 1280x800") }
    request.width = parts[0]
    request.height = parts[1]
case "app launch":
    request = ControlRequest(command: .appLaunch)
    request.screen = args.value("--screen")
    request.bundleID = args.value("--bundle")
    request.path = args.value("--path")
    request.newInstance = args.has("--new-instance")
    request.fill = args.has("--fill")
    request.fitScreen = args.has("--fit-screen")
    guard request.bundleID != nil || request.path != nil else { fail("app launch needs --bundle or --path") }
case "window move":
    request = ControlRequest(command: .windowMove)
    request.screen = args.value("--screen")
    guard let pid = args.value("--pid").flatMap(Int32.init) else { fail("window move needs --pid") }
    request.pid = pid
    request.windowID = args.value("--window-id").flatMap(UInt32.init)
    request.fill = args.has("--fill")
    request.fitScreen = args.has("--fit-screen")
case "window release":
    request = ControlRequest(command: .windowRelease)
    request.screen = args.value("--screen")
    guard let pid = args.value("--pid").flatMap(Int32.init) else { fail("window release needs --pid") }
    request.pid = pid
    request.windowID = args.value("--window-id").flatMap(UInt32.init)
default:
    if args.positional.first == "screenshot" {
        request = ControlRequest(command: .screenshot)
        request.screen = args.value("--screen")
        request.output = args.value("--output")
        if args.has("--windows") { request.windowsOnly = true }
    } else {
        fail("unknown command\n\n" + usage)
    }
}

do {
    finish(try sendControlRequest(request))
} catch {
    fail(error.localizedDescription, code: 1)
}
