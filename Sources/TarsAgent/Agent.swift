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
        public init() {}
    }

    public enum Event {
        case thought(String, [ParsedAction])
        case step(Step)
        case error(String)
    }

    public struct Result {
        public var outcome: Outcome
        public var reason: String
        public var steps: Int
    }

    static let actionSpaces = """
        click(start_box='[x1, y1, x2, y2]')
        left_double(start_box='[x1, y1, x2, y2]')
        right_single(start_box='[x1, y1, x2, y2]')
        drag(start_box='[x1, y1, x2, y2]', end_box='[x3, y3, x4, y4]')
        hotkey(key='')
        type(content='') #If you want to submit your input, use "\\n" at the end of `content`.
        scroll(start_box='[x1, y1, x2, y2]', direction='down or up or right or left')
        wait() #Sleep for 5s and take a screenshot to check for any changes.
        finished(content='') #Use this when the task is done; put any answer in content.
        call_user() # Submit the task and call the user when the task is unsolvable, or when you need the user's help.
        """

    /// UI-TARS's prompt (`@ui-tars/sdk`, Apache-2.0, ByteDance), with this
    /// agent's action space.
    static func prompt(_ instruction: String) -> String {
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
        - Write a small plan and finally summarize your next action (with its target element) in one sentence in `Thought` part.

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

    public init(screen: AgentScreen, model: VisionModel, options: Options = Options(),
                onEvent: @escaping (Event) -> Void = { _ in }) {
        self.screen = screen
        self.model = model
        self.options = options
        self.onEvent = onEvent
    }

    public func run(_ instruction: String) -> Result {
        var messages: [Message] = [.user(Self.prompt(instruction))]
        var failedShots = 0
        for step in 1...max(options.maxSteps, 1) {
            let frame: CGRect
            do {
                frame = try screen.frame()
                messages.append(.screenshot(try screen.screenshot(size: frame.size)))
            } catch {
                onEvent(.error("screenshot: \(error.localizedDescription)"))
                failedShots += 1
                if failedShots >= 3 { return Result(outcome: .user, reason: "screenshots keep failing", steps: step) }
                Thread.sleep(forTimeInterval: 1)
                continue
            }
            Self.trimImages(&messages)

            let reply: String
            do {
                reply = try model.complete(messages)
            } catch {
                return Result(outcome: .user, reason: error.localizedDescription, steps: step)
            }
            messages.append(.assistant(summary(of: reply)))
            let prediction = ActionParser.parse(reply)
            onEvent(.thought(prediction.thought, prediction.actions))
            if prediction.actions.isEmpty {
                onEvent(.error("no action in the reply: \(reply)"))
                continue
            }

            var context = PlanContext(frame: frame, allowSubmit: options.allowSubmit, foreground: options.foreground)
            for var action in prediction.actions {
                context.menuOpen = screen.menuOpen()
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
                    if let stop = execute(planned, prediction: reply) {
                        return Result(outcome: stop.0, reason: stop.1, steps: step)
                    }
                }
            }
        }
        return Result(outcome: .user, reason: "reached \(options.maxSteps) steps", steps: options.maxSteps)
    }

    /// Run one step; returns why the run ends, if it does.
    private func execute(_ step: Step, prediction: String) -> (Outcome, String)? {
        switch step {
        case .stop(let outcome, let reason):
            onEvent(.step(step))
            return (outcome, reason)
        case .wait(let seconds):
            onEvent(.step(step))
            Thread.sleep(forTimeInterval: seconds)
            return nil
        case .act(var action):
            if action.kind == .click, !options.allowSubmit {
                // Apps that draw their own controls hide a Send button from
                // accessibility, so also go by what the model says it does.
                if Self.matches(Self.submitIntent, prediction) {
                    let reason = "stopped before a click the model describes as sending"
                    onEvent(.step(.stop(.done, reason)))
                    return (.done, reason)
                }
                if let point = action.point, isSubmitControl(at: point) {
                    let reason = "stopped before clicking a control that submits"
                    onEvent(.step(.stop(.done, reason)))
                    return (.done, reason)
                }
            }
            if action.kind == .click { lastClick = action.point }
            // Keystrokes miss backgrounded web views without any error;
            // typing into the field the model clicked goes through
            // accessibility instead.
            if action.kind == .type, let field = field(at: lastClick) { action.index = field.index }
            onEvent(.step(.act(action)))
            do {
                let response = try screen.perform(action)
                if !response.ok { onEvent(.error(response.error ?? "\(action.kind) failed")) }
            } catch {
                // Carry on: the next screenshot shows the model nothing changed.
                onEvent(.error(error.localizedDescription))
            }
            return nil
        }
    }

    /// The smallest text field containing `point`.
    private func field(at point: CGPoint?) -> AXElementInfo? {
        guard let point else { return nil }
        return ((try? screen.elements()) ?? [])
            .filter { $0.index >= 0 && AXActions.isText($0) && Self.contains($0.frame, point) }
            .min { area($0.frame) < area($1.frame) }
    }

    /// Whether the point is on a control labelled like a Send button. Apps
    /// that do not expose their controls pass this check, so the Enter and
    /// newline rules matter as much.
    private func isSubmitControl(at point: CGPoint) -> Bool {
        ((try? screen.elements()) ?? []).contains { element in
            Self.matches(options.submitLabels, (element.label ?? "").trimmingCharacters(in: .whitespaces))
                && Self.contains(element.frame, point)
        }
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
