import Foundation
import SecondScreenCore

/// Serves `ControlProtocol` requests on a Unix socket in the user's
/// Application Support folder, readable only by the user.
///
/// Each client connection is read on a background queue; the handler runs
/// on the main actor, where all display and window state lives.
public final class ControlServer {
    public typealias Handler = @MainActor (ControlRequest) async -> ControlResponse

    private let path: String
    private let handler: Handler
    private var listener: Int32 = -1
    private var source: DispatchSourceRead?
    private let clients = DispatchQueue(label: "2ndscreen.control.clients", attributes: .concurrent)

    public init(path: String = ControlProtocol.socketURL.path, handler: @escaping Handler) {
        self.path = path
        self.handler = handler
    }

    public func start() throws {
        let directory = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // A previous instance that crashed leaves its socket file behind.
        unlink(path)

        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw ControlClientError.io("socket: \(String(cString: strerror(errno)))") }
        var address = try unixAddress(path)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, chmod(path, 0o600) == 0, listen(listener, 16) == 0 else {
            let message = String(cString: strerror(errno))
            close(listener)
            throw ControlClientError.io("could not listen on \(path): \(message)")
        }

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
        unlink(path)
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
