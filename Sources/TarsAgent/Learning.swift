import CoreGraphics
import Foundation
import SecondScreenCore

/// Learning from a run that worked, and replaying what was learned.
///
/// The model explores once. Its steps are kept with the controls they acted
/// on, and the next run of the instruction repeats them by finding those
/// controls again, which needs no model. A step whose control is missing, a
/// text that did not land, or an end that looks unlike the learned one
/// hands the rest to the model, and what it then does becomes the procedure.
extension TarsAgent {
    enum ReplayEnd {
        case finished(Result)
        /// Why the model has to take over, and whether the procedure let
        /// the run down or only needs the model's eyes for the answer.
        case handOver(String, failed: Bool)
    }

    /// Containers: a click inside one is aimed at something they do not name.
    static let containerRoles: Set<String> = ["AXGroup", "AXScrollArea", "AXWindow", "AXWebArea", "AXList", "AXTable",
                                              "AXOutline", "AXSplitGroup", "AXLayoutArea", "AXApplication"]

    // MARK: Recording

    /// `action` as a procedure would repeat it, with the control it acts on:
    /// the one the model named, or the smallest named control under the
    /// point it chose by sight. Marks the run unlearnable when no control
    /// says where the action went.
    func learnedStep(_ action: InputAction, named: AXElementInfo?) -> LearnedStep? {
        var step = LearnedStep(kind: action.kind.rawValue)
        step.button = action.button
        step.count = action.count
        step.value = action.value
        step.key = action.key
        step.modifiers = action.modifiers
        step.direction = action.direction
        step.amount = action.amount
        step.by = action.by
        let frame = currentFrame

        switch action.kind {
        case .key:
            return step
        case .drag:
            unlearnable = unlearnable ?? "a drag takes the real pointer"
            return nil
        case .type where named == nil:
            // Keys to whatever has focus, which the step before gave it.
            return step
        case .click, .type, .scroll, .hover:
            if let named, let reference = ElementRef(named, in: frame) {
                step.target = reference
                return step
            }
            guard let point = action.point else {
                // A wheel with no point turns mid-window.
                if action.kind == .scroll { return step }
                unlearnable = unlearnable ?? "a \(action.kind.rawValue) had no control to go by"
                return nil
            }
            let under = currentElements()
                .filter { element in
                    guard element.index >= 0, let box = element.frame, Self.contains(box, point) else { return false }
                    let base = element.role.split(separator: "/").first.map(String.init) ?? element.role
                    return !Self.containerRoles.contains(base) && box.width * box.height <= Double(frame.width * frame.height) / 5
                        && (!(element.label ?? "").isEmpty || AXActions.isText(element))
                }
                .min { $0.frame!.width * $0.frame!.height < $1.frame!.width * $1.frame!.height }
            guard let under, let box = under.frame, let reference = ElementRef(under, in: frame) else {
                unlearnable = unlearnable ?? "a \(action.kind.rawValue) went to a point no control names"
                return nil
            }
            step.target = reference
            step.offsetX = (point.x - box.x) / max(box.width, 1)
            step.offsetY = (point.y - box.y) / max(box.height, 1)
            return step
        }
    }

    /// The action a run held back, as a replay would find it again; nil if
    /// no control says where it went. Unlike a step, it never makes the run
    /// unlearnable: the run stopped before it.
    func learnedHeld(_ action: InputAction, named: AXElementInfo?) -> LearnedStep? {
        let before = unlearnable
        defer { unlearnable = before }
        return learnedStep(action, named: named)
    }

    /// The held step as an action on the screen as it is.
    func heldAction(_ step: LearnedStep, _ bindings: [String]) -> InputAction? {
        guard let kind = InputAction.Kind(rawValue: step.kind) else { return nil }
        var action = InputAction(kind)
        action.button = step.button
        action.count = step.count
        action.value = step.value.map { Slots.fill($0, bindings) }
        action.key = step.key
        action.modifiers = step.modifiers
        if let target = step.target {
            elementCache = nil
            guard let element = target.find(in: currentElements(), frame: currentFrame, bindings: bindings),
                  let box = element.frame else { return nil }
            if let offsetX = step.offsetX, let offsetY = step.offsetY {
                action.x = box.x + offsetX * box.width
                action.y = box.y + offsetY * box.height
            } else {
                action.index = element.index
                action.x = box.x + box.width / 2
                action.y = box.y + box.height / 2
            }
        }
        return action
    }

    /// The text of each control, keyed by role and place.
    static func texts(_ elements: [AXElementInfo], in frame: CGRect) -> [String: String] {
        var texts: [String: String] = [:]
        for element in elements {
            guard let reference = ElementRef(element, in: frame) else { continue }
            texts[key(reference)] = text(of: element)
        }
        return texts
    }

    static func key(_ reference: ElementRef) -> String {
        "\(reference.role)|\(Int((reference.x * 500).rounded()))|\(Int((reference.y * 500).rounded()))"
    }

    static func text(of element: AXElementInfo) -> String {
        // Less invisible direction marks, which Calculator puts between digits.
        func clean(_ text: String?) -> String {
            String((text ?? "").unicodeScalars.filter { $0.properties.generalCategory != .format })
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let value = clean(element.value)
        return value.isEmpty ? clean(element.label) : value
    }

    /// Letters and digits only, so "1,651" answers "1651".
    static func plain(_ text: String) -> String {
        String(text.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
    }

    /// The named controls on screen, as "role|label", less plain text and
    /// labels in `except`, which belong to this run's instruction.
    static func controls(_ elements: [AXElementInfo], in frame: CGRect, except: [String] = []) -> [String] {
        var seen = Set<String>()
        return elements.compactMap { element -> String? in
            guard element.index >= 0, element.role != "AXStaticText", let box = element.frame,
                  frame.contains(CGPoint(x: box.x + box.width / 2, y: box.y + box.height / 2))
            else { return nil }
            let label = (element.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, !except.contains(where: { label.hasPrefix($0) }) else { return nil }
            let entry = "\(element.role)|\(label)"
            return seen.insert(entry).inserted ? entry : nil
        }
    }

    /// Fewer named controls than this say too little about where a run ended.
    static let fewestEndControls = 3
    /// The share of the learned end's controls a replay's end must show.
    static let endSimilarity = 0.6

    // MARK: Learning

    /// Keep a run that worked as a procedure, and say on the result what
    /// became of it.
    func finish(_ result: Result, _ instruction: String, _ store: ProcedureStore) -> Result {
        var result = result
        guard result.outcome == .done else {
            result.learned = "not learned: the run did not finish"
            return result
        }
        if let unlearnable {
            result.learned = "not learned: \(unlearnable)"
            return result
        }
        guard trace.contains(where: { $0.kind != "wait" }) else {
            result.learned = "not learned: nothing was done"
            return result
        }
        elementCache = nil
        let frame = (try? screen.frame()) ?? currentFrame
        let elements = currentElements()

        // An answer that some control now shows, and did not show before,
        // can be read off that control next time.
        var finish = Procedure.Finish.steps
        var answerFrom: ElementRef?
        var answerPattern: String?
        var reason = result.reason
        if let content = finishedContent, !content.isEmpty, !Self.matches(Self.asksForInformation, instruction) {
            // A task that asks for nothing has no answer to read again; what the
            // model said about this run (the fonts a search found) would be wrong
            // about the next.
            reason = "done: replayed the steps learned for this task"
        } else if let content = finishedContent, !content.isEmpty {
            // A control the run changed whose text holds the answer, or part of
            // it: Windows Calculator shows "显示为 1651" where the model said
            // "结果为 1651". Text the instruction already holds, such as the sum
            // it gave (37×48-125), is not what the run found out.
            let asked = Self.plain(instruction)
            let shown = elements.compactMap { element -> (reference: ElementRef, text: String, core: String)? in
                guard let reference = ElementRef(element, in: frame) else { return nil }
                let text = Self.text(of: element)
                guard startTexts[Self.key(reference)] != text else { return nil }
                let core = Self.answerCore(Self.longestCommon(text, content))
                let bare = Self.plain(core)
                guard !bare.isEmpty, !asked.contains(bare), bare.count >= 2 || bare.contains(where: \.isNumber) else { return nil }
                return (reference, text, core)
            }
            if let best = shown.min(by: { a, b in
                let (la, lb) = (Self.plain(a.core).count, Self.plain(b.core).count)
                return la != lb ? la > lb : a.text.count < b.text.count
            }) {
                finish = .element
                answerFrom = best.reference
                // Found by place: its label holds the answer, which changes.
                if answerFrom!.label.contains(best.core) { answerFrom!.label = "" }
                if best.text != best.core { answerPattern = best.text.replacingOccurrences(of: best.core, with: "⟦⟧") }
            } else {
                finish = .model
            }
        }

        let found = Slots.discover(instruction: instruction, steps: trace + (heldStep.map { [$0] } ?? []),
                                   texts: [reason])
        let bound = Slots.match(found.template, instruction) ?? []
        let end = Self.controls(elements, in: frame, except: bound)
        if finish == .steps, end.count < Self.fewestEndControls {
            // Nothing to check a replay's end against; let the model look.
            finish = .model
        }
        let procedure = Procedure(
            app: options.app, instruction: instruction, template: found.template, slots: found.slots,
            steps: heldStep == nil ? found.steps : Array(found.steps.dropLast()), finish: finish,
            answerFrom: answerFrom, answerPattern: answerPattern, reason: found.texts[0], held: heldStep == nil ? nil : found.steps.last,
            endControls: end, allowSubmit: options.allowSubmit, learned: Date(), successes: 1, failures: 0)
        var known = store.load(app: options.app)
        known.removeAll { $0.template == procedure.template && $0.allowSubmit == procedure.allowSubmit }
        known.append(procedure)
        store.save(known, app: options.app)
        result.modelCalls = modelCalls
        result.learned = "saved"
        onEvent(.note("learned \(procedure.steps.count) step(s) for next time"))
        return result
    }

    /// Wording that asks for something to be read and reported, which no
    /// learned run may answer from memory.
    static let asksForInformation = try! NSRegularExpression(
        pattern: #"告诉我|多少|是什么|是谁|是否|几[个点号次]|读|查|算|求|结果|what|which|how many|how much|tell me|read|find out|calculate|compute"#,
        options: .caseInsensitive)

    /// The longest text the two share.
    static func longestCommon(_ a: String, _ b: String) -> String {
        let a = Array(a), b = Array(b)
        var row = Array(repeating: 0, count: b.count + 1)
        var best = 0, end = 0
        for i in 1...max(a.count, 1) where i <= a.count {
            var diagonal = 0
            for j in 1...max(b.count, 1) where j <= b.count {
                let above = row[j]
                row[j] = a[i - 1] == b[j - 1] ? diagonal + 1 : 0
                if row[j] > best { best = row[j]; end = i }
                diagonal = above
            }
        }
        return String(a[(end - best)..<end])
    }

    /// Shared text cut to its digits and Latin letters when it has any, so the
    /// "为 " that "结果为 1651" and "显示为 1651" share stays out of the answer.
    static func answerCore(_ shared: String) -> String {
        let characters = Array(shared)
        func ascii(_ c: Character) -> Bool { c.isASCII && (c.isLetter || c.isNumber) }
        guard let first = characters.firstIndex(where: ascii), let last = characters.lastIndex(where: ascii) else {
            return shared.trimmingCharacters(in: .whitespaces)
        }
        return String(characters[first...last])
    }


    // MARK: Replay

    func replay(_ procedure: Procedure, _ bindings: [String], instruction: String) -> ReplayEnd {
        for (number, step) in procedure.steps.enumerated() {
            if options.isCancelled() { return .handOver("stopped", failed: false) }
            let what = "step \(number + 1) (\(step.summary(bindings)))"
            if step.kind == "wait" {
                // A wait only gave the app time, which finding the next
                // step's control does better; keep it before blind steps.
                let next = procedure.steps.dropFirst(number + 1).first
                if next?.target == nil { Thread.sleep(forTimeInterval: min(step.seconds ?? 1, options.replayPatience)) }
                onEvent(.step(.wait(seconds: step.seconds ?? 1)))
                trace.append(step)
                continue
            }
            guard let kind = InputAction.Kind(rawValue: step.kind) else { return .handOver("\(what) is not an action", failed: true) }
            var action = InputAction(kind)
            action.button = step.button
            action.count = step.count
            action.value = step.value.map { Slots.fill($0, bindings) }
            action.key = step.key
            action.modifiers = step.modifiers
            action.direction = step.direction
            action.amount = step.amount
            action.by = step.by

            var element: AXElementInfo?
            if let target = step.target {
                guard let found = locate(target, bindings) else { return .handOver("\(what): its control is not on screen", failed: true) }
                element = found
                let box = found.frame!
                if let offsetX = step.offsetX, let offsetY = step.offsetY {
                    action.x = box.x + offsetX * box.width
                    action.y = box.y + offsetY * box.height
                } else {
                    action.index = found.index
                    if kind == .click {
                        action.x = box.x + box.width / 2
                        action.y = box.y + box.height / 2
                    }
                }
            } else {
                Thread.sleep(forTimeInterval: min(0.3, options.replayPatience))
            }

            // The guards a model's step goes through.
            if !options.allowSubmit {
                if kind == .click, let element,
                   Self.matches(options.submitLabels, (element.label ?? "").trimmingCharacters(in: .whitespaces)) {
                    return .handOver("\(what) would submit", failed: true)
                }
                if kind == .type, action.value?.last?.isNewline == true { return .handOver("\(what) would submit", failed: true) }
                if kind == .key, ["return", "enter"].contains((step.key ?? "").lowercased()), !screen.menuOpen() {
                    return .handOver("\(what) would submit", failed: true)
                }
            }

            onEvent(.step(.act(action)))
            elementCache = nil
            do {
                let response = try screen.perform(action)
                guard response.ok else { return .handOver("\(what) failed: \(response.error ?? "no reason given")", failed: true) }
            } catch {
                return .handOver("\(what) failed: \(error.localizedDescription)", failed: true)
            }
            trace.append(step)

            // Typed text shows in a field that reports its text.
            if kind == .type, let target = step.target, let text = action.value, let element, AXActions.isText(element),
               element.value != nil, !landed(text, in: target, bindings) {
                return .handOver("\(what): the text did not land", failed: true)
            }
        }

        // The same steps ending somewhere else did something else.
        if procedure.endControls.count >= Self.fewestEndControls, !endsAlike(procedure, bindings) {
            return .handOver("the screen does not end as it did when this was learned", failed: true)
        }
        let steps = procedure.steps.count
        switch procedure.finish {
        case .steps:
            var result = Result(outcome: .done, reason: Slots.fill(procedure.reason, bindings), steps: steps,
                                modelCalls: modelCalls, replayed: steps)
            if let held = procedure.held {
                // The run ends where the learned one did: before an action for
                // a person to confirm, which must be on screen to be offered.
                guard let action = heldAction(held, bindings) else {
                    return .handOver("the control it stopped before is not on screen", failed: true)
                }
                result.held = action
            }
            return .finished(result)
        case .element:
            guard let from = procedure.answerFrom, let element = locate(from, bindings, anyLabel: true) else {
                return .handOver("the control that held the answer is not on screen", failed: true)
            }
            var answer = Self.text(of: element)
            if let pattern = procedure.answerPattern {
                let parts = pattern.components(separatedBy: "⟦⟧").map(NSRegularExpression.escapedPattern(for:))
                guard let regex = try? NSRegularExpression(pattern: "^" + parts.joined(separator: "(.+?)") + "$",
                                                           options: [.dotMatchesLineSeparators]),
                      let match = regex.firstMatch(in: answer, range: NSRange(answer.startIndex..., in: answer)),
                      let range = Range(match.range(at: 1), in: answer)
                else { return .handOver("the control that held the answer reads differently now", failed: true) }
                answer = answer[range].trimmingCharacters(in: .whitespaces)
            }
            guard !answer.isEmpty else { return .handOver("the control that held the answer is empty", failed: true) }
            guard !Self.plain(instruction).contains(Self.plain(answer)) else {
                return .handOver("the control that held the answer shows the instruction's own text", failed: true)
            }
            return .finished(Result(outcome: .done, reason: answer, steps: steps, modelCalls: modelCalls, replayed: steps))
        case .model:
            return .handOver("the steps ran; the answer takes a look at the screen", failed: false)
        }
    }

    /// Wait for `test` to hold on a fresh read of the window.
    private func eventually(_ test: ([AXElementInfo], CGRect) -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(options.replayPatience)
        while true {
            elementCache = nil
            if let frame = try? screen.frame() {
                currentFrame = frame
                if test(currentElements(), frame) { return true }
            }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 0.4)
        }
    }

    private func locate(_ target: ElementRef, _ bindings: [String], anyLabel: Bool = false) -> AXElementInfo? {
        var found: AXElementInfo?
        _ = eventually { elements, frame in
            found = target.find(in: elements, frame: frame, bindings: bindings, anyLabel: anyLabel)
            return found != nil
        }
        return found
    }

    private func landed(_ text: String, in target: ElementRef, _ bindings: [String]) -> Bool {
        let wanted = text.trimmingCharacters(in: .newlines)
        return eventually { elements, frame in
            target.find(in: elements, frame: frame, bindings: bindings)?.value?.contains(wanted) ?? false
        }
    }

    private func endsAlike(_ procedure: Procedure, _ bindings: [String]) -> Bool {
        let learned = Set(procedure.endControls)
        return eventually { elements, frame in
            let now = Set(Self.controls(elements, in: frame, except: bindings))
            return Double(learned.intersection(now).count) / Double(learned.count) >= Self.endSimilarity
        }
    }
}
