import AppKit
import AVFoundation
import SecondScreenCore

/// A window showing an Android device's screen. Clicks and drags become
/// touches, the scroll wheel scrolls, and typing goes to the focused field.
/// The title bar has Back, Home and Recents; right-click is also Back.
@MainActor
final class AndroidMirrorWindow: NSObject, NSWindowDelegate {
    let mirror: AndroidMirror
    private let window: NSWindow
    private let screenView: AndroidScreenView
    /// Where the window was placed with `place(on:)`, so rotation keeps it there.
    private var displayID: CGDirectDisplayID?

    /// Called when the window closes, by the user or because the phone went away.
    var onClose: (() -> Void)?

    var windowNumber: Int { window.windowNumber }

    init(mirror: AndroidMirror) {
        self.mirror = mirror
        screenView = AndroidScreenView(mirror: mirror)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        super.init()
        window.title = mirror.deviceName.isEmpty ? mirror.serial : mirror.deviceName
        window.isReleasedWhenClosed = false
        window.contentView = screenView
        window.delegate = self
        window.collectionBehavior = [.fullScreenPrimary]
        window.addTitlebarAccessoryViewController(navigationButtons())

        let renderer = screenView.displayLayer.sampleBufferRenderer
        mirror.onFrame = { sample in
            if renderer.status == .failed { renderer.flush() }
            renderer.enqueue(sample)
        }
        mirror.onVideoSize = { [weak self] size in self?.videoSizeChanged(size) }
        mirror.onEnd = { [weak self] reason in
            guard let self else { return }
            // An alert would take focus; on an agent screen just close.
            if let reason, self.displayID == nil {
                let alert = NSAlert()
                alert.messageText = "\(self.window.title) disconnected"
                alert.informativeText = reason
                NSApp.activate()
                alert.runModal()
            }
            self.window.close()
        }
        mirror.startStreaming()
    }

    enum Presentation {
        /// The user asked: full screen on a Space of its own, like iPhone
        /// Mirroring, and switch to it. A swipe goes back to their work.
        case fullScreen
        /// An agent asked: open behind the user's windows, without taking
        /// focus or switching Spaces.
        case background
    }

    func show(_ presentation: Presentation) {
        window.makeFirstResponder(screenView)
        if let displayID {
            // On an agent screen, whoever asked.
            place(on: displayID)
            window.orderFrontRegardless()
            return
        }
        switch presentation {
        case .background:
            if !window.isVisible {
                window.center()
                window.orderBack(nil)
            }
        case .fullScreen:
            if !window.isVisible { window.center() }
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
            if !window.styleMask.contains(.fullScreen) {
                // Entering full screen needs the window on screen first.
                DispatchQueue.main.async { [window] in window.toggleFullScreen(nil) }
            }
        }
    }

    /// Fit the window to a display, such as an agent screen, and keep it
    /// there when the phone rotates.
    func place(on displayID: CGDirectDisplayID) {
        self.displayID = displayID
        guard let screen = NSScreen.screens.first(where: { $0.displayID == displayID }) else { return }
        let visible = screen.visibleFrame
        let size = fittedContentSize(in: visible.insetBy(dx: 8, dy: 8))
        let frame = window.frameRect(forContentRect: NSRect(origin: .zero, size: size))
        window.setFrame(NSRect(x: visible.midX - frame.width / 2, y: visible.midY - frame.height / 2,
                               width: frame.width, height: frame.height), display: true)
    }

    var frameOnScreen: CGRect {
        // Global top-left coordinates, like every other frame agents see.
        let frame = window.frame
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return CGRect(x: frame.minX, y: primaryHeight - frame.maxY, width: frame.width, height: frame.height)
    }

    func close() {
        window.close()
    }

    /// The video may have rotated while full screen, where the window
    /// keeps the screen's shape; take the video's shape again.
    func windowDidExitFullScreen(_ notification: Notification) {
        videoSizeChanged(mirror.videoSize)
    }

    /// Keep the phone's shape.
    func windowWillResize(_ sender: NSWindow, to frameSize: NSSize) -> NSSize {
        let video = mirror.videoSize
        guard video.width > 0, video.height > 0, !window.styleMask.contains(.fullScreen) else { return frameSize }
        let content = window.contentRect(forFrameRect: NSRect(origin: .zero, size: frameSize)).size
        let width = max(160, content.width)
        let size = NSSize(width: width, height: (width * video.height / video.width).rounded())
        return window.frameRect(forContentRect: NSRect(origin: .zero, size: size)).size
    }

    func windowWillClose(_ notification: Notification) {
        mirror.onEnd = nil
        mirror.stop()
        onClose?()
        onClose = nil
    }

    private func videoSizeChanged(_ size: CGSize) {
        guard size.width > 0, size.height > 0, !window.styleMask.contains(.fullScreen) else { return }
        if let displayID {
            place(on: displayID)
            return
        }
        // Keep the longer side, so a rotated phone stays about as big.
        let screen = window.screen ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let current = window.contentLayoutRect.size
        let longSide = max(current.width, current.height)
        var target = size.width > size.height
            ? NSSize(width: longSide, height: longSide * size.height / size.width)
            : NSSize(width: longSide * size.width / size.height, height: longSide)
        if target.width > visible.width * 0.9 || target.height > visible.height * 0.9 {
            let fitted = fittedContentSize(in: visible.insetBy(dx: visible.width * 0.05, dy: visible.height * 0.05))
            target = fitted
        }
        let topLeft = NSPoint(x: window.frame.minX, y: window.frame.maxY)
        window.setContentSize(NSSize(width: target.width.rounded(), height: target.height.rounded()))
        window.setFrameTopLeftPoint(topLeft)
    }

    /// The content size that fits the phone in `area`.
    private func fittedContentSize(in area: NSRect) -> NSSize {
        let video = mirror.videoSize.width > 0 ? mirror.videoSize : CGSize(width: 9, height: 19.5)
        let titleBar = window.frame.height - window.contentLayoutRect.height
        let scale = min(area.width / video.width, (area.height - titleBar) / video.height)
        return NSSize(width: (video.width * scale).rounded(), height: (video.height * scale).rounded())
    }

    private func navigationButtons() -> NSTitlebarAccessoryViewController {
        func button(_ symbol: String, _ label: String, _ action: Selector) -> NSButton {
            let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)!
            let button = NSButton(image: image, target: self, action: action)
            button.bezelStyle = .accessoryBarAction
            button.isBordered = false
            button.toolTip = label
            return button
        }
        let stack = NSStackView(views: [
            button("chevron.backward", "Back", #selector(backPressed)),
            button("circle", "Home", #selector(homePressed)),
            button("square", "Recents", #selector(recentsPressed)),
        ])
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 8)
        stack.frame.size = stack.fittingSize
        let controller = NSTitlebarAccessoryViewController()
        controller.view = stack
        controller.layoutAttribute = .trailing
        return controller
    }

    @objc private func backPressed() { mirror.back() }
    @objc private func homePressed() { mirror.press(AndroidKey.home) }
    @objc private func recentsPressed() { mirror.press(AndroidKey.appSwitch) }
}

/// Draws the video and turns mouse and keyboard input into control messages.
/// Text goes through the input method, so Chinese and other IMEs work.
final class AndroidScreenView: NSView, NSTextInputClient {
    private let mirror: AndroidMirror
    let displayLayer = AVSampleBufferDisplayLayer()
    private var markedText = NSAttributedString()

    init(mirror: AndroidMirror) {
        self.mirror = mirror
        super.init(frame: NSRect(x: 0, y: 0, width: 360, height: 780))
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        displayLayer.videoGravity = .resizeAspect
        displayLayer.frame = bounds
        displayLayer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        layer?.addSublayer(displayLayer)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: Pointer

    /// The rectangle the video fills inside the view, letterboxed.
    private var videoRect: NSRect {
        let video = mirror.videoSize
        guard video.width > 0, video.height > 0 else { return bounds }
        let scale = min(bounds.width / video.width, bounds.height / video.height)
        let size = NSSize(width: video.width * scale, height: video.height * scale)
        return NSRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2,
                      width: size.width, height: size.height)
    }

    /// A point in the view as video pixels, top-left origin, clamped to the video.
    private func devicePoint(_ event: NSEvent) -> CGPoint {
        let point = convert(event.locationInWindow, from: nil)
        let rect = videoRect
        let video = mirror.videoSize
        let x = (point.x - rect.minX) / rect.width * video.width
        let y = (rect.maxY - point.y) / rect.height * video.height
        return CGPoint(x: max(0, min(video.width - 1, x)), y: max(0, min(video.height - 1, y)))
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        mirror.touch(.down, at: devicePoint(event))
    }

    override func mouseDragged(with event: NSEvent) {
        mirror.touch(.move, at: devicePoint(event))
    }

    override func mouseUp(with event: NSEvent) {
        mirror.touch(.up, at: devicePoint(event))
    }

    override func rightMouseDown(with event: NSEvent) {
        mirror.back()
    }

    override func scrollWheel(with event: NSEvent) {
        // Trackpads report points; a wheel notch is about ten of them.
        let scale = event.hasPreciseScrollingDeltas ? 0.1 : 1
        mirror.scroll(at: devicePoint(event),
                      horizontal: -event.scrollingDeltaX * scale, vertical: event.scrollingDeltaY * scale)
    }

    // MARK: Keyboard

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self, event.modifierFlags.contains(.command) else {
            return super.performKeyEquivalent(with: event)
        }
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "v":
            if let text = NSPasteboard.general.string(forType: .string) { mirror.paste(text) }
        case "w":
            window?.performClose(nil)
        case "b", "[":
            mirror.back()
        case "h":
            mirror.press(AndroidKey.home)
        case "s":
            mirror.press(AndroidKey.appSwitch)
        case "p":
            mirror.press(AndroidKey.power)
        case "\u{F700}":  // up arrow
            mirror.press(AndroidKey.volumeUp)
        case "\u{F701}":  // down arrow
            mirror.press(AndroidKey.volumeDown)
        default:
            return super.performKeyEquivalent(with: event)
        }
        return true
    }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.control) { return }
        interpretKeyEvents([event])
    }

    override func doCommand(by selector: Selector) {
        let keys: [Selector: UInt32] = [
            #selector(insertNewline(_:)): AndroidKey.enter,
            #selector(deleteBackward(_:)): AndroidKey.delete,
            #selector(deleteForward(_:)): AndroidKey.forwardDelete,
            #selector(insertTab(_:)): AndroidKey.tab,
            #selector(moveUp(_:)): AndroidKey.up,
            #selector(moveDown(_:)): AndroidKey.down,
            #selector(moveLeft(_:)): AndroidKey.left,
            #selector(moveRight(_:)): AndroidKey.right,
            #selector(scrollPageUp(_:)): AndroidKey.pageUp,
            #selector(scrollPageDown(_:)): AndroidKey.pageDown,
            #selector(scrollToBeginningOfDocument(_:)): AndroidKey.moveHome,
            #selector(scrollToEndOfDocument(_:)): AndroidKey.moveEnd,
        ]
        if selector == #selector(cancelOperation(_:)) {
            mirror.back()
        } else if let key = keys[selector] {
            mirror.press(key)
        }
    }

    func insertText(_ string: Any, replacementRange: NSRange) {
        markedText = NSAttributedString()
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        mirror.type(text)
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        markedText = (string as? NSAttributedString) ?? NSAttributedString(string: string as? String ?? "")
    }

    func unmarkText() { markedText = NSAttributedString() }
    func hasMarkedText() -> Bool { markedText.length > 0 }
    func markedRange() -> NSRange {
        hasMarkedText() ? NSRange(location: 0, length: markedText.length) : NSRange(location: NSNotFound, length: 0)
    }
    func selectedRange() -> NSRange { NSRange(location: markedText.length, length: 0) }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func characterIndex(for point: NSPoint) -> Int { NSNotFound }

    /// Where the input method puts its candidate window: the bottom of the video.
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        let rect = videoRect
        let local = NSRect(x: rect.minX + 16, y: rect.minY + 40, width: 1, height: 20)
        return window?.convertToScreen(convert(local, to: nil)) ?? .zero
    }
}
