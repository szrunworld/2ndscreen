import CoreGraphics
import CGVirtualDisplayPrivate
import Foundation

/// A software-backed display that exists for as long as this object lives.
///
/// Built on CoreGraphics' private `CGVirtualDisplay`. The display's resolution
/// can change in place: the descriptor reserves room for the largest mode it
/// may need at 2x, and `apply(_:hiDPI:)` swaps the active mode without
/// recreating it.
public final class VirtualDisplay {
    public struct Mode: Hashable, Codable, CustomStringConvertible {
        public let width: Int
        public let height: Int

        public init(width: Int, height: Int) {
            self.width = width
            self.height = height
        }

        public var description: String { "\(width)×\(height)" }
    }

    /// Resolutions offered by the app, in points.
    public static let presets: [Mode] = [
        Mode(width: 1280, height: 720),
        Mode(width: 1280, height: 800),
        Mode(width: 1440, height: 900),
        Mode(width: 1920, height: 1080),
        Mode(width: 2560, height: 1440),
    ]

    public private(set) var mode: Mode
    public private(set) var hiDPI: Bool
    public let refreshRate: Double
    public var displayID: CGDirectDisplayID { display.displayID }

    private let display: CGVirtualDisplay

    /// - Parameters:
    ///   - reserving: further modes `apply` must be able to switch to, such as
    ///     the sizes of connected displays. The presets are always reserved.
    ///   - serialNumber: macOS refuses two live displays with the same
    ///     vendor/product/serial, and remembers arrangement per serial. Give
    ///     each concurrent display its own value.
    ///   - onTerminate: called on the main queue if macOS tears the display
    ///     down on its own (for example after a WindowServer restart).
    public init?(name: String, mode: Mode, hiDPI: Bool, refreshRate: Double = 60,
                 reserving: [Mode] = [], serialNumber: UInt32 = 1,
                 onTerminate: @escaping () -> Void = {}) {
        let candidates = Self.presets + reserving + [mode]
        let widest = candidates.map(\.width).max()!
        let tallest = candidates.map(\.height).max()!

        let descriptor = CGVirtualDisplayDescriptor()
        descriptor.setDispatchQueue(DispatchQueue.main)
        descriptor.name = name
        descriptor.maxPixelsWide = UInt32(widest * 2)
        descriptor.maxPixelsHigh = UInt32(tallest * 2)
        // A 24-inch-class physical size keeps macOS' default scaling sensible.
        descriptor.sizeInMillimeters = CGSize(width: 527, height: 296)
        // Stable IDs let macOS remember where the user arranged the display.
        descriptor.vendorID = 0x3256
        descriptor.productID = 0x0002
        descriptor.serialNum = serialNumber
        descriptor.terminationHandler = { _, _ in onTerminate() }

        guard let display = CGVirtualDisplay(descriptor: descriptor) else { return nil }
        self.display = display
        self.mode = mode
        self.hiDPI = hiDPI
        self.refreshRate = refreshRate
        guard apply(mode, hiDPI: hiDPI) else { return nil }
    }

    /// Switch resolution and/or HiDPI in place. Returns false if macOS
    /// rejected the settings; the previous mode then stays active.
    @discardableResult
    public func apply(_ mode: Mode, hiDPI: Bool) -> Bool {
        // Modes are logical sizes: with hiDPI set, macOS backs each one with
        // 2x pixels itself (the descriptor reserves room for that).
        let settings = CGVirtualDisplaySettings()
        settings.hiDPI = hiDPI ? 1 : 0
        settings.modes = [
            CGVirtualDisplayMode(
                width: UInt(mode.width),
                height: UInt(mode.height),
                refreshRate: refreshRate),
        ]
        guard display.apply(settings) else { return false }
        self.mode = mode
        self.hiDPI = hiDPI
        selectSystemMode()
        return true
    }

    /// Given one mode, macOS lists both its 1x and 2x variants and may make
    /// the wrong one current. Pick the variant matching `mode` and `hiDPI`.
    /// The list can lag behind `apply`, by seconds when several displays
    /// appear at once, and a switch can fail to take; keep checking until
    /// the right variant is current.
    private func selectSystemMode(attemptsLeft: Int = 30) {
        let options = [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue] as CFDictionary
        let modes = CGDisplayCopyAllDisplayModes(displayID, options) as? [CGDisplayMode] ?? []
        let pixelWidth = hiDPI ? mode.width * 2 : mode.width
        let wanted = modes.first {
            $0.width == mode.width && $0.height == mode.height && $0.pixelWidth == pixelWidth
        }
        if let wanted, CGDisplayCopyDisplayMode(displayID)?.ioDisplayModeID == wanted.ioDisplayModeID {
            return
        }
        if let wanted {
            var config: CGDisplayConfigRef?
            if CGBeginDisplayConfiguration(&config) == .success {
                CGConfigureDisplayWithDisplayMode(config, displayID, wanted, nil)
                CGCompleteDisplayConfiguration(config, .forSession)
            }
        }
        guard attemptsLeft > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.selectSystemMode(attemptsLeft: attemptsLeft - 1)
        }
    }

    /// Whether the current system mode matches the requested size and scale.
    public var isSettled: Bool {
        guard let current = CGDisplayCopyDisplayMode(displayID) else { return false }
        return current.width == mode.width && current.height == mode.height
            && current.pixelWidth == (hiDPI ? mode.width * 2 : mode.width)
    }

    /// The display's frame in global points, once macOS has placed it.
    public var bounds: CGRect { CGDisplayBounds(displayID) }
}
