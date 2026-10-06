import CoreGraphics
import Foundation
import Testing
@testable import SecondScreenRuntime
import SecondScreenCore

/// Routing in the runtime facade, without creating any display.
@MainActor
struct AgentRuntimeTests {
    private func hostScreen() -> ScreenInfo {
        ScreenInfo(name: "host", kind: .primary, displayID: 7, width: 1440, height: 900, hiDPI: false,
                   frame: Frame(CGRect(x: 0, y: 0, width: 1440, height: 900)))
    }

    @Test func screenListShowsTheHostsScreens() async {
        let runtime = AgentRuntime(serialBase: 950)
        let host = hostScreen()
        runtime.hostScreens = { [host] }
        let response = await runtime.handle(ControlRequest(command: .screenList))
        #expect(response.ok)
        #expect(response.screens?.map(\.name) == ["host"])
    }

    @Test func hostScreensCannotBeDestroyedOrResized() async {
        let runtime = AgentRuntime(serialBase: 950)
        let host = hostScreen()
        runtime.hostScreens = { [host] }
        var destroy = ControlRequest(command: .screenDestroy)
        destroy.screen = "host"
        let destroyed = await runtime.handle(destroy)
        #expect(!destroyed.ok)
        #expect(destroyed.error?.contains("host's own screen") == true, "\(destroyed.error ?? "")")
        var resize = ControlRequest(command: .screenResize)
        resize.screen = "host"
        resize.width = 800
        resize.height = 600
        let resized = await runtime.handle(resize)
        #expect(!resized.ok)
    }

    @Test func commandsItDoesNotHandleGoToTheHost() async {
        let runtime = AgentRuntime(serialBase: 950)
        let seen = Seen()
        runtime.fallback = { request in
            seen.command = request.command
            var response = ControlResponse()
            response.output = "host answered"
            return response
        }
        let before = Date()
        let response = await runtime.handle(ControlRequest(command: .androidList))
        #expect(seen.command == .androidList)
        #expect(response.output == "host answered")
        #expect(runtime.lastRequest >= before)
    }

    @Test func unhandledCommandsAreRefusedByDefault() async {
        let runtime = AgentRuntime(serialBase: 950)
        let response = await runtime.handle(ControlRequest(command: .androidList))
        #expect(!response.ok)
    }

    @MainActor
    private final class Seen {
        var command: ControlRequest.Command?
    }
}
