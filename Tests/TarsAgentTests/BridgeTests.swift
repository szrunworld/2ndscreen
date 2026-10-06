import CoreGraphics
import Foundation
import SecondScreenCore
import Testing
@testable import TarsAgent

// The exploration bridge on a synthetic screen and a scripted model: no app,
// no socket, no model service.

private let bridgeFrame = CGRect(x: 3000, y: 25, width: 1360, height: 848)

private final class BridgeScreen: AgentScreen {
    var performed: [InputAction] = []
    var elementList: [AXElementInfo] = []
    /// Runs inside each action, as the app takes it.
    var during: ((InputAction) throws -> ControlResponse)?
    var frameError: Error?

    func frame() throws -> CGRect {
        if let frameError { throw frameError }
        return bridgeFrame
    }
    func screenshot(size: CGSize) throws -> Data { Data([0x89, 0x50, 0x4E, 0x47]) }
    func perform(_ action: InputAction) throws -> ControlResponse {
        performed.append(action)
        return try during?(action) ?? ControlResponse()
    }
    func elements() throws -> [AXElementInfo] { elementList }
}

private final class Script: VisionModel {
    var replies: [String]
    var calls = 0
    var before: (() throws -> Void)?
    init(_ replies: [String]) { self.replies = replies }
    func complete(_ messages: [Message]) throws -> String {
        calls += 1
        try before?()
        return replies.isEmpty ? "Thought: 继续\nAction: click(start_box='[500, 500, 500, 500]')" : replies.removeFirst()
    }
}

private final class Counted: TokenReportingModel {
    var replies: [String]
    init(_ replies: [String]) { self.replies = replies }
    func complete(_ messages: [Message]) throws -> String { fatalError("the bridge asks for usage") }
    func completeReportingUsage(_ messages: [Message]) throws -> (reply: String, inputTokens: Int?, outputTokens: Int?) {
        (replies.removeFirst(), 1000, 20)
    }
}

private func requestLine(_ overrides: [String: Any] = [:], unit: [String: Any] = [:], budget: [String: Any] = [:]) -> String {
    var unitFields: [String: Any] = ["name": "open_resume", "goal": "打开 {{candidate.name}} 的在线简历",
                                     "allowedEffects": ["read", "navigation"],
                                     "expectedPostconditions": [["kind": "page", "pageClass": "online_resume"]]]
    unitFields.merge(unit) { $1 }
    var budgetFields: [String: Any] = ["maxRounds": 6, "timeoutMs": 120_000]
    budgetFields.merge(budget) { $1 }
    var fields: [String: Any] = ["v": 1, "taskId": "t1", "unitAttemptId": "u1",
                                 "session": ["socket": "/tmp/x.sock", "screenId": "boss", "pid": 4242, "windowId": 77],
                                 "unit": unitFields, "parameters": ["candidate.name": "张三"],
                                 "budget": budgetFields, "submitAllowed": false]
    fields.merge(overrides) { $1 }
    return String(data: try! JSONSerialization.data(withJSONObject: fields), encoding: .utf8)!
}

private func request(_ overrides: [String: Any] = [:], unit: [String: Any] = [:], budget: [String: Any] = [:]) -> ExplorationRequest {
    let parsed = ExplorationRequest.parse(requestLine(overrides, unit: unit, budget: budget))
    #expect(parsed.errors.isEmpty, "\(parsed.errors)")
    return parsed.request!
}

/// A bridge whose events land in `lines`; `clock` moves only when told.
private final class Harness {
    var lines: [String] = []
    var clock = Date(timeIntervalSince1970: 1_790_000_000)
    let screen = BridgeScreen()
    var bridge: ExplorationBridge!

    init(_ request: ExplorationRequest, model: VisionModel?) {
        bridge = ExplorationBridge(request: request, screen: screen, model: model,
                                   window: { BridgeWindow(pid: 4242, windowId: 77, bundleId: "com.example.synthetic",
                                                          title: "Synthetic", frame: bridgeFrame, scale: 2, displayId: 7) },
                                   now: { [unowned self] in self.clock }, write: { [unowned self] in self.lines.append($0) })
    }

    /// With BRIDGE_EVENTS_DUMP set, every line goes to that file too, so the
    /// runtime's own parser can check what Swift writes.
    deinit {
        guard let path = ProcessInfo.processInfo.environment["BRIDGE_EVENTS_DUMP"], !lines.isEmpty else { return }
        Harness.dumpLock.lock()
        defer { Harness.dumpLock.unlock() }
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        if let file = FileHandle(forWritingAtPath: path) {
            file.seekToEndOfFile()
            file.write(lines.joined().data(using: .utf8)!)
            try? file.close()
        }
    }
    static let dumpLock = NSLock()

    var events: [[String: Any]] {
        lines.map { try! JSONSerialization.jsonObject(with: $0.data(using: .utf8)!) as! [String: Any] }
    }
    func of(_ type: String) -> [[String: Any]] { events.filter { $0["type"] as? String == type } }
    var last: [String: Any] { events.last ?? [:] }
}

@Suite struct BridgeRequests {
    @Test func aGoodRequestParses() {
        let parsed = request(["usageContext": ["purpose": "repair", "reason": "replay_failed"]])
        #expect(parsed.pid == 4242 && parsed.windowId == 77 && parsed.screenId == "boss")
        #expect(parsed.instruction == "打开 张三 的在线简历")
        #expect(parsed.purpose == "repair" && parsed.reason == "replay_failed")
        #expect(request().purpose == "ui" && request().reason == "missing_procedure")
    }

    @Test func badRequestsListEveryProblem() {
        let parsed = ExplorationRequest.parse(requestLine(["submitAllowed": true, "v": 2],
                                                          unit: ["allowedEffects": ["read", "external-submit"]],
                                                          budget: ["maxRounds": 0]))
        #expect(parsed.request == nil)
        #expect(parsed.ids == ("t1", "u1"))
        for problem in ["v must be 1", "external-submit", "budget", "submitAllowed"] {
            #expect(parsed.errors.contains { $0.contains(problem) }, "\(problem) in \(parsed.errors)")
        }
        #expect(ExplorationRequest.parse(requestLine(["parameters": [String: String]()])).errors
            .contains { $0.contains("{{candidate.name}}") })
        #expect(!ExplorationRequest.parse(requestLine(["usageContext": ["purpose": "ui", "reason": "because"]])).errors.isEmpty)
        #expect(ExplorationRequest.parse("not json").errors == ["the request is not a JSON object"])
        let refusal = ExplorationBridge.refusal(parsed.errors, ids: parsed.ids)
        #expect(refusal.hasSuffix("\n") && !refusal.dropLast().contains("\n"))
        #expect(refusal.contains("\"reason\":\"error\""))
    }
}

@Suite struct BridgeRuns {
    @Test func aFinishedUnitReportsEachActionOnceWithAProposal() {
        let harness = Harness(request(["usageContext": ["purpose": "repair", "reason": "replay_failed"]]),
                              model: Script([
                                  "Thought: 点搜索框\nAction: click(element='3')",
                                  "Thought: 输入名字\nAction: type(content='张三', element='3')",
                                  "Thought: 打开简历\nAction: click(start_box='[250, 500, 250, 500]')",
                                  "Thought: 好了\nAction: finished(content='done')",
                              ]))
        harness.screen.elementList = [AXElementInfo(index: 3, role: "AXTextField", label: "搜索",
                                                    frame: CGRect(x: 3100, y: 100, width: 300, height: 30))]
        #expect(harness.bridge.run() == 0)
        #expect(harness.screen.performed.count == 3)
        #expect(harness.of("action_started").count == 3 && harness.of("action_finished").count == 3)
        #expect(harness.of("model_usage").count == 4)
        #expect(harness.of("model_usage").allSatisfy { $0["purpose"] as? String == "repair" && $0["inputTokens"] as? String == "unknown" })
        #expect(harness.of("observed").count == 4)
        #expect(harness.events.allSatisfy { $0["taskId"] as? String == "t1" && $0["unitAttemptId"] as? String == "u1" && $0["v"] as? Int == 1 })

        let finished = harness.of("action_finished")
        let first = finished[0]["action"] as! [String: Any]
        #expect((first["target"] as! [String: Any])["label"] as? String == "搜索")
        #expect((finished[0]["result"] as! [String: Any])["route"] as? String == "element")
        #expect((finished[0]["resolvedElement"] as! [String: Any])["role"] as? String == "AXTextField")
        let third = finished[2]["action"] as! [String: Any]
        let point = (third["target"] as! [String: Any])["point"] as! [String: Double]
        // 250/1000 of the screen is x 3340, a quarter of the window from its left edge.
        #expect(abs(point["x"]! - 0.25) < 0.001 && abs(point["y"]! - 0.5) < 0.01)
        #expect((finished[2]["result"] as! [String: Any])["beforeSnapshotId"] as? String == "u1-s3")

        let last = harness.last
        #expect(last["type"] as? String == "unit_finished" && last["steps"] as? Int == 3)
        let proposal = last["proposal"] as! [String: Any]
        #expect(proposal["parameters"] as? [String] == ["candidate.name"])
        let steps = proposal["steps"] as! [[String: Any]]
        #expect((steps[1]["action"] as! [String: Any])["value"] as? String == "{{candidate.name}}")
        #expect((proposal["postconditions"] as! [[String: Any]])[0]["pageClass"] as? String == "online_resume")
    }

    @Test func withoutAModelNothingRuns() {
        let harness = Harness(request(), model: nil)
        #expect(harness.bridge.run() == 1)
        #expect(harness.events.count == 1 && harness.last["reason"] as? String == "model_unavailable")
        #expect(harness.screen.performed.isEmpty)
    }

    @Test func enterIsHeldAndTheUnitFails() {
        let harness = Harness(request(), model: Script(["Thought: 回复\nAction: type(content='你好\\n')"]))
        #expect(harness.bridge.run() == 1)
        // The text went in once; Enter never did.
        #expect(harness.screen.performed.map(\.kind) == [.type])
        #expect(harness.last["reason"] as? String == "forbidden_effect")
        #expect(harness.of("action_finished").count == 1)
    }

    @Test func anEffectTheUnitDoesNotAllowIsRefused() {
        let harness = Harness(request(unit: ["allowedEffects": ["read"]]),
                              model: Script(["Thought: 点\nAction: click(start_box='[500, 500, 500, 500]')"]))
        #expect(harness.bridge.run() == 1)
        #expect(harness.screen.performed.isEmpty && harness.of("action_started").isEmpty)
        #expect(harness.last["reason"] as? String == "forbidden_effect")
    }

    @Test func bossControlsThatSendAreRefusedByElementPointOrDialog() {
        let greet = AXElementInfo(index: 5, role: "AXButton", label: "打招呼", frame: CGRect(x: 4000, y: 700, width: 120, height: 40))
        let askFor = AXElementInfo(index: 6, role: "AXGroup", label: "索取简历", frame: CGRect(x: 3500, y: 300, width: 160, height: 40))
        let question = AXElementInfo(index: 7, role: "AXStaticText", value: "确定向牛人索取简历吗？", frame: CGRect(x: 3500, y: 380, width: 300, height: 20))
        let okay = AXElementInfo(index: 8, role: "AXButton", label: "好的", frame: CGRect(x: 3700, y: 420, width: 80, height: 30))
        let cases: [(elements: [AXElementInfo], reply: String)] = [
            // By the element the model named.
            ([greet], "Thought: 打开候选人\nAction: click(element='5')"),
            // By a bare point that lands on a request control.
            ([askFor], "Thought: 查看\nAction: click(start_box='[421, 359, 421, 359]')"),
            // The yes of a request dialog, though "好的" alone sends nothing.
            ([question, okay], "Thought: 关闭弹窗\nAction: click(element='8')"),
            // An app that lists nothing: the model's own words.
            ([], "Thought: 页面已打开。点击打招呼按钮。\nAction: click(start_box='[500, 500, 500, 500]')"),
        ]
        for (elements, reply) in cases {
            let harness = Harness(request(), model: Script([reply]))
            harness.screen.elementList = elements
            #expect(harness.bridge.run() == 1, "\(reply)")
            #expect(harness.screen.performed.isEmpty, "\(reply)")
            #expect(harness.of("action_started").isEmpty)
            #expect(harness.last["reason"] as? String == "forbidden_effect", "\(reply)")
        }
    }

    @Test func aPlainClickNextToARequestControlStillGoes() {
        let askFor = AXElementInfo(index: 6, role: "AXButton", label: "索取简历", frame: CGRect(x: 3500, y: 300, width: 160, height: 40))
        let harness = Harness(request(), model: Script([
            "Thought: 打开在线简历\nAction: click(start_box='[700, 700, 700, 700]')",
            "Thought: 好了\nAction: finished(content='ok')",
        ]))
        harness.screen.elementList = [askFor]
        #expect(harness.bridge.run() == 0)
        #expect(harness.screen.performed.count == 1)
    }

    @Test func noInputAfterTheDeadline() {
        let model = Script(["Thought: 点\nAction: click(start_box='[500, 500, 500, 500]')"])
        let harness = Harness(request(budget: ["timeoutMs": 1000]), model: model)
        // The reply arrives after the deadline: its click must not go out.
        model.before = { [unowned harness] in harness.clock.addTimeInterval(2) }
        #expect(harness.bridge.run() == 1)
        #expect(harness.screen.performed.isEmpty)
        #expect(harness.last["reason"] as? String == "timeout")
    }

    @Test func aFinishAfterTheDeadlineIsATimeout() {
        let model = Script(["Thought: 好了\nAction: finished(content='done')"])
        let harness = Harness(request(budget: ["timeoutMs": 1000]), model: model)
        model.before = { [unowned harness] in harness.clock.addTimeInterval(2) }
        #expect(harness.bridge.run() == 1)
        #expect(harness.of("unit_finished").isEmpty && harness.last["reason"] as? String == "timeout")
    }

    @Test func aPointOffTheWindowIsNotSent() {
        // x 50/1000 of the screen is left of the window, which starts at 3000.
        let shape = ExplorationBridge.shape(InputAction(.click).at(2990, 400), effect: "navigation", element: nil, in: bridgeFrame)
        #expect(shape == nil)
    }

    @Test func roundsRunOut() {
        let model = Script([])
        let harness = Harness(request(budget: ["maxRounds": 2]), model: model)
        #expect(harness.bridge.run() == 1)
        #expect(model.calls == 2 && harness.of("model_usage").count == 2)
        #expect(harness.screen.performed.count == 2)
        #expect(harness.last["reason"] as? String == "budget_exhausted")
    }

    @Test func roundsLostToAnUnreadableScreenAreAnErrorNotABudget() {
        let model = Script([])
        let harness = Harness(request(budget: ["maxRounds": 1]), model: model)
        harness.screen.frameError = AgentError("no screen named \"boss\"")
        #expect(harness.bridge.run() == 1)
        #expect(model.calls == 0 && harness.screen.performed.isEmpty)
        #expect(harness.last["reason"] as? String == "error")
        #expect((harness.last["message"] as? String ?? "").contains("no screen named"))
    }

    @Test func unknownTokensUnderALimitStopAfterOneCall() {
        let model = Script([])
        let harness = Harness(request(budget: ["maxTokens": 5000]), model: model)
        #expect(harness.bridge.run() == 1)
        #expect(model.calls == 1)
        #expect(harness.last["reason"] as? String == "budget_exhausted")
    }

    @Test func reportedTokensAreSummedAgainstTheLimit() {
        let model = Counted(Array(repeating: "Thought: 点\nAction: click(start_box='[500, 500, 500, 500]')", count: 5))
        let harness = Harness(request(budget: ["maxTokens": 2000]), model: model)
        #expect(harness.bridge.run() == 1)
        let usage = harness.of("model_usage")
        #expect(usage.count == 2 && usage.allSatisfy { $0["inputTokens"] as? Int == 1000 && $0["outputTokens"] as? Int == 20 })
        #expect(harness.last["reason"] as? String == "budget_exhausted")
    }

    @Test func aCancelMidActionLetsItFinishThenStops() {
        let harness = Harness(request(), model: Script([]))
        harness.screen.during = { [unowned harness] _ in
            #expect(harness.bridge.cancel() == false)
            return ControlResponse()
        }
        #expect(harness.bridge.run() == 1)
        #expect(harness.screen.performed.count == 1)
        #expect(harness.of("action_finished").count == 1)
        #expect(harness.last["reason"] as? String == "cancelled")
        #expect(harness.of("unit_failed").count == 1)
    }

    @Test func aCancelBetweenActionsEndsAtOnce() {
        let model = Script([])
        let harness = Harness(request(), model: model)
        model.before = { [unowned harness] in
            // The model is thinking: nothing is under way at the app.
            if model.calls == 2 { #expect(harness.bridge.cancel() == true) }
        }
        #expect(harness.bridge.run() == 1)
        #expect(harness.screen.performed.count == 1)
        #expect(harness.of("unit_failed").count == 1 && harness.last["reason"] as? String == "cancelled")
        // The outstanding request is counted, once, before the last line.
        #expect(harness.of("model_usage").count == 2)
    }

    @Test func runningPastTheDeadlineTimesOut() {
        let model = Script([])
        let harness = Harness(request(budget: ["timeoutMs": 1000]), model: model)
        model.before = { [unowned harness] in harness.clock.addTimeInterval(0.6) }
        #expect(harness.bridge.run() == 1)
        #expect(harness.last["reason"] as? String == "timeout")
        #expect(model.calls == 2)
    }

    @Test func aBrokenDeliveryIsUnknownAndNotRetried() {
        let harness = Harness(request(budget: ["maxRounds": 1]), model: Script([]))
        harness.screen.during = { _ in throw AgentError("socket closed") }
        _ = harness.bridge.run()
        #expect(harness.screen.performed.count == 1)
        let result = harness.of("action_finished")[0]["result"] as! [String: Any]
        #expect(result["status"] as? String == "unknown")
        #expect((result["error"] as! [String: Any])["code"] as? String == "io")
    }

    @Test func aFailedActionGivesNoProposal() {
        let harness = Harness(request(), model: Script([
            "Thought: 点\nAction: click(start_box='[500, 500, 500, 500]')",
            "Thought: 好了\nAction: finished(content='done')",
        ]))
        harness.screen.during = { _ in .failure("no such element") }
        #expect(harness.bridge.run() == 0)
        #expect((harness.of("action_finished")[0]["result"] as! [String: Any])["status"] as? String == "failed")
        #expect(harness.last["type"] as? String == "unit_finished" && harness.last["proposal"] == nil)
    }

    @Test func aModelErrorIsAFailureNotAFinish() {
        let model = Script([])
        model.before = { throw AgentError("model request failed (500): busy") }
        let harness = Harness(request(), model: model)
        #expect(harness.bridge.run() == 1)
        #expect(harness.last["reason"] as? String == "error")
        #expect((harness.last["message"] as? String ?? "").contains("busy"))
    }

    @Test func linesAreSingleAndNothingFollowsTheLast() {
        let harness = Harness(request(), model: Script(["Thought: 好了\nAction: finished(content='多行\\n答案')"]))
        #expect(harness.bridge.run() == 0)
        #expect(harness.lines.allSatisfy { $0.hasSuffix("\n") && $0.filter { $0 == "\n" }.count == 1 })
        let written = harness.lines.count
        #expect(harness.bridge.cancel() == false)
        #expect(harness.lines.count == written)
        #expect(harness.of("unit_finished").count == 1 && harness.of("unit_failed").isEmpty)
    }
}

private extension InputAction {
    func at(_ x: Double, _ y: Double) -> InputAction {
        var action = self
        action.x = x
        action.y = y
        return action
    }
}
