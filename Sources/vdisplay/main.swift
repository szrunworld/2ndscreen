import AppKit
import SecondScreenCore

// vdisplay — create a software-backed display that lives as long as this
// process does.
//
//   swift run vdisplay [--width 1920] [--height 1080] [--hidpi] [--name "2ndscreen"]
//                      [--preview [--fps 15] [--float]] [--serial 2]
//
// --width/--height are in points. With --hidpi the display is backed by 2x
// pixels, like a Retina panel. --preview opens a live view of the display in
// a window on the main screen; --float keeps that window above others.
// Ctrl-C (or SIGTERM) removes the display.
//
//   vdisplay cursor <move|click> <x> <y>
//   vdisplay cursor hide
//
// Shows the menu bar app's agent cursor at a global point (top-left origin,
// the coordinates accessibility reports). Visual only: the real pointer and the
// app under the point are untouched.

if CommandLine.arguments.dropFirst().first == "cursor" {
    let args = Array(CommandLine.arguments.dropFirst(2))
    guard let action = args.first.flatMap(AgentCursorEvent.Action.init(rawValue:)),
          action == .hide || (args.count == 3 && Double(args[1]) != nil && Double(args[2]) != nil)
    else {
        FileHandle.standardError.write(
            "usage: vdisplay cursor <move|click> <x> <y> | vdisplay cursor hide\n".data(using: .utf8)!)
        exit(2)
    }
    let point = action == .hide ? .zero : CGPoint(x: Double(args[1])!, y: Double(args[2])!)
    AgentCursorEvent(action: action, point: point).post()
    exit(0)
}

struct Options {
    var width = 1920
    var height = 1080
    var hiDPI = false
    var name = "2ndscreen"
    var refreshRate = 60.0
    var preview = false
    var previewFPS: Int32 = 15
    var floatPreview = false
    // Distinct from the menu bar app's display so both can run at once.
    var serialNumber: UInt32 = 2
}

func parseOptions() -> Options {
    var options = Options()
    var args = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = args.next() {
        switch arg {
        case "--width": options.width = args.next().flatMap(Int.init) ?? options.width
        case "--height": options.height = args.next().flatMap(Int.init) ?? options.height
        case "--hidpi": options.hiDPI = true
        case "--name": options.name = args.next() ?? options.name
        case "--refresh": options.refreshRate = args.next().flatMap(Double.init) ?? options.refreshRate
        case "--preview": options.preview = true
        case "--fps": options.previewFPS = args.next().flatMap(Int32.init) ?? options.previewFPS
        case "--float": options.floatPreview = true
        case "--serial": options.serialNumber = args.next().flatMap(UInt32.init) ?? options.serialNumber
        default:
            FileHandle.standardError.write("unknown argument: \(arg)\n".data(using: .utf8)!)
            exit(2)
        }
    }
    return options
}

let options = parseOptions()
guard let display = VirtualDisplay(
    name: options.name,
    mode: .init(width: options.width, height: options.height),
    hiDPI: options.hiDPI,
    refreshRate: options.refreshRate,
    serialNumber: options.serialNumber,
    onTerminate: {
        print("virtual display terminated by the system")
        exit(1)
    })
else {
    FileHandle.standardError.write("failed to create virtual display\n".data(using: .utf8)!)
    exit(1)
}

let displayID = display.displayID
print("created virtual display id=\(displayID) \(display.mode)pt hidpi=\(display.hiDPI)")

// An accessory app: no Dock icon, and showing the preview never activates it.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var preview: DisplayPreview?

// Report where macOS placed it once the display arrangement settles.
DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
    print("display bounds (global points): \(display.bounds)")
    fflush(stdout)

    guard options.preview else { return }
    let livePreview = DisplayPreview(
        displayID: displayID, title: "\(options.name) preview",
        framesPerSecond: options.previewFPS, floating: options.floatPreview)
    preview = livePreview
    Task { @MainActor in
        do {
            try await livePreview.start()
            print("preview streaming at up to \(options.previewFPS) fps")
        } catch {
            print("preview failed: \(error.localizedDescription)")
        }
        fflush(stdout)
    }
}

// Exit cleanly on Ctrl-C / SIGTERM. The display dies with the process.
// `_exit` skips teardown: releasing the display during `exit` fires
// terminationHandler, whose exit(1) would override the status.
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        print("virtual display removed")
        fflush(stdout)
        _exit(0)
    }
    source.resume()
    signalSources.append(source)
}
fflush(stdout)
app.run()
