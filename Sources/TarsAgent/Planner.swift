import CoreGraphics
import Foundation
import SecondScreenCore

/// What to do for one model action.
public enum Step {
    case act(InputAction)
    case wait(seconds: Double)
    /// End the run: `done` when the model finished or stopped short of
    /// submitting, `user` when it needs a person.
    case stop(Outcome, String)
}

public enum Outcome: String {
    case done
    case user
}

public struct PlanContext {
    /// The agent screen's frame in global points; model boxes map onto it.
    public var frame: CGRect
    /// Let the model submit: press Enter, or type text that ends in a newline.
    public var allowSubmit: Bool
    /// Let actions that need the real pointer run.
    public var foreground: Bool
    /// The app has a popup menu open, where Enter picks an item rather
    /// than submitting.
    public var menuOpen = false

    public init(frame: CGRect, allowSubmit: Bool = false, foreground: Bool = false) {
        self.frame = frame
        self.allowSubmit = allowSubmit
        self.foreground = foreground
    }
}

/// Turns one parsed UI-TARS action into input actions. Pure, so the mapping
/// and the send policy can be tested without a model or a screen.
public enum Planner {
    static let modifierWords: Set<String> = ["ctrl", "control", "cmd", "command", "meta", "win", "super",
                                             "shift", "alt", "option"]
    static let keyNames: [String: String] = [
        "arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right",
        "esc": "escape", "enter": "return", "backspace": "delete",
    ]

    /// The center of a normalised box as a global point on the screen.
    public static func point(_ box: [Double]?, in frame: CGRect) -> CGPoint? {
        guard let box, box.count >= 2 else { return nil }
        let (x1, y1) = (box[0], box[1])
        let (x2, y2) = box.count >= 4 ? (box[2], box[3]) : (x1, y1)
        let nx = min(max((x1 + x2) / 2, 0), 1)
        let ny = min(max((y1 + y2) / 2, 0), 1)
        return CGPoint(x: ((frame.minX + nx * frame.width) * 10).rounded() / 10,
                       y: ((frame.minY + ny * frame.height) * 10).rounded() / 10)
    }

    /// "ctrl c", "cmd+shift+n" or "enter" as a key and its modifiers. As in
    /// UI-TARS's own desktop operator, ctrl means cmd on macOS.
    public static func keys(_ text: String) -> (key: String, modifiers: [String])? {
        let words = text.lowercased()
            .replacingOccurrences(of: #"page (up|down)"#, with: "page$1", options: .regularExpression)
            .split(whereSeparator: { $0 == " " || $0 == "+" }).map(String.init)
        var modifiers: [String] = []
        var key: String?
        for word in words {
            if modifierWords.contains(word) {
                let modifier: String
                switch word {
                case "ctrl", "control", "command", "meta", "super", "win": modifier = "cmd"
                case "alt": modifier = "option"
                default: modifier = word
                }
                if !modifiers.contains(modifier) { modifiers.append(modifier) }
            } else {
                key = keyNames[word] ?? word
            }
        }
        return key.map { ($0, modifiers) }
    }

    /// Shortcuts that act beyond the app's window: quitting, hiding or
    /// switching apps, and system ones. Models reach for them when stuck.
    static func escape(_ keys: (key: String, modifiers: [String])) -> String? {
        let modifiers = Set(keys.modifiers)
        guard modifiers.contains("cmd") else { return nil }
        switch keys.key {
        case "q": return modifiers.contains("shift") ? "log out" : "quit the app or lock the screen"
        case "tab", "`": return "switch apps"
        case "escape": return modifiers.contains("option") ? "open Force Quit" : nil
        case "h": return "hide the app"
        case "m": return "minimize the window off the screen"
        case "space": return "open Spotlight"
        default: return nil
        }
    }

    public static func plan(_ action: ParsedAction, _ context: PlanContext) -> [Step] {
        let start = point(action.boxes["start_box"], in: context.frame)
        let end = point(action.boxes["end_box"], in: context.frame)
        let input = { (name: String) in action.inputs[name] ?? "" }

        switch action.type {
        case "click", "left_click", "left_single", "left_double", "double_click", "right_single", "right_click":
            guard let start else { return [.stop(.user, "\(action.type) without a point")] }
            var click = InputAction(.click)
            click.x = start.x
            click.y = start.y
            if ["left_double", "double_click"].contains(action.type) { click.count = 2 }
            if ["right_single", "right_click"].contains(action.type) { click.button = "right" }
            return [.act(click)]

        case "drag", "left_click_drag", "select":
            guard let start, let end else { return [.stop(.user, "drag without both points")] }
            guard context.foreground else {
                // Models drag mostly to select text. Without the real pointer,
                // a double click selects a word, and a click then a shift-click
                // selects a range, in editors and web pages alike.
                var first = InputAction(.click)
                first.x = start.x
                first.y = start.y
                if hypot(end.x - start.x, end.y - start.y) < 4 {
                    first.count = 2
                    return [.act(first)]
                }
                var second = InputAction(.click)
                second.x = end.x
                second.y = end.y
                second.modifiers = ["shift"]
                return [.act(first), .act(second)]
            }
            var drag = InputAction(.drag)
            drag.x = start.x
            drag.y = start.y
            drag.toX = end.x
            drag.toY = end.y
            drag.foreground = true
            return [.act(drag)]

        case "type":
            // A trailing newline, literal or escaped, means "and submit".
            var text = input("content")
            var submit = false
            for ending in ["\\n", "\n"] where text.hasSuffix(ending) {
                text.removeLast(ending.count)
                submit = true
                break
            }
            var steps: [Step] = []
            if !text.isEmpty {
                var type = InputAction(.type)
                type.value = text.replacingOccurrences(of: "\\n", with: "\n")
                steps.append(.act(type))
            }
            if submit {
                if context.allowSubmit {
                    var key = InputAction(.key)
                    key.key = "return"
                    steps.append(.act(key))
                } else {
                    steps.append(.stop(.done, "stopped before submitting; the text is typed but not sent"))
                }
            }
            return steps

        case "hotkey", "press", "keydown":
            guard let keys = keys(input("key").isEmpty ? input("hotkey") : input("key")) else { return [] }
            if keys.key == "return", keys.modifiers.isEmpty, context.menuOpen {
                var key = InputAction(.key)
                key.key = "return"
                return [.act(key)]
            }
            if keys.key == "return", !context.allowSubmit {
                return [.stop(.done, "stopped before pressing Enter, which would submit")]
            }
            if let effect = escape(keys) {
                return [.stop(.user, "the model asked for \((keys.modifiers + [keys.key]).joined(separator: "+")), "
                    + "which would \(effect); a person should look")]
            }
            var key = InputAction(.key)
            key.key = keys.key
            if !keys.modifiers.isEmpty { key.modifiers = keys.modifiers }
            return [.act(key)]

        case "scroll":
            let direction = input("direction").lowercased()
            guard ["up", "down", "left", "right"].contains(direction) else { return [] }
            var scroll = InputAction(.scroll)
            scroll.direction = direction
            scroll.amount = 5
            if let start {
                scroll.x = start.x
                scroll.y = start.y
            }
            return [.act(scroll)]

        case "wait":
            return [.wait(seconds: 5)]

        case "finished":
            let content = input("content")
            return [.stop(.done, content.isEmpty ? "finished" : content)]

        case "call_user", "error_env", "user_stop":
            return [.stop(.user, action.type)]

        case "hover", "mouse_move":
            // Nothing to do: agents act without moving a pointer.
            return []

        default:
            return [.stop(.user, "unsupported action \(action.type)")]
        }
    }
}
