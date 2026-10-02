import CoreGraphics
import Foundation

/// A request to show the agent cursor at a point, sent from any process to
/// the menu bar app through the distributed notification center.
///
/// The cursor is purely visual: it shows where an agent acts so a person can
/// follow along in the preview. It never moves or clicks the real pointer.
public struct AgentCursorEvent {
    public enum Action: String {
        /// Glide to the point and rest there.
        case move
        /// Glide to the point and play a click ripple.
        case click
        /// Fade the cursor out.
        case hide
    }

    public static let notificationName = Notification.Name("io.github.szrunworld.2ndscreen.agent-cursor")

    public let action: Action
    /// Global point in CoreGraphics coordinates (top-left origin), the same
    /// space cua-driver reports element frames in.
    public let point: CGPoint

    public init(action: Action, point: CGPoint = .zero) {
        self.action = action
        self.point = point
    }

    public init?(userInfo: [AnyHashable: Any]?) {
        guard let raw = userInfo?["action"] as? String, let action = Action(rawValue: raw) else {
            return nil
        }
        let x = userInfo?["x"] as? Double ?? 0
        let y = userInfo?["y"] as? Double ?? 0
        self.init(action: action, point: CGPoint(x: x, y: y))
    }

    public var userInfo: [String: Any] {
        ["action": action.rawValue, "x": Double(point.x), "y": Double(point.y)]
    }

    public func post() {
        DistributedNotificationCenter.default().postNotificationName(
            Self.notificationName, object: nil, userInfo: userInfo, deliverImmediately: true)
    }
}
