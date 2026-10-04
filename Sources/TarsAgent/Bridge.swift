import CoreGraphics
import Foundation
import SecondScreenCore

// The exploration bridge (docs/task-runtime-contracts.md, "Bridge JSONL
// protocol"): the task runtime hands one unit to the existing agent and
// reads back, one JSON line each, what the agent observed, every action it
// actually sent, every model call, and how the unit ended.
//
// Nothing here plans or acts on its own. The agent runs as it always does;
// the bridge only wraps its screen and model, so each event comes from an
// action that really went to the app, from the element the agent really
// resolved, and from a model request that was really made, never from what
// the model wrote it would do.

/// The one line the runtime writes to the bridge's stdin.
public struct ExplorationRequest {
    public var taskId: String
    public var unitAttemptId: String
    public var socket: String
    public var screenId: String
    public var pid: Int32
    public var windowId: UInt32
    public var unitName: String
    public var goal: String
    public var allowedEffects: [String]
    /// Kept as JSON, to hand back in a proposal unchanged.
    public var expectedPostconditions: [Any]
    public var parameters: [String: String]
    public var maxRounds: Int
    public var maxTokens: Int?
    public var timeoutMs: Int
    /// Why the runtime explores, for each model_usage event: ui and
    /// missing_procedure when the request leaves it out.
    public var purpose = "ui"
    public var reason = "missing_procedure"

    public static let version = 1
    static let purposes: Set<String> = ["ui", "repair", "analysis"]
    static let reasons: Set<String> = ["missing_procedure", "replay_failed", "postcondition_failed",
                                       "recovery_exhausted", "analysis"]
    static let effects: Set<String> = ["read", "navigation", "artifact", "external-submit"]
    static let slot = try! NSRegularExpression(pattern: #"\{\{([a-zA-Z][a-zA-Z0-9_.]*)\}\}"#)

    /// The request in a line, or every problem with it. Whatever ids the line
    /// had come back either way, so a refusal can still name its attempt.
    public static func parse(_ line: String) -> (request: ExplorationRequest?, errors: [String], ids: (String, String)) {
        guard let data = line.data(using: .utf8),
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return (nil, ["the request is not a JSON object"], ("", "")) }
        let ids = (raw["taskId"] as? String ?? "", raw["unitAttemptId"] as? String ?? "")
        var errors: [String] = []
        func int(_ value: Any?, min: Int) -> Int? {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue == number.doubleValue.rounded(), number.intValue >= min else { return nil }
            return number.intValue
        }
        func text(_ value: Any?) -> String? {
            (value as? String).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        }
        if int(raw["v"], min: 0) != version { errors.append("v must be \(version)") }
        if ids.0.isEmpty { errors.append("taskId is required") }
        if ids.1.isEmpty { errors.append("unitAttemptId is required") }
        let session = raw["session"] as? [String: Any] ?? [:]
        let socket = text(session["socket"]), screenId = text(session["screenId"])
        let pid = int(session["pid"], min: 1), windowId = int(session["windowId"], min: 1)
        if socket == nil || screenId == nil || pid == nil || windowId == nil {
            errors.append("session needs socket, screenId, pid and windowId")
        }
        let unit = raw["unit"] as? [String: Any] ?? [:]
        let name = text(unit["name"]), goal = text(unit["goal"])
        if name == nil || goal == nil { errors.append("unit needs name and goal") }
        let effects = unit["allowedEffects"] as? [Any] ?? [1]
        let effectNames = effects.compactMap { $0 as? String }
        if effectNames.count != effects.count || !effectNames.allSatisfy(Self.effects.contains) {
            errors.append("unit.allowedEffects must be effect classes")
        } else if effectNames.contains("external-submit") {
            errors.append("unit.allowedEffects must not include external-submit")
        }
        let postconditions = unit["expectedPostconditions"] as? [Any]
        if postconditions == nil || !(postconditions ?? []).allSatisfy({ ($0 as? [String: Any])?["kind"] is String }) {
            errors.append("unit.expectedPostconditions must be an array of conditions")
        }
        let rawParameters = raw["parameters"] as? [String: Any]
        let parameters = rawParameters?.compactMapValues { $0 as? String }
        if parameters == nil || parameters?.count != rawParameters?.count {
            errors.append("parameters must map names to strings")
        }
        let budget = raw["budget"] as? [String: Any] ?? [:]
        let maxRounds = int(budget["maxRounds"], min: 1), timeoutMs = int(budget["timeoutMs"], min: 1)
        let maxTokens = budget["maxTokens"].map { int($0, min: 1) }
        if maxRounds == nil || timeoutMs == nil || maxTokens == .some(nil) {
            errors.append("budget needs maxRounds and timeoutMs >= 1")
        }
        if (raw["submitAllowed"] as? NSNumber).map({ CFGetTypeID($0) == CFBooleanGetTypeID() && !$0.boolValue }) != true {
            errors.append("submitAllowed must be false")
        }
        let context = raw["usageContext"].map { $0 as? [String: Any] ?? [:] }
        if let context, !purposes.contains(context["purpose"] as? String ?? "")
            || !reasons.contains(context["reason"] as? String ?? "") {
            errors.append("usageContext needs a model purpose and call reason")
        }
        if let goal, let parameters {
            for name in slots(in: goal) where parameters[name] == nil {
                errors.append("unit.goal uses {{\(name)}}, which is not a parameter")
            }
        }
        guard errors.isEmpty, let socket, let screenId, let pid, let windowId, let name, let goal,
              let parameters, let maxRounds, let timeoutMs, let postconditions
        else { return (nil, errors, ids) }
        var request = ExplorationRequest(taskId: ids.0, unitAttemptId: ids.1, socket: socket, screenId: screenId,
                                   pid: Int32(pid), windowId: UInt32(windowId), unitName: name, goal: goal,
                                   allowedEffects: effectNames, expectedPostconditions: postconditions,
                                   parameters: parameters, maxRounds: maxRounds, maxTokens: maxTokens ?? nil,
                                   timeoutMs: timeoutMs)
        if let context, let purpose = context["purpose"] as? String, let reason = context["reason"] as? String {
            request.purpose = purpose
            request.reason = reason
        }
        return (request, [], ids)
    }

    static func slots(in text: String) -> [String] {
        slot.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
            Range($0.range(at: 1), in: text).map { String(text[$0]) }
        }
    }

    /// The goal with its slots filled, as the agent's instruction.
    public var instruction: String {
        var text = goal
        for name in Set(Self.slots(in: goal)) {
            text = text.replacingOccurrences(of: "{{\(name)}}", with: parameters[name] ?? "")
        }
        return text
    }
}

/// A model that reports what each request used. `ChatCompletionsModel`
/// does not, so its calls are counted with tokens "unknown".
public protocol TokenReportingModel: VisionModel {
    func completeReportingUsage(_ messages: [Message]) throws -> (reply: String, inputTokens: Int?, outputTokens: Int?)
}

/// The bound app window as the bridge reads it, for `observed` events and to
/// express clicks as fractions of the window.
public struct BridgeWindow {
    public var pid: Int32
    public var windowId: UInt32
    public var bundleId: String
    public var title: String
    public var frame: CGRect
    public var scale: Double
    public var displayId: UInt32

    public init(pid: Int32, windowId: UInt32, bundleId: String, title: String, frame: CGRect,
                scale: Double, displayId: UInt32) {
        self.pid = pid
        self.windowId = windowId
        self.bundleId = bundleId
        self.title = title
        self.frame = frame
        self.scale = scale
        self.displayId = displayId
    }
}

/// Runs one unit through `TarsAgent` and writes the bridge's events.
public final class ExplorationBridge {
    public enum Failure: String {
        case budgetExhausted = "budget_exhausted"
        case modelUnavailable = "model_unavailable"
        case cancelled
        case timeout
        case forbiddenEffect = "forbidden_effect"
        case error
    }

    public let request: ExplorationRequest
    let screen: AgentScreen
    let model: VisionModel?
    let window: () -> BridgeWindow?
    let now: () -> Date
    let write: (String) -> Void
    let log: (String) -> Void

    private let lock = NSLock()
    private let writing = NSLock()
    /// Whether a model request is out, to count it if a cancel ends the run first.
    private var callUnderWay = false
    /// Why the run must stop, once something decided it; the first reason stays.
    private var stop: (Failure, String)?
    /// Whether an action is on its way to the app: a cancel then waits for it.
    private var acting = false
    /// Whether the last line, unit_finished or unit_failed, went out.
    private var ended = false
    private var deadline = Date.distantFuture

    private var snapshots = 0
    private var lastSnapshot: String?
    private var stepCount = 0
    private var modelCalls = 0
    /// The last error reading the screen, to explain rounds that came to nothing.
    private var lastScreenError: String?
    private var inputTokens: Int? = 0
    private var outputTokens: Int? = 0
    /// Every action that reached the app, in order, as the events told it.
    private(set) var executed: [[String: Any]] = []
    /// What the agent last read of the window's elements; indexes refer to it.
    private var elements: [AXElementInfo] = []

    /// - Parameters:
    ///   - model: nil when no model is configured; the run then ends at once
    ///     with `model_unavailable`.
    ///   - window: reads the bound window afresh; nil when it is gone.
    ///   - write: takes each event as one line, newline included.
    public init(request: ExplorationRequest, screen: AgentScreen, model: VisionModel?,
                window: @escaping () -> BridgeWindow?, now: @escaping () -> Date = Date.init,
                write: @escaping (String) -> Void, log: @escaping (String) -> Void = { _ in }) {
        self.request = request
        self.screen = screen
        self.model = model
        self.window = window
        self.now = now
        self.write = write
        self.log = log
    }

    /// The one line for a request that could not be taken (exit code 2),
    /// under whatever ids it had.
    public static func refusal(_ errors: [String], ids: (String, String), at date: Date = Date()) -> String {
        let event: [String: Any] = ["v": ExplorationRequest.version, "taskId": ids.0, "unitAttemptId": ids.1,
                                    "at": timeFormat.string(from: date), "type": "unit_failed", "reason": "error",
                                    "message": "invalid request: " + errors.joined(separator: "; ")]
        let data = try! JSONSerialization.data(withJSONObject: event, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(data: data, encoding: .utf8)! + "\n"
    }

    /// Run the unit; returns the exit code: 0 finished, 1 failed.
    public func run() -> Int32 {
        deadline = now().addingTimeInterval(Double(request.timeoutMs) / 1000)
        guard let model else {
            return end(.modelUnavailable, "no model is configured")
        }
        var options = TarsAgent.Options()
        options.maxSteps = request.maxRounds
        options.allowSubmit = false
        options.foreground = false
        // Procedures belong to the runtime; the bridge only proposes one.
        options.procedures = nil
        // The agent's own guard holds clicks on these too, before the bridge's.
        options.submitLabels = Self.submitControls
        options.isCancelled = { [unowned self] in self.shouldStop() }
        let agent = TarsAgent(screen: RecordingScreen(self, screen), model: BudgetedModel(self, model),
                              options: options) { [unowned self] event in
            if case .thought(let thought, _) = event { self.lastThought = thought }
            self.log(TarsAgent.describe(event))
        }
        let result = agent.run(request.instruction)

        // A finish that comes after the deadline is a timeout, not a success.
        _ = shouldStop()
        if let (failure, message) = locked({ stop }) { return end(failure, message) }
        if let held = result.held {
            return end(.forbiddenEffect, "stopped before \(TarsAgent.describe(held)): \(result.reason)")
        }
        switch result.outcome {
        case .done:
            return finish()
        case .user where result.reason == "reached \(options.maxSteps) steps":
            // Rounds also pass when the screen cannot be read; only rounds
            // spent on the model use up the budget.
            let (calls, screenError) = locked { (modelCalls, lastScreenError) }
            if calls < request.maxRounds {
                return end(.error, "\(request.maxRounds) rounds passed with \(calls) model call(s)"
                           + (screenError.map { "; the screen: \($0)" } ?? ""))
            }
            return end(.budgetExhausted, "used all \(request.maxRounds) rounds")
        case .user:
            return end(.error, result.reason)
        }
    }

    /// Stop as asked (SIGTERM). Returns true when the last event went out now,
    /// with no action under way, so the process may exit at once; otherwise
    /// the run stops after the current action and reports then.
    @discardableResult
    public func cancel(_ failure: Failure = .cancelled, _ message: String = "cancelled by the runtime") -> Bool {
        lock.lock()
        if stop == nil { stop = (failure, message) }
        let (reason, text) = stop!
        let idle = !acting
        let inCall = callUnderWay
        lock.unlock()
        guard idle else { return false }
        // The process exits before an outstanding model reply arrives; the
        // request was still made, so it is counted, with tokens unknown.
        if inCall { usage(nil, nil) }
        return emit(["type": "unit_failed", "reason": reason.rawValue, "message": text], last: true)
    }

    // MARK: Events

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    static let timeFormat: ISO8601DateFormatter = {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format
    }()

    func time(_ date: Date) -> String { Self.timeFormat.string(from: date) }

    /// Write one event; nothing goes out after the last one. Returns whether
    /// the event was written.
    @discardableResult
    private func emit(_ fields: [String: Any], last: Bool = false) -> Bool {
        var event = fields
        event["v"] = ExplorationRequest.version
        event["taskId"] = request.taskId
        event["unitAttemptId"] = request.unitAttemptId
        if event["at"] == nil { event["at"] = time(now()) }
        guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys, .withoutEscapingSlashes]),
              let line = String(data: data, encoding: .utf8)
        else {
            log("could not encode a \(fields["type"] ?? "") event")
            return false
        }
        // Held while writing, so lines never interleave and none follows the last.
        writing.lock()
        defer { writing.unlock() }
        guard locked({ () -> Bool in
            if ended { return false }
            if last { ended = true }
            return true
        }) else { return false }
        write(line + "\n")
        return true
    }

    private func end(_ failure: Failure, _ message: String) -> Int32 {
        emit(["type": "unit_failed", "reason": failure.rawValue, "message": message], last: true)
        return 1
    }

    private func finish() -> Int32 {
        var event: [String: Any] = ["type": "unit_finished", "steps": locked { stepCount }]
        if let proposal = proposal() { event["proposal"] = proposal }
        return emit(event, last: true) ? 0 : 1
    }

    /// Whether the agent should stop before its next step or model call.
    func shouldStop() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stoppingLocked()
    }

    /// `shouldStop` for a caller holding the lock.
    private func stoppingLocked() -> Bool {
        if stop == nil, now() >= deadline {
            stop = (.timeout, "the unit ran past its \(request.timeoutMs) ms")
        }
        return stop != nil
    }

    private func halt(_ failure: Failure, _ message: String) {
        lock.lock()
        if stop == nil { stop = (failure, message) }
        lock.unlock()
    }

    // MARK: Observations

    func observed() {
        guard let window = window() else { return log("the bound window is gone; no observation") }
        snapshots += 1
        let id = "\(request.unitAttemptId)-s\(snapshots)"
        lastSnapshot = id
        emit(["type": "observed", "snapshotId": id, "window": Self.geometry(window)])
    }

    static func geometry(_ window: BridgeWindow) -> [String: Any] {
        let frame = rect(window.frame)
        // As the session adapter reads it: the content area is the window.
        return ["pid": Int(window.pid), "windowId": Int(window.windowId), "bundleId": window.bundleId,
                "title": window.title, "frame": frame, "contentFrame": frame, "scale": window.scale,
                "displayId": Int(window.displayId)]
    }

    static func rect(_ rect: CGRect) -> [String: Any] {
        ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
    }

    func remember(_ elements: [AXElementInfo]) { self.elements = elements }

    func screenFailed(_ error: Error) {
        lock.lock()
        lastScreenError = error.localizedDescription
        lock.unlock()
    }

    // MARK: Actions

    /// What an input action does, by the contract's effect classes. Enter and
    /// typed newlines submit; scrolling only reads; anything else moves around
    /// the app. A drag has no contract form and needs the real pointer.
    static func effect(of action: InputAction) -> String? {
        switch action.kind {
        case .scroll: return "read"
        case .click: return "navigation"
        case .type: return (action.value ?? "").contains("\n") || (action.value ?? "").contains("\r") ? "external-submit" : "navigation"
        case .key: return ["return", "enter", "kpenter"].contains((action.key ?? "").lowercased()) ? "external-submit" : "navigation"
        case .drag: return nil
        }
    }

    /// Labels of controls that send something to the other side on BOSS直聘
    /// and chat apps: a greeting, a resume request, an exchange, or the
    /// confirmation of one. Matched anywhere in a label, so it errs on refusing.
    static let submitControls = try! NSRegularExpression(
        pattern: #"发送|發送|打招呼|索取|请求简历|求简历|交换|立即沟通|继续沟通|提交|确认|确定|同意|\bsend\b|\bsubmit\b|\bconfirm\b"#,
        options: .caseInsensitive)
    /// What the model's next-action sentence says when a click would send.
    static let submitIntent = try! NSRegularExpression(
        pattern: #"发送|發送|打招呼|索取|请求简历|求简历|交换|立即沟通|提交|\bsend\b|\bsubmit\b"#,
        options: .caseInsensitive)
    /// Text that marks a dialog about sending a request, where any yes sends it.
    static let requestDialog = try! NSRegularExpression(
        pattern: #"索取|请求简历|求简历|交换(微信|电话|简历)|打招呼"#, options: .caseInsensitive)
    static let yes = try! NSRegularExpression(pattern: #"^\s*(确认|确定|同意|是|好的?|ok|yes)\s*$"#,
                                              options: .caseInsensitive)

    /// The model's last thought, whose closing sentence names the action it takes.
    private var lastThought = ""

    /// Why a click would send something, judged from the app's elements as
    /// the agent last read them and from what the model said it is doing;
    /// nil when nothing suggests it.
    func submitReason(_ click: InputAction, element: AXElementInfo?) -> String? {
        func text(_ element: AXElementInfo) -> [String] {
            [element.label, element.value].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        }
        func isField(_ element: AXElementInfo) -> Bool { AXActions.isText(element) }
        let point = click.point ?? element?.center
        // The element named, and every element under the point: a button's
        // label may sit on its group or its text rather than on itself.
        var hit = element.map { [$0] } ?? []
        if let point {
            hit += elements.filter { TarsAgent.contains($0.frame, point) && !isField($0) }
        }
        if let control = hit.first(where: { text($0).contains { TarsAgent.matches(Self.submitControls, $0) } }) {
            return "a click on \"\(text(control).first ?? control.role)\", which sends or confirms"
        }
        if hit.contains(where: { text($0).contains { TarsAgent.matches(Self.yes, $0) } }),
           elements.contains(where: { text($0).contains { TarsAgent.matches(Self.requestDialog, $0) } }) {
            return "a yes in a dialog about sending a request"
        }
        let intoField = element.map(isField) ?? false
            || (point.map { p in elements.contains { isField($0) && TarsAgent.contains($0.frame, p) } } ?? false)
        if !intoField, TarsAgent.matches(Self.submitIntent, TarsAgent.nextActionSentence(lastThought)) {
            return "a click the model describes as sending"
        }
        return nil
    }

    /// Send one action, once, and record it. Refused actions never reach the app.
    func perform(_ action: InputAction, on inner: AgentScreen) throws -> ControlResponse {
        guard let effect = Self.effect(of: action), effect != "external-submit" else {
            let what = TarsAgent.describe(action)
            halt(.forbiddenEffect, "the agent tried \(what), which would submit or needs the real pointer")
            return .failure("refused: \(what)")
        }
        let element = action.index.flatMap { index in elements.first { $0.index == index } }
        if action.kind == .click, let why = submitReason(action, element: element) {
            halt(.forbiddenEffect, "refused \(why)")
            return .failure("refused: \(why)")
        }
        guard request.allowedEffects.contains(effect) else {
            halt(.forbiddenEffect, "\(TarsAgent.describe(action)) is a \(effect) action; unit \(request.unitName) allows \(request.allowedEffects.joined(separator: ", "))")
            return .failure("refused: \(effect) is not allowed")
        }
        guard let window = window() else {
            halt(.error, "the bound window is gone")
            return .failure("the bound window is gone")
        }
        guard let shape = Self.shape(action, effect: effect, element: element, in: window.frame) else {
            // A point off the bound window would land on something else.
            log("refused \(TarsAgent.describe(action)): outside window \(window.windowId)")
            return .failure("refused: the point is outside the app's window")
        }

        lock.lock()
        // Checked last, with the deadline, so no input goes out after either.
        if stoppingLocked() {
            lock.unlock()
            return .failure("refused: the run is stopping")
        }
        acting = true
        stepCount += 1
        let stepId = "st\(stepCount)"
        lock.unlock()

        let started = now()
        emit(["type": "action_started", "stepId": stepId, "action": shape.action, "at": time(started)])
        var status = "ok"
        var error: String?
        defer {
            var result: [String: Any] = ["actionId": stepId, "status": status, "route": shape.route,
                                         "startedAt": time(started), "finishedAt": time(now())]
            if let point = shape.point { result["point"] = ["x": Double(point.x), "y": Double(point.y)] }
            if let lastSnapshot { result["beforeSnapshotId"] = lastSnapshot }
            if let error { result["error"] = ["code": "io", "message": error] }
            var event: [String: Any] = ["type": "action_finished", "stepId": stepId, "action": shape.action,
                                        "result": result]
            if let element { event["resolvedElement"] = Self.resolved(element) }
            emit(event)
            executed.append(["stepId": stepId, "action": shape.action, "status": status])
            lock.lock()
            acting = false
            let stopping = stop != nil
            lock.unlock()
            if stopping { log("stopping after \(stepId)") }
        }
        do {
            let response = try inner.perform(action)
            if !response.ok {
                status = "failed"
                error = response.error ?? "\(action.kind) failed"
            }
            return response
        } catch let thrown {
            // The request may or may not have reached the app before it broke.
            status = "unknown"
            error = thrown.localizedDescription
            throw thrown
        }
    }

    struct Shape {
        var action: [String: Any]
        var route: String
        var point: CGPoint?
    }

    /// The contract's form of an input action: the element it resolved to by
    /// role and label when the app named it, else its point as fractions of
    /// the window. Nil when a point falls outside the window.
    static func shape(_ input: InputAction, effect: String, element: AXElementInfo?, in window: CGRect) -> Shape? {
        var locator: [String: Any]?
        var route = "keyboard"
        var point: CGPoint?
        let label = element?.label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let element, !label.isEmpty {
            locator = ["kind": "element", "role": element.role, "label": label]
            route = "element"
        } else if let at = input.point ?? element?.center {
            guard window.width > 0, window.height > 0, window.contains(at) || at.x == window.maxX || at.y == window.maxY
            else { return nil }
            let fraction = ["x": min(max(Double((at.x - window.minX) / window.width), 0), 1),
                            "y": min(max(Double((at.y - window.minY) / window.height), 0), 1)]
            locator = ["kind": "relative", "point": fraction]
            route = element == nil ? "coordinate" : "element"
            point = at
        }
        var action: [String: Any] = ["effect": effect]
        switch input.kind {
        case .click:
            guard let locator else { return nil }
            action["kind"] = "click"
            action["target"] = locator
            if input.button == "right" { action["button"] = "right" }
            if input.count == 2 { action["count"] = 2 }
        case .type:
            action["kind"] = "type"
            action["value"] = input.value ?? ""
            if let locator { action["target"] = locator }
            if input.replace == true, locator != nil { action["replace"] = true }
        case .key:
            action["kind"] = "key"
            action["key"] = input.key ?? ""
            let modifiers = (input.modifiers ?? []).filter { ["cmd", "shift", "option", "ctrl"].contains($0) }
            if !modifiers.isEmpty { action["modifiers"] = modifiers }
            route = "keyboard"
            point = nil
        case .scroll:
            action["kind"] = "scroll"
            action["direction"] = input.direction ?? "down"
            if let amount = input.amount { action["amount"] = min(max(amount, 1), 50) }
            if let by = input.by, ["line", "page"].contains(by) { action["by"] = by }
            if let locator { action["target"] = locator }
        case .drag:
            return nil
        }
        return Shape(action: action, route: route, point: point)
    }

    static func resolved(_ element: AXElementInfo) -> [String: Any] {
        var fields: [String: Any] = ["role": element.role]
        if let label = element.label, !label.isEmpty { fields["label"] = label }
        if let frame = element.frame {
            fields["frame"] = ["x": frame.x, "y": frame.y, "width": frame.width, "height": frame.height]
        }
        return fields
    }

    // MARK: Proposal

    /// The executed steps as a procedure to try: only when every one of them
    /// worked, with typed values and labels that equal a parameter turned
    /// back into its slot. The runtime still verifies and decides.
    func proposal() -> [String: Any]? {
        guard !executed.isEmpty, executed.allSatisfy({ $0["status"] as? String == "ok" }) else { return nil }
        // Longer values first, so a value inside another is not split.
        let bound = request.parameters.filter { !$0.value.isEmpty }.sorted { $0.value.count > $1.value.count }
        var used = Set<String>()
        func slotted(_ text: String) -> String {
            guard let (name, _) = bound.first(where: { $0.value == text }) else { return text }
            used.insert(name)
            return "{{\(name)}}"
        }
        let steps = executed.map { step -> [String: Any] in
            var action = step["action"] as? [String: Any] ?? [:]
            if let value = action["value"] as? String { action["value"] = slotted(value) }
            if var target = action["target"] as? [String: Any], let label = target["label"] as? String {
                target["label"] = slotted(label)
                action["target"] = target
            }
            return ["id": step["stepId"] as? String ?? "", "action": action]
        }
        return ["parameters": used.sorted(), "steps": steps, "preconditions": [Any](),
                "postconditions": request.expectedPostconditions]
    }

    // MARK: Model calls

    /// Make one model request within the budget, and report it.
    func complete(_ messages: [Message], with model: VisionModel) throws -> String {
        lock.lock()
        let calls = modelCalls
        let tokensKnown = inputTokens != nil && outputTokens != nil
        let spent = (inputTokens ?? 0) + (outputTokens ?? 0)
        lock.unlock()
        if shouldStop() { throw AgentError("stopping") }
        if calls >= request.maxRounds {
            halt(.budgetExhausted, "used all \(request.maxRounds) model rounds")
            throw AgentError("the model budget is spent")
        }
        if let limit = request.maxTokens, !tokensKnown || spent >= limit {
            // As checkBudget: with a token limit, unknown counts cannot be shown to fit.
            halt(.budgetExhausted, tokensKnown ? "used \(spent) of \(limit) tokens"
                 : "token use is unknown, so the \(limit)-token limit cannot be kept")
            throw AgentError("the token budget is spent")
        }
        lock.lock()
        modelCalls += 1
        callUnderWay = true
        lock.unlock()
        var input: Int?, output: Int?
        defer { usage(input, output) }
        if let model = model as? TokenReportingModel {
            let reply = try model.completeReportingUsage(messages)
            input = reply.inputTokens
            output = reply.outputTokens
            return reply.reply
        }
        return try model.complete(messages)
    }

    /// Count one model request and report it; nil tokens are unknown.
    private func usage(_ input: Int?, _ output: Int?) {
        lock.lock()
        let first = callUnderWay
        callUnderWay = false
        if first {
            inputTokens = inputTokens.flatMap { total in input.map { total + $0 } }
            outputTokens = outputTokens.flatMap { total in output.map { total + $0 } }
        }
        lock.unlock()
        guard first else { return }
        emit(["type": "model_usage", "purpose": request.purpose, "reason": request.reason,
              "inputTokens": input.map { $0 as Any } ?? "unknown",
              "outputTokens": output.map { $0 as Any } ?? "unknown"])
    }

    // MARK: Wrappers

    /// The agent's screen, with every action and screenshot reported.
    final class RecordingScreen: AgentScreen {
        unowned let bridge: ExplorationBridge
        let inner: AgentScreen

        init(_ bridge: ExplorationBridge, _ inner: AgentScreen) {
            self.bridge = bridge
            self.inner = inner
        }

        func frame() throws -> CGRect {
            do {
                return try inner.frame()
            } catch {
                bridge.screenFailed(error)
                throw error
            }
        }

        func screenshot(size: CGSize) throws -> Data {
            let png: Data
            do {
                png = try inner.screenshot(size: size)
            } catch {
                bridge.screenFailed(error)
                throw error
            }
            bridge.observed()
            return png
        }

        func perform(_ action: InputAction) throws -> ControlResponse {
            try bridge.perform(action, on: inner)
        }

        func elements() throws -> [AXElementInfo] {
            let elements = try inner.elements()
            bridge.remember(elements)
            return elements
        }

        func menuOpen() -> Bool { inner.menuOpen() }
    }

    final class BudgetedModel: VisionModel {
        unowned let bridge: ExplorationBridge
        let inner: VisionModel

        init(_ bridge: ExplorationBridge, _ inner: VisionModel) {
            self.bridge = bridge
            self.inner = inner
        }

        func complete(_ messages: [Message]) throws -> String {
            try bridge.complete(messages, with: inner)
        }
    }
}
