import CoreGraphics
import Foundation
import SecondScreenCore

/// A control as a learned step names it: by role and label, which survive
/// the window being rebuilt, and by where it was, to tell twins apart.
public struct ElementRef: Codable, Equatable {
    public var role: String
    /// The control's label, which may hold slots; empty for an unnamed
    /// control, which is then found by its place.
    public var label: String
    /// Its center when learned, normalised to the screen.
    public var x: Double
    public var y: Double
}

/// One action of a learned procedure.
public struct LearnedStep: Codable, Equatable {
    /// An `InputAction.Kind`, or "wait".
    public var kind: String
    public var target: ElementRef?
    /// For a click or wheel the model aimed by sight: where in the target
    /// it landed, 0 to 1. Without these the step acts on the control itself.
    public var offsetX: Double?
    public var offsetY: Double?
    public var button: String?
    public var count: Int?
    /// Typed text, which may hold slots.
    public var value: String?
    public var key: String?
    public var modifiers: [String]?
    public var direction: String?
    public var amount: Int?
    public var by: String?
    public var seconds: Double?

    public init(kind: String) {
        self.kind = kind
    }

    /// One line for logs and for telling the model what already ran.
    public func summary(_ bindings: [String] = []) -> String {
        var parts = [kind]
        if button == "right" { parts.append("right") }
        if count == 2 { parts.append("double") }
        if let value { parts.append("\"\(Slots.fill(value, bindings))\"") }
        if let key { parts.append(((modifiers ?? []) + [key]).joined(separator: "+")) }
        if let direction { parts.append(direction) }
        if let seconds { parts.append("\(Int(seconds)) s") }
        if let target {
            let role = target.role.hasPrefix("AX") ? String(target.role.dropFirst(2)) : target.role
            parts.append(target.label.isEmpty ? "→ \(role)" : "→ \(role) \"\(Slots.fill(target.label, bindings))\"")
        }
        return parts.joined(separator: " ")
    }
}

/// The steps that carried out an instruction in an app once, kept so the
/// next run can repeat them without asking the model.
///
/// Every step names a control, so a replay can tell whether the window is
/// where the procedure expects before it acts; a run with a step that only
/// had a point on the screenshot to go by is not kept.
public struct Procedure: Codable {
    public enum Finish: String, Codable {
        /// The task is done when the steps are.
        case steps
        /// The answer is the text of `answerFrom` once the steps ran.
        case element
        /// The answer takes a look at the screen: the model gives it.
        case model
    }

    public var app: String
    /// The instruction it was learned from.
    public var instruction: String
    /// The instruction with the texts the steps use replaced by slots, so
    /// "给陈一写：你好" also serves "给李四写：在的".
    public var template: String
    public var slots: Int
    public var steps: [LearnedStep]
    public var finish: Finish
    public var answerFrom: ElementRef?
    /// The answer control's text with the answer marked ⟦⟧, such as
    /// "显示为 ⟦⟧", when the control holds more than the answer; a replay
    /// takes what stands in the mark.
    public var answerPattern: String? = nil
    /// What the run reported; may hold slots.
    public var reason: String
    /// The action the learned run stopped before for a person to confirm,
    /// such as clicking Send: a replay holds the same one back.
    public var held: LearnedStep?
    /// The named controls on screen when the run ended, as "role|label": a
    /// replay that ends somewhere else did not do the same thing.
    public var endControls: [String]
    /// Whether it was learned with sending allowed; it only serves runs
    /// that allow the same.
    public var allowSubmit: Bool
    public var learned: Date
    public var successes = 0
    /// Replays in a row that had to hand over to the model.
    public var failures = 0

    /// The procedure for `instruction`, with what its slots hold: one
    /// learned from these exact words first, then the most specific.
    public static func best(for instruction: String, in procedures: [Procedure],
                            allowSubmit: Bool) -> (Procedure, [String])? {
        procedures
            .filter { $0.allowSubmit == allowSubmit }
            .compactMap { procedure in Slots.match(procedure.template, instruction).map { (procedure, $0) } }
            .min { a, b in
                let exact = (a.0.instruction == instruction ? 0 : 1, b.0.instruction == instruction ? 0 : 1)
                return exact.0 != exact.1 ? exact.0 < exact.1 : a.0.slots < b.0.slots
            }
    }
}

/// Slots stand for the parts of an instruction that its steps use: text it
/// typed, and names of controls it acted on. They are found by looking, not
/// by asking a model: a typed text or a control's label that appears in the
/// instruction is a slot.
public enum Slots {
    static func marker(_ number: Int) -> String { "⟦\(number)⟧" }
    static let pattern = try! NSRegularExpression(pattern: #"⟦(\d+)⟧"#)
    /// Shorter texts match by accident: "1" is in most instructions.
    static let minLength = 2

    public static func hasSlot(_ text: String) -> Bool {
        pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    public static func fill(_ text: String, _ bindings: [String]) -> String {
        var result = text
        for (number, value) in bindings.enumerated() {
            result = result.replacingOccurrences(of: marker(number), with: value)
        }
        return result
    }

    /// The instruction as a template and the steps and texts with their
    /// slots marked.
    public static func discover(instruction: String, steps: [LearnedStep],
                                texts: [String] = []) -> (template: String, steps: [LearnedStep], texts: [String], slots: Int) {
        var literals: [String] = []
        func add(_ text: String) {
            let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.count >= minLength, instruction.contains(text), !literals.contains(text) { literals.append(text) }
        }
        for step in steps {
            if step.kind == "type", let value = step.value { add(value) }
            if let label = step.target?.label, !label.isEmpty {
                // A row's label often goes on after the name the instruction
                // gave ("陈一 前端工程师 在的"): the name is its start.
                add(instruction.contains(label) ? label : leadingPart(of: label, in: instruction))
            }
        }

        // Longest first, each where the instruction still has room for it.
        var taken: [(range: Range<String.Index>, literal: String)] = []
        for literal in literals.sorted(by: { $0.count > $1.count }) {
            var from = instruction.startIndex
            while let range = instruction.range(of: literal, range: from..<instruction.endIndex) {
                if !taken.contains(where: { $0.range.overlaps(range) }) { taken.append((range, literal)) }
                from = range.upperBound
            }
        }
        taken.sort { $0.range.lowerBound < $1.range.lowerBound }
        // Two slots with nothing between them cannot be told apart in the
        // next instruction; keep the longer.
        var index = 1
        while index < taken.count {
            if taken[index - 1].range.upperBound == taken[index].range.lowerBound,
               taken[index - 1].literal != taken[index].literal {
                let drop = taken[index - 1].literal.count < taken[index].literal.count ? taken[index - 1].literal : taken[index].literal
                taken.removeAll { $0.literal == drop }
                index = 1
            } else {
                index += 1
            }
        }

        var numbers: [String: Int] = [:]
        for entry in taken where numbers[entry.literal] == nil { numbers[entry.literal] = numbers.count }
        var template = ""
        var position = instruction.startIndex
        for entry in taken {
            template += instruction[position..<entry.range.lowerBound] + marker(numbers[entry.literal]!)
            position = entry.range.upperBound
        }
        template += instruction[position...]

        let ordered = numbers.sorted { $0.key.count > $1.key.count }
        func mark(_ text: String) -> String {
            ordered.reduce(text) { $0.replacingOccurrences(of: $1.key, with: marker($1.value)) }
        }
        let marked = steps.map { step -> LearnedStep in
            var step = step
            if step.kind == "type", let value = step.value { step.value = mark(value) }
            if let label = step.target?.label {
                // Only the name the instruction gave; the rest of a row's
                // label belongs to that one row.
                if let literal = ordered.first(where: { label.hasPrefix($0.key) }) {
                    step.target?.label = marker(literal.value) + (label == literal.key ? "" : "…")
                }
            }
            return step
        }
        return (template, marked, texts.map(mark), numbers.count)
    }

    /// What the slots of `template` hold in `instruction`, or nil if it is
    /// a different instruction.
    public static func match(_ template: String, _ instruction: String) -> [String]? {
        var expression = "^"
        var seen: [Int: Int] = [:]  // slot number → capture group
        var position = template.startIndex
        let whole = NSRange(template.startIndex..., in: template)
        for found in pattern.matches(in: template, range: whole) {
            let range = Range(found.range, in: template)!
            expression += NSRegularExpression.escapedPattern(for: String(template[position..<range.lowerBound]))
            let number = Int(template[Range(found.range(at: 1), in: template)!])!
            if let group = seen[number] {
                expression += "\\\(group)"
            } else {
                seen[number] = seen.count + 1
                expression += "(.+?)"
            }
            position = range.upperBound
        }
        expression += NSRegularExpression.escapedPattern(for: String(template[position...])) + "$"
        guard let regex = try? NSRegularExpression(pattern: expression, options: [.dotMatchesLineSeparators]),
              let result = regex.firstMatch(in: instruction, range: NSRange(instruction.startIndex..., in: instruction))
        else { return nil }
        var bindings = Array(repeating: "", count: seen.count)
        for (number, group) in seen {
            guard number < bindings.count, let range = Range(result.range(at: group), in: instruction) else { return nil }
            bindings[number] = String(instruction[range])
        }
        return bindings.contains { $0.trimmingCharacters(in: .whitespaces).isEmpty } ? nil : bindings
    }

    /// The longest start of `label` that the instruction contains.
    static func leadingPart(of label: String, in instruction: String) -> String {
        var best = ""
        var prefix = ""
        for character in label {
            prefix.append(character)
            if instruction.contains(prefix) { best = prefix } else { break }
        }
        return best
    }
}

extension ElementRef {
    static func center(_ element: Frame, in frame: CGRect) -> (x: Double, y: Double) {
        ((element.x + element.width / 2 - frame.minX) / max(frame.width, 1),
         (element.y + element.height / 2 - frame.minY) / max(frame.height, 1))
    }

    init?(_ element: AXElementInfo, in frame: CGRect) {
        guard element.index >= 0, let box = element.frame else { return nil }
        let center = Self.center(box, in: frame)
        self.init(role: element.role, label: (element.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                  x: center.x, y: center.y)
    }

    /// How far an unnamed control may have moved and still be the one.
    static let reach = 0.1

    /// The element this names among `elements`: same role and label, the
    /// one nearest to where it was. A label that was a slot matches labels
    /// that start with what the slot now holds, a whole match first. With
    /// `anyLabel`, an empty label takes the nearest control of the role
    /// whatever it is called, as for an answer whose label is the answer
    /// itself ("Pressed 1", then "Pressed 2").
    public func find(in elements: [AXElementInfo], frame: CGRect, bindings: [String] = [],
                     anyLabel: Bool = false) -> AXElementInfo? {
        func distance(_ element: AXElementInfo) -> Double {
            let center = Self.center(element.frame!, in: frame)
            return hypot(center.x - x, center.y - y)
        }
        var wanted = Slots.fill(label, bindings)
        let open = Slots.hasSlot(label) && wanted.hasSuffix("…")
        if open { wanted.removeLast() }
        let ranked = elements.compactMap { element -> (AXElementInfo, Int, Double)? in
            guard element.index >= 0, element.role == role, element.frame != nil else { return nil }
            let found = (element.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if label.isEmpty {
                return (anyLabel || found.isEmpty) && distance(element) <= Self.reach ? (element, 0, distance(element)) : nil
            }
            if found == wanted { return (element, 0, distance(element)) }
            if Slots.hasSlot(label), found.hasPrefix(wanted) { return (element, 1, distance(element)) }
            return nil
        }
        return ranked.min { ($0.1, $0.2) < ($1.1, $1.2) }?.0
    }
}

/// Where procedures are kept between runs.
public protocol ProcedureStore {
    func load(app: String) -> [Procedure]
    func save(_ procedures: [Procedure], app: String)
}

/// One JSON file an app, under a directory.
public struct FileProcedureStore: ProcedureStore {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// ~/.config/2ndscreen/procedures
    public static var standard: FileProcedureStore {
        FileProcedureStore(directory: URL(fileURLWithPath: NSHomeDirectory() + "/.config/2ndscreen/procedures"))
    }

    public func file(app: String) -> URL {
        let name = String(app.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" ? $0 : "_" })
        return directory.appendingPathComponent((name.isEmpty ? "app" : name) + ".json")
    }

    public func load(app: String) -> [Procedure] {
        guard let data = try? Data(contentsOf: file(app: app)) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([Procedure].self, from: data)) ?? []
    }

    public func save(_ procedures: [Procedure], app: String) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(procedures) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: file(app: app), options: .atomic)
    }
}
