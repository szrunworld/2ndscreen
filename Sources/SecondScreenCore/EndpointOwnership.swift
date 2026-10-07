import Foundation

/// The host answering on a control endpoint: what it is, which process, and
/// what it speaks. The owner writes it into the endpoint's lock file, and
/// answers it to `host.info`, so a client can tell which instance it reached
/// and whether they agree on the protocol.
public struct HostIdentity: Codable, Equatable, Sendable {
    public var product: String
    public var bundleId: String
    public var pid: Int32
    public var protocolVersion: String
    public var engineVersion: String
    public var capabilities: [String]

    public init(product: String, bundleId: String, pid: Int32 = ProcessInfo.processInfo.processIdentifier,
                protocolVersion: String = ControlProtocol.version, engineVersion: String = ControlProtocol.engineVersion,
                capabilities: [String] = HostIdentity.defaultCapabilities) {
        self.product = product
        self.bundleId = bundleId
        self.pid = pid
        self.protocolVersion = protocolVersion
        self.engineVersion = engineVersion
        self.capabilities = capabilities
    }

    /// What every host built on the runtime offers.
    public static let defaultCapabilities = ["screen", "window", "input", "screenshot", "host.info"]

    /// This process, as its bundle (or, outside one, its executable) names it.
    public static func current(capabilities: [String] = defaultCapabilities) -> HostIdentity {
        let bundle = Bundle.main
        let name = (bundle.infoDictionary?["CFBundleName"] as? String) ?? ProcessInfo.processInfo.processName
        return HostIdentity(product: name, bundleId: bundle.bundleIdentifier ?? "process." + ProcessInfo.processInfo.processName,
                            capabilities: capabilities)
    }
}

/// What the lock file beside an endpoint says about it.
public struct EndpointRecord: Codable, Sendable {
    public var identity: HostIdentity
    /// The owner has bound and listens on the socket; before that it is starting.
    public var listening: Bool
    public var since: Date
}

public enum EndpointState: Sendable {
    /// No lock is held and no socket file exists.
    case free
    /// No lock is held and the socket file refuses connections: an owner that crashed. The next owner replaces it.
    case stale
    /// No lock is held, yet the socket answers requests: a host from before
    /// locks (v0.2.0) is running. It is not taken over; it has to quit first.
    case activeLegacy
    /// The lock is held and the owner has not started listening yet.
    case starting(EndpointRecord?)
    /// The lock is held by a listening owner.
    case active(EndpointRecord?)
}

public enum EndpointError: LocalizedError {
    /// Another process holds the endpoint. The record is what its lock file said, if it could be read.
    case held(socket: String, by: EndpointRecord?)
    /// A host from before locks answers on the socket; it cannot be taken over.
    case legacyActive(socket: String)
    /// The socket path cannot be an endpoint: too long for a Unix socket, or its lock path would be itself.
    case badPath(String)
    case io(String)

    public var errorDescription: String? {
        switch self {
        case .held(let socket, let record):
            if let record {
                let identity = record.identity
                return "\(socket) is owned by \(identity.product) (\(identity.bundleId), pid \(identity.pid), protocol \(identity.protocolVersion))"
                    + (record.listening ? "" : ", which is still starting")
            }
            return "\(socket) is owned by another process"
        case .legacyActive(let socket):
            return "\(socket) is served by a host from before 2ndscreen took endpoint locks; quit that host first"
        case .badPath(let message), .io(let message): return message
        }
    }
}

/// What a request round trip to a socket found.
public enum EndpointProbe: Sendable {
    /// A host answered a request: it is alive.
    case answered
    /// The socket file refuses connections or is gone: nobody serves it.
    case refused
    /// Connected, but no reply came in time, or the reply was cut off. Treated as alive: never taken over.
    case silent
}

/// Ownership of a control endpoint, taken atomically through a lock file
/// beside the socket (`control.sock` → `control.lock`) with `flock`.
///
/// Only the holder creates, replaces or removes the socket. A process that
/// fails to take the lock removes nothing, and can read who holds it. When
/// the holder dies the kernel drops the lock, so a socket file left behind
/// is recognised as stale and replaced by the next owner; while the lock is
/// held but the socket is not yet listening, the endpoint is starting. A
/// socket with no lock holder that still answers requests belongs to a host
/// from before locks: it is left alone.
public final class EndpointOwnership {
    public let socketPath: String
    public let lockPath: String
    public let identity: HostIdentity
    private var fd: Int32 = -1

    /// `control.sock` → `control.lock`, in the same directory. A socket path
    /// whose lock path would be itself cannot be an endpoint.
    public static func lockPath(forSocket socketPath: String) throws -> String {
        let base = (socketPath as NSString).deletingPathExtension
        let lock = (base as NSString).appendingPathExtension("lock") ?? base + ".lock"
        guard lock != socketPath else {
            throw EndpointError.badPath("\(socketPath) cannot be a control socket: its lock file would be the socket itself")
        }
        return lock
    }

    private init(socketPath: String, lockPath: String, identity: HostIdentity, fd: Int32) {
        self.socketPath = socketPath
        self.lockPath = lockPath
        self.identity = identity
        self.fd = fd
    }

    deinit {
        if fd >= 0 { close(fd) }
    }

    /// Whether this object still holds the lock.
    public var isHeld: Bool { fd >= 0 }

    /// How often, and how long apart, a non-blocking lock is retried before
    /// the endpoint counts as held: an `inspect` holds the shared lock for a
    /// moment, and must not turn a starting owner away.
    static let lockAttempts = 10
    static let lockRetryInterval: useconds_t = 20_000

    /// Take the endpoint for `identity`, or throw: `held` with what the lock
    /// file says about its owner, `legacyActive` when a host without a lock
    /// answers on the socket. Taking it removes a socket that nobody serves;
    /// it never touches a living host's.
    public static func acquire(socketPath: String, identity: HostIdentity,
                               probe: (String) -> EndpointProbe = probe) throws -> EndpointOwnership {
        let lockPath = try lockPath(forSocket: socketPath)
        let directory = (socketPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // A lock on a file that was unlinked under us guards nothing; look again.
        for _ in 0..<8 {
            let fd = open(lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw EndpointError.io("open \(lockPath): \(String(cString: strerror(errno)))") }
            if !(try lock(fd, lockPath: lockPath)) {
                close(fd)
                throw EndpointError.held(socket: socketPath, by: readRecord(lockPath, waitingUpTo: 0.5))
            }
            var locked = stat(), named = stat()
            guard fstat(fd, &locked) == 0, stat(lockPath, &named) == 0, locked.st_ino == named.st_ino, locked.st_dev == named.st_dev else {
                close(fd)  // the file we locked is gone; retry on the one now at the path
                continue
            }
            let ownership = EndpointOwnership(socketPath: socketPath, lockPath: lockPath, identity: identity, fd: fd)
            // Held now. A socket at the path belongs to nobody who holds a lock; but a
            // host from before locks may serve it, and only a request can tell.
            if FileManager.default.fileExists(atPath: socketPath) {
                switch probe(socketPath) {
                case .refused:
                    unlink(socketPath)
                case .answered, .silent:
                    ownership.release(removingSocket: false)
                    throw EndpointError.legacyActive(socket: socketPath)
                }
            }
            do {
                try ownership.write(listening: false)
            } catch {
                ownership.release(removingSocket: false)
                throw error
            }
            return ownership
        }
        throw EndpointError.io("could not settle the lock at \(lockPath)")
    }

    /// The exclusive lock, retried a bounded number of times: false when
    /// another process holds it after the retries.
    private static func lock(_ fd: Int32, lockPath: String) throws -> Bool {
        for attempt in 0..<lockAttempts {
            if flock(fd, LOCK_EX | LOCK_NB) == 0 { return true }
            let code = errno
            guard code == EWOULDBLOCK || code == EAGAIN else {
                throw EndpointError.io("flock \(lockPath): \(String(cString: strerror(code)))")
            }
            if attempt + 1 < lockAttempts { usleep(lockRetryInterval) }
        }
        return false
    }

    /// Record that the socket is bound and listening.
    public func markListening() throws {
        try write(listening: true)
    }

    /// Give the endpoint up: the socket file (if asked) and the lock file,
    /// then the lock itself. Only while held; a released or never-held
    /// ownership removes nothing.
    public func release(removingSocket: Bool) {
        guard fd >= 0 else { return }
        if removingSocket { unlink(socketPath) }
        // Unlinked while still locked: a racing acquirer that locked this inode sees it vanish and retries.
        unlink(lockPath)
        close(fd)
        fd = -1
    }

    private func write(listening: Bool) throws {
        guard fd >= 0 else { throw EndpointError.io("the endpoint is not held") }
        let record = EndpointRecord(identity: identity, listening: listening, since: Date())
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var data = try encoder.encode(record)
        data.append(0x0A)
        guard ftruncate(fd, 0) == 0, lseek(fd, 0, SEEK_SET) == 0 else {
            throw EndpointError.io("truncate \(lockPath): \(String(cString: strerror(errno)))")
        }
        try writeAll(fd, data)
        fsync(fd)
    }

    /// What the lock file says, if it is readable and well formed. With
    /// `waitingUpTo`, an empty or half-written file is read again for that
    /// long: a holder that has just taken the lock is still writing it.
    public static func readRecord(_ lockPath: String, waitingUpTo seconds: TimeInterval = 0) -> EndpointRecord? {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if let data = FileManager.default.contents(atPath: lockPath), !data.isEmpty {
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                if let record = try? decoder.decode(EndpointRecord.self, from: data) { return record }
            }
            if Date() >= deadline { return nil }
            usleep(10_000)
        } while true
    }

    /// Ask the socket a harmless question (`screen.list`) and see whether
    /// anything answers. A full round trip, never a bare connect: a host from
    /// before locks ends on a connection that closes without a request.
    public static func probe(socketPath: String) -> EndpointProbe {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return .silent }
        defer { close(fd) }
        var seconds = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &seconds, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &seconds, socklen_t(MemoryLayout<timeval>.size))
        var noSignal: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        guard var address = try? unixAddress(socketPath) else { return .refused }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            return errno == ECONNREFUSED || errno == ENOENT ? .refused : .silent
        }
        guard var payload = try? JSONEncoder().encode(ControlRequest(command: .screenList)) else { return .silent }
        payload.append(0x0A)
        guard (try? writeAll(fd, payload)) != nil, (try? readLine(fd)) != nil else { return .silent }
        return .answered
    }

    /// The endpoint's state as seen from outside, without taking it.
    public static func inspect(socketPath: String, probe: (String) -> EndpointProbe = probe) throws -> EndpointState {
        let lockPath = try lockPath(forSocket: socketPath)
        let socketExists = FileManager.default.fileExists(atPath: socketPath)
        func unheld() -> EndpointState {
            guard socketExists else { return .free }
            switch probe(socketPath) {
            case .refused: return .stale
            case .answered, .silent: return .activeLegacy
            }
        }
        let fd = open(lockPath, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { return unheld() }
        defer { close(fd) }
        if flock(fd, LOCK_SH | LOCK_NB) == 0 {
            // Nobody holds it exclusively.
            flock(fd, LOCK_UN)
            return unheld()
        }
        let record = readRecord(lockPath)
        if record?.listening == true, socketExists { return .active(record) }
        return .starting(record)
    }
}
