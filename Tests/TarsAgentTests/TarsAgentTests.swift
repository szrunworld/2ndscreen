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
    for step in steps {
        if case .stop(let outcome, let reason) = step { return (outcome, reason) }
        if case .hold(_, let reason) = step { return (.done, reason) }
    }
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
    /// Called after each action, to change the window as an app would.
    var afterAction: ((FakeScreen) -> Void)?

    func frame() throws -> CGRect { screenFrame }
    func screenshot(size: CGSize) throws -> Data { Data([0x89, 0x50, 0x4E, 0x47]) }
    func perform(_ action: InputAction) throws -> ControlResponse {
        performed.append(action)
        afterAction?(self)
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

    @Test func aPlanThatSendsLaterStillClicksIntoTheField() {
        let screen = FakeScreen()
        screen.fields = [field(index: 3, x: 1920, y: 700, width: 1200, height: 60)]
        let model = ScriptedModel([
            "Thought: 先点击输入框，输入回复后再发送。现在点击底部的输入框。\nAction: click(start_box='[500, 900, 500, 900]')",
            "Thought: 输入回复。\nAction: type(content='好的')",
            "Thought: 现在点击发送按钮。\nAction: click(start_box='[990, 950, 990, 950]')",
        ])
        let result = TarsAgent(screen: screen, model: model).run("x")
        #expect(screen.performed.map(\.kind) == [.click, .type])
        #expect(result.reason.contains("sending"))
    }

    @Test func proseTwiceInARowIsTheAnswer() {
        let model = ScriptedModel(["已经发送了。", "任务完成，消息已发送。"])
        let result = TarsAgent(screen: FakeScreen(), model: model).run("x")
        #expect(result.outcome == .done && result.reason == "任务完成，消息已发送。" && result.steps == 2)
        // The model was reminded of the format in between.
        #expect(model.seen[1].contains { if case .user(let text) = $0 { text.contains("Action:") && text.contains("finished") } else { false } })
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

@Suite struct Elements {
    func elementList(_ messages: [Message]) -> String? {
        messages.compactMap { if case .user(let text) = $0, text.hasPrefix(TarsAgent.elementsHeading) { text } else { nil } }.last
    }

    @Test func theModelSeesTheControlsOnScreen() {
        let screen = FakeScreen()
        screen.fields = [
            field(index: 2, x: 1920, y: 0, width: 128, height: 80, label: "张三", role: "AXButton"),
            field(index: 5, x: 1920, y: 600, width: 1280, height: 200),
            field(index: 6, x: 0, y: 0, width: 100, height: 100, label: "on another screen", role: "AXButton"),
            field(index: -1, x: 1920, y: 0, width: 100, height: 100, label: "context only", role: "AXGroup"),
        ]
        let model = ScriptedModel(["Action: finished(content='ok')"])
        _ = TarsAgent(screen: screen, model: model).run("x")
        let list = elementList(model.seen[0])
        #expect(list == "## Elements\n[2] Button \"张三\" box=[0, 0, 100, 100]\n[5] TextArea box=[0, 750, 1000, 1000]")
    }

    @Test func appsWithoutControlsGetNoList() {
        let model = ScriptedModel(["Action: finished(content='ok')"])
        _ = TarsAgent(screen: FakeScreen(), model: model).run("x")
        #expect(elementList(model.seen[0]) == nil)
        var options = TarsAgent.Options()
        options.listElements = false
        let screen = FakeScreen()
        screen.fields = [field(index: 1, x: 1920, y: 0, width: 100, height: 100, label: "A", role: "AXButton")]
        let quiet = ScriptedModel(["Action: finished(content='ok')"])
        _ = TarsAgent(screen: screen, model: quiet, options: options).run("x")
        #expect(elementList(quiet.seen[0]) == nil)
    }

    @Test func actingOnAnElementByNumber() {
        let screen = FakeScreen()
        screen.fields = [
            field(index: 2, x: 1920, y: 0, width: 128, height: 80, label: "张三", role: "AXButton"),
            field(index: 5, x: 1920, y: 600, width: 1280, height: 200),
        ]
        let model = ScriptedModel([
            "Thought: 打开张三\nAction: click(element='2')",
            "Thought: 写回复\nAction: type(content='明天见', element='5')",
            "Action: finished(content='ok')",
        ])
        _ = TarsAgent(screen: screen, model: model).run("x")
        #expect(screen.performed.map(\.kind) == [.click, .type])
        // The click carries the element and its center, for the guards.
        #expect(screen.performed[0].index == 2 && screen.performed[0].x == 1984 && screen.performed[0].y == 40)
        #expect(screen.performed[1].index == 5 && screen.performed[1].value == "明天见")
    }

    @Test func anElementIsFoundAgainAfterTheWindowChanges() {
        let screen = FakeScreen()
        screen.fields = [field(index: 5, x: 1920, y: 600, width: 1280, height: 200)]
        // The first action renumbers the window; the field is now 9.
        screen.afterAction = { $0.fields = [field(index: 9, x: 1920, y: 600, width: 1280, height: 200)] }
        let model = ScriptedModel([
            "Thought: 点击后输入\nAction: click(element='5')\n\ntype(content='hi', element='5')",
            "Action: finished(content='ok')",
        ])
        _ = TarsAgent(screen: screen, model: model).run("x")
        #expect(screen.performed.map(\.index) == [5, 9])
    }

    @Test func aSendButtonByNumberStops() {
        let screen = FakeScreen()
        screen.fields = [field(index: 7, x: 3000, y: 700, width: 100, height: 40, label: "发送", role: "AXButton")]
        let model = ScriptedModel(["Thought: 点按钮\nAction: click(element='7')"])
        let result = TarsAgent(screen: screen, model: model).run("x")
        #expect(result.reason.contains("submits"))
        #expect(screen.performed.isEmpty)
    }

    @Test func anUnlistedNumberIsRefused() {
        let screen = FakeScreen()
        screen.fields = [field(index: 2, x: 1920, y: 0, width: 128, height: 80, label: "A", role: "AXButton")]
        let model = ScriptedModel(["Action: click(element='40')", "Action: finished(content='ok')"])
        let result = TarsAgent(screen: screen, model: model).run("x")
        #expect(screen.performed.isEmpty && result.outcome == .done)
        #expect(model.seen[1].contains { if case .user(let text) = $0 { text.contains("no element 40") } else { false } })
    }

    @Test func controlsOutlastTextWhenTheListIsFull() {
        // A long message list, then the message box at the end of the tree.
        var elements = (0..<200).map {
            field(index: $0, x: 1920, y: Double($0 % 700), width: 100, height: 20, label: "消息 \($0)", role: "AXStaticText")
        }
        elements.append(field(index: 200, x: 2000, y: 700, width: 700, height: 60))
        let listed = TarsAgent.listable(elements, in: screenFrame)
        #expect(listed.count == TarsAgent.maxListed)
        #expect(listed.last?.index == 200)
        // Tree order is kept.
        #expect(listed.map(\.index) == listed.map(\.index).sorted())
    }

    @Test func onlyTheLatestListStays() {
        let screen = FakeScreen()
        screen.fields = [field(index: 2, x: 1920, y: 0, width: 128, height: 80, label: "A", role: "AXButton")]
        let model = ScriptedModel(["Action: hover(start_box='[1, 1, 1, 1]')", "Action: finished(content='ok')"])
        _ = TarsAgent(screen: screen, model: model).run("x")
        let lists = model.seen[1].filter { if case .user(let text) = $0 { text.hasPrefix(TarsAgent.elementsHeading) } else { false } }
        #expect(lists.count == 1)
    }
}

/// A phone: planned on its screenshot in device pixels, then turned into
/// `2ndscreen android` commands.
@Suite struct Phone {
    let phone = PlanContext(frame: CGRect(x: 0, y: 0, width: 1000, height: 2000), foreground: true)

    func commands(_ text: String, _ context: PlanContext? = nil) throws -> [String] {
        try inputs(Planner.plan(action(text), context ?? phone)).flatMap {
            try AndroidPlan.commands(for: $0, size: CGSize(width: 1000, height: 2000)).map { $0.joined(separator: " ") }
        }
    }

    @Test func tapsLandInDevicePixels() throws {
        #expect(try commands("click(start_box='[500, 250, 500, 250]')") == ["tap --x 500 --y 500"])
        #expect(try commands("left_double(start_box='[0, 1000, 0, 1000]')") == ["tap --x 0 --y 2000", "tap --x 0 --y 2000"])
    }

    @Test func aLongPressHoldsInPlace() throws {
        #expect(try commands("long_press(start_box='[100, 100, 100, 100]')")
            == ["swipe --x 100 --y 200 --to-x 100 --to-y 200 --duration 0.8"])
    }

    @Test func aDragIsASwipe() throws {
        #expect(try commands("drag(start_box='[500, 800, 500, 800]', end_box='[500, 200, 500, 200]')")
            == ["swipe --x 500 --y 1600 --to-x 500 --to-y 400 --duration 0.5"])
    }

    @Test func scrollingDownMovesTheFingerUp() throws {
        func numbers(_ command: String) -> [String: Double] {
            let words = command.split(separator: " ").map(String.init)
            var values: [String: Double] = [:]
            for (index, word) in words.enumerated() where word.hasPrefix("--") && index + 1 < words.count {
                values[word] = Double(words[index + 1])
            }
            return values
        }
        let down = numbers(try commands("scroll(start_box='[500, 500, 500, 500]', direction='down')")[0])
        #expect(down["--y"]! > down["--to-y"]!)
        #expect(down["--x"] == down["--to-x"])
        // Off the edges, where swipes are the system's Back and Home.
        #expect(down["--to-y"]! >= 300 && down["--y"]! <= 1700)
        let left = numbers(try commands("scroll(start_box='[500, 500, 500, 500]', direction='left')")[0])
        #expect(left["--x"]! < left["--to-x"]!)
        // Pointing near the bottom still swipes the full reach, moved inward.
        let low = numbers(try commands("scroll(start_box='[450, 900, 450, 900]', direction='down')")[0])
        #expect(low["--y"]! - low["--to-y"]! == 600)
        #expect(low["--y"]! <= 1700)
    }

    @Test func typingThatWouldSubmitIsHeld() throws {
        for content in ["好的，明天见\\n", "好的，明天见\n"] {
            let steps = Planner.plan(action("type(content='\(content)')"), phone)
            #expect(inputs(steps).first?.value == "好的，明天见")
            guard case .hold(let held, _) = steps.last else { Issue.record("not held: \(content)"); continue }
            #expect(try AndroidPlan.commands(for: held, size: .zero) == [["key", "--key", "enter"]])
            var allowed = phone
            allowed.allowSubmit = true
            #expect(try commands("type(content='\(content)')", allowed) == ["type --text 好的，明天见", "key --key enter"])
        }
        guard case .hold(let enter, _) = Planner.plan(action("hotkey(key='enter')"), phone).first else {
            Issue.record("Enter not held")
            return
        }
        #expect(try AndroidPlan.commands(for: enter, size: .zero) == [["key", "--key", "enter"]])
    }

    @Test func navigationKeys() throws {
        #expect(try commands("press_back()") == ["key --key back"])
        #expect(try commands("press_home()") == ["key --key home"])
        #expect(try commands("hotkey(key='esc')") == ["key --key back"])
        var copy = InputAction(.key)
        copy.key = "c"
        copy.modifiers = ["cmd"]
        #expect(throws: AndroidPlan.Failure.self) { try AndroidPlan.commands(for: copy, size: .zero) }
    }

    @Test func thePhonePromptOffersPhoneActions() {
        let prompt = TarsAgent.prompt("看看最新消息", actionSpaces: TarsAgent.phoneActionSpaces, elements: false)
        #expect(prompt.contains("press_back()"))
        #expect(!prompt.contains("## Elements"))
        #expect(TarsAgent.prompt("x").contains("## Elements"))
    }
}
