import AppKit
import CoreGraphics
import Foundation
import SecondScreenCore
import TarsAgent

/// `2ndscreen agent-bridge`: run one task-runtime unit with the UI-TARS agent
/// and report it as JSON lines (docs/task-runtime-contracts.md, "Bridge JSONL
/// protocol"). The runtime writes one ExplorationRequest line to stdin and
/// closes it; every event goes to stdout, one a line; logs go to stderr.
///
/// Exit codes: 0 the unit finished, 1 it failed, 2 the request was invalid.
/// SIGTERM stops the run after the action under way, reporting `cancelled`.
///
/// main.swift registers the subcommand (task A7).
enum AgentBridgeCommand {
    static func run(_ args: Arguments) -> Never {
        let line = readLine(strippingNewline: true) ?? ""
        let (parsed, errors, ids) = ExplorationRequest.parse(line)
        guard let request = parsed else {
            write(ExplorationBridge.refusal(errors, ids: ids))
            exit(2)
        }
        // Every control request goes to the session's app through this
        // socket; another one would be another app's screen.
        let socket = ProcessInfo.processInfo.environment["SECONDSCREEN_SOCKET"] ?? ""
        guard socket == request.socket else {
            write(ExplorationBridge.refusal(["SECONDSCREEN_SOCKET must be the session's socket \(request.socket)"],
                                            ids: (request.taskId, request.unitAttemptId)))
            exit(2)
        }

        let model = (try? ModelConfig.fromEnvironment()).map(ChatCompletionsModel.init)
        let screen = ControlScreen(screen: request.screenId, pid: request.pid, windowID: request.windowId)
        let bridge = ExplorationBridge(request: request, screen: screen, model: model,
                                       window: { window(pid: request.pid, id: request.windowId) },
                                       write: write, log: log)

        // A cancel with no action under way ends the process at once; one
        // that lands mid-action lets the action finish and the run report.
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler {
                if bridge.cancel() { exit(1) }
            }
            source.resume()
            signals.append(source)
        }
        exit(bridge.run())
    }

    /// Kept alive for the whole run.
    private static var signals: [DispatchSourceSignal] = []

    private static func write(_ line: String) {
        FileHandle.standardOutput.write(line.data(using: .utf8)!)
    }

    private static func log(_ text: String) {
        FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
    }

    /// The bound window as it is now, or nil once it is gone.
    static func window(pid: Int32, id: UInt32) -> BridgeWindow? {
        guard let info = WindowMover.windows(ofPID: pid).first(where: { $0.windowID == id }) else { return nil }
        let app = NSRunningApplication(processIdentifier: pid)
        let center = CGPoint(x: info.frame.midX, y: info.frame.midY)
        var display: CGDirectDisplayID = 0
        var count: UInt32 = 0
        CGGetDisplaysWithPoint(center, 1, &display, &count)
        let scale = NSScreen.screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display
        }?.backingScaleFactor ?? 1
        return BridgeWindow(pid: pid, windowId: id, bundleId: app?.bundleIdentifier ?? "",
                            title: info.title, frame: info.frame, scale: Double(scale), displayId: display)
    }
}
