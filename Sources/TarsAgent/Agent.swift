import CoreGraphics
import Foundation
import SecondScreenCore

/// What the agent sees and acts on: one app on one agent screen.
public protocol AgentScreen {
    /// The screen's current frame in global points. Frames move when
    /// screens come and go, so it is read every step.
    func frame() throws -> CGRect
    /// The whole screen as a PNG the size of `frame` in points, so the
    /// model's normalised boxes map straight onto it.
    func screenshot(size: CGSize) throws -> Data
    func perform(_ action: InputAction) throws -> ControlResponse
    /// The app window's elements; also makes their indexes current.
    func elements() throws -> [AXElementInfo]
    /// Whether the app has a popup menu open.
    func menuOpen() -> Bool
}

extension AgentScreen {
    public func menuOpen() -> Bool { false }
}

/// Runs an instruction with a UI-TARS model: screenshot, ask the model,
/// act, repeat, until it finishes, asks for help, or a guard stops it.
///
/// Each step also lists the app's controls read through accessibility, when
/// it exposes any, and the model may act on one by its number: exact where
/// the app reports its controls, and the screenshot alone for apps that draw
/// their own (WeChat 4.x), which list nothing.
public final class TarsAgent {
    public struct Options {
        public var maxSteps = 25
        /// Let the model submit: Enter, typed text ending in a newline, or a
        /// click on a Send button. Off by default.
        public var allowSubmit = false
        /// Let actions that take the real pointer run. Off by default.
        public var foreground = false
        /// Labels of controls that submit; with allowSubmit off, a click on
        /// one ends the run instead.
        public var submitLabels = try! NSRegularExpression(pattern: #"^(发送|發送|send)(\s*\(s\))?$"#,
                                                           options: .caseInsensitive)
        /// Show the model the app's controls each step. On by default.
        public var listElements = true
        /// The actions offered to the model; `TarsAgent.phoneActionSpaces`
        /// for a phone.
        public var actionSpaces = TarsAgent.actionSpaces
        /// Where to keep what a run learned, and the app it is learned for.
        /// With a store, a run that worked is kept as a procedure, and the
        /// next run of the same instruction replays it without the model.
        public var procedures: ProcedureStore?
        public var app = ""
        /// How long a replay waits for a step's control to show up.
        public var replayPatience: TimeInterval = 6
        /// Asked before each step; true ends the run, as the user asked.
        public var isCancelled: () -> Bool = { false }
        public init() {}

        /// For a phone: its action space, no Elements list, and swipes,
        /// which take nothing of the user's.
        public mutating func forPhone() {
            actionSpaces = TarsAgent.phoneActionSpaces
            listElements = false
            foreground = true
        }
    }

    public enum Event {
        case thought(String, [ParsedAction])
        case step(Step)
        case error(String)
        /// What the agent is doing about learned procedures.
        case note(String)
    }

    public struct Result {
        public var outcome: Outcome
        public var reason: String
        public var steps: Int
        /// Requests made to the model; none when a learned procedure ran through.
        public var modelCalls = 0
        /// Steps taken from a learned procedure.
        public var replayed = 0
        /// What became of the run as a procedure: "saved", or why not.
        public var learned: String?
        /// The action the run stopped before because it would submit, for
        /// a person to confirm.
        public var held: InputAction?
    }

    public static let actionSpaces = """
        click(start_box='[x1, y1, x2, y2]')
        left_double(start_box='[x1, y1, x2, y2]')
        right_single(start_box='[x1, y1, x2, y2]')
        click(element='N') #Click element N from the Elements list.
        drag(start_box='[x1, y1, x2, y2]', end_box='[x3, y3, x4, y4]')
        hotkey(key='')
        type(content='') #If you want to submit your input, use "\\n" at the end of `content`.
        type(content='', element='N') #Type into text field N from the Elements list.
        scroll(start_box='[x1, y1, x2, y2]', direction='down or up or right or left')
        wait() #Sleep for 5s and take a screenshot to check for any changes.
        finished(content='') #Use this when the task is done; put any answer in content.
        call_user() # Submit the task and call the user when the task is unsolvable, or when you need the user's help.
        """

    /// For a phone: taps and swipes, Home and Back, and no Elements list.
    public static let phoneActionSpaces = """
        click(start_box='[x1, y1, x2, y2]')
        long_press(start_box='[x1, y1, x2, y2]')
        type(content='') #Tap the text field first. If you want to submit your input, use "\\n" at the end of `content`.
        scroll(start_box='[x1, y1, x2, y2]', direction='down or up or right or left')
        drag(start_box='[x1, y1, x2, y2]', end_box='[x3, y3, x4, y4]')
        press_home()
        press_back()
        wait() #Sleep for 5s and take a screenshot to check for any changes.
        finished(content='') #Use this when the task is done; put any answer in content.
        call_user() # Submit the task and call the user when the task is unsolvable, or when you need the user's help.
        """

    /// UI-TARS's prompt (`@ui-tars/sdk`, Apache-2.0, ByteDance), with this
    /// agent's action space; the note on elements only when they are listed.
    static func prompt(_ instruction: String, actionSpaces: String = actionSpaces, elements: Bool = true) -> String {
        let elementsNote = elements ? """

            - A screenshot may come with an `## Elements` list, read from the app's accessibility tree: \
            `[N] role "label" value="…" box=[x1, y1, x2, y2]`, boxes on the screenshot's 0-1000 scale. \
            When your target is listed, act on it with element='N': it is exact. \
            Use start_box for anything not listed.
            """ : ""
        return
        """
        You are a GUI agent. You are given a task and your action history, with screenshots. \
        You need to perform the next action to complete the task.

        ## Output Format
        ```
        Thought: ...
        Action: ...
        ```

        ## Action Space
        \(actionSpaces)

        ## Note
        - Write a small plan and finally summarize your next action (with its target element) in one sentence in `Thought` part.\(elementsNote)

        ## User Instruction
        \(instruction)
        """
    }

    /// Screenshots the model sees at once; older ones leave the history.
    static let maxImages = 5
    /// Words in a reply that mean a click would send or submit.
    static let submitIntent = try! NSRegularExpression(pattern: #"发送|發送|提交|\bsend\b|\bsubmit\b"#,
                                                       options: .caseInsensitive)

    let screen: AgentScreen
    let model: VisionModel
    let options: Options
    let onEvent: (Event) -> Void
    /// Where the model last clicked, to find the field it then types into.
    private var lastClick: CGPoint?
    /// The app's elements as last read, which the engine's indexes refer
    /// to; nil once an action may have changed the window.
    var elementCache: [AXElementInfo]?
    /// The steps that ran, as a procedure would repeat them.
    var trace: [LearnedStep] = []
    /// Why this run cannot become a procedure, once something rules it out.
    var unlearnable: String?
    /// The screen's frame as last read.
    var currentFrame = CGRect.zero
    /// The text each control held when the run began, to tell an answer the
    /// run produced from text that was there all along.
    var startTexts: [String: String] = [:]
    var modelCalls = 0
    /// The answer the model finished with, as opposed to a guard's stop.
    var finishedContent: String?
    /// The action the run held back for a person, as a replay would find it.
    var heldStep: LearnedStep?

    public init(screen: AgentScreen, model: VisionModel, options: Options = Options(),
                onEvent: @escaping (Event) -> Void = { _ in }) {
        self.screen = screen
        self.model = model
        self.options = options
        self.onEvent = onEvent
    }

    public func run(_ instruction: String) -> Result {
        let instruction = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        trace = []
        unlearnable = nil
        modelCalls = 0
        finishedContent = nil
        heldStep = nil
        startTexts = [:]
        guard let store = options.procedures else { return explore(instruction, alreadyDone: nil) }

        var known = store.load(app: options.app)
        if let frame = try? screen.frame() {
            currentFrame = frame
            startTexts = Self.texts(currentElements(), in: frame)
        }
        guard let (procedure, bindings) = Procedure.best(for: instruction, in: known, allowSubmit: options.allowSubmit),
              let position = known.firstIndex(where: { $0.template == procedure.template && $0.allowSubmit == procedure.allowSubmit })
        else { return finish(explore(instruction, alreadyDone: nil), instruction, store) }

        onEvent(.note("replaying \(procedure.steps.count) learned step(s)"))
        switch replay(procedure, bindings, instruction: instruction) {
        case .finished(var result):
            known[position].successes += 1
            known[position].failures = 0
            store.save(known, app: options.app)
            result.learned = "replayed"
            return result
        case .handOver(let why, let failed):
            onEvent(.note("\(why); the model takes over"))
            let replayed = trace.count
            if failed {
                known[position].failures += 1
                // Three replays in a row that broke off: it no longer fits.
                if known[position].failures >= 3 { known.remove(at: position) }
                store.save(known, app: options.app)
            }
            var result = finish(explore(instruction, alreadyDone: (procedure, bindings, why)), instruction, store)
            result.replayed = replayed
            return result
        }
    }

    /// Run the instruction with the model, from the screen as it is.
    /// `alreadyDone` tells it what a replay did before it stopped.
    private func explore(_ instruction: String, alreadyDone: (Procedure, [String], String)?) -> Result {
        var messages: [Message] = [.user(Self.prompt(instruction, actionSpaces: options.actionSpaces,
                                                     elements: options.listElements))]
        if let (procedure, bindings, why) = alreadyDone {
            let done = trace.enumerated().map { "\($0.offset + 1). \($0.element.summary(bindings))" }.joined(separator: "\n")
            messages.append(.user("These steps of a procedure learned for this task were just performed on this screen:\n"
                + (done.isEmpty ? "(none)" : done) + "\nIt stopped there: \(why). "
                + "Look at the screenshot and carry on from where things stand; "
                + "do not repeat a step whose effect already shows."
                + (procedure.steps.count == trace.count ? " If the task is done, finish with the answer." : "")))
        }
        var failedShots = 0
        var replyWithoutAction = false
        for step in 1...max(options.maxSteps, 1) {
            if options.isCancelled() { return Result(outcome: .user, reason: "stopped", steps: step - 1) }
            let frame: CGRect
            do {
                frame = try screen.frame()
                currentFrame = frame
                messages.append(.screenshot(try screen.screenshot(size: frame.size)))
            } catch {
                onEvent(.error("screenshot: \(error.localizedDescription)"))
                failedShots += 1
                if failedShots >= 3 { return result(.user, "screenshots keep failing", step) }
                Thread.sleep(forTimeInterval: 1)
                continue
            }
            Self.trimImages(&messages)
            // The model numbers elements from this read; keep it until an action runs.
            elementCache = nil
            let listed = options.listElements ? Self.listable(currentElements(), in: frame) : []
            messages.removeAll { if case .user(let text) = $0 { text.hasPrefix(Self.elementsHeading) } else { false } }
            if !listed.isEmpty { messages.append(.user(Self.describe(listed, in: frame))) }

            let reply: String
            do {
                modelCalls += 1
                reply = try model.complete(messages)
            } catch {
                return result(.user, error.localizedDescription, step)
            }
            messages.append(.assistant(summary(of: reply)))
            let prediction = ActionParser.parse(reply)
            onEvent(.thought(prediction.thought, prediction.actions))
            if prediction.actions.isEmpty {
                onEvent(.error("no action in the reply: \(reply)"))
                // Models that consider the task done tend to answer in prose.
                // Remind once; a second answer without an action is final.
                if replyWithoutAction {
                    finishedContent = reply.trimmingCharacters(in: .whitespacesAndNewlines)
                    return result(.done, finishedContent!, step)
                }
                replyWithoutAction = true
                messages.append(.user("Answer in the format `Thought: ...` then `Action: ...`, "
                    + "using one action from the action space; use finished(content='...') when the task is done."))
                continue
            }
            replyWithoutAction = false

            var context = PlanContext(frame: frame, allowSubmit: options.allowSubmit, foreground: options.foreground)
            for var action in prediction.actions {
                context.menuOpen = screen.menuOpen()
                // An element the model named stands in for any box it gave.
                var target: AXElementInfo?
                if let raw = action.inputs["element"] {
                    guard let number = Int(raw.filter(\.isNumber)),
                          let element = listed.first(where: { $0.index == number }), let box = Self.box(element.frame, in: frame)
                    else {
                        onEvent(.error("no element \(raw) in the list"))
                        messages.append(.user("There is no element \(raw) in the Elements list; "
                            + "use one that is listed, or start_box."))
                        break
                    }
                    action.boxes["start_box"] = box
                    target = element
                }
                for name in ["start_box", "end_box"] where action.inputs[name] != nil && action.boxes[name] == nil {
                    if let box = ActionParser.recoverBox(reply, name) {
                        action.boxes[name] = box
                        onEvent(.error("read \(name) \(box) from the raw reply"))
                    }
                }
                // Models often finish with the answer in the thought only.
                if action.type == "finished", (action.inputs["content"] ?? "").isEmpty, !prediction.thought.isEmpty {
                    action.inputs["content"] = prediction.thought
                }
                for planned in Planner.plan(action, context) {
                    if let stop = execute(planned, on: target,
                                          prediction: prediction.thought.isEmpty ? reply : prediction.thought) {
                        if action.type == "finished", stop.0 == .done { finishedContent = stop.1 }
                        heldStep = stop.2.flatMap { learnedHeld($0, named: target) }
                        var ended = result(stop.0, stop.1, step)
                        ended.held = stop.2
                        return ended
                    }
                }
            }
        }
        return result(.user, "reached \(options.maxSteps) steps", options.maxSteps)
    }

    func result(_ outcome: Outcome, _ reason: String, _ steps: Int) -> Result {
        Result(outcome: outcome, reason: reason, steps: steps, modelCalls: modelCalls)
    }

    /// Run one step, on `target` if the model named an element; returns why
    /// the run ends, if it does, and the action it held back.
    private func execute(_ step: Step, on target: AXElementInfo?, prediction: String) -> (Outcome, String, InputAction?)? {
        switch step {
        case .stop(let outcome, let reason):
            onEvent(.step(step))
            return (outcome, reason, nil)
        case .hold(let action, let reason):
            onEvent(.step(step))
            return (.done, reason, action)
        case .wait(let seconds):
            onEvent(.step(step))
            Thread.sleep(forTimeInterval: seconds)
            var waited = LearnedStep(kind: "wait")
            waited.seconds = seconds
            if options.procedures != nil { trace.append(waited) }
            return nil
        case .act(var action):
            if action.kind == .click, !options.allowSubmit {
                // Apps that draw their own controls hide a Send button from
                // accessibility, so also go by what the model says this step
                // does: the thought's last sentence, which UI-TARS keeps for
                // the next action (its plan may mention sending later). A
                // click into a text field is never the send.
                if Self.matches(Self.submitIntent, Self.nextActionSentence(prediction)),
                   action.point.flatMap({ field(at: $0) }) == nil {
                    let reason = "stopped before a click the model describes as sending"
                    onEvent(.step(.hold(action, reason)))
                    return (.done, reason, action)
                }
                if let target, Self.matches(options.submitLabels, (target.label ?? "").trimmingCharacters(in: .whitespaces)) {
                    let reason = "stopped before clicking a control that submits"
                    onEvent(.step(.hold(action, reason)))
                    return (.done, reason, action)
                }
                if let point = action.point, isSubmitControl(at: point) {
                    let reason = "stopped before clicking a control that submits"
                    onEvent(.step(.hold(action, reason)))
                    return (.done, reason, action)
                }
            }
            if action.kind == .click { lastClick = action.point }
            var named: AXElementInfo?
            if let target, [.click, .type, .scroll].contains(action.kind) {
                // Indexes refer to the engine's last read, which an earlier
                // action may have replaced; find the element again there.
                named = currentElements().first { Self.same($0, target) }
                action.index = named?.index
            } else if action.kind == .type, let field = field(at: lastClick) {
                // Keystrokes miss backgrounded web views without any error;
                // typing into the field the model clicked goes through
                // accessibility instead.
                named = field
                action.index = field.index
            }
            let learned = options.procedures == nil ? nil : learnedStep(action, named: named)
            onEvent(.step(.act(action)))
            elementCache = nil
            do {
                let response = try screen.perform(action)
                if response.ok {
                    // Only what worked is worth repeating.
                    if let learned { trace.append(learned) }
                } else {
                    onEvent(.error(response.error ?? "\(action.kind) failed"))
                }
            } catch {
                // Carry on: the next screenshot shows the model nothing changed.
                onEvent(.error(error.localizedDescription))
            }
            return nil
        }
    }

    /// The app's elements, read again only after an action ran, so the
    /// indexes stay the ones the engine holds.
    func currentElements() -> [AXElementInfo] {
        if let elementCache { return elementCache }
        let elements = (try? screen.elements()) ?? []
        elementCache = elements
        return elements
    }

    /// The smallest text field containing `point`.
    private func field(at point: CGPoint?) -> AXElementInfo? {
        guard let point else { return nil }
        return currentElements()
            .filter { $0.index >= 0 && AXActions.isText($0) && Self.contains($0.frame, point) }
            .min { area($0.frame) < area($1.frame) }
    }

    /// Whether the point is on a control labelled like a Send button. Apps
    /// that do not expose their controls pass this check, so the Enter and
    /// newline rules matter as much.
    private func isSubmitControl(at point: CGPoint) -> Bool {
        currentElements().contains { element in
            Self.matches(options.submitLabels, (element.label ?? "").trimmingCharacters(in: .whitespaces))
                && Self.contains(element.frame, point)
        }
    }

    static let elementsHeading = "## Elements"
    /// Elements beyond this many are left out of the list, to keep steps small.
    static let maxListed = 120

    /// Elements worth listing: numbered, on the screen, and named, holding
    /// a value, or taking text. When there are too many, plain text goes
    /// first: in a chat app the message list alone can fill the list and
    /// push out the message box (BOSS直聘), and the screenshot shows text anyway.
    static func listable(_ elements: [AXElementInfo], in frame: CGRect) -> [AXElementInfo] {
        let candidates = elements.filter { element in
            guard element.index >= 0, let box = element.frame, box.width > 0, box.height > 0,
                  frame.contains(CGPoint(x: box.x + box.width / 2, y: box.y + box.height / 2))
            else { return false }
            return !(element.label ?? "").isEmpty || !(element.value ?? "").isEmpty || AXActions.isText(element)
        }
        guard candidates.count > maxListed else { return candidates }
        let controls = Set(candidates.filter { $0.role != "AXStaticText" }.prefix(maxListed).map(\.index))
        var room = maxListed - controls.count
        return candidates.filter { element in
            if controls.contains(element.index) { return true }
            guard element.role == "AXStaticText", room > 0 else { return false }
            room -= 1
            return true
        }
    }

    /// The list the model reads, one element a line.
    static func describe(_ elements: [AXElementInfo], in frame: CGRect) -> String {
        func quoted(_ text: String?) -> String? {
            guard var text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
            if text.count > 60 { text = String(text.prefix(60)) + "…" }
            return "\"" + text.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\"", with: "'") + "\""
        }
        let lines = elements.map { element -> String in
            var parts = ["[\(element.index)]", element.role.hasPrefix("AX") ? String(element.role.dropFirst(2)) : element.role]
            if let label = quoted(element.label) { parts.append(label) }
            if let value = quoted(element.value), element.value != element.label { parts.append("value=\(value)") }
            if let box = box(element.frame, in: frame) {
                parts.append("box=[" + box.map { String(Int(($0 * ActionParser.factor).rounded())) }
                    .joined(separator: ", ") + "]")
            }
            return parts.joined(separator: " ")
        }
        return ([elementsHeading] + lines).joined(separator: "\n")
    }

    /// An element's frame as a box normalised to the screen, as the parser
    /// stores model boxes.
    static func box(_ element: Frame?, in frame: CGRect) -> [Double]? {
        guard let element, frame.width > 0, frame.height > 0 else { return nil }
        func clamp(_ value: Double) -> Double { min(max(value, 0), 1) }
        return [clamp((element.x - frame.minX) / frame.width), clamp((element.y - frame.minY) / frame.height),
                clamp((element.x + element.width - frame.minX) / frame.width),
                clamp((element.y + element.height - frame.minY) / frame.height)]
    }

    /// Whether two reads describe the same element.
    static func same(_ a: AXElementInfo, _ b: AXElementInfo) -> Bool {
        guard a.role == b.role, a.label == b.label, let fa = a.frame, let fb = b.frame else { return false }
        return abs(fa.x - fb.x) < 2 && abs(fa.y - fb.y) < 2 && abs(fa.width - fb.width) < 2 && abs(fa.height - fb.height) < 2
    }

    /// The last sentence of a thought, where UI-TARS summarises the action
    /// it is about to take.
    static func nextActionSentence(_ thought: String) -> String {
        let sentences = thought.components(separatedBy: CharacterSet(charactersIn: "。！？.!?\n"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return sentences.last ?? thought
    }

    static func trimImages(_ messages: inout [Message]) {
        var images = messages.filter { if case .screenshot = $0 { return true } else { return false } }.count
        messages.removeAll { message in
            guard images > maxImages, case .screenshot = message else { return false }
            images -= 1
            return true
        }
    }

    static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    static func contains(_ frame: Frame?, _ point: CGPoint) -> Bool {
        guard let frame else { return false }
        return point.x >= frame.x && point.x <= frame.x + frame.width
            && point.y >= frame.y && point.y <= frame.y + frame.height
    }

    private func area(_ frame: Frame?) -> Double { frame.map { $0.width * $0.height } ?? .infinity }
}
