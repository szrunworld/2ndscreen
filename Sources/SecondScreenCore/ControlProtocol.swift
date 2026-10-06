import Foundation

/// The request/response protocol between the `2ndscreen` command-line tool
/// and the menu bar app, which owns every screen.
///
/// Each connection carries one JSON request line and one JSON response line
/// over a Unix socket that only the current user can open.
public enum ControlProtocol {
    /// `~/Library/Application Support/2ndscreen/control.sock`, or
    /// `$SECONDSCREEN_SOCKET`, which lets a second build of the app run beside
    /// the usual one, as when testing a change.
    /// Whether this process uses `$SECONDSCREEN_SOCKET`. The app then runs
    /// as a side instance for testing: beside the usual one, without the
    /// primary screen or the global hot key.
    public static var isSideInstance: Bool {
        !(ProcessInfo.processInfo.environment["SECONDSCREEN_SOCKET"] ?? "").isEmpty
    }

    public static var socketURL: URL {
        if let path = ProcessInfo.processInfo.environment["SECONDSCREEN_SOCKET"], !path.isEmpty {
            return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        }
        return primarySocketURL
    }

    /// The usual app's socket, whichever this process uses.
    public static var primarySocketURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("2ndscreen", isDirectory: true)
            .appendingPathComponent("control.sock")
    }

    /// Whether an app is listening on `url`. A crashed one leaves its socket
    /// file behind, which refuses connections.
    public static func isListening(_ url: URL) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0, var address = try? unixAddress(url.path) else { return false }
        defer { close(fd) }
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
            }
        }
    }
}

public struct ControlRequest: Codable {
    public enum Command: String, Codable {
        case screenCreate = "screen.create"
        case screenList = "screen.list"
        case screenDestroy = "screen.destroy"
        /// Change an agent screen's size in place.
        case screenResize = "screen.resize"
        case appLaunch = "app.launch"
        case windowMove = "window.move"
        /// Hand an app's windows back to the user's main display and stop
        /// keeping them on the agent screen.
        case windowRelease = "window.release"
        case screenshot
        /// Read a window's accessibility tree.
        case windowState = "window.state"
        /// Click, type, press keys, scroll or drag in a window, in the background.
        case input
        case androidList = "android.list"
        case androidShow = "android.show"
        case androidHide = "android.hide"
        case androidScreenshot = "android.screenshot"
        case androidTap = "android.tap"
        case androidSwipe = "android.swipe"
        case androidType = "android.type"
        case androidKey = "android.key"
    }

    public var command: Command
    /// The screen to create, destroy, or act on.
    public var screen: String?
    public var width: Int?
    public var height: Int?
    public var hiDPI: Bool?
    public var bundleID: String?
    /// Path to an `.app` bundle, such as a fresh build.
    public var path: String?
    /// Launch another instance even if the app is already running.
    public var newInstance: Bool?
    /// Size the window to the screen's visible area instead of keeping its size.
    public var fill: Bool?
    /// `app.launch`, `window.move`: keep the screen sized to the app's main
    /// window as it changes, such as iPhone Mirroring when the phone rotates.
    public var fitScreen: Bool?
    public var pid: Int32?
    public var windowID: UInt32?
    /// Where `screenshot` writes its PNG.
    public var output: String?
    /// `screenshot`: compose the screen from its windows instead of
    /// capturing the display.
    public var windowsOnly: Bool?
    /// `screen.create`: destroy the screen this many seconds after creation.
    public var ttl: Double?
    /// `screen.create`: destroy the screen after this many seconds without
    /// a request naming it. 0 means never; the app has a default.
    public var idleTimeout: Double?
    /// `screen.create`: destroy the screen when this process exits.
    public var ownerPID: Int32?
    /// `window.state`: only elements whose text or role contains this.
    public var query: String?
    /// `input`: what to do.
    public var input: InputAction?
    /// `android.*`: the device's adb serial; optional when only one is connected.
    public var serial: String?
    /// `android.show`: the longest side of the video in pixels; 0 for full size.
    public var maxSize: Int?
    /// `android.tap` and `android.swipe`: a point in device pixels, as in
    /// `android.screenshot`; a swipe goes on to `toX`, `toY`.
    public var x: Double?
    public var y: Double?
    public var toX: Double?
    public var toY: Double?
    /// `android.swipe`: how long the finger takes, in seconds.
    public var duration: Double?
    /// `android.type`: the text to type.
    public var text: String?
    /// `android.key`: a name such as "back", "home" or "enter", or a keycode.
    public var key: String?

    public init(command: Command) {
        self.command = command
    }
}

public struct ScreenInfo: Codable {
    public enum Kind: String, Codable {
        /// The menu bar app's own screen, managed from its menu.
        case primary
        /// Created through the control socket for an agent.
        case agent
    }

    public var name: String
    public var kind: Kind
    public var displayID: UInt32
    /// Size in points.
    public var width: Int
    public var height: Int
    public var hiDPI: Bool
    /// Global frame in CoreGraphics coordinates (top-left origin), the space
    /// accessibility reports element frames in.
    public var frame: Frame
    /// Seconds until the TTL destroys the screen, if it has one.
    public var expiresIn: Int?
    /// Seconds without use after which the screen is destroyed, if any.
    public var idleTimeout: Int?
    /// The process whose exit destroys the screen, if any.
    public var ownerPID: Int32?

    public init(name: String, kind: Kind, displayID: UInt32, width: Int, height: Int,
                hiDPI: Bool, frame: Frame) {
        self.name = name
        self.kind = kind
        self.displayID = displayID
        self.width = width
        self.height = height
        self.hiDPI = hiDPI
        self.frame = frame
    }
}

public struct Frame: Codable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(_ rect: CGRect) {
        x = rect.minX
        y = rect.minY
        width = rect.width
        height = rect.height
    }
}

public struct WindowSummary: Codable {
    public var pid: Int32
    public var windowID: UInt32
    public var app: String
    public var title: String
    public var frame: Frame

    public init(_ window: WindowInfo, frame: CGRect? = nil) {
        pid = window.pid
        windowID = window.windowID
        app = window.appName
        title = window.title
        self.frame = Frame(frame ?? window.frame)
    }
}

/// One input action in a window on an agent screen. Points are global,
/// top-left-origin points and must fall in the window.
public struct InputAction: Codable {
    public enum Kind: String, Codable {
        case click, type, key, scroll, drag, hover
        /// AXPress on one element of the window's last `window.state`, by
        /// index, and nothing else: no pointer, focus, key or event fallback.
        /// A kind of its own rather than a click option, so an app that
        /// predates it refuses the request when decoding it instead of
        /// clicking with events.
        case accessibilityPress
    }

    public var kind: Kind
    /// `click`: "left" (default) or "right", and 1 or 2 clicks.
    public var button: String?
    public var count: Int?
    public var x: Double?
    public var y: Double?
    /// `drag`: where to release.
    public var toX: Double?
    public var toY: Double?
    /// An element by its index in the window's last `window.state`.
    public var index: Int?
    /// An element by its text, from a fresh read of the window.
    public var text: String?
    /// `type`: the text to enter.
    public var value: String?
    /// `type`: set the field's whole text to `value` instead of adding to it;
    /// needs the field named.
    public var replace: Bool?
    /// `key`: a key name such as return, a, f5 or down, and modifiers
    /// (cmd, shift, option, ctrl).
    public var key: String?
    public var modifiers: [String]?
    /// `key`: press the modifiers as keys of their own around the key, all
    /// sent to the app in the background, instead of through its menus;
    /// iPhone Mirroring takes ⌘V only this way.
    public var holdModifiers: Bool?
    /// `scroll`: up, down, left or right; notches (default 3); "line" or "page".
    public var direction: String?
    public var amount: Int?
    public var by: String?
    /// `drag`: let the action take the real pointer and the foreground.
    public var foreground: Bool?
    public var durationMs: Int?

    public init(_ kind: Kind) {
        self.kind = kind
    }

    public var point: CGPoint? {
        guard let x, let y else { return nil }
        return CGPoint(x: x, y: y)
    }
}

/// An Android device adb knows about, and its mirror window if it has one.
public struct AndroidDeviceInfo: Codable {
    public var serial: String
    /// "device" when usable; also "unauthorized", "offline", ...
    public var state: String
    public var model: String?
    public var mirroring: Bool
    /// The mirror window's frame, in the same space as screen frames.
    public var frame: Frame?
    /// The mirrored video's size in pixels. It is scaled down from the
    /// device's own size when that exceeds `maxSize`; `adb shell input`
    /// takes device pixels (`adb shell wm size`).
    public var width: Int?
    public var height: Int?

    public init(serial: String, state: String, model: String?, mirroring: Bool) {
        self.serial = serial
        self.state = state
        self.model = model
        self.mirroring = mirroring
    }
}

public struct ControlResponse: Codable {
    public var ok: Bool
    public var error: String?
    public var screen: ScreenInfo?
    public var screens: [ScreenInfo]?
    public var pid: Int32?
    public var windows: [WindowSummary]?
    public var output: String?
    /// `window.state` and `input`: the window acted on.
    public var window: WindowSummary?
    /// `window.state`: the elements, and the tree they come from.
    public var elements: [AXElementInfo]?
    public var tree: String?
    /// `input`: how the action was delivered, such as `ax.press` or
    /// `event.pid`, and the element it went to, if any.
    public var route: String?
    public var element: AXElementInfo?
    public var android: [AndroidDeviceInfo]?

    public init(ok: Bool = true) {
        self.ok = ok
    }

    public static func failure(_ message: String) -> ControlResponse {
        var response = ControlResponse(ok: false)
        response.error = message
        return response
    }
}

public enum ControlClientError: LocalizedError {
    case notRunning
    case io(String)

    public var errorDescription: String? {
        switch self {
        case .notRunning: return "2ndscreen is not running; open 2ndscreen.app first"
        case .io(let message): return message
        }
    }
}

/// Send one request to the running app and wait for its response.
public func sendControlRequest(_ request: ControlRequest, timeout: TimeInterval = 60) throws -> ControlResponse {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw ControlClientError.io("socket: \(String(cString: strerror(errno)))") }
    defer { close(fd) }

    var seconds = timeval(tv_sec: Int(timeout), tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &seconds, socklen_t(MemoryLayout<timeval>.size))

    var address = try unixAddress(ControlProtocol.socketURL.path)
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0 else { throw ControlClientError.notRunning }

    var payload = try JSONEncoder().encode(request)
    payload.append(0x0A)
    try writeAll(fd, payload)
    let line = try readLine(fd)
    return try JSONDecoder().decode(ControlResponse.self, from: line)
}

// MARK: Socket helpers shared by the client and the app's server.

public func unixAddress(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard bytes.count < capacity else { throw ControlClientError.io("socket path too long: \(path)") }
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
        buffer.copyBytes(from: bytes)
        buffer[bytes.count] = 0
    }
    return address
}

public func writeAll(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
        var offset = 0
        while offset < buffer.count {
            let written = write(fd, buffer.baseAddress! + offset, buffer.count - offset)
            guard written > 0 else { throw ControlClientError.io("write: \(String(cString: strerror(errno)))") }
            offset += written
        }
    }
}

/// Read up to the first newline. Requests and responses are single lines.
public func readLine(_ fd: Int32, limit: Int = 1 << 20) throws -> Data {
    var data = Data()
    var byte: UInt8 = 0
    while data.count < limit {
        let count = read(fd, &byte, 1)
        if count == 0 { break }
        guard count > 0 else { throw ControlClientError.io("read: \(String(cString: strerror(errno)))") }
        if byte == 0x0A { return data }
        data.append(byte)
    }
    guard !data.isEmpty else { throw ControlClientError.io("connection closed without a response") }
    return data
}

extension CGRect {
    public init(_ frame: Frame) {
        self.init(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
    }
}
