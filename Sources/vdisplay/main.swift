import AppKit
import CGVirtualDisplayPrivate

// vdisplay — create a software-backed display that lives as long as this
// process does.
//
//   swift run vdisplay [--width 1920] [--height 1080] [--hidpi] [--name "2ndscreen"]
//                      [--preview [--fps 15] [--float]]
//
// --width/--height are in points. With --hidpi the display is backed by 2x
// pixels, like a Retina panel. --preview opens a live view of the display in
// a window on the main screen; --float keeps that window above others.
// Ctrl-C (or SIGTERM) removes the display.

struct Options {
    var width = 1920
    var height = 1080
    var hiDPI = false
    var name = "2ndscreen"
    var refreshRate = 60.0
    var preview = false
    var previewFPS: Int32 = 15
    var floatPreview = false
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
        default:
            FileHandle.standardError.write("unknown argument: \(arg)\n".data(using: .utf8)!)
            exit(2)
        }
    }
    return options
}

func makeDisplay(_ options: Options) -> CGVirtualDisplay? {
    let scale = options.hiDPI ? 2 : 1
    let descriptor = CGVirtualDisplayDescriptor()
    descriptor.setDispatchQueue(DispatchQueue.main)
    descriptor.name = options.name
    descriptor.maxPixelsWide = UInt32(options.width * scale)
    descriptor.maxPixelsHigh = UInt32(options.height * scale)
    // A 24-inch-class physical size keeps macOS' default scaling sensible.
    descriptor.sizeInMillimeters = CGSize(width: 527, height: 296)
    descriptor.vendorID = 0x3256  // arbitrary, stable IDs so macOS remembers arrangement
    descriptor.productID = 0x0002
    descriptor.serialNum = 0x0001
    descriptor.terminationHandler = { _, _ in
        print("virtual display terminated by the system")
        exit(1)
    }

    guard let display = CGVirtualDisplay(descriptor: descriptor) else { return nil }

    let settings = CGVirtualDisplaySettings()
    settings.hiDPI = options.hiDPI ? 1 : 0
    settings.modes = [
        CGVirtualDisplayMode(
            width: UInt(options.width * scale),
            height: UInt(options.height * scale),
            refreshRate: options.refreshRate),
    ]
    guard display.apply(settings) else { return nil }
    return display
}

let options = parseOptions()
guard let display = makeDisplay(options) else {
    FileHandle.standardError.write("failed to create virtual display\n".data(using: .utf8)!)
    exit(1)
}

let displayID = display.displayID
print("created virtual display id=\(displayID) \(options.width)x\(options.height)pt hidpi=\(options.hiDPI)")

// An accessory app: no Dock icon, and showing the preview never activates it.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var preview: DisplayPreview?

// Report where macOS placed it once the display arrangement settles.
DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
    let bounds = CGDisplayBounds(displayID)
    print("display bounds (global points): \(bounds)")
    fflush(stdout)

    guard options.preview else { return }
    let livePreview = DisplayPreview(
        displayID: displayID, title: "\(options.name) preview",
        framesPerSecond: options.previewFPS, floating: options.floatPreview)
    preview = livePreview
    Task {
        do {
            try await livePreview.start()
            print("preview streaming at up to \(options.previewFPS) fps")
        } catch {
            print("preview failed: \(error.localizedDescription)")
        }
        fflush(stdout)
    }
}

// Exit cleanly on Ctrl-C / SIGTERM. The display dies with the process;
// releasing it first would fire terminationHandler and report a failure.
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        print("virtual display removed")
        exit(0)
    }
    source.resume()
    signalSources.append(source)
}
fflush(stdout)
app.run()
