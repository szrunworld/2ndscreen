import CoreGraphics
import Foundation
import SecondScreenCore
import TarsAgent

/// The agent's view of an Android phone: screenshots and actions go through
/// the app's `android.*` commands, which reach the phone over adb and
/// scrcpy's control channel. Nothing moves the user's pointer or takes their
/// focus, and it works on apps such as WeChat that ignore background input
/// on a Mac.
///
/// Points are device pixels, the space of the phone's screenshots and taps.
final class AndroidAgentScreen: AgentScreen {
    /// The longest side of the screenshot the model sees. Boxes are
    /// normalised, so this only trades detail for upload size and speed.
    static let modelLongSide: CGFloat = 1400

    let serial: String?
    /// The screenshot taken by `frame()`, which `screenshot(size:)` hands on.
    private var latest: CGImage?

    init(serial: String?) {
        self.serial = serial
    }

    func frame() throws -> CGRect {
        let scratch = NSTemporaryDirectory() + "2ndscreen-android-agent-\(getpid()).png"
        defer { try? FileManager.default.removeItem(atPath: scratch) }
        var request = ControlRequest(command: .androidScreenshot)
        request.serial = serial
        request.output = scratch
        let response = try sendControlRequest(request)
        guard response.ok else { throw CommandError(response.error ?? "screenshot failed") }
        let image = try Images.load(scratch)
        latest = image
        return CGRect(x: 0, y: 0, width: image.width, height: image.height)
    }

    func screenshot(size: CGSize) throws -> Data {
        guard let image = latest else { throw CommandError("no screenshot taken") }
        let scale = min(1, Self.modelLongSide / max(size.width, size.height))
        return try Images.png(Images.scaled(image, to: CGSize(width: (size.width * scale).rounded(),
                                                               height: (size.height * scale).rounded())))
    }

    func perform(_ action: InputAction) throws -> ControlResponse {
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
            response = try sendControlRequest(AndroidCommands.request(words, serial: serial))
            guard response.ok else { return response }
        }
        // Let the phone draw the result before the next screenshot.
        Thread.sleep(forTimeInterval: 0.6)
        return response
    }

    /// Phones offer no accessibility list the agent can use: WeChat hides its
    /// controls from uiautomator. The model goes by the screenshot.
    func elements() throws -> [AXElementInfo] { [] }
}
