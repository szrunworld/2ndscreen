import Foundation
import SecondScreenCore

extension TarsAgent {
    /// One line or a few for a run's progress, as the command line prints
    /// it and the app's panel shows it: thoughts (·), the model's actions
    /// (→), what ran ($), errors (!), notes (~) and the stop.
    public static func describe(_ event: Event) -> String {
        switch event {
        case .thought(let thought, let actions):
            let calls = actions.map { action in
                let arguments = action.inputs.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
                return "\(action.type)(\(arguments.joined(separator: ", ")))"
            }
            return (thought.isEmpty ? "" : "· \(thought)\n") + calls.map { "  → \($0)" }.joined(separator: "\n")
        case .step(.act(let action)):
            return "  $ \(describe(action))"
        case .step(.wait(let seconds)):
            return "  wait \(Int(seconds)) s"
        case .step(.stop(_, let reason)):
            return "  stop: \(reason)"
        case .step(.hold(let action, let reason)):
            return "  stop: \(reason) (held: \(describe(action)))"
        case .error(let message):
            return "  ! \(message)"
        case .note(let message):
            return "~ \(message)"
        }
    }

    public static func describe(_ action: InputAction) -> String {
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
