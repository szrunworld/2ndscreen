import Foundation
import SecondScreenCore

/// Serves `ControlProtocol` requests on a Unix socket in the user's
/// Application Support folder, readable only by the user.
///
/// The socket is created only by the process that owns the endpoint
/// (`EndpointOwnership`): starting takes the lock beside it, so two hosts
/// started at once cannot both listen, and a host that finds the endpoint
/// held fails with who holds it and removes nothing. Stopping removes the
/// socket and the lock only while this server still owns them.
///
/// Each client connection is read on a background queue; the handler runs
/// on the main actor, where all display and window state lives.
public final class ControlServer {
    public typealias Handler = @MainActor (ControlRequest) async -> ControlResponse

    private let path: String
    private let handler: Handler
    /// Who this server says it is: written into the lock file, answered to `host.info`.
    public let identity: HostIdentity
    private var listener: Int32 = -1
    private var source: DispatchSourceRead?
    private var ownership: EndpointOwnership?
    private let clients = DispatchQueue(label: "2ndscreen.control.clients", attributes: .concurrent)

    public init(path: String = ControlProtocol.socketURL.path, identity: HostIdentity = .current(), handler: @escaping Handler) {
        self.path = path
        self.identity = identity
        self.handler = handler
    }

    /// Whether this server owns the endpoint right now.
    public var isOwner: Bool { ownership?.isHeld == true }

    public func start() throws {
        // Taking the endpoint also clears a socket a dead owner left; a living owner makes this throw.
        let ownership = try EndpointOwnership.acquire(socketPath: path, identity: identity)
        self.ownership = ownership

        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else {
            let message = String(cString: strerror(errno))
            ownership.release(removingSocket: false)
            self.ownership = nil
            throw ControlClientError.io("socket: \(message)")
        }
        var address = try unixAddress(path)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, chmod(path, 0o600) == 0, listen(listener, 16) == 0 else {
            let message = String(cString: strerror(errno))
            close(listener)
            listener = -1
            // Whatever is at the path now is this owner's own, half-made; nobody else's.
            ownership.release(removingSocket: true)
            self.ownership = nil
            throw ControlClientError.io("could not listen on \(path): \(message)")
        }
        try ownership.markListening()

        let source = DispatchSource.makeReadSource(fileDescriptor: listener, queue: clients)
        source.setEventHandler { [weak self] in self?.acceptClient() }
        source.resume()
        self.source = source
    }

    public func stop() {
        source?.cancel()
        source = nil
        if listener >= 0 {
            close(listener)
            listener = -1
        }
        // A server that never owned the endpoint, or lost it, leaves the owner's files alone.
        ownership?.release(removingSocket: true)
        ownership = nil
    }

    private func acceptClient() {
        let client = accept(listener, nil, nil)
        guard client >= 0 else { return }
        // A client may leave before the reply (a listener check connects and
        // closes at once; a command can be interrupted). Writing to it then
        // fails with EPIPE for this connection alone instead of raising
        // SIGPIPE, which would end the whole host.
        var noSignal: Int32 = 1
        guard setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            // Without the guard a reply to this client could end the host; drop it.
            close(client)
            return
        }
        clients.async { [handler] in
            defer { close(client) }
            // No request (the client closed, or the read failed): nothing to
            // answer and no handler to run.
            guard let line = try? readLine(client) else { return }
            let response: ControlResponse
            do {
                let request = try JSONDecoder().decode(ControlRequest.self, from: line)
                response = Self.runOnMain { await handler(request) }
            } catch {
                response = .failure("bad request: \(error.localizedDescription)")
            }
            guard var data = try? JSONEncoder().encode(response) else { return }
            data.append(0x0A)
            // The client may be gone by now; the failure is this connection's alone.
            try? writeAll(client, data)
        }
    }

    /// Block this client's background thread until the main actor answers.
    private static func runOnMain(_ work: @escaping @MainActor () async -> ControlResponse) -> ControlResponse {
        let done = DispatchSemaphore(value: 0)
        var result = ControlResponse.failure("no response")
        Task { @MainActor in
            result = await work()
            done.signal()
        }
        done.wait()
        return result
    }
}
