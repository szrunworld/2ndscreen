import CoreGraphics
import Foundation
import Testing
@testable import SecondScreenCore

/// The explicit accessibility press: its own wire kind, only an index, only
/// AXPress. Synthetic elements and closures only; nothing reaches a window.
struct AccessibilityPressTests {
    /// `InputAction` as it was before `accessibilityPress`, as an older app decodes it.
    private struct OldInputAction: Decodable {
        enum Kind: String, Decodable { case click, type, key, scroll, drag }
        var kind: Kind
        var index: Int?
    }

    private func press(_ index: Int?) -> InputAction {
        var action = InputAction(.accessibilityPress)
        action.index = index
        return action
    }

    private func element(_ actions: [String]?) -> AXElementInfo {
        AXElementInfo(index: 7, role: "AXGroup", actions: actions,
                      frame: Frame(CGRect(x: 2336, y: 56, width: 12, height: 12)))
    }

    @Test func encodesAsItsOwnKindThatAnOlderDecoderRefuses() throws {
        let data = try JSONEncoder().encode(press(7))
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["kind"] as? String == "accessibilityPress")
        #expect(object["button"] == nil && object["x"] == nil, "no click options ride along")
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(OldInputAction.self, from: data) }
        // A whole request carrying it fails to decode on the old side too, before any input.
        var request = ControlRequest(command: .input)
        request.input = press(7)
        let line = try JSONEncoder().encode(request)
        struct OldRequest: Decodable { var input: OldInputAction? }
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(OldRequest.self, from: line) }
        // An ordinary click still decodes on both sides.
        var click = InputAction(.click)
        click.index = 7
        let old = try JSONDecoder().decode(OldInputAction.self, from: try JSONEncoder().encode(click))
        #expect(old.kind == .click)
        #expect(try JSONDecoder().decode(InputAction.self, from: data).kind == .accessibilityPress)
    }

    @Test func takesOnlyAnIndex() throws {
        try InputEngine.checkAccessibilityPress(press(7))
        #expect(throws: AccessibilityError.self) { try InputEngine.checkAccessibilityPress(press(nil)) }
        #expect(throws: AccessibilityError.self) { try InputEngine.checkAccessibilityPress(press(-1)) }
        var variants: [(String, (inout InputAction) -> Void)] = []
        variants.append(("text", { $0.text = "全部职位" }))
        variants.append(("point", { $0.x = 2336; $0.y = 56 }))
        variants.append(("right", { $0.button = "right" }))
        variants.append(("double", { $0.count = 2 }))
        variants.append(("single count", { $0.count = 1 }))
        variants.append(("modifiers", { $0.modifiers = ["cmd"] }))
        variants.append(("empty modifiers", { $0.modifiers = [] }))
        variants.append(("key", { $0.key = "return" }))
        variants.append(("value", { $0.value = "x" }))
        variants.append(("foreground", { $0.foreground = true }))
        for (name, change) in variants {
            var action = press(7)
            change(&action)
            #expect(throws: AccessibilityError.self, "\(name) is refused") { try InputEngine.checkAccessibilityPress(action) }
        }
        var click = InputAction(.click)
        click.index = 7
        #expect(throws: AccessibilityError.self, "a click is not an explicit press") { try InputEngine.checkAccessibilityPress(click) }
    }

    @Test func pressesOnlyAnElementThatAdvertisesAXPressAndNeverFallsBack() throws {
        var calls = 0
        #expect(throws: AccessibilityError.self) {
            try InputEngine.pressExplicitly(element(["AXShowMenu"])) { calls += 1; return true }
        }
        #expect(throws: AccessibilityError.self) {
            try InputEngine.pressExplicitly(element(nil)) { calls += 1; return true }
        }
        #expect(calls == 0, "an element without AXPress is never pressed")
        #expect(throws: AccessibilityError.self) {
            try InputEngine.pressExplicitly(element(["AXPress"])) { calls += 1; return false }
        }
        #expect(calls == 1, "a failed press is reported once, not retried another way")
        let route = try InputEngine.pressExplicitly(element(["AXShowMenu", "AXPress"])) { calls += 1; return true }
        #expect(route == "ax.press.explicit")
        #expect(route != "ax.press", "distinct from a default click's press")
        #expect(calls == 2)
    }

    @Test func refusesBeforeTouchingTheWindowWithoutAStateOrWithExtraOptions() throws {
        let engine = InputEngine()
        // A window id no state was taken of: nothing cached, so nothing to press.
        let window = WindowInfo(pid: 999_999, windowID: 999_999, appName: "Synthetic", title: "",
                                frame: CGRect(x: 1920, y: 25, width: 1440, height: 875))
        let screen = ScreenInfo(name: "agent", kind: .agent, displayID: 0, width: 1440, height: 900, hiDPI: true,
                                frame: Frame(CGRect(x: 1920, y: 0, width: 1440, height: 900)))
        #expect(throws: AccessibilityError.self) { try engine.perform(press(7), in: window, on: screen) }
        var pointed = press(7)
        pointed.x = 2336
        pointed.y = 56
        #expect(throws: AccessibilityError.self) { try engine.perform(pointed, in: window, on: screen) }
    }
}
