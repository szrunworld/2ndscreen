import AppKit
import ScreenCaptureKit

/// A live, scaled view of one display, drawn in a window on another display.
///
/// Frames come from ScreenCaptureKit as IOSurfaces and are handed straight to
/// a CALayer, so nothing is copied or encoded. Capturing requires the Screen
/// Recording permission for the process that owns the preview.
public final class DisplayPreview: NSObject, SCStreamOutput, SCStreamDelegate, NSWindowDelegate {
    private let displayID: CGDirectDisplayID
    private let framesPerSecond: Int32
    private let window: NSWindow
    private let imageLayer = CALayer()
    private var stream: SCStream?

    /// Called on the main queue when the user closes the preview window.
    public var onClose: (() -> Void)?

    public var isFloating: Bool {
        get { window.level == .floating }
        set { window.level = newValue ? .floating : .normal }
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
        isFloating = floating
    }

    /// Show the window on a display other than the previewed one (which would
    /// capture itself) and start streaming.
    @MainActor
    public func start() async throws {
        if let other = NSScreen.screens.first(where: { $0.displayID != displayID }) {
            let visible = other.visibleFrame
            window.setFrameTopLeftPoint(NSPoint(x: visible.maxX - window.frame.width - 24,
                                                y: visible.maxY - 24))
        }
        window.orderFrontRegardless()

        let display = try await findDisplay()
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: framesPerSecond)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.queueDepth = 3

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
        try await stream.startCapture()
        self.stream = stream
    }

    /// Stop streaming and hide the window without reporting `onClose`.
    @MainActor
    public func stop() {
        stream?.stopCapture { _ in }
        stream = nil
        window.delegate = nil
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
        stream?.stopCapture { _ in }
        stream = nil
        onClose?()
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                       of type: SCStreamOutputType) {
        guard type == .screen, isCompleteFrame(sampleBuffer),
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let surface = CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue()
        else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.contents = surface
        CATransaction.commit()
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
