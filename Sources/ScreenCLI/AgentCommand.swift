import CoreGraphics
import Foundation
import SecondScreenCore
import TarsAgent

/// `2ndscreen agent`: run an instruction with a UI-TARS vision model on an
/// agent screen, acting only on one app, through the running 2ndscreen app.
enum AgentCommand {
    static func run(_ args: Arguments) -> Never {
        let instruction = args.positional.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespaces)
        guard let screen = args.value("--screen"), let pid = args.value("--pid").flatMap(Int32.init),
              !instruction.isEmpty
        else { fail("usage: 2ndscreen agent --screen NAME --pid PID [--window-id ID] [--allow-submit] "
            + "[--foreground] [--max-steps N] INSTRUCTION") }

        var options = TarsAgent.Options()
        options.allowSubmit = args.has("--allow-submit")
        options.foreground = args.has("--foreground")
        if let steps = args.value("--max-steps") {
            guard let number = Int(steps), number > 0 else { fail("--max-steps takes a positive number") }
            options.maxSteps = number
        }
        let config: ModelConfig
        do {
            config = try ModelConfig.fromEnvironment()
        } catch {
            fail(error.localizedDescription)
        }

        let target = ControlScreen(screen: screen, pid: pid, windowID: args.value("--window-id").flatMap(UInt32.init))
        let agent = TarsAgent(screen: target, model: ChatCompletionsModel(config), options: options) { event in
            log(event)
        }
        let result = agent.run(instruction)
        DriverCommands.emit(["ok": result.outcome == .done, "outcome": result.outcome.rawValue,
                             "reason": result.reason, "steps": result.steps])
        exit(result.outcome == .done ? 0 : 1)
    }

    /// Progress on stderr, so stdout carries only the result.
    private static func log(_ event: TarsAgent.Event) {
        let line: String
        switch event {
        case .thought(let thought, let actions):
            let calls = actions.map { action in
                let arguments = action.inputs.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
                return "\(action.type)(\(arguments.joined(separator: ", ")))"
            }
            line = (thought.isEmpty ? "" : "· \(thought)\n") + calls.map { "  → \($0)" }.joined(separator: "\n")
        case .step(.act(let action)):
            line = "  $ \(describe(action))"
        case .step(.wait(let seconds)):
            line = "  wait \(Int(seconds)) s"
        case .step(.stop(_, let reason)):
            line = "  stop: \(reason)"
        case .error(let message):
            line = "  ! \(message)"
        }
        FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
    }

    private static func describe(_ action: InputAction) -> String {
        var parts = [action.kind.rawValue]
        if let x = action.x, let y = action.y { parts.append("(\(x), \(y))") }
        if let toX = action.toX, let toY = action.toY { parts.append("→ (\(toX), \(toY))") }
        if action.button == "right" { parts.append("right") }
        if action.count == 2 { parts.append("double") }
        if let index = action.index { parts.append("element \(index)") }
        if let value = action.value { parts.append("\"\(value)\"") }
        if let key = action.key { parts.append(((action.modifiers ?? []) + [key]).joined(separator: "+")) }
        if let direction = action.direction { parts.append(direction) }
        return parts.joined(separator: " ")
    }
}

/// The agent's view of one app on one screen, through the app's socket.
struct ControlScreen: AgentScreen {
    let screen: String
    let pid: Int32
    let windowID: UInt32?

    func frame() throws -> CGRect {
        var request = ControlRequest(command: .screenList)
        request.screen = screen
        let response = try sendControlRequest(request)
        guard let info = response.screens?.first(where: { $0.name == screen }) else {
            throw CommandError("no screen named \"\(screen)\"")
        }
        // Displays rearrange as screens come and go; make sure the app is
        // still on this one, or the model would act on a screen without it.
        let frame = CGRect(info.frame)
        let windows = WindowMover.windows(ofPID: pid).filter { windowID == nil || $0.windowID == windowID }
        guard windows.contains(where: { frame.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }) else {
            throw CommandError("pid \(pid) has no window on screen \"\(screen)\" any more")
        }
        return frame
    }

    func screenshot(size: CGSize) throws -> Data {
        let scratch = NSTemporaryDirectory() + "2ndscreen-agent-\(getpid()).png"
        defer { try? FileManager.default.removeItem(atPath: scratch) }
        var request = ControlRequest(command: .screenshot)
        request.screen = screen
        request.output = scratch
        request.windowsOnly = true
        let response = try sendControlRequest(request)
        guard response.ok else { throw CommandError(response.error ?? "screenshot failed") }
        return try Images.png(Images.scaled(Images.load(scratch), to: size))
    }

    func perform(_ action: InputAction) throws -> ControlResponse {
        var request = ControlRequest(command: .input)
        request.screen = screen
        request.pid = pid
        request.windowID = windowID
        request.input = action
        return try sendControlRequest(request)
    }

    func menuOpen() -> Bool {
        BackgroundInput.hasOpenMenu(pid: pid)
    }

    func elements() throws -> [AXElementInfo] {
        var request = ControlRequest(command: .windowState)
        request.screen = screen
        request.pid = pid
        request.windowID = windowID
        let response = try sendControlRequest(request)
        guard response.ok else { throw CommandError(response.error ?? "state failed") }
        return response.elements ?? []
    }
}
