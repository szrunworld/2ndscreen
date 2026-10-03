import AppKit

/// Runs the adb that ships inside 2ndscreen.app, which the app and the
/// `2ndscreen` command share so they talk to the same adb server.
public enum ADB {
    public struct Result {
        public var status: Int32
        public var output: String
        public var error: String

        public var ok: Bool { status == 0 }
        /// What to show when the command failed: adb puts some errors on stdout.
        public var message: String {
            let text = error.isEmpty ? output : error
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    public struct Device: Codable, Equatable {
        public var serial: String
        /// "device" when usable; also "unauthorized", "offline", ...
        public var state: String
        public var model: String?

        public var label: String { (model ?? serial).replacingOccurrences(of: "_", with: " ") }
    }

    /// A service the phone advertises over mDNS: the pairing service while
    /// "Pair device with QR code" or "Pair device with pairing code" is
    /// open, and the connect service while wireless debugging is on.
    public struct Service {
        public var name: String
        public var type: String
        public var address: String
    }

    public enum Failure: LocalizedError {
        case notFound

        public var errorDescription: String? {
            "adb not found; build 2ndscreen.app with scripts/bundle-app.sh, or set $ADB"
        }
    }

    /// `$ADB` if set, else the adb in this app's bundle, else the one in the
    /// running 2ndscreen.app, else adb on the PATH.
    public static func executable() -> URL? {
        let fileManager = FileManager.default
        if let path = ProcessInfo.processInfo.environment["ADB"], fileManager.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        var bundles = [Bundle.main.bundleURL]
        bundles += NSRunningApplication.runningApplications(withBundleIdentifier: "io.github.szrunworld.2ndscreen")
            .compactMap(\.bundleURL)
        for bundle in bundles {
            let adb = bundle.appendingPathComponent("Contents/Resources/android/adb")
            if fileManager.isExecutableFile(atPath: adb.path) { return adb }
        }
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        for directory in path.split(separator: ":") {
            let adb = URL(fileURLWithPath: String(directory)).appendingPathComponent("adb")
            if fileManager.isExecutableFile(atPath: adb.path) { return adb }
        }
        return nil
    }

    /// Run adb to completion. Blocks; call off the main thread when it may
    /// take a while (pairing, connecting, pushing).
    @discardableResult
    public static func run(_ arguments: [String], timeout: TimeInterval = 30) throws -> Result {
        let process = try makeProcess(arguments)
        let output = Pipe()
        let error = Pipe()
        process.standardOutput = output
        process.standardError = error
        process.standardInput = FileHandle.nullDevice
        try process.run()

        // Read both pipes while adb runs, or a full pipe would stall it.
        var outData = Data()
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            outData = output.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            errData = error.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        let timedOut = group.wait(timeout: .now() + timeout) == .timedOut
        if timedOut {
            process.terminate()
            group.wait()
        }
        process.waitUntilExit()
        return Result(
            status: process.terminationStatus,
            output: String(decoding: outData, as: UTF8.self),
            error: timedOut ? "adb \(arguments.first ?? "") timed out" : String(decoding: errData, as: UTF8.self))
    }

    /// An adb process to run with its own pipes, such as the mirror's server.
    public static func makeProcess(_ arguments: [String]) throws -> Process {
        guard let adb = executable() else { throw Failure.notFound }
        let process = Process()
        process.executableURL = adb
        process.arguments = arguments
        return process
    }

    /// `adb devices -l`, parsed.
    public static func devices() throws -> [Device] {
        let result = try run(["devices", "-l"], timeout: 10)
        guard result.ok else { throw ControlClientError.io(result.message) }
        return result.output.split(separator: "\n").dropFirst().compactMap { line in
            let fields = line.split(whereSeparator: \.isWhitespace).map(String.init)
            guard fields.count >= 2, !line.hasPrefix("*") else { return nil }
            let model = fields.first { $0.hasPrefix("model:") }.map { String($0.dropFirst(6)) }
            return Device(serial: fields[0], state: fields[1], model: model)
        }
    }

    /// `adb mdns services`, parsed. Lines are "name  type  address".
    public static func services() throws -> [Service] {
        let result = try run(["mdns", "services"], timeout: 10)
        return result.output.split(separator: "\n").compactMap { line in
            let fields = line.split(whereSeparator: \.isWhitespace).map(String.init)
            guard fields.count >= 3, let type = fields.first(where: { $0.hasPrefix("_adb") }),
                  let address = fields.last, address.contains(":") else { return nil }
            return Service(name: fields[0], type: type, address: address)
        }
    }

    /// Starts the adb server where it gets 2ndscreen's Local Network
    /// permission. The app's own process does; the command-line tool asks
    /// the app.
    public static var startServer: () -> Void = { _ = try? run(["start-server"], timeout: 15) }

    /// macOS blocks the local network for an adb server that 2ndscreen did
    /// not start, such as one started from a terminal or by an earlier build
    /// of the app, and connections fail with "No route to host". Start a new
    /// server and try once more.
    private static func retryingDeniedServer(_ attempt: () throws -> Result) throws -> Result {
        let result = try attempt()
        // `adb pair` only reports "protocol fault"; the cause is in the server's log.
        let denied = ["No route to host", "protocol fault"].contains { result.message.contains($0) }
        guard denied else { return result }
        _ = try? run(["kill-server"], timeout: 10)
        startServer()
        return try attempt()
    }

    /// `adb pair ADDRESS CODE`.
    public static func pair(address: String, code: String) throws -> Result {
        try retryingDeniedServer { try pairOnce(address: address, code: code) }
    }

    private static func pairOnce(address: String, code: String) throws -> Result {
        let result = try run(["pair", address, code], timeout: 30)
        // adb exits 0 even when pairing fails, and says so on stdout.
        if result.ok, !result.output.contains("Successfully paired") {
            return Result(status: 1, output: result.output, error: result.message)
        }
        return result
    }

    /// `adb connect ADDRESS`.
    public static func connect(address: String) throws -> Result {
        try retryingDeniedServer { try connectOnce(address: address) }
    }

    private static func connectOnce(address: String) throws -> Result {
        let result = try run(["connect", address], timeout: 20)
        // Likewise exits 0 on failure, and leaves an offline entry behind.
        guard result.output.contains("connected to"), !result.output.contains("failed") else {
            _ = try? run(["disconnect", address], timeout: 5)
            return Result(status: 1, output: result.output, error: result.message)
        }
        return result
    }
}
