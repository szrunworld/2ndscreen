import CoreGraphics
import Foundation
import SecondScreenCore

// The screens an agent works on, through the 2ndscreen app's socket: the
// command line and the app's own UI-TARS panel use the same ones.

/// The agent's view of one app on one screen, through the app's socket.
public struct ControlScreen: AgentScreen {
    public let screen: String
    public let pid: Int32
    public let windowID: UInt32?

    public init(screen: String, pid: Int32, windowID: UInt32?) {
        self.screen = screen
        self.pid = pid
        self.windowID = windowID
    }

    public func frame() throws -> CGRect {
        var request = ControlRequest(command: .screenList)
        request.screen = screen
        let response = try sendControlRequest(request)
        guard let info = response.screens?.first(where: { $0.name == screen }) else {
            throw AgentError("no screen named \"\(screen)\"")
        }
        // Displays rearrange as screens come and go; make sure the app is
        // still on this one, or the model would act on a screen without it.
        let frame = CGRect(info.frame)
        let windows = WindowMover.windows(ofPID: pid).filter { windowID == nil || $0.windowID == windowID }
        guard windows.contains(where: { frame.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }) else {
            throw AgentError("pid \(pid) has no window on screen \"\(screen)\" any more")
        }
        return frame
    }

    public func screenshot(size: CGSize) throws -> Data {
        let scratch = NSTemporaryDirectory() + "2ndscreen-agent-\(getpid()).png"
        defer { try? FileManager.default.removeItem(atPath: scratch) }
        var request = ControlRequest(command: .screenshot)
        request.screen = screen
        request.output = scratch
        request.windowsOnly = true
        let response = try sendControlRequest(request)
        guard response.ok else { throw AgentError(response.error ?? "screenshot failed") }
        return try Images.png(Images.scaled(Images.load(scratch), to: size))
    }

    public func perform(_ action: InputAction) throws -> ControlResponse {
        var request = ControlRequest(command: .input)
        request.screen = screen
        request.pid = pid
        request.windowID = windowID
        request.input = action
        return try sendControlRequest(request)
    }

    public func menuOpen() -> Bool {
        BackgroundInput.hasOpenMenu(pid: pid)
    }

    public func elements() throws -> [AXElementInfo] {
        var request = ControlRequest(command: .windowState)
        request.screen = screen
        request.pid = pid
        request.windowID = windowID
        let response = try sendControlRequest(request)
        guard response.ok else { throw AgentError(response.error ?? "state failed") }
        return response.elements ?? []
    }
}

/// The agent's view of an Android phone: screenshots and actions go through
/// the app's `android.*` commands, which reach the phone over adb and
/// scrcpy's control channel. Nothing moves the user's pointer or takes their
/// focus, and it works on apps such as WeChat that ignore background input
/// on a Mac.
///
/// Points are device pixels, the space of the phone's screenshots and taps.
public final class AndroidAgentScreen: AgentScreen {
    /// The longest side of the screenshot the model sees. Boxes are
    /// normalised, so this only trades detail for upload size and speed.
    static let modelLongSide: CGFloat = 1400

    public let serial: String?
    /// The screenshot taken by `frame()`, which `screenshot(size:)` hands on.
    private var latest: CGImage?

    public init(serial: String?) {
        self.serial = serial
    }

    public func frame() throws -> CGRect {
        let scratch = NSTemporaryDirectory() + "2ndscreen-android-agent-\(getpid()).png"
        defer { try? FileManager.default.removeItem(atPath: scratch) }
        var request = ControlRequest(command: .androidScreenshot)
        request.serial = serial
        request.output = scratch
        let response = try sendControlRequest(request)
        guard response.ok else { throw AgentError(response.error ?? "screenshot failed") }
        let image = try Images.load(scratch)
        latest = image
        return CGRect(x: 0, y: 0, width: image.width, height: image.height)
    }

    public func screenshot(size: CGSize) throws -> Data {
        guard let image = latest else { throw AgentError("no screenshot taken") }
        let scale = min(1, Self.modelLongSide / max(size.width, size.height))
        return try Images.png(Images.scaled(image, to: CGSize(width: (size.width * scale).rounded(),
                                                               height: (size.height * scale).rounded())))
    }

    public func perform(_ action: InputAction) throws -> ControlResponse {
        let size = latest.map { CGSize(width: $0.width, height: $0.height) } ?? .zero
        let commands: [[String]]
        do {
            commands = try AndroidPlan.commands(for: action, size: size)
        } catch {
            return .failure(error.localizedDescription)
        }
        var response = ControlResponse()
        for (index, words) in commands.enumerated() {
            if index > 0 { Thread.sleep(forTimeInterval: 0.08) }
            response = try sendControlRequest(try AndroidPlan.request(words, serial: serial))
            guard response.ok else { return response }
        }
        // Let the phone draw the result before the next screenshot.
        Thread.sleep(forTimeInterval: 0.6)
        return response
    }

    /// Phones offer no accessibility list the agent can use: WeChat hides its
    /// controls from uiautomator. The model goes by the screenshot.
    public func elements() throws -> [AXElementInfo] { [] }
}
