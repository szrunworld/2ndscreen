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

    @Test func dragsStayDragsWithoutGestures() {
        // On iPhone Mirroring a click is a tap, so a drag must never become
        // clicks; it goes to the screen as a drag, which refuses it.
        var phone = context
        phone.gestures = false
        let drag = action("drag(start_box='[450, 850, 450, 850]', end_box='[450, 300, 450, 300]')")
        let steps = inputs(Planner.plan(drag, phone))
        #expect(steps.map(\.kind) == [.drag] && steps[0].foreground != true)
    }

    @Test func iPhoneOptionsOfferNoSwipes() {
        var options = TarsAgent.Options()
        options.forIPhone()
        #expect(!options.gestures && !options.listElements)
        for word in ["scroll(", "drag(", "long_press(", "press_back("] {
            #expect(!options.actionSpaces.contains(word), "\(word)")
        }
        #expect(options.actionSpaces.contains("press_home()"))
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

final class MemoryStore: ProcedureStore {
    var procedures: [Procedure] = []
    func load(app: String) -> [Procedure] { procedures }
    func save(_ procedures: [Procedure], app: String) { self.procedures = procedures }
}

func button(_ index: Int, _ label: String, x: Double, y: Double = 100, value: String? = nil,
            role: String = "AXButton") -> AXElementInfo {
    AXElementInfo(index: index, role: role, label: label, value: value, frame: CGRect(x: x, y: y, width: 100, height: 40))
}

@Suite struct SlotsInInstructions {
    func step(_ kind: String, label: String? = nil, value: String? = nil) -> LearnedStep {
        var step = LearnedStep(kind: kind)
        step.value = value
        if let label { step.target = ElementRef(role: "AXButton", label: label, x: 0.5, y: 0.5) }
        return step
    }

    @Test func typedTextAndNamedControlsBecomeSlots() {
        let found = Slots.discover(instruction: "给陈一写：你好，还在招",
                                   steps: [step("click", label: "陈一 前端工程师 在吗"), step("type", value: "你好，还在招")],
                                   texts: ["已给陈一写好草稿"])
        #expect(found.template == "给⟦0⟧写：⟦1⟧" && found.slots == 2)
        #expect(found.steps[0].target?.label == "⟦0⟧…" && found.steps[1].value == "⟦1⟧")
        #expect(found.texts == ["已给⟦0⟧写好草稿"])
        #expect(Slots.match(found.template, "给李四写：在的") == ["李四", "在的"])
        #expect(Slots.match(found.template, "打开设置") == nil)
    }

    @Test func shortTextsAndPlainLabelsStayFixed() {
        // "3" and "=" are in the instruction, but one character matches by accident.
        let found = Slots.discover(instruction: "计算 3 + 4 =", steps: [step("click", label: "3"), step("click", label: "=")])
        #expect(found.template == "计算 3 + 4 =" && found.slots == 0)
        #expect(Slots.match(found.template, "计算 3 + 4 =") == [])
        #expect(Slots.match(found.template, "计算 5 + 4 =") == nil)
    }

    @Test func slotsThatTouchKeepOnlyTheLonger() {
        let found = Slots.discover(instruction: "搜索陈一前端", steps: [step("click", label: "陈一"), step("type", value: "前端")])
        #expect(found.slots == 1)
        #expect(Slots.match(found.template, "搜索陈一前端") != nil)
    }

    @Test func aSlotLabelFindsTheRowThatStartsWithIt() {
        let reference = ElementRef(role: "AXButton", label: "⟦0⟧…", x: 0.1, y: 0.1)
        let rows = [button(1, "李四光 后端", x: 1920), button(2, "李四 产品经理 你好", x: 2100), button(3, "王五", x: 2300)]
        #expect(reference.find(in: rows, frame: screenFrame, bindings: ["李四"])?.index == 1)  // nearest of the two
        #expect(reference.find(in: rows, frame: screenFrame, bindings: ["赵六"]) == nil)
        let exact = ElementRef(role: "AXButton", label: "⟦0⟧", x: 0.1, y: 0.1)
        #expect(exact.find(in: rows + [button(4, "李四", x: 3000)], frame: screenFrame, bindings: ["李四"])?.index == 4)
    }
}

@Suite struct Learned {
    /// A calculator of sorts: buttons, and a display that shows what was pressed.
    func calculator() -> FakeScreen {
        let screen = FakeScreen()
        func layout(_ shown: String) -> [AXElementInfo] {
            [button(1, "7", x: 2000), button(2, "8", x: 2200), button(3, "等于", x: 2400), button(4, "清除", x: 2600),
             button(5, "", x: 2000, y: 300, value: shown, role: "AXStaticText")]
        }
        screen.fields = layout("0")
        screen.afterAction = { screen in
            let pressed = screen.performed.compactMap { action in screen.fields.first { $0.index == action.index }?.label }
            screen.fields = layout(pressed.last == "等于" ? "15" : pressed.joined())
        }
        return screen
    }

    func options(_ store: ProcedureStore) -> TarsAgent.Options {
        var options = TarsAgent.Options()
        options.procedures = store
        options.app = "test"
        options.replayPatience = 0
        return options
    }

    let script = [
        "Thought: 按 7\nAction: click(element='1')",
        "Thought: 按 8\nAction: click(element='2')",
        "Thought: 按等于\nAction: click(element='3')",
        "Thought: 结果\nAction: finished(content='结果是 15')",
    ]

    @Test func theSecondRunNeedsNoModel() {
        let store = MemoryStore()
        let first = TarsAgent(screen: calculator(), model: ScriptedModel(script), options: options(store)).run("算 7 加 8")
        #expect(first.outcome == .done && first.learned == "saved" && first.modelCalls == 4)
        #expect(store.procedures.count == 1 && store.procedures[0].finish == .element)

        let screen = calculator()
        let model = ScriptedModel([])
        let second = TarsAgent(screen: screen, model: model, options: options(store)).run("算 7 加 8")
        // The answer is read off the display, not remembered.
        #expect(second.outcome == .done && second.reason == "15")
        #expect(second.modelCalls == 0 && model.seen.isEmpty && second.replayed == 3)
        #expect(screen.performed.map(\.index) == [1, 2, 3])
        #expect(store.procedures[0].successes == 2)
    }

    @Test func theAnswerIsNotTextTheInstructionGave() {
        // Calculator shows the sum above the result; the model's answer names both.
        let store = MemoryStore()
        let screen = calculator()
        let react = screen.afterAction!
        screen.afterAction = { screen in
            react(screen)
            if screen.performed.last?.index == 3 {
                screen.fields.append(button(6, "", x: 2000, y: 250, value: "7+8", role: "AXStaticText"))
            }
        }
        let model = ScriptedModel(Array(script.dropLast()) + ["Action: finished(content='7+8 的结果是 15')"])
        _ = TarsAgent(screen: screen, model: model, options: options(store)).run("计算 7+8")
        #expect(store.procedures.first?.finish == .element && store.procedures.first?.answerFrom?.y ?? 0 > 0.3)
    }

    @Test func anAnswerWhoseLabelIsTheAnswerIsReadAgain() {
        // Text that carries its words as its label: "Pressed 11", then "Pressed 12".
        let store = MemoryStore()
        func counter(_ start: Int) -> FakeScreen {
            let screen = FakeScreen()
            var presses = start
            screen.fields = [button(1, "Press me", x: 2000), button(2, "Pressed \(presses)", x: 2200, role: "AXStaticText")]
            screen.afterAction = { screen in
                presses += 1
                screen.fields[1] = button(2, "Pressed \(presses)", x: 2200, role: "AXStaticText")
            }
            return screen
        }
        _ = TarsAgent(screen: counter(10), model: ScriptedModel(["Action: click(element='1')", "Action: finished(content='计数是 Pressed 11')"]),
                      options: options(store)).run("点按钮，读计数")
        #expect(store.procedures.first?.finish == .element && store.procedures.first?.answerFrom?.label == "")
        let again = TarsAgent(screen: counter(11), model: ScriptedModel([]), options: options(store)).run("点按钮，读计数")
        #expect(again.reason == "Pressed 12" && again.modelCalls == 0)
    }

    @Test func anAnswerInsideALongerTextIsReadOutOfIt() {
        // Windows Calculator's display reads "显示为 1651"; the model says "结果为 1651".
        let store = MemoryStore()
        func display(_ result: String) -> FakeScreen {
            let screen = FakeScreen()
            screen.fields = [button(1, "等于", x: 2400), button(2, "清除", x: 2600), button(3, "七", x: 2000),
                             button(4, "显示为 0", x: 2000, y: 300, role: "AXStaticText")]
            screen.afterAction = { $0.fields[3] = button(4, "显示为 \(result)", x: 2000, y: 300, role: "AXStaticText") }
            return screen
        }
        _ = TarsAgent(screen: display("1651"), model: ScriptedModel(["Action: click(element='1')", "Action: finished(content='37×48−125 的结果为 1651')"]),
                      options: options(store)).run("计算 37×48−125，告诉我结果")
        #expect(store.procedures.first?.finish == .element && store.procedures.first?.answerPattern == "显示为 ⟦⟧")
        let again = TarsAgent(screen: display("1652"), model: ScriptedModel([]), options: options(store)).run("计算 37×48−125，告诉我结果")
        #expect(again.reason == "1652" && again.modelCalls == 0)
    }

    @Test func aTaskThatAsksNothingRepeatsNoAnswer() {
        // The model reports what this search found; the next search finds something else.
        let store = MemoryStore()
        func search() -> FakeScreen {
            let screen = FakeScreen()
            screen.fields = [AXElementInfo(index: 1, role: "AXTextField", label: "Search", value: "", frame: CGRect(x: 2800, y: 100, width: 200, height: 30)),
                             button(2, "Aa, Helvetica", x: 2000, y: 300), button(3, "Fonts", x: 2200, y: 300), button(4, "Info", x: 2400, y: 300)]
            screen.afterAction = { screen in
                guard let typed = screen.performed.last, typed.kind == .type else { return }
                screen.fields[0] = AXElementInfo(index: 1, role: "AXTextField", label: "Search", value: typed.value,
                                                 frame: CGRect(x: 2800, y: 100, width: 200, height: 30))
                screen.fields[1] = button(2, "Aa, \(typed.value ?? "")", x: 2000, y: 300)
            }
            return screen
        }
        _ = TarsAgent(screen: search(), model: ScriptedModel(["Action: type(content='Helvetica', element='1')",
                                                             "Action: finished(content='找到了 Helvetica 和 Helvetica Neue')"]),
                      options: options(store)).run("搜索 Helvetica")
        #expect(store.procedures.first?.finish == .steps && store.procedures.first?.answerFrom == nil)
        let again = TarsAgent(screen: search(), model: ScriptedModel([]), options: options(store)).run("搜索 Menlo")
        #expect(again.modelCalls == 0 && !again.reason.contains("Helvetica"))
    }

    @Test func aQuestionIsNeverAnsweredFromMemory() {
        // Nothing on screen shows the answer: the replay asks the model rather than repeat the old reply.
        let store = MemoryStore()
        let screen = FakeScreen()
        screen.fields = [button(1, "打开", x: 2000), button(2, "设置", x: 2200), button(3, "帮助", x: 2400)]
        let model = ScriptedModel(["Action: click(element='1')", "Action: finished(content='版本号是 3.2')"])
        _ = TarsAgent(screen: screen, model: model, options: options(store)).run("打开看看版本号是多少")
        #expect(store.procedures.first?.finish == .model)
        // The wording asked for information, so no extra question went to the model.
        #expect(model.seen.count == 2)
    }

    @Test func controlsAreFoundAgainWhereverTheyMoved() {
        let store = MemoryStore()
        _ = TarsAgent(screen: calculator(), model: ScriptedModel(script), options: options(store)).run("算 7 加 8")
        let screen = calculator()
        // The same buttons, renumbered.
        screen.fields = screen.fields.map { AXElementInfo(index: $0.index + 10, role: $0.role, label: $0.label, value: $0.value, frame: CGRect(x: $0.frame!.x, y: $0.frame!.y, width: 100, height: 40)) }
        screen.afterAction = nil
        let model = ScriptedModel(["Action: finished(content='看过了')"])
        _ = TarsAgent(screen: screen, model: model, options: options(store)).run("算 7 加 8")
        #expect(screen.performed.map(\.index) == [11, 12, 13])
    }

    @Test func aMissingControlHandsOverToTheModel() {
        let store = MemoryStore()
        _ = TarsAgent(screen: calculator(), model: ScriptedModel(script), options: options(store)).run("算 7 加 8")

        // The app changed: 等于 is now called "=".
        let screen = calculator()
        func renamed(_ fields: [AXElementInfo]) -> [AXElementInfo] {
            fields.map { $0.label == "等于" ? button($0.index, "=", x: $0.frame!.x) : $0 }
        }
        let react = screen.afterAction!
        screen.fields = renamed(screen.fields)
        screen.afterAction = { screen in
            let equals = screen.performed.last?.index == 3
            react(screen)
            if equals { screen.fields = screen.fields.map { $0.index == 5 ? button(5, "", x: 2000, y: 300, value: "15", role: "AXStaticText") : $0 } }
            screen.fields = renamed(screen.fields)
        }
        let model = ScriptedModel(["Thought: 按 =\nAction: click(element='3')", "Action: finished(content='结果是 15')"])
        let result = TarsAgent(screen: screen, model: model, options: options(store)).run("算 7 加 8")
        #expect(result.outcome == .done && result.replayed == 2 && result.modelCalls == 2)
        // The model was told what had run, and the procedure now names the new control.
        #expect(model.seen[0].contains { if case .user(let text) = $0 { text.contains("1. click → Button \"7\"") && text.contains("not on screen") } else { false } })
        #expect(result.learned == "saved" && store.procedures.count == 1)
        #expect(store.procedures[0].steps.map { $0.target?.label } == ["7", "8", "="])
    }

    @Test func aProcedureThatKeepsBreakingIsForgotten() {
        let store = MemoryStore()
        _ = TarsAgent(screen: calculator(), model: ScriptedModel(script), options: options(store)).run("算 7 加 8")
        for attempt in 1...3 {
            let empty = FakeScreen()
            let result = TarsAgent(screen: empty, model: ScriptedModel(["Action: call_user()"]), options: options(store)).run("算 7 加 8")
            #expect(result.outcome == .user)
            #expect(store.procedures.count == (attempt < 3 ? 1 : 0))
        }
    }

    @Test func stepsAimedBySightAloneAreNotLearned() {
        let store = MemoryStore()
        // An app that draws its own controls: nothing to find again.
        let model = ScriptedModel(["Thought: 点\nAction: click(start_box='[500, 500, 500, 500]')", "Action: finished(content='ok')"])
        let result = TarsAgent(screen: FakeScreen(), model: model, options: options(store)).run("点中间")
        #expect(result.outcome == .done && store.procedures.isEmpty)
        #expect(result.learned?.contains("no control names") == true)
    }

    @Test func aClickBySightIsKeptWithTheControlUnderIt() {
        let store = MemoryStore()
        let screen = calculator()
        // 0.0859 of 1280 points is x 2030, inside "7" (2000 to 2100); y 0.15 of 800 is 120.
        let model = ScriptedModel(["Thought: 按 7\nAction: click(start_box='[86, 150, 86, 150]')", "Action: finished(content='ok')"])
        _ = TarsAgent(screen: screen, model: model, options: options(store)).run("按 7")
        let step = store.procedures[0].steps[0]
        #expect(step.target?.label == "7" && abs((step.offsetX ?? 0) - 0.3) < 0.02 && abs((step.offsetY ?? 0) - 0.5) < 0.02)

        let again = calculator()
        again.fields = again.fields.map { $0.label == "7" ? button(1, "7", x: 2500, y: 500) : $0 }
        again.afterAction = nil
        _ = TarsAgent(screen: again, model: ScriptedModel(["Action: finished(content='ok')"]), options: options(store)).run("按 7")
        // The same spot in the button, where the button now is.
        #expect(again.performed.first?.index == nil && abs((again.performed.first?.x ?? 0) - 2530) < 2 && again.performed.first?.y == 520)
    }

    @Test func slotsCarryANewInstructionThroughTheSameSteps() {
        let store = MemoryStore()
        func chat() -> FakeScreen {
            let screen = FakeScreen()
            screen.fields = [button(1, "陈一 前端", x: 1950), button(2, "李四 后端", x: 1950, y: 200),
                             AXElementInfo(index: 3, role: "AXTextArea", label: "消息", value: "", frame: CGRect(x: 2200, y: 600, width: 800, height: 100)),
                             button(4, "发送", x: 3000, y: 700), button(5, "表情", x: 2200, y: 720), button(6, "简历", x: 2400, y: 720)]
            screen.afterAction = { screen in
                guard let typed = screen.performed.last, typed.kind == .type else { return }
                screen.fields[2] = AXElementInfo(index: 3, role: "AXTextArea", label: "消息", value: typed.value, frame: CGRect(x: 2200, y: 600, width: 800, height: 100))
            }
            return screen
        }
        let model = ScriptedModel([
            "Thought: 打开陈一\nAction: click(element='1')",
            "Thought: 写草稿\nAction: type(content='你好，还在招', element='3')",
            "Thought: 点击发送按钮。\nAction: click(element='4')",
        ])
        let first = TarsAgent(screen: chat(), model: model, options: options(store)).run("给陈一写：你好，还在招")
        #expect(first.reason.contains("sending") && first.learned == "saved")
        #expect(store.procedures[0].template == "给⟦0⟧写：⟦1⟧" && store.procedures[0].finish == .steps)

        let screen = chat()
        let silent = ScriptedModel([])
        let second = TarsAgent(screen: screen, model: silent, options: options(store)).run("给李四写：方便发份简历吗")
        #expect(second.outcome == .done && second.modelCalls == 0 && silent.seen.isEmpty)
        #expect(screen.performed.map(\.index) == [2, 3] && screen.performed[1].value == "方便发份简历吗")
        // It stopped where the learned run did: before Send, which it offers
        // for a person to confirm, as the model's run did.
        #expect(second.reason.contains("sending"))
        #expect(first.held?.kind == .click && second.held?.index == 4 && second.held?.x == 3050)
        #expect(store.procedures[0].held?.target?.label == "发送" && store.procedures[0].steps.count == 2)

        // Someone the list does not show: the model takes over rather than guess.
        let third = TarsAgent(screen: chat(), model: ScriptedModel(["Action: call_user()"]), options: options(store)).run("给赵六写：在吗")
        #expect(third.outcome == .user && third.replayed == 0)
    }

    @Test func textThatDidNotLandHandsOver() {
        let store = MemoryStore()
        let field = AXElementInfo(index: 3, role: "AXTextArea", label: "消息", value: "", frame: CGRect(x: 2200, y: 600, width: 800, height: 100))
        let others = [button(4, "表情", x: 2200, y: 720), button(5, "简历", x: 2400, y: 720), button(6, "更多", x: 2600, y: 720)]
        let learning = FakeScreen()
        learning.fields = [field] + others
        learning.afterAction = { $0.fields[0] = AXElementInfo(index: 3, role: "AXTextArea", label: "消息", value: "在吗", frame: CGRect(x: 2200, y: 600, width: 800, height: 100)) }
        _ = TarsAgent(screen: learning, model: ScriptedModel(["Action: type(content='在吗', element='3')", "Action: finished()"]),
                      options: options(store)).run("写在吗")
        #expect(store.procedures.count == 1)

        // This time the app drops the text.
        let deaf = FakeScreen()
        deaf.fields = [field] + others
        let model = ScriptedModel(["Action: call_user()"])
        let result = TarsAgent(screen: deaf, model: model, options: options(store)).run("写在吗")
        #expect(result.outcome == .user && model.seen.count == 1)
        #expect(model.seen[0].contains { if case .user(let text) = $0 { text.contains("did not land") } else { false } })
    }

    @Test func aRunLearnedWithoutSendingDoesNotServeOneThatSends() {
        let store = MemoryStore()
        _ = TarsAgent(screen: calculator(), model: ScriptedModel(script), options: options(store)).run("算 7 加 8")
        var sending = options(store)
        sending.allowSubmit = true
        let model = ScriptedModel(["Action: finished(content='x')"])
        let result = TarsAgent(screen: calculator(), model: model, options: sending).run("算 7 加 8")
        #expect(result.replayed == 0 && model.seen.count >= 1)
    }

    @Test func proceduresSurviveTheFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("2ndscreen-procedures-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FileProcedureStore(directory: directory)
        _ = TarsAgent(screen: calculator(), model: ScriptedModel(script), options: options(store)).run("算 7 加 8")
        let loaded = store.load(app: "test")
        #expect(loaded.count == 1 && loaded[0].steps.count == 3 && loaded[0].answerFrom?.role == "AXStaticText")
        #expect(store.file(app: "com.zhipin.www/x").lastPathComponent == "com.zhipin.www_x.json")
    }
}
