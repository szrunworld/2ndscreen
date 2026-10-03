import AppKit
import CoreGraphics
import Foundation
import SecondScreenCore
import TarsAgent

/// `2ndscreen agent`: run an instruction with a UI-TARS vision model on an
/// agent screen, acting only on one app, or on an Android phone, through
/// the running 2ndscreen app.
enum AgentCommand {
    static func run(_ args: Arguments) -> Never {
        let instruction = args.positional.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespaces)
        let android = args.has("--android")
        let iphone = args.has("--iphone")
        let usage = "usage: 2ndscreen agent --screen NAME --pid PID [--window-id ID] [--allow-submit] "
            + "[--foreground] [--no-elements] [--no-learn] [--max-steps N] INSTRUCTION\n"
            + "       2ndscreen agent --android [--serial SERIAL] [--allow-submit] [--max-steps N] INSTRUCTION\n"
            + "       2ndscreen agent --iphone [--screen phone] [--allow-submit] [--max-steps N] INSTRUCTION"
        guard !instruction.isEmpty else { fail(usage) }

        var options = TarsAgent.Options()
        options.allowSubmit = args.has("--allow-submit")
        options.foreground = args.has("--foreground")
        options.listElements = !args.has("--no-elements")
        let target: AgentScreen
        if iphone {
            target = IPhoneAgentScreen(screen: args.value("--screen") ?? "phone")
            options.forIPhone()
        } else if android {
            target = AndroidAgentScreen(serial: args.value("--serial"))
            options.forPhone()
        } else {
            guard let screen = args.value("--screen"), let pid = args.value("--pid").flatMap(Int32.init) else { fail(usage) }
            target = ControlScreen(screen: screen, pid: pid, windowID: args.value("--window-id").flatMap(UInt32.init))
            // Phones list no controls, so nothing they do could be replayed.
            if !args.has("--no-learn") {
                // Procedures are kept by app: its bundle identifier, else its name.
                let app = NSRunningApplication(processIdentifier: pid)
                options.app = app?.bundleIdentifier ?? app?.localizedName ?? "pid-\(pid)"
                options.procedures = FileProcedureStore.standard
            }
        }
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

        let agent = TarsAgent(screen: target, model: ChatCompletionsModel(config), options: options) { event in
            log(event)
        }
        let result = agent.run(instruction)
        var output: [String: Any] = ["ok": result.outcome == .done, "outcome": result.outcome.rawValue,
                                     "reason": result.reason, "steps": result.steps,
                                     "modelCalls": result.modelCalls, "replayedSteps": result.replayed]
        if let learned = result.learned { output["learned"] = learned }
        if let held = result.held {
            // What would run on confirmation, as 2ndscreen arguments.
            if let screen = target as? AndroidAgentScreen,
               let words = try? AndroidPlan.commands(for: held, size: .zero), words.count == 1 {
                output["pending"] = ["android"] + words[0] + (screen.serial.map { ["--serial", $0] } ?? [])
            } else {
                output["held"] = TarsAgent.describe(held)
            }
        }
        DriverCommands.emit(output)
        exit(result.outcome == .done ? 0 : 1)
    }

    /// Progress on stderr, so stdout carries only the result.
    private static func log(_ event: TarsAgent.Event) {
        FileHandle.standardError.write((TarsAgent.describe(event) + "\n").data(using: .utf8)!)
    }
}
