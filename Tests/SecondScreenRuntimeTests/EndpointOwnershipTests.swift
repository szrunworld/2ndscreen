import Foundation
import Testing
@testable import SecondScreenRuntime
import SecondScreenCore

/// Who may create, use and clean up a control endpoint when two hosts try
/// at once, one dies, or one leaves (roadmap C02, first step).
@MainActor
struct EndpointOwnershipTests {
    init() {
        // `isListening` connects and closes without a request, which makes the
        // server of this baseline write to a closed socket (issue #61, fixed in
        // PR #62). Until that lands, keep the signal from ending the test process.
        signal(SIGPIPE, SIG_IGN)
    }

    private func temporarySocket() -> String {
        // Unix socket paths are short; keep out of the long temporary directory.
        let dir = "/tmp/2ndscreen-own-\(UUID().uuidString.prefix(8))"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir + "/control.sock"
    }

    private func identity(_ product: String) -> HostIdentity {
        HostIdentity(product: product, bundleId: "test.\(product)", capabilities: ["test"])
    }

    private func server(_ path: String, _ product: String) -> ControlServer {
        ControlServer(path: path, identity: identity(product)) { _ in .failure(product) }
    }

    private func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }

    @Test func twoHostsStartedAtOnceEndWithOneOwnerAndTheLoserRemovesNothing() async throws {
        let path = temporarySocket()
        let lock = EndpointOwnership.lockPath(forSocket: path)
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
        #expect(exists(lock))

        // The loser's stop leaves the owner's files alone.
        loser.stop()
        #expect(exists(path) && exists(lock))
        #expect(ControlProtocol.isListening(URL(fileURLWithPath: path)))
        if case .active(let record) = EndpointOwnership.inspect(socketPath: path) {
            #expect(record?.identity.product == winner.identity.product)
        } else {
            Issue.record("the endpoint is active while the winner runs")
        }

        // The owner's stop removes both.
        winner.stop()
        #expect(!exists(path) && !exists(lock))
        if case .free = EndpointOwnership.inspect(socketPath: path) {} else { Issue.record("free after the owner left") }
    }

    @Test func aSocketLeftByADeadOwnerIsReplacedByTheNextOwner() throws {
        let path = temporarySocket()
        // A crash leaves the socket file bound by nobody; the kernel has dropped the lock.
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = try unixAddress(path)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        #expect(bound == 0)
        close(fd)
        try "stale".write(toFile: EndpointOwnership.lockPath(forSocket: path), atomically: true, encoding: .utf8)
        if case .stale = EndpointOwnership.inspect(socketPath: path) {} else { Issue.record("a socket without a lock holder is stale") }

        let next = server(path, "Next")
        try next.start()
        defer { next.stop() }
        #expect(next.isOwner)
        #expect(ControlProtocol.isListening(URL(fileURLWithPath: path)))
    }

    @Test func aHeldEndpointThatIsNotListeningYetIsStartingNotStale() throws {
        let path = temporarySocket()
        // An owner that took the lock but has not bound the socket: starting.
        let starting = try EndpointOwnership.acquire(socketPath: path, identity: identity("Slow"))
        if case .starting(let record) = EndpointOwnership.inspect(socketPath: path) {
            #expect(record?.identity.product == "Slow")
            #expect(record?.listening == false)
        } else {
            Issue.record("held but not listening is starting")
        }
        let other = server(path, "Other")
        #expect(throws: EndpointError.self) { try other.start() }
        #expect(!other.isOwner)
        #expect(exists(EndpointOwnership.lockPath(forSocket: path)), "the loser removed nothing")
        starting.release(removingSocket: true)
        #expect(!exists(EndpointOwnership.lockPath(forSocket: path)))
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
        #expect(exists(EndpointOwnership.lockPath(forSocket: path)))
        #expect(EndpointOwnership.readRecord(EndpointOwnership.lockPath(forSocket: path))?.identity.product == "Second")
        second.release(removingSocket: true)
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

private final class Outcomes: @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Int: Error?] = [:]
    func record(_ i: Int, _ error: Error?) { lock.withLock { results[i] = error } }
    var errors: [Error] { lock.withLock { results.values.compactMap { $0 } } }
}
