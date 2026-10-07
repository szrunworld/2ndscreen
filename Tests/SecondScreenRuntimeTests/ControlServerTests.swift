import Foundation
import Testing
@testable import SecondScreenRuntime
import SecondScreenCore

/// Clients that leave early must not end the host. These run in the test
/// process, which does not ignore SIGPIPE: a regression would kill it.
@MainActor
struct ControlServerTests {
    private func temporarySocket() -> String {
        // Unix socket paths are short; keep out of the long temporary directory.
        "/tmp/2ndscreen-test-\(UUID().uuidString.prefix(8)).sock"
    }

    nonisolated private static func connect(_ path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = try unixAddress(path)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        #expect(connected == 0, "connect: \(String(cString: strerror(errno)))")
        return fd
    }

    nonisolated private static func request(_ path: String) throws -> ControlResponse {
        let fd = try connect(path)
        defer { close(fd) }
        var payload = try JSONEncoder().encode(ControlRequest(command: .screenList))
        payload.append(0x0A)
        try writeAll(fd, payload)
        return try JSONDecoder().decode(ControlResponse.self, from: try readLine(fd))
    }

    @Test func aClientThatConnectsAndLeavesDoesNotRunTheHandlerOrEndTheHost() async throws {
        let path = temporarySocket()
        let handled = Counter()
        let server = ControlServer(path: path) { _ in
            handled.increment()
            return .failure("pong")
        }
        try server.start()
        defer { server.stop() }

        for _ in 0..<3 {
            let fd = try Self.connect(path)
            close(fd)
        }
        try await Task.sleep(for: .milliseconds(200))
        #expect(handled.value == 0, "an empty connection must not reach the handler")

        let response = try await Task.detached { try Self.request(path) }.value
        #expect(response.error == "pong")
        #expect(handled.value == 1)
    }

    @Test func aClientThatLeavesWhileItsRequestRunsDoesNotEndTheHost() async throws {
        let path = temporarySocket()
        let server = ControlServer(path: path) { _ in
            try? await Task.sleep(for: .milliseconds(300))
            return .failure("late")
        }
        try server.start()
        defer { server.stop() }

        let fd = try Self.connect(path)
        var payload = try JSONEncoder().encode(ControlRequest(command: .screenList))
        payload.append(0x0A)
        try writeAll(fd, payload)
        close(fd)  // gone before the handler answers
        try await Task.sleep(for: .milliseconds(600))

        let response = try await Task.detached { try Self.request(path) }.value
        #expect(response.error == "late", "the host still answers after a client left mid-request")
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func increment() { lock.withLock { count += 1 } }
}
