import CoreGraphics
import Foundation
import SecondScreenCore

/// A mouse wheel posted to one app in the background, for Electron and
/// Chromium windows, where cua-driver refuses to scroll without taking the
/// foreground. Chromium routes a posted wheel by the window-local point
/// stamped on it, so the event carries that point and the window's number,
/// and a mouse move to the point goes first so the page hit-tests there.
/// It goes through SkyLight's per-process post, as cua-driver's clicks do,
/// and the public one. The real pointer and the frontmost app are untouched.
enum BackgroundWheel {
    private typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
    private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    private typealias SetIntegerField = @convention(c) (CGEvent, UInt32, Int64) -> Void

    private struct SkyLight {
        let post: PostToPid
        let setWindowLocation: SetWindowLocation
        let setIntegerField: SetIntegerField
    }

    private static let skyLight: SkyLight? = {
        _ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
        let any = UnsafeMutableRawPointer(bitPattern: -2)  // RTLD_DEFAULT
        guard let post = dlsym(any, "SLEventPostToPid"),
              let location = dlsym(any, "CGEventSetWindowLocation"),
              let field = dlsym(any, "SLEventSetIntegerValueField")
        else { return nil }
        return SkyLight(post: unsafeBitCast(post, to: PostToPid.self),
                        setWindowLocation: unsafeBitCast(location, to: SetWindowLocation.self),
                        setIntegerField: unsafeBitCast(field, to: SetIntegerField.self))
    }()

    /// Scroll `notches` lines in `direction` at `point`, a global point in
    /// `window`, which belongs to `pid`.
    static func scroll(pid: pid_t, window: WindowInfo, at point: CGPoint, direction: String, notches: Int) throws {
        guard let skyLight else { throw DriverError("this macOS has no SkyLight event posting") }
        let local = CGPoint(x: point.x - window.frame.minX, y: point.y - window.frame.minY)
        let source = CGEventSource(stateID: .hidSystemState)

        func send(_ event: CGEvent) {
            event.location = point
            skyLight.setWindowLocation(event, local)
            // Fields 51, 91 and 92 name the window the event is for and the
            // window under it; 40 is the target pid Chromium checks.
            for field: UInt32 in [51, 91, 92] { skyLight.setIntegerField(event, field, Int64(window.windowID)) }
            skyLight.setIntegerField(event, 40, Int64(pid))
            skyLight.post(pid, event)
            event.postToPid(pid)
        }

        if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                              mouseCursorPosition: point, mouseButton: .left) {
            send(move)
        }
        Thread.sleep(forTimeInterval: 0.15)

        // Posted this way, a positive delta scrolls down or right, the
        // reverse of a wheel through the HID system.
        let sign: Int32 = ["down", "right"].contains(direction) ? 1 : -1
        let vertical = ["up", "down"].contains(direction)
        for _ in 0..<max(notches, 1) {
            guard let wheel = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
                                      wheel1: vertical ? sign : 0, wheel2: vertical ? 0 : sign, wheel3: 0)
            else { continue }
            send(wheel)
            Thread.sleep(forTimeInterval: 0.03)
        }
    }
}
