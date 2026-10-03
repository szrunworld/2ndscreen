import Foundation

/// One action a UI-TARS model asked for.
public struct ParsedAction: Equatable {
    public var type: String
    /// Arguments as written, except boxes: `start_box` and `end_box` hold
    /// their coordinates normalised to 0..1, as `[x1, y1, x2, y2]`.
    public var inputs: [String: String]
    public var boxes: [String: [Double]]

    public init(type: String, inputs: [String: String] = [:], boxes: [String: [Double]] = [:]) {
        self.type = type
        self.inputs = inputs
        self.boxes = boxes
    }
}

/// A model reply: its reasoning and the actions it chose.
public struct Prediction: Equatable {
    public var thought: String
    public var actions: [ParsedAction]
    /// The reply as the model wrote it.
    public var raw: String
}

/// Reads UI-TARS replies, in the `Thought: … Action: …` format of its
/// prompt. Follows `@ui-tars/action-parser` (Apache-2.0, ByteDance) for
/// what models write, and also reads boxes it misses: models now and then
/// drop the comma, `[383 117]`, or write `<point>383 117</point>`.
public enum ActionParser {
    /// Model coordinates are on a 0..1000 scale.
    static let factor = 1000.0

    public static func parse(_ text: String) -> Prediction {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var thought = ""
        if let match = firstMatch(#"Thought:\s*([\s\S]+?)(?=\s*Action[:：]|$)"#, in: text) {
            thought = match
        } else if let match = firstMatch(#"Action_Summary:\s*([\s\S]+?)(?=\s*Action[:：]|$)"#, in: text) {
            thought = match
        }
        var actionText = text
        if let range = text.range(of: #"Action[:：]"#, options: [.regularExpression, .backwards]) {
            actionText = String(text[range.upperBound...])
        }
        let actions = actionText.components(separatedBy: "\n\n").compactMap { chunk -> ParsedAction? in
            let line = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
            return line.isEmpty ? nil : parseCall(line)
        }
        return Prediction(thought: thought.trimmingCharacters(in: .whitespacesAndNewlines), actions: actions, raw: text)
    }

    /// `name(key='value', …)` as an action, or nil if it is not a call.
    static func parseCall(_ text: String) -> ParsedAction? {
        var call = text.replacingOccurrences(of: "<|box_start|>", with: "")
            .replacingOccurrences(of: "<|box_end|>", with: "")
            .replacingOccurrences(of: "\n", with: "\\n")
        call = call.replacingOccurrences(of: #"(?<!start_|end_)point="#, with: "start_box=", options: .regularExpression)
            .replacingOccurrences(of: "start_point=", with: "start_box=")
            .replacingOccurrences(of: "end_point=", with: "end_box=")
        guard let open = call.firstIndex(of: "("), call.hasSuffix(")") else { return nil }
        let name = String(call[..<open]).trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
        let body = String(call[call.index(after: open)..<call.index(before: call.endIndex)])

        var action = ParsedAction(type: name)
        for (key, value) in arguments(body) {
            if key.contains("start_box") || key.contains("end_box") {
                let name = key.contains("start_box") ? "start_box" : "end_box"
                if let box = box(value) { action.boxes[name] = box }
                action.inputs[name] = value
            } else {
                action.inputs[key] = value
            }
        }
        return action
    }

    /// `key='value'` pairs, splitting on commas outside quotes.
    static func arguments(_ body: String) -> [(String, String)] {
        var pairs: [(String, String)] = []
        var current = ""
        var quote: Character?
        func flush() {
            let parts = current.split(separator: "=", maxSplits: 1).map(String.init)
            if parts.count == 2 {
                let key = parts[0].trimmingCharacters(in: .whitespaces)
                var value = parts[1].trimmingCharacters(in: .whitespaces)
                if let first = value.first, first == "'" || first == "\"" { value.removeFirst() }
                if let last = value.last, last == "'" || last == "\"" { value.removeLast() }
                if !key.isEmpty { pairs.append((key, value)) }
            }
            current = ""
        }
        for character in body {
            if let open = quote {
                if character == open { quote = nil }
                current.append(character)
            } else if character == "'" || character == "\"" {
                quote = character
                current.append(character)
            } else if character == ",", !current.contains("=") || isBalancedBox(current) {
                flush()
            } else {
                current.append(character)
            }
        }
        flush()
        return pairs
    }

    /// Whether a pending `key=(…` or `key=[…` has closed, so a comma ends it.
    private static func isBalancedBox(_ text: String) -> Bool {
        let opens = text.filter { $0 == "(" || $0 == "[" }.count
        let closes = text.filter { $0 == ")" || $0 == "]" }.count
        return opens == closes
    }

    /// A box as four numbers in 0..1. Takes `[x1, y1, x2, y2]`, `(x, y)`,
    /// `<point>x y</point>`, `<bbox>…</bbox>` and comma-less `[x y]`; a point
    /// becomes a box of zero size. Values above 1 are on the 0..1000 scale.
    public static func box(_ text: String) -> [Double]? {
        let numbers = numbers(in: text)
        guard numbers.count >= 2 else { return nil }
        let scale = numbers.contains { $0 > 1 } ? factor : 1
        let n = numbers.prefix(4).map { $0 / scale }
        return n.count >= 4 ? Array(n) : [n[0], n[1], n[0], n[1]]
    }

    /// The box named `name` read again from the whole reply, for when the
    /// call itself would not parse.
    public static func recoverBox(_ prediction: String, _ name: String) -> [Double]? {
        guard let range = prediction.range(of: name, options: .backwards) else { return nil }
        var rest = String(prediction[range.upperBound...])
        for stop in ["end_box", "direction", "content"] {
            if let end = rest.range(of: stop) { rest = String(rest[..<end.lowerBound]) }
        }
        return box(rest)
    }

    static func numbers(in text: String) -> [Double] {
        let regex = try! NSRegularExpression(pattern: #"-?\d+(?:\.\d+)?"#)
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { Range($0.range, in: text).flatMap { Double(text[$0]) } }
    }

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text)
        else { return nil }
        return String(text[range])
    }
}

/// The text a model's reply contributes to the conversation history: the
/// reply without any `Reflection:` block, as UI-TARS's SDK keeps it.
func summary(of prediction: String) -> String {
    prediction.replacingOccurrences(of: #"Reflection:[\s\S]*?(?=Action_Summary:|Action:|$)"#, with: "",
                                    options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}
