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
    /// No lock is held but a socket file was left behind: an owner that crashed. The next owner replaces it.
    case stale
    /// The lock is held and the owner has not started listening yet.
    case starting(EndpointRecord?)
    /// The lock is held by a listening owner.
    case active(EndpointRecord?)
}

public enum EndpointError: LocalizedError {
    /// Another process holds the endpoint. The record is what its lock file said, if it could be read.
    case held(socket: String, by: EndpointRecord?)
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
        case .io(let message): return message
        }
    }
}

/// Ownership of a control endpoint, taken atomically through a lock file
/// beside the socket (`control.sock` → `control.lock`) with `flock`.
///
/// Only the holder creates, replaces or removes the socket. A process that
/// fails to take the lock removes nothing, and can read who holds it. When
/// the holder dies the kernel drops the lock, so a socket file left behind
/// is recognised as stale and replaced by the next owner; while the lock is
/// held but the socket is not yet listening, the endpoint is starting.
public final class EndpointOwnership {
    public let socketPath: String
    public let lockPath: String
    public let identity: HostIdentity
    private var fd: Int32 = -1

    /// `control.sock` → `control.lock`, in the same directory.
    public static func lockPath(forSocket socketPath: String) -> String {
        ((socketPath as NSString).deletingPathExtension as NSString).appendingPathExtension("lock") ?? socketPath + ".lock"
    }

    private init(socketPath: String, identity: HostIdentity, fd: Int32) {
        self.socketPath = socketPath
        self.lockPath = Self.lockPath(forSocket: socketPath)
        self.identity = identity
        self.fd = fd
    }

    deinit {
        if fd >= 0 { close(fd) }
    }

    /// Whether this object still holds the lock.
    public var isHeld: Bool { fd >= 0 }

    /// Take the endpoint for `identity`, or throw `EndpointError.held` with
    /// what the lock file says about its owner. Taking it removes a stale
    /// socket file; it never touches a living owner's.
    public static func acquire(socketPath: String, identity: HostIdentity) throws -> EndpointOwnership {
        let lockPath = lockPath(forSocket: socketPath)
        let directory = (socketPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // A lock on a file that was unlinked under us guards nothing; look again.
        for _ in 0..<8 {
            let fd = open(lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw EndpointError.io("open \(lockPath): \(String(cString: strerror(errno)))") }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
                let code = errno
                close(fd)
                if code == EWOULDBLOCK || code == EAGAIN {
                    // The holder writes its record right after locking; give it a moment.
                    throw EndpointError.held(socket: socketPath, by: readRecord(lockPath, waitingUpTo: 0.5))
                }
                throw EndpointError.io("flock \(lockPath): \(String(cString: strerror(code)))")
            }
            var locked = stat(), named = stat()
            if fstat(fd, &locked) == 0, stat(lockPath, &named) == 0, locked.st_ino == named.st_ino, locked.st_dev == named.st_dev {
                let ownership = EndpointOwnership(socketPath: socketPath, identity: identity, fd: fd)
                // Held now: a socket file at the path belongs to nobody alive.
                if FileManager.default.fileExists(atPath: socketPath) { unlink(socketPath) }
                try ownership.write(listening: false)
                return ownership
            }
            close(fd)  // the file we locked is gone; retry on the one now at the path
        }
        throw EndpointError.io("could not settle the lock at \(lockPath)")
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

    /// The endpoint's state as seen from outside, without taking it.
    public static func inspect(socketPath: String) -> EndpointState {
        let lockPath = lockPath(forSocket: socketPath)
        let socketExists = FileManager.default.fileExists(atPath: socketPath)
        let fd = open(lockPath, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { return socketExists ? .stale : .free }
        defer { close(fd) }
        if flock(fd, LOCK_SH | LOCK_NB) == 0 {
            // Nobody holds it exclusively.
            flock(fd, LOCK_UN)
            return socketExists ? .stale : .free
        }
        let record = readRecord(lockPath)
        if record?.listening == true, socketExists { return .active(record) }
        return .starting(record)
    }
}
