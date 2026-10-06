import AppKit
import QuartzCore
import SecondScreenCore

/// Draws the agent cursor in a transparent, click-through window that covers
/// the virtual display.
///
/// The window can be captured, so the cursor shows up in the preview and in
/// screenshots of the virtual display. It ignores mouse events, so it never
/// blocks clicks on the apps beneath it.
@MainActor
public final class AgentCursorOverlay {
    private let displayID: CGDirectDisplayID
    private let window: NSWindow
    private let cursor = CAShapeLayer()
    private var hideWorkItem: DispatchWorkItem?

    private static let glideDuration: CFTimeInterval = 0.35
    private static let idleHideDelay: TimeInterval = 4

    public init(displayID: CGDirectDisplayID) {
        self.displayID = displayID
        window = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        // Above normal app windows on that display, below system alerts.
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        window.isReleasedWhenClosed = false

        let view = NSView()
        view.wantsLayer = true
        window.contentView = view

        cursor.path = Self.arrowPath()
        cursor.fillColor = NSColor.systemPink.cgColor
        cursor.strokeColor = NSColor.white.cgColor
        cursor.lineWidth = 1.5
        cursor.shadowColor = NSColor.black.cgColor
        cursor.shadowOpacity = 0.35
        cursor.shadowRadius = 2
        cursor.shadowOffset = CGSize(width: 0, height: -1)
        cursor.opacity = 0
        view.layer?.addSublayer(cursor)

        fitToDisplay()
        window.orderFrontRegardless()
    }

    public func close() {
        hideWorkItem?.cancel()
        window.close()
    }

    public func handle(_ event: AgentCursorEvent) {
        fitToDisplay()
        switch event.action {
        case .hide:
            fade(to: 0)
        case .move:
            glide(to: event.point)
        case .click:
            glide(to: event.point)
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.glideDuration) { [weak self] in
                self?.ripple(at: event.point)
            }
        }
    }

    // MARK: Drawing

    /// Keep the overlay matched to the display, which moves or resizes when
    /// the user rearranges displays or picks another resolution.
    private func fitToDisplay() {
        guard let screen = NSScreen.screens.first(where: { $0.displayID == displayID }) else { return }
        if window.frame != screen.frame {
            window.setFrame(screen.frame, display: true)
        }
    }

    /// Converts a global CG point (top-left origin) into the overlay view's
    /// coordinates (bottom-left origin), or nil if it is off this display.
    private func localPoint(_ point: CGPoint) -> CGPoint? {
        let bounds = CGDisplayBounds(displayID)
        guard bounds.contains(point) else { return nil }
        return CGPoint(x: point.x - bounds.minX, y: bounds.maxY - point.y)
    }

    private func glide(to point: CGPoint) {
        guard let target = localPoint(point) else { return }
        if cursor.opacity == 0 {
            // First appearance: start where the click lands, no glide.
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            cursor.position = target
            CATransaction.commit()
        } else {
            let glide = CABasicAnimation(keyPath: "position")
            glide.fromValue = cursor.presentation()?.position ?? cursor.position
            glide.toValue = target
            glide.duration = Self.glideDuration
            glide.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            cursor.add(glide, forKey: "glide")
            cursor.position = target
        }
        fade(to: 1)
        scheduleHide()
    }

    private func ripple(at point: CGPoint) {
        guard let center = localPoint(point), let host = window.contentView?.layer else { return }
        let ring = CAShapeLayer()
        ring.path = CGPath(ellipseIn: CGRect(x: -14, y: -14, width: 28, height: 28), transform: nil)
        ring.position = center
        ring.fillColor = NSColor.systemPink.withAlphaComponent(0.25).cgColor
        ring.strokeColor = NSColor.systemPink.cgColor
        ring.lineWidth = 2
        host.insertSublayer(ring, below: cursor)

        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.3
        grow.toValue = 1.8
        let fadeOut = CABasicAnimation(keyPath: "opacity")
        fadeOut.fromValue = 1
        fadeOut.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fadeOut]
        group.duration = 0.5
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ring.opacity = 0
        ring.add(group, forKey: "ripple")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { ring.removeFromSuperlayer() }
    }

    private func fade(to opacity: Float) {
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = cursor.presentation()?.opacity ?? cursor.opacity
        fade.toValue = opacity
        fade.duration = 0.2
        cursor.add(fade, forKey: "fade")
        cursor.opacity = opacity
    }

    private func scheduleHide() {
        hideWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.fade(to: 0) }
        hideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.idleHideDelay, execute: work)
    }

    /// A classic arrow pointer with its tip at the layer origin.
    private static func arrowPath() -> CGPath {
        let path = CGMutablePath()
        // View coordinates are y-up, so the arrow body extends downward (-y).
        path.move(to: CGPoint(x: 0, y: 0))
        path.addLine(to: CGPoint(x: 0, y: -22))
        path.addLine(to: CGPoint(x: 6, y: -16.5))
        path.addLine(to: CGPoint(x: 10, y: -25))
        path.addLine(to: CGPoint(x: 13.5, y: -23.5))
        path.addLine(to: CGPoint(x: 9.5, y: -15))
        path.addLine(to: CGPoint(x: 17, y: -15))
        path.closeSubpath()
        return path
    }
}
