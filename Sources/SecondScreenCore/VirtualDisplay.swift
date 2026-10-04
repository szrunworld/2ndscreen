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

    /// Whether macOS will run a display of this size at 2x. It lists a 2x
    /// variant for any size, but refuses to switch to one whose long side is
    /// under 800 points or whose short side is under 525 (found by probing
    /// on macOS 15), and falls back to some other mode instead.
    public static func supportsHiDPI(_ mode: Mode) -> Bool {
        max(mode.width, mode.height) >= 800 && min(mode.width, mode.height) >= 525
    }

    public private(set) var mode: Mode
    /// The largest size `apply` can switch to: the descriptor reserves
    /// pixels for it and nothing bigger.
    public let largest: Mode
    public private(set) var hiDPI: Bool
    public let refreshRate: Double
    public var displayID: CGDirectDisplayID { display.displayID }

    private let display: CGVirtualDisplay
    /// Bumped by each `apply` and on release, so mode selection for an older request stops.
    private let generation = Generation()
    private let configurator: DisplayConfigurator

    /// - Parameters:
    ///   - reserving: further modes `apply` must be able to switch to, such as
    ///     the sizes of connected displays. The presets are always reserved.
    ///   - serialNumber: macOS refuses two live displays with the same
    ///     vendor/product/serial, and remembers arrangement per serial. Give
    ///     each concurrent display its own value.
    ///   - onTerminate: called on the main queue if macOS tears the display
    ///     down on its own (for example after a WindowServer restart).
    ///   - configurator: where the system mode is chosen, off the main thread.
    public init?(name: String, mode: Mode, hiDPI: Bool, refreshRate: Double = 60,
                 reserving: [Mode] = [], serialNumber: UInt32 = 1,
                 configurator: DisplayConfigurator = .shared,
                 onTerminate: @escaping () -> Void = {}) {
        self.configurator = configurator
        let candidates = Self.presets + reserving + [mode]
        let widest = candidates.map(\.width).max()!
        let tallest = candidates.map(\.height).max()!
        largest = Mode(width: widest, height: tallest)

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

    deinit {
        // Pending attempts only hold the display's id; they stop instead of configuring a released display.
        generation.bump()
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
    /// the right variant is current. The checks and the switch run on the
    /// display configurator, never on the caller's thread: completing the
    /// switch waits for WindowServer, which can hang (see DisplayConfigurator).
    private func selectSystemMode(attempts: Int = 30) {
        let id = displayID
        let generation = self.generation
        let request = generation.bump()
        let options = [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue] as CFDictionary
        ModeSelection(
            label: "mode \(mode)\(hiDPI ? " HiDPI" : "") for display \(id)",
            width: mode.width, height: mode.height, hiDPI: hiDPI,
            generation: request, configurator: configurator,
            read: {
                let modes = CGDisplayCopyAllDisplayModes(id, options) as? [CGDisplayMode] ?? []
                return (modes.map { ModeSelection.Variant(width: $0.width, height: $0.height,
                                                           pixelWidth: $0.pixelWidth, id: $0.ioDisplayModeID) },
                        CGDisplayCopyDisplayMode(id)?.ioDisplayModeID)
            },
            select: { [weak display = self.display] wanted in
                let modes = CGDisplayCopyAllDisplayModes(id, options) as? [CGDisplayMode] ?? []
                // Checked again right before the transaction: a display released meanwhile is not configured.
                // A transaction already begun is not undone by a later release; instead the display is kept
                // alive until the transaction returns, and its last reference is dropped on the main queue.
                guard generation.is(request), let held = display,
                      let mode = modes.first(where: { $0.ioDisplayModeID == wanted }) else { return }
                DisplayConfigurator.transaction { CGConfigureDisplayWithDisplayMode($0, id, mode, nil) }
                DispatchQueue.main.async { withExtendedLifetime(held) {} }
            },
            isCurrent: { generation.is($0) }
        ).start(attempts: attempts)
    }

    /// Whether the current system mode matches the requested size and scale.
    public var isSettled: Bool {
        guard let current = CGDisplayCopyDisplayMode(displayID) else { return false }
        return current.width == mode.width && current.height == mode.height
            && current.pixelWidth == (hiDPI ? mode.width * 2 : mode.width)
    }

    /// Whether another online display has the same unit number as `id`.
    /// macOS remembers a unit number for each vendor/product/serial and can
    /// hand two live displays the same one; ScreenCaptureKit then captures
    /// one of them for both, so screenshots and previews show the wrong screen.
    public static func sharesUnitNumber(_ id: CGDirectDisplayID) -> Bool {
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(UInt32(ids.count), &ids, &count) == .success else { return false }
        let unit = CGDisplayUnitNumber(id)
        return ids.prefix(Int(count)).contains { $0 != id && CGDisplayUnitNumber($0) == unit }
    }

    /// The display's frame in global points, once macOS has placed it.
    public var bounds: CGRect { CGDisplayBounds(displayID) }
}

/// A counter shared with background mode selection; thread-safe.
final class Generation: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    /// Start a new generation and return it.
    @discardableResult
    func bump() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }

    func `is`(_ candidate: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return value == candidate
    }
}
