import CoreGraphics
import Foundation
import SecondScreenCore
import Testing
@testable import TarsAgent

let screenFrame = CGRect(x: 1920, y: 0, width: 1280, height: 800)
let context = PlanContext(frame: screenFrame)

func action(_ text: String) -> ParsedAction {
    ActionParser.parse("Thought: t\nAction: \(text)").actions[0]
}

func inputs(_ steps: [Step]) -> [InputAction] {
    steps.compactMap { if case .act(let action) = $0 { action } else { nil } }
}

func stopReason(_ steps: [Step]) -> (Outcome, String)? {
    for step in steps { if case .stop(let outcome, let reason) = step { return (outcome, reason) } }
    return nil
}

@Suite struct Parsing {
    @Test func thoughtAndAction() {
        let prediction = ActionParser.parse("""
            Thought: 点击文件传输助手。
            Action: click(start_box='[100, 200, 300, 400]')
            """)
        #expect(prediction.thought == "点击文件传输助手。")
        #expect(prediction.actions.count == 1)
        #expect(prediction.actions[0].type == "click")
        #expect(prediction.actions[0].boxes["start_box"] == [0.1, 0.2, 0.3, 0.4])
    }

    @Test func pointsAndOddBoxes() {
        #expect(action("click(start_box='(500,250)')").boxes["start_box"] == [0.5, 0.25, 0.5, 0.25])
        #expect(action("click(point='<point>383 117</point>')").boxes["start_box"] == [0.383, 0.117, 0.383, 0.117])
        #expect(action("click(start_box='[383 117]')").boxes["start_box"] == [0.383, 0.117, 0.383, 0.117])
        #expect(action("click(start_box='<|box_start|>(10,20)<|box_end|>')").boxes["start_box"] == [0.01, 0.02, 0.01, 0.02])
    }

    @Test func textArguments() {
        let type = action("type(content='你好，世界\\n')")
        #expect(type.inputs["content"] == "你好，世界\\n")
        let scroll = action("scroll(start_box='[500, 500, 500, 500]', direction='down')")
        #expect(scroll.inputs["direction"] == "down")
        #expect(action("hotkey(key='ctrl c')").inputs["key"] == "ctrl c")
        #expect(action("finished(content='done, really')").inputs["content"] == "done, really")
    }

    @Test func fullWidthColonAndNoThought() {
        let prediction = ActionParser.parse("Action：wait()")
        #expect(prediction.actions.first?.type == "wait")
        #expect(ActionParser.parse("not an action at all").actions.isEmpty)
    }

    @Test func recoveringBoxes() {
        #expect(ActionParser.recoverBox("Action: click(start_box='[383 117]')", "start_box") == [0.383, 0.117, 0.383, 0.117])
        #expect(ActionParser.recoverBox("drag(start_box='(100,200)', end_box='(300,400)')", "end_box") == [0.3, 0.4, 0.3, 0.4])
        #expect(ActionParser.recoverBox("drag(start_box='(100,200)', end_box='(300,400)')", "start_box") == [0.1, 0.2, 0.1, 0.2])
        #expect(ActionParser.recoverBox("click(start_box='[383]')", "start_box") == nil)
        #expect(ActionParser.recoverBox("finished()", "start_box") == nil)
    }
}

@Suite struct Planning {
    @Test func boxesMapOntoTheScreen() {
        #expect(Planner.point([0.5, 0.25, 0.5, 0.25], in: screenFrame) == CGPoint(x: 2560, y: 200))
        #expect(Planner.point([0.1, 0.1, 0.3, 0.5], in: screenFrame) == CGPoint(x: 2176, y: 240))
        #expect(Planner.point([2, -1], in: screenFrame) == CGPoint(x: 3200, y: 0))
        #expect(Planner.point(nil, in: screenFrame) == nil)
    }

    @Test func clicksCarryThePointAndButton() {
        let right = inputs(Planner.plan(action("right_single(start_box='[500, 500, 500, 500]')"), context))
        #expect(right.count == 1)
        #expect(right[0].kind == .click && right[0].button == "right" && right[0].x == 2560 && right[0].y == 400)
        let double = inputs(Planner.plan(action("left_double(start_box='[0, 0, 0, 0]')"), context))
        #expect(double[0].count == 2)
        #expect(stopReason(Planner.plan(ParsedAction(type: "click"), context))?.0 == .user)
    }

    @Test func typingThatWouldSubmitStops() {
        let steps = Planner.plan(action("type(content='好的，明天见\\n')"), context)
        #expect(inputs(steps).map(\.value) == ["好的，明天见"])
        #expect(stopReason(steps)?.0 == .done)
        var allowed = context
        allowed.allowSubmit = true
        let sent = inputs(Planner.plan(action("type(content='hi\\n')"), allowed))
        #expect(sent.map(\.kind) == [.type, .key])
        #expect(sent[1].key == "return")
    }

    @Test func enterStopsUnlessAllowed() {
        #expect(stopReason(Planner.plan(action("hotkey(key='enter')"), context)) != nil)
        #expect(stopReason(Planner.plan(action("hotkey(key='cmd enter')"), context)) != nil)
        var allowed = context
        allowed.allowSubmit = true
        #expect(inputs(Planner.plan(action("hotkey(key='Enter')"), allowed))[0].key == "return")
    }

    @Test func enterInAnOpenMenuPicksAnItem() {
        var menu = context
        menu.menuOpen = true
        #expect(inputs(Planner.plan(action("hotkey(key='enter')"), menu)).first?.key == "return")
        #expect(stopReason(Planner.plan(action("hotkey(key='cmd enter')"), menu)) != nil)
        #expect(stopReason(Planner.plan(action("type(content='hi\\n')"), menu)) != nil)
    }

    @Test func keyNames() {
        #expect(Planner.keys("ctrl c")! == ("c", ["cmd"]))
        #expect(Planner.keys("cmd+shift+n")! == ("n", ["cmd", "shift"]))
        #expect(Planner.keys("page down")! == ("pagedown", []))
        #expect(Planner.keys("backspace")! == ("delete", []))
        #expect(Planner.keys("alt tab")! == ("tab", ["option"]))
        #expect(Planner.keys("ctrl") == nil)
    }

    @Test func shortcutsBeyondTheWindowStop() {
        for keys in ["cmd q", "ctrl q", "cmd tab", "cmd option esc", "command h", "cmd space"] {
            #expect(stopReason(Planner.plan(action("hotkey(key='\(keys)')"), context))?.0 == .user, "\(keys)")
        }
        for keys in ["ctrl a", "cmd c", "esc", "cmd shift n"] {
            #expect(stopReason(Planner.plan(action("hotkey(key='\(keys)')"), context)) == nil, "\(keys)")
        }
    }

    @Test func dragsInTheBackgroundSelect() {
        let drag = action("drag(start_box='[100, 100, 100, 100]', end_box='[200, 200, 200, 200]')")
        // In the background, a drag becomes a click and a shift-click...
        let selection = inputs(Planner.plan(drag, context))
        #expect(selection.map(\.kind) == [.click, .click] && selection[1].modifiers == ["shift"])
        // ...or, on one spot, a double click.
        let word = inputs(Planner.plan(action("drag(start_box='[100, 100, 100, 100]', end_box='[100, 100, 101, 100]')"), context))
        #expect(word.count == 1 && word[0].count == 2)
        var allowed = context
        allowed.foreground = true
        let steps = inputs(Planner.plan(drag, allowed))
        #expect(steps.first?.kind == .drag && steps.first?.foreground == true && steps.first?.toX == 2176)
    }

    @Test func scrollAtAPoint() {
        let steps = inputs(Planner.plan(action("scroll(start_box='[500, 500, 500, 500]', direction='down')"), context))
        #expect(steps.first?.direction == "down" && steps.first?.x == 2560)
        #expect(Planner.plan(action("scroll(direction='sideways')"), context).isEmpty)
    }

    @Test func finishedCarriesTheAnswer() {
        let stop = stopReason(Planner.plan(action("finished(content='最新消息是：你好')"), context))
        #expect(stop?.0 == .done && stop?.1 == "最新消息是：你好")
        #expect(stopReason(Planner.plan(action("call_user()"), context))?.0 == .user)
    }
}

final class FakeScreen: AgentScreen {
    var performed: [InputAction] = []
    var fields: [AXElementInfo] = []

    func frame() throws -> CGRect { screenFrame }
    func screenshot(size: CGSize) throws -> Data { Data([0x89, 0x50, 0x4E, 0x47]) }
    func perform(_ action: InputAction) throws -> ControlResponse {
        performed.append(action)
        return ControlResponse()
    }
    func elements() throws -> [AXElementInfo] { fields }
}

final class ScriptedModel: VisionModel {
    var replies: [String]
    var seen: [[Message]] = []
    init(_ replies: [String]) { self.replies = replies }
    func complete(_ messages: [Message]) throws -> String {
        seen.append(messages)
        return replies.isEmpty ? "Action: finished(content='out of script')" : replies.removeFirst()
    }
}

func field(index: Int, x: Double, y: Double, width: Double, height: Double, label: String? = nil,
           role: String = "AXTextArea") -> AXElementInfo {
    AXElementInfo(index: index, role: role, label: label, frame: CGRect(x: x, y: y, width: width, height: height))
}

@Suite struct Loop {
    @Test func clickTypeFinish() {
        let screen = FakeScreen()
        screen.fields = [field(index: 4, x: 1920, y: 600, width: 1280, height: 200)]
        let model = ScriptedModel([
            "Thought: 点输入框\nAction: click(start_box='[500, 875, 500, 875]')",
            "Thought: 输入\nAction: type(content='明天见')",
            "Thought: 完成\nAction: finished(content='typed')",
        ])
        let result = TarsAgent(screen: screen, model: model).run("在输入框里写明天见")
        #expect(result.outcome == .done && result.reason == "typed")
        #expect(screen.performed.map(\.kind) == [.click, .type])
        // Typing goes to the field the model clicked, by its index.
        #expect(screen.performed[1].index == 4)
        // The first message carries the prompt and the instruction.
        if case .user(let text) = model.seen[0][0] {
            #expect(text.contains("## User Instruction\n在输入框里写明天见"))
        } else {
            Issue.record("the first message is not the prompt")
        }
    }

    @Test func anAnswerInTheThoughtIsKept() {
        let model = ScriptedModel(["Thought: 结果是 1776。\nAction: finished()"])
        let result = TarsAgent(screen: FakeScreen(), model: model).run("x")
        #expect(result.outcome == .done && result.reason == "结果是 1776。")
    }

    @Test func clickOnSendStops() {
        let screen = FakeScreen()
        screen.fields = [field(index: 9, x: 3000, y: 700, width: 100, height: 40, label: "发送", role: "AXButton")]
        let model = ScriptedModel(["Thought: 点按钮\nAction: click(start_box='[900, 900, 900, 900]')"])
        let result = TarsAgent(screen: screen, model: model).run("x")
        #expect(result.outcome == .done && result.reason.contains("submits"))
        #expect(screen.performed.isEmpty)
    }

    @Test func clickTheModelCallsSendingStops() {
        let screen = FakeScreen()
        let model = ScriptedModel(["Thought: Click the send button.\nAction: click(start_box='[100, 100, 100, 100]')"])
        let result = TarsAgent(screen: screen, model: model).run("x")
        #expect(result.reason.contains("sending"))
        #expect(screen.performed.isEmpty)
    }

    @Test func oldScreenshotsLeaveTheHistory() {
        let screen = FakeScreen()
        let model = ScriptedModel(Array(repeating: "Action: hover(start_box='[1, 1, 1, 1]')", count: 8))
        var options = TarsAgent.Options()
        options.maxSteps = 8
        let result = TarsAgent(screen: screen, model: model, options: options).run("x")
        #expect(result.outcome == .user)
        let images = model.seen.last!.filter { if case .screenshot = $0 { true } else { false } }.count
        #expect(images == TarsAgent.maxImages)
    }
}
