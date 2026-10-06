import CoreGraphics
import Foundation
import SecondScreenCore

/// Turns the agent's input actions into `2ndscreen android` commands for a
/// phone, in device pixels.
public enum AndroidPlan {
    public struct Failure: LocalizedError {
        public let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    /// `2ndscreen android` words, without the serial, for one action. Pure,
    /// so the mapping is tested without a phone.
    public static func commands(for action: InputAction, size: CGSize) throws -> [[String]] {
        func number(_ value: Double) -> String { String(Int(value.rounded())) }
        func point(_ p: CGPoint) -> [String] { ["--x", number(p.x), "--y", number(p.y)] }
        func swipe(_ from: CGPoint, _ to: CGPoint, _ seconds: Double) -> [String] {
            ["swipe"] + point(from) + ["--to-x", number(to.x), "--to-y", number(to.y), "--duration", "\(seconds)"]
        }

        switch action.kind {
        case .click:
            guard let p = action.point else { throw AndroidPlan.Failure("click without a point") }
            // A held press, or a right click, is a long press on a phone.
            if action.durationMs != nil || action.button == "right" {
                return [swipe(p, p, 0.8)]
            }
            let tap = ["tap"] + point(p)
            return action.count == 2 ? [tap, tap] : [tap]

        case .hover:
            // A touch screen has no pointer to rest anywhere.
            return []

        case .drag:
            guard let from = action.point, let toX = action.toX, let toY = action.toY else {
                throw AndroidPlan.Failure("drag without both points")
            }
            return [swipe(from, CGPoint(x: toX, y: toY), 0.5)]

        case .scroll:
            // Scrolling down shows what is below, so the finger moves up.
            let p = action.point ?? CGPoint(x: size.width / 2, y: size.height / 2)
            let direction = action.direction ?? "down"
            let dx: CGFloat = direction == "left" ? 1 : direction == "right" ? -1 : 0
            let dy: CGFloat = direction == "up" ? 1 : direction == "down" ? -1 : 0
            let reach = min(size.width, size.height) * 0.6
            // Keep off the edges, where a swipe is the system's Back or Home
            // gesture, by moving the whole swipe inward rather than cutting
            // it short: models point near the bottom of a list.
            func center(_ value: CGFloat, _ limit: CGFloat, _ half: CGFloat) -> CGFloat {
                min(max(value, limit * 0.15 + half), limit * 0.85 - half)
            }
            let middle = CGPoint(x: center(p.x, size.width, abs(dx) * reach / 2),
                                 y: center(p.y, size.height, abs(dy) * reach / 2))
            let start = CGPoint(x: (middle.x - dx * reach / 2).rounded(), y: (middle.y - dy * reach / 2).rounded())
            let end = CGPoint(x: (middle.x + dx * reach / 2).rounded(), y: (middle.y + dy * reach / 2).rounded())
            return [swipe(start, end, 0.35)]

        case .type:
            guard let text = action.value, !text.isEmpty else { return [] }
            return [["type", "--text", text]]

        case .key:
            guard let key = action.key else { throw AndroidPlan.Failure("key without a key") }
            guard (action.modifiers ?? []).isEmpty else {
                throw AndroidPlan.Failure("a phone has no \(((action.modifiers ?? []) + [key]).joined(separator: "+")) shortcut")
            }
            let names = ["return": "enter", "escape": "back"]
            return [["key", "--key", names[key] ?? key]]
        }
    }

    /// The app request for words from `commands`.
    public static func request(_ words: [String], serial: String?) throws -> ControlRequest {
        func value(_ flag: String) -> String? {
            words.firstIndex(of: flag).flatMap { $0 + 1 < words.count ? words[$0 + 1] : nil }
        }
        func number(_ flag: String) throws -> Double {
            guard let number = value(flag).flatMap(Double.init) else { throw Failure("\(words.first ?? "") needs \(flag)") }
            return number
        }
        var request: ControlRequest
        switch words.first {
        case "tap":
            request = ControlRequest(command: .androidTap)
            request.x = try number("--x")
            request.y = try number("--y")
        case "swipe":
            request = ControlRequest(command: .androidSwipe)
            request.x = try number("--x")
            request.y = try number("--y")
            request.toX = try number("--to-x")
            request.toY = try number("--to-y")
            request.duration = value("--duration").flatMap(Double.init)
        case "type":
            request = ControlRequest(command: .androidType)
            request.text = value("--text")
        case "key":
            request = ControlRequest(command: .androidKey)
            request.key = value("--key")
        default:
            throw Failure("no android command \(words.first ?? "")")
        }
        request.serial = serial
        return request
    }
}
