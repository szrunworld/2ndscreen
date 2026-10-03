import AppKit
import CoreGraphics
import Foundation
import SecondScreenCore
import TarsAgent
import Vision

/// The agent's view of an iPhone through iPhone Mirroring on an agent
/// screen. What was found running it by hand:
///
/// - Background clicks reach the phone, and so do plain keys (Delete,
///   Return) and ⌘1 / ⌘2, which 2ndscreen sends with the app made front for
///   the instant the key is queued.
/// - Nothing scrolls or swipes: wheel events, trackpad phases and drags,
///   in the background or with the real pointer and the app in front, are
///   all ignored. So the model is offered no scroll, drag or long press.
/// - Typed text reaches the phone's keyboard as key codes, so a Chinese
///   keyboard turns every character into "a". Text is pasted instead, with
///   iPhone Mirroring in front for about a second, once the user has left
///   the keyboard and mouse alone for a few seconds; their clipboard and
///   frontmost app are put back after.
/// - Without the phone the window shows a status page ("iPhone in Use",
///   "Connection Paused") or a Connect / Try Again / Resume button.
///
/// Points are global; the screenshot is the mirroring window alone.
final class IPhoneAgentScreen: AgentScreen {
    static let bundleID = "com.apple.ScreenContinuity"

    let screen: String
    /// Seconds without keyboard or mouse input before pasting may take the
    /// foreground, and how long to wait for that.
    var idleNeeded: TimeInterval = 3
    var idleWaitMax: TimeInterval = 120

    private var screenFrame: CGRect = .zero
    private var windowFrame: CGRect = .zero

    init(screen: String) {
        self.screen = screen
    }

    static func pid() throws -> pid_t {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
            throw CommandError("iPhone Mirroring is not running; run `2ndscreen iphone setup`")
        }
        return app.processIdentifier
    }

    func frame() throws -> CGRect {
        var request = ControlRequest(command: .screenList)
        request.screen = screen
        let response = try sendControlRequest(request)
        guard let info = response.screens?.first(where: { $0.name == screen }) else {
            throw CommandError("no screen named \"\(screen)\"; run `2ndscreen iphone setup`")
        }
        screenFrame = CGRect(info.frame)
        let pid = try Self.pid()
        guard let window = WindowMover.windows(ofPID: pid)
            .filter({ screenFrame.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) })
            .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        else {
            throw CommandError("iPhone Mirroring has no window on screen \"\(screen)\"; run `2ndscreen iphone setup`")
        }
        try Self.reconnectIfAsked(pid: pid)
        windowFrame = window.frame
        return window.frame
    }

    func screenshot(size: CGSize) throws -> Data {
        let scratch = NSTemporaryDirectory() + "2ndscreen-iphone-agent-\(getpid()).png"
        let cropped = scratch + ".window.png"
        defer {
            try? FileManager.default.removeItem(atPath: scratch)
            try? FileManager.default.removeItem(atPath: cropped)
        }
        var request = ControlRequest(command: .screenshot)
        request.screen = screen
        request.output = scratch
        request.windowsOnly = true
        let response = try sendControlRequest(request)
        guard response.ok else { throw CommandError(response.error ?? "screenshot failed") }
        try Images.crop(scratch, to: cropped, frame: Frame(windowFrame), screenFrame: Frame(screenFrame))
        let image = try Images.load(cropped)
        if let status = Self.statusPage(in: image) {
            throw CommandError("iPhone Mirroring shows \"\(status)\": lock the phone and leave it near the Mac")
        }
        return try Images.png(Images.scaled(image, to: size))
    }

    func perform(_ action: InputAction) throws -> ControlResponse {
        let pid = try Self.pid()
        switch action.kind {
        case .scroll, .drag:
            return .failure("iPhone Mirroring ignores swipes and scrolling from the Mac; "
                + "use what is on screen, Home Screen, or search")
        case .click where action.durationMs != nil:
            return .failure("a long press is not possible through iPhone Mirroring")
        case .key where action.key == "home":
            return try send(key("1", ["cmd"]), pid: pid)
        case .key where action.key == "back":
            return .failure("an iPhone has no Back key; tap the app's own back button")
        case .type:
            guard var text = action.value, !text.isEmpty else { return ControlResponse() }
            let submit = text.hasSuffix("\n")
            if submit { text.removeLast() }
            if !text.isEmpty {
                if let failure = paste(text, pid: pid) { return .failure(failure) }
            }
            if submit { return try send(key("return", []), pid: pid) }
            Thread.sleep(forTimeInterval: 0.4)
            return ControlResponse()
        default:
            return try send(action, pid: pid)
        }
    }

    /// Mirroring lists nothing through accessibility; the model goes by the
    /// screenshot.
    func elements() throws -> [AXElementInfo] { [] }

    // MARK: Helpers

    private func key(_ name: String, _ modifiers: [String]) -> InputAction {
        var action = InputAction(.key)
        action.key = name
        action.modifiers = modifiers
        return action
    }

    private func send(_ action: InputAction, pid: pid_t) throws -> ControlResponse {
        var request = ControlRequest(command: .input)
        request.screen = screen
        request.pid = pid
        request.input = action
        let response = try sendControlRequest(request)
        // Let the phone draw the result before the next screenshot.
        Thread.sleep(forTimeInterval: 0.6)
        return response
    }

    /// Paste `text` into the phone's focused field. Returns why not, if not.
    private func paste(_ text: String, pid: pid_t) -> String? {
        let deadline = Date().addingTimeInterval(idleWaitMax)
        while Self.idleSeconds() < idleNeeded {
            if Date() > deadline { return "the user kept using the Mac; nothing pasted" }
            Thread.sleep(forTimeInterval: 0.3)
        }
        let pasteboard = NSPasteboard.general
        let backup = pasteboard.string(forType: .string)
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        let ours = pasteboard.changeCount
        let previous = NSWorkspace.shared.frontmostApplication
        defer {
            if let previous, previous.processIdentifier != pid { previous.activate() }
            // The phone fetches the clipboard after the paste; then put the
            // user's back, unless they copied something meanwhile.
            Thread.sleep(forTimeInterval: 2.5)
            if pasteboard.changeCount == ours {
                pasteboard.clearContents()
                if let backup { pasteboard.setString(backup, forType: .string) }
            }
        }
        guard let mirroring = NSRunningApplication(processIdentifier: pid) else { return "iPhone Mirroring quit" }
        mirroring.activate()
        for _ in 0..<20 where NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
            Thread.sleep(forTimeInterval: 0.1)
        }
        Thread.sleep(forTimeInterval: 0.4)
        // Only ever into iPhone Mirroring: if it is not in front, nothing.
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            return "iPhone Mirroring did not come to the front; nothing pasted"
        }
        // ⌘V through the HID path: iPhone Mirroring takes a paste only from
        // a real-looking key while it is front.
        let source = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: down) else { continue }
            event.flags = .maskCommand
            event.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.02)
        }
        Thread.sleep(forTimeInterval: 0.5)
        return nil
    }

    static func idleSeconds() -> TimeInterval {
        CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
    }

    /// Press Connect, Try Again or Resume when the window offers one, and
    /// say so: the phone needs a moment to come back.
    static func reconnectIfAsked(pid: pid_t) throws {
        let app = AXUIElementCreateApplication(pid)
        var windows: AnyObject?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows) == .success,
              let list = windows as? [AXUIElement] else { return }
        for window in list {
            for button in buttons(in: window) {
                var title: AnyObject?
                AXUIElementCopyAttributeValue(button, kAXTitleAttribute as CFString, &title)
                if let title = title as? String, ["Connect", "Try Again", "Resume"].contains(title) {
                    AXUIElementPerformAction(button, kAXPressAction as CFString)
                    throw CommandError("iPhone Mirroring was disconnected; asked it to reconnect (\(title)). "
                        + "Lock the phone and try again shortly")
                }
            }
        }
    }

    private static func buttons(in element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
        guard depth < 8 else { return [] }
        var children: AnyObject?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
              let list = children as? [AXUIElement] else { return [] }
        return list.flatMap { child -> [AXUIElement] in
            var role: AnyObject?
            AXUIElementCopyAttributeValue(child, kAXRoleAttribute as CFString, &role)
            return (role as? String) == kAXButtonRole ? [child] : buttons(in: child, depth: depth + 1)
        }
    }

    static let statusPages = ["iPhone in Use", "Connection Paused", "iPhone Not Found", "Unable to Connect"]

    /// The title of a status page iPhone Mirroring shows without the phone.
    static func statusPage(in image: CGImage) -> String? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        // The message sits in the middle third of the window.
        request.regionOfInterest = CGRect(x: 0, y: 0.33, width: 1, height: 0.34)
        try? VNImageRequestHandler(cgImage: image).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        return statusPages.first { text.contains($0) }
    }
}

/// `2ndscreen iphone setup`: an agent screen with iPhone Mirroring on it,
/// kept sized to its window (it turns landscape with the phone's videos).
enum IPhoneCommands {
    static func run(_ args: Arguments) -> Never {
        guard args.positional.dropFirst().first == "setup" else {
            fail("usage: 2ndscreen iphone setup [--screen NAME]")
        }
        let name = args.value("--screen") ?? "phone"
        do {
            let list = try sendControlRequest(ControlRequest(command: .screenList))
            if !(list.screens ?? []).contains(where: { $0.name == name }) {
                var create = ControlRequest(command: .screenCreate)
                create.screen = name
                // Holds iPhone Mirroring's largest window and its menu bar
                // at HiDPI; --fit-screen then follows the window.
                create.width = 525
                create.height = 1001
                create.hiDPI = true
                create.idleTimeout = 0
                let created = try sendControlRequest(create)
                guard created.ok else { fail(created.error ?? "screen create failed") }
            }
            var place: ControlRequest
            if let pid = try? IPhoneAgentScreen.pid() {
                place = ControlRequest(command: .windowMove)
                place.pid = pid
            } else {
                place = ControlRequest(command: .appLaunch)
                place.bundleID = IPhoneAgentScreen.bundleID
            }
            place.screen = name
            place.fitScreen = true
            let response = try sendControlRequest(place)
            var output: [String: Any] = ["ok": response.ok, "screen": name]
            if let error = response.error { output["error"] = error }
            DriverCommands.emit(output)
            exit(response.ok ? 0 : 1)
        } catch {
            fail(error.localizedDescription)
        }
    }
}
