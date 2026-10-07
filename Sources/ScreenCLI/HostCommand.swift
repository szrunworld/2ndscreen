import Foundation
import SecondScreenCore

/// `2ndscreen host info`: who answers on the control endpoint, so a client
/// can check it reached the host it meant and that they agree on the
/// protocol. When nobody answers, the endpoint's lock says whether it is
/// free, left behind by a crash, or held by a host that is still starting.
enum HostCommand {
    static func run(_ args: Arguments) -> Never {
        guard args.positional.dropFirst().first == "info" else {
            fail("usage: 2ndscreen host info")
        }
        let socket = ControlProtocol.socketURL.path
        do {
            var response = try sendControlRequest(ControlRequest(command: .hostInfo))
            if response.ok, response.host == nil {
                // An older host answers commands it does not know with a failure, never this; be explicit anyway.
                response = .failure("the host at \(socket) did not say who it is")
            }
            finish(response)
        } catch ControlClientError.notRunning {
            let state: String
            var owner: EndpointRecord?
            switch (try? EndpointOwnership.inspect(socketPath: socket)) ?? .free {
            case .free: state = "free"
            case .stale: state = "stale"
            case .activeLegacy: state = "served by a host from before endpoint locks"
            case .starting(let record): state = "starting"; owner = record
            case .active(let record): state = "active"; owner = record
            }
            var response = ControlResponse.failure("no host answers at \(socket): the endpoint is \(state)")
            response.host = owner?.identity
            finish(response)
        } catch {
            fail(error.localizedDescription, code: 1)
        }
    }
}
