import Foundation

/// The request/response protocol between the `2ndscreen` command-line tool
/// and the menu bar app, which owns every screen.
///
/// Each connection carries one JSON request line and one JSON response line
/// over a Unix socket that only the current user can open.
public enum ControlProtocol {
    /// `~/Library/Application Support/2ndscreen/control.sock`
    public static var socketURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("2ndscreen", isDirectory: true)
            .appendingPathComponent("control.sock")
    }
}

public struct ControlRequest: Codable {
    public enum Command: String, Codable {
        case screenCreate = "screen.create"
        case screenList = "screen.list"
        case screenDestroy = "screen.destroy"
        case appLaunch = "app.launch"
        case windowMove = "window.move"
        case screenshot
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
    public var pid: Int32?
    public var windowID: UInt32?
    /// Where `screenshot` writes its PNG.
    public var output: String?

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
    /// cua-driver reports element frames in.
    public var frame: Frame

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

public struct ControlResponse: Codable {
    public var ok: Bool
    public var error: String?
    public var screen: ScreenInfo?
    public var screens: [ScreenInfo]?
    public var pid: Int32?
    public var windows: [WindowSummary]?
    public var output: String?

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
