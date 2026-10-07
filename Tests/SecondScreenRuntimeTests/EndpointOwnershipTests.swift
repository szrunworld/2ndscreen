import Foundation
import Testing
@testable import SecondScreenRuntime
import SecondScreenCore

/// Who may create, use and clean up a control endpoint when two hosts try
/// at once, one dies, one leaves, or one from before locks is still there
/// (roadmap C02, first step).
@MainActor
struct EndpointOwnershipTests {
    private func temporaryDirectory() -> String {
        // Unix socket paths are short; keep out of the long temporary directory.
        let dir = "/tmp/2ndscreen-own-\(UUID().uuidString.prefix(8))"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    private func temporarySocket() -> String { temporaryDirectory() + "/control.sock" }

    private func identity(_ product: String) -> HostIdentity {
        HostIdentity(product: product, bundleId: "test.\(product)", capabilities: ["test"])
    }

    private func server(_ path: String, _ product: String) -> ControlServer {
        ControlServer(path: path, identity: identity(product)) { _ in .failure(product) }
    }

    private func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }
    private func lock(_ path: String) -> String { try! EndpointOwnership.lockPath(forSocket: path) }

    @Test func twoHostsStartedAtOnceEndWithOneOwnerAndTheLoserRemovesNothing() async throws {
        let path = temporarySocket()
        let a = server(path, "A")
        let b = server(path, "B")
        let outcomes = Outcomes()
        // Both race for the same endpoint from two threads.
        DispatchQueue.concurrentPerform(iterations: 2) { i in
            do {
                try (i == 0 ? a : b).start()
                outcomes.record(i, nil)
            } catch {
                outcomes.record(i, error)
            }
        }
        let errors = outcomes.errors
        #expect(errors.count == 1, "exactly one start fails: \(errors)")
        let winner = a.isOwner ? a : b
        let loser = a.isOwner ? b : a
        #expect(winner.isOwner && !loser.isOwner)
        if case .held(_, let record)? = errors.first.flatMap({ $0 as? EndpointError }) {
            // The loser reads who holds it; whether the winner had bound the socket by then is timing.
            #expect(record?.identity.pid == ProcessInfo.processInfo.processIdentifier)
            #expect(record?.identity.product == winner.identity.product)
        } else {
            Issue.record("the loser must learn who holds the endpoint: \(errors)")
        }
        #expect(ControlProtocol.isListening(URL(fileURLWithPath: path)), "the winner listens")
        #expect(exists(lock(path)))

        // The loser's stop leaves the owner's files alone.
        loser.stop()
        #expect(exists(path) && exists(lock(path)))
        #expect(ControlProtocol.isListening(URL(fileURLWithPath: path)))
        if case .active(let record) = try EndpointOwnership.inspect(socketPath: path) {
            #expect(record?.identity.product == winner.identity.product)
        } else {
            Issue.record("the endpoint is active while the winner runs")
        }

        // The owner's stop removes both.
        winner.stop()
        #expect(!exists(path) && !exists(lock(path)))
        if case .free = try EndpointOwnership.inspect(socketPath: path) {} else { Issue.record("free after the owner left") }
    }

    @Test func aSocketLeftByADeadOwnerIsReplacedByTheNextOwner() throws {
        let path = temporarySocket()
        // A crash leaves the socket file bound by nobody; the kernel has dropped the lock.
        let fd = try Self.bindOnly(path)
        close(fd)
        try "stale".write(toFile: lock(path), atomically: true, encoding: .utf8)
        if case .stale = try EndpointOwnership.inspect(socketPath: path) {} else { Issue.record("a socket nobody serves is stale") }

        let next = server(path, "Next")
        try next.start()
        defer { next.stop() }
        #expect(next.isOwner)
        #expect(ControlProtocol.isListening(URL(fileURLWithPath: path)))
    }

    @Test func aHostFromBeforeLocksIsNotTakenOver() async throws {
        let path = temporarySocket()
        // v0.2.0 style: a listener on the socket, no lock file, answering requests.
        let legacy = try LegacyHost(path)
        defer { legacy.close() }
        if case .activeLegacy = try EndpointOwnership.inspect(socketPath: path) {} else { Issue.record("an answering socket without a lock is a legacy host") }

        let next = server(path, "Next")
        #expect(throws: EndpointError.self) { try next.start() }
        #expect(!next.isOwner)
        #expect(exists(path), "the legacy host's socket is left alone")
        #expect(!exists(lock(path)), "the failed start left no lock file")
        #expect(legacy.answered.value >= 1, "it was identified by a full request, not a bare connect")
        #expect(ControlProtocol.isListening(URL(fileURLWithPath: path)), "the legacy host still serves")

        // Once it quits, its socket file is stale and the next owner takes the endpoint.
        legacy.close()
        if case .stale = try EndpointOwnership.inspect(socketPath: path) {} else { Issue.record("stale once the legacy host is gone") }
        try next.start()
        #expect(next.isOwner)
        next.stop()
    }

    @Test func anInspectHoldingTheSharedLockDoesNotTurnAStartingOwnerAway() throws {
        let path = temporarySocket()
        let lockPath = lock(path)
        // Something holds the shared lock for a while, as inspect does for a moment.
        let shared = open(lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        #expect(flock(shared, LOCK_SH | LOCK_NB) == 0)
        let started = DispatchSemaphore(value: 0)
        let released = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            started.wait()
            usleep(60_000)  // three retry intervals
            flock(shared, LOCK_UN)
            close(shared)
            released.signal()
        }
        started.signal()
        let ownership = try EndpointOwnership.acquire(socketPath: path, identity: identity("Patient"))
        released.wait()
        #expect(ownership.isHeld)
        ownership.release(removingSocket: true)
    }

    @Test func aHeldEndpointThatIsNotListeningYetIsStartingNotStale() throws {
        let path = temporarySocket()
        // An owner that took the lock but has not bound the socket: starting.
        let starting = try EndpointOwnership.acquire(socketPath: path, identity: identity("Slow"))
        if case .starting(let record) = try EndpointOwnership.inspect(socketPath: path) {
            #expect(record?.identity.product == "Slow")
            #expect(record?.listening == false)
        } else {
            Issue.record("held but not listening is starting")
        }
        let other = server(path, "Other")
        #expect(throws: EndpointError.self) { try other.start() }
        #expect(!other.isOwner)
        #expect(exists(lock(path)), "the loser removed nothing")
        starting.release(removingSocket: true)
        #expect(!exists(lock(path)))
        // Now free: the other can take it.
        try other.start()
        #expect(other.isOwner)
        other.stop()
    }

    @Test func aReleasedOwnershipRemovesNothingTwice() throws {
        let path = temporarySocket()
        let first = try EndpointOwnership.acquire(socketPath: path, identity: identity("First"))
        first.release(removingSocket: true)
        #expect(!first.isHeld)
        let second = try EndpointOwnership.acquire(socketPath: path, identity: identity("Second"))
        // A late release of the first must not take the second's lock file away.
        first.release(removingSocket: true)
        #expect(exists(lock(path)))
        #expect(EndpointOwnership.readRecord(lock(path))?.identity.product == "Second")
        second.release(removingSocket: true)
    }

    @Test func aStartThatFailsAfterTakingTheLockGivesItBack() throws {
        let dir = temporaryDirectory()
        // Too long for a Unix socket: bind cannot happen, and unixAddress refuses it.
        let long = dir + "/" + String(repeating: "s", count: 110) + ".sock"
        let server = server(long, "Long")
        #expect(throws: (any Error).self) { try server.start() }
        #expect(!server.isOwner)
        #expect(!exists(lock(long)), "no lock file is left behind")
        #expect(!exists(long))
        // The same server starts on a path that fits.
        let short = dir + "/control.sock"
        let again = self.server(short, "Short")
        try again.start()
        #expect(again.isOwner)
        again.stop()
        #expect(!exists(short) && !exists(lock(short)))
    }

    @Test func aSocketWhoseLockPathWouldBeItselfIsRefused() throws {
        let path = temporaryDirectory() + "/control.lock"
        #expect(throws: EndpointError.self) { try EndpointOwnership.lockPath(forSocket: path) }
        #expect(throws: EndpointError.self) { try EndpointOwnership.acquire(socketPath: path, identity: identity("Bad")) }
        #expect(throws: EndpointError.self) { try server(path, "Bad").start() }
        #expect(!exists(path))
    }

    @Test func hostInfoAnswersTheIdentityTheHostSet() async {
        let runtime = AgentRuntime(serialBase: 950)
        runtime.identity = HostIdentity(product: "Agent Desktop", bundleId: "com.agentdesktop.app", capabilities: ["screen", "host.info"])
        let response = await runtime.handle(ControlRequest(command: .hostInfo))
        #expect(response.ok)
        #expect(response.host == runtime.identity)
        #expect(response.host?.protocolVersion == ControlProtocol.version)
        #expect(response.host?.engineVersion == ControlProtocol.engineVersion)
    }

    @Test func hostInfoTravelsOverTheSocket() async throws {
        let path = temporarySocket()
        let server = ControlServer(path: path, identity: identity("Wire")) { request in
            var response = ControlResponse()
            response.host = request.command == .hostInfo ? HostIdentity(product: "Wire", bundleId: "test.Wire") : nil
            return response
        }
        try server.start()
        defer { server.stop() }
        // The handler runs on the main actor, so the client must wait off it.
        let response = try await Task.detached { try Self.request(path, ControlRequest(command: .hostInfo)) }.value
        #expect(response.host?.product == "Wire")
        #expect(response.host?.bundleId == "test.Wire")
    }

    nonisolated private static func bindOnly(_ path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = try unixAddress(path)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0 else { throw ControlClientError.io("bind: \(String(cString: strerror(errno)))") }
        return fd
    }

    nonisolated private static func request(_ path: String, _ request: ControlRequest) throws -> ControlResponse {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { close(fd) }
        var address = try unixAddress(path)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { throw ControlClientError.notRunning }
        var payload = try JSONEncoder().encode(request)
        payload.append(0x0A)
        try writeAll(fd, payload)
        return try JSONDecoder().decode(ControlResponse.self, from: try readLine(fd))
    }
}

/// A host as v0.2.0 ran it: a listening socket with no lock file, answering
/// every request line with an empty screen list.
private final class LegacyHost: @unchecked Sendable {
    private var listener: Int32
    private let source: DispatchSourceRead
    let answered = Counter()

    init(_ path: String) throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = try unixAddress(path)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, listen(fd, 4) == 0 else { throw ControlClientError.io("legacy listen: \(String(cString: strerror(errno)))") }
        listener = fd
        let answered = self.answered
        source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue(label: "legacy"))
        source.setEventHandler {
            let client = accept(fd, nil, nil)
            guard client >= 0 else { return }
            var noSignal: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            if (try? readLine(client)) != nil {
                answered.increment()
                try? writeAll(client, Data("{\"ok\":true,\"screens\":[]}\n".utf8))
            }
            Darwin.close(client)
        }
        source.resume()
    }

    /// Quit as a crash would: the socket file stays, nobody serves it.
    func close() {
        guard listener >= 0 else { return }
        source.cancel()
        Darwin.close(listener)
        listener = -1
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func increment() { lock.withLock { count += 1 } }
}

private final class Outcomes: @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Int: Error?] = [:]
    func record(_ i: Int, _ error: Error?) { lock.withLock { results[i] = error } }
    var errors: [Error] { lock.withLock { results.values.compactMap { $0 } } }
}
