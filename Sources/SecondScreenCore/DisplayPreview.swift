import AppKit
import CoreImage
import Metal
import ScreenCaptureKit

/// A live, scaled view of one display, drawn in a window on another display.
///
/// Frames come from ScreenCaptureKit as IOSurfaces. One that fits the window
/// is handed straight to a CALayer and shown pixel for pixel; a larger one is
/// shrunk with a Lanczos filter first, since the compositor's own bilinear
/// scaling softens small text (an iPhone Mirroring screen squeezed by 5%
/// was visibly blurry). Capturing requires the Screen Recording permission
/// for the process that owns the preview.
public final class DisplayPreview: NSObject, SCStreamOutput, SCStreamDelegate, NSWindowDelegate {
    private let displayID: CGDirectDisplayID
    private let framesPerSecond: Int32
    private let window: NSWindow
    private let imageLayer = CALayer()
    private let scaler: CIContext = {
        if let device = MTLCreateSystemDefaultDevice() {
            return CIContext(mtlDevice: device, options: [.cacheIntermediates: false])
        }
        return CIContext()
    }()
    private var stream: SCStream?
    /// Whether the owner wants frames. Capture still pauses while the window
    /// is fully hidden, such as on another Space, to save power.
    private var wantsStream = false
    /// Bumped whenever a stream is stopped, so a start still awaiting
    /// ScreenCaptureKit can tell it was superseded and discard its stream.
    private var streamGeneration = 0

    /// Called on the main queue when the user closes the preview window.
    public var onClose: (() -> Void)?

    /// A button in the preview's title bar.
    public struct ToolbarButton {
        public let symbol: String
        public let help: String
        public let action: () -> Void

        public init(symbol: String, help: String, action: @escaping () -> Void) {
            self.symbol = symbol
            self.help = help
            self.action = action
        }
    }

    private final class ButtonTarget: NSObject {
        let action: () -> Void
        init(_ action: @escaping () -> Void) { self.action = action }
        @objc func fire(_ sender: Any?) { action() }
    }

    private var toolbar: NSTitlebarAccessoryViewController?
    private var buttonTargets: [ButtonTarget] = []

    public var isFloating: Bool {
        get { window.level == .floating }
        set { window.level = newValue ? .floating : .normal }
    }

    public var isFullScreen: Bool { window.styleMask.contains(.fullScreen) }

    @MainActor
    public func toggleFullScreen() {
        window.toggleFullScreen(nil)
    }

    public init(displayID: CGDirectDisplayID, title: String, framesPerSecond: Int32, floating: Bool) {
        self.displayID = displayID
        self.framesPerSecond = framesPerSecond

        let bounds = CGDisplayBounds(displayID)
        let aspect = bounds.height > 0 ? bounds.width / bounds.height : 16.0 / 9.0
        let contentSize = NSSize(width: 640, height: (640 / aspect).rounded())
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: contentSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = title
        window.contentAspectRatio = contentSize
        window.isReleasedWhenClosed = false
        // Native full screen gives the preview its own Space, reachable with
        // the usual trackpad swipe.
        window.collectionBehavior = [.fullScreenPrimary]

        let view = NSView(frame: NSRect(origin: .zero, size: contentSize))
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.black.cgColor
        imageLayer.frame = view.bounds
        imageLayer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        imageLayer.contentsGravity = .resizeAspect
        view.layer?.addSublayer(imageLayer)
        window.contentView = view
        super.init()
        window.delegate = self
        matchBackingScale()
        isFloating = floating
    }

    /// Show the window on a display other than the previewed one (which would
    /// capture itself) and start streaming.
    @MainActor
    public func start() async throws {
        if let other = NSScreen.screens.first(where: { $0.displayID != displayID }) {
            let visible = other.visibleFrame
            showActualSizeIfItFits(in: visible)
            window.setFrameTopLeftPoint(NSPoint(x: visible.maxX - window.frame.width - 24,
                                                y: visible.maxY - 24))
        }
        window.orderFrontRegardless()
        wantsStream = true
        try await startStream()
    }

    /// Put `buttons` at the right of the title bar, replacing any there.
    @MainActor
    public func setToolbar(_ buttons: [ToolbarButton]) {
        if let toolbar, let index = window.titlebarAccessoryViewControllers.firstIndex(of: toolbar) {
            window.removeTitlebarAccessoryViewController(at: index)
        }
        buttonTargets = buttons.map { ButtonTarget($0.action) }
        guard !buttons.isEmpty else { toolbar = nil; return }
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 4, bottom: 0, right: 6)
        for (button, target) in zip(buttons, buttonTargets) {
            let image = NSImage(systemSymbolName: button.symbol, accessibilityDescription: button.help)
                ?? NSImage(named: NSImage.actionTemplateName)!
            let control = NSButton(image: image, target: target, action: #selector(ButtonTarget.fire(_:)))
            control.bezelStyle = .accessoryBarAction
            control.isBordered = false
            control.toolTip = button.help
            control.setAccessibilityLabel(button.help)
            stack.addArrangedSubview(control)
        }
        stack.frame.size = stack.fittingSize
        let controller = NSTitlebarAccessoryViewController()
        controller.view = stack
        controller.layoutAttribute = .trailing
        window.addTitlebarAccessoryViewController(controller)
        toolbar = controller
    }

    /// Draw the layer at the screen's pixel density, so that centered
    /// contents land pixel for pixel.
    private func matchBackingScale() {
        let scale = window.backingScaleFactor
        imageLayer.contentsScale = scale
        window.contentView?.layer?.contentsScale = scale
    }

    public func windowDidChangeBackingProperties(_ notification: Notification) {
        matchBackingScale()
    }

    /// Show the display point for point when the window fits on the screen
    /// it opens on. Any other size resamples the image, and a slight shrink,
    /// such as a phone-sized screen squeezed to fit the window's default
    /// width, blurs small text.
    @MainActor
    private func showActualSizeIfItFits(in visible: NSRect) {
        let bounds = CGDisplayBounds(displayID)
        let margin: CGFloat = 24
        let titleBar = window.frame.height - window.contentLayoutRect.height
        guard bounds.width > 0, bounds.width + 2 * margin <= visible.width,
              bounds.height + titleBar + margin <= visible.height
        else { return }
        window.setContentSize(NSSize(width: bounds.width, height: bounds.height))
    }

    /// Re-capture after the virtual display changes resolution. The window,
    /// and its full-screen Space if it has one, stay as they are.
    @MainActor
    public func restartStream() async throws {
        guard wantsStream else { return }
        stopStream()
        if !isFullScreen {
            let bounds = CGDisplayBounds(displayID)
            if bounds.height > 0 {
                let width = window.contentLayoutRect.width
                window.contentAspectRatio = NSSize(width: bounds.width, height: bounds.height)
                window.setContentSize(NSSize(width: width, height: (width * bounds.height / bounds.width).rounded()))
            }
        }
        try await startStream()
    }

    @MainActor
    private func startStream() async throws {
        let generation = streamGeneration
        let display = try await findDisplay()
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        // SCDisplay reports points; capture at the mode's pixel size so a
        // HiDPI display stays sharp when the preview is shown full screen.
        let mode = CGDisplayCopyDisplayMode(displayID)
        config.width = mode?.pixelWidth ?? display.width
        config.height = mode?.pixelHeight ?? display.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: framesPerSecond)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.queueDepth = 3

        guard generation == streamGeneration else { return }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
        try await stream.startCapture()
        guard generation == streamGeneration, wantsStream else {
            try? await stream.stopCapture()
            return
        }
        let previous = self.stream
        self.stream = stream
        try? await previous?.stopCapture()
    }

    private func stopStream() {
        streamGeneration += 1
        stream?.stopCapture { _ in }
        stream = nil
    }

    /// Pause capture while no part of the window can be seen and resume when
    /// it reappears; the last frame stays on screen meanwhile.
    public func windowDidChangeOcclusionState(_ notification: Notification) {
        guard wantsStream else { return }
        if window.occlusionState.contains(.visible) {
            guard stream == nil else { return }
            Task { @MainActor in try? await self.startStream() }
        } else {
            stopStream()
        }
    }

    /// Stop streaming and close the window without reporting `onClose`.
    ///
    /// A full-screen window leaves full screen first: closing it in place
    /// strands its Space as a frozen, empty desktop.
    @MainActor
    public func stop() {
        wantsStream = false
        stopStream()
        closingSilently = true
        if isFullScreen {
            closeAfterExitingFullScreen = true
            window.toggleFullScreen(nil)
            // If the exit never completes, close anyway rather than leave
            // the window, and its Space, behind.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, self.closeAfterExitingFullScreen else { return }
                self.closeAfterExitingFullScreen = false
                self.window.close()
            }
        } else {
            window.close()
        }
    }

    private var closingSilently = false
    private var closeAfterExitingFullScreen = false

    /// The windowed preview keeps the display's aspect ratio, but that
    /// constraint conflicts with the full-screen frame and collapsed the
    /// window to 0x0, leaving a black, unresponsive Space. Drop it while full
    /// screen; the layer letterboxes the image instead.
    public func windowWillEnterFullScreen(_ notification: Notification) {
        window.contentResizeIncrements = NSSize(width: 1, height: 1)
    }

    public func window(_ window: NSWindow, willUseFullScreenContentSize proposedSize: NSSize) -> NSSize {
        proposedSize
    }

    public func windowDidExitFullScreen(_ notification: Notification) {
        let bounds = CGDisplayBounds(displayID)
        if bounds.height > 0 {
            window.contentAspectRatio = NSSize(width: bounds.width, height: bounds.height)
        }
        guard closeAfterExitingFullScreen else { return }
        closeAfterExitingFullScreen = false
        window.close()
    }

    /// A freshly created virtual display can take a moment to appear in
    /// ScreenCaptureKit's shareable content.
    private func findDisplay() async throws -> SCDisplay {
        for _ in 0..<20 {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            if let display = content.displays.first(where: { $0.displayID == displayID }) {
                return display
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw PreviewError.displayNotShareable(displayID)
    }

    public func windowWillClose(_ notification: Notification) {
        wantsStream = false
        stopStream()
        if !closingSilently {
            onClose?()
        }
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                       of type: SCStreamOutputType) {
        guard type == .screen, isCompleteFrame(sampleBuffer),
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let surface = CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue()
        else { return }
        let contents = fitted(surface)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.contentsGravity = contents.exact ? .center : .resizeAspect
        imageLayer.contents = contents.image
        CATransaction.commit()
    }

    /// The surface itself when it fits the layer's pixels (drawn centered,
    /// without scaling), else a Lanczos-shrunk copy that fits.
    private func fitted(_ surface: IOSurfaceRef) -> (image: Any, exact: Bool) {
        let scale = imageLayer.contentsScale
        let target = CGSize(width: imageLayer.bounds.width * scale, height: imageLayer.bounds.height * scale)
        let source = CGSize(width: CGFloat(IOSurfaceGetWidth(surface)), height: CGFloat(IOSurfaceGetHeight(surface)))
        guard target.width > 0, target.height > 0, source.width > 0, source.height > 0 else { return (surface, false) }
        if source.width <= target.width, source.height <= target.height { return (surface, true) }
        let factor = min(target.width / source.width, target.height / source.height)
        let filter = CIFilter(name: "CILanczosScaleTransform")!
        filter.setValue(CIImage(ioSurface: surface), forKey: kCIInputImageKey)
        filter.setValue(factor, forKey: kCIInputScaleKey)
        filter.setValue(1.0, forKey: kCIInputAspectRatioKey)
        guard let output = filter.outputImage,
              let image = scaler.createCGImage(output, from: output.extent.integral)
        else { return (surface, false) }
        return (image, false)
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("preview stopped: \(error.localizedDescription)")
        fflush(stdout)
    }

    /// Idle and blank frames carry no new image; skip them.
    private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: raw)
        else { return false }
        return status == .complete
    }
}

public enum PreviewError: LocalizedError {
    case displayNotShareable(CGDirectDisplayID)

    public var errorDescription: String? {
        switch self {
        case .displayNotShareable(let id):
            return "display \(id) never appeared in ScreenCaptureKit; check Screen Recording permission"
        }
    }
}

extension NSScreen {
    public var displayID: CGDirectDisplayID? {
        deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
    }
}
