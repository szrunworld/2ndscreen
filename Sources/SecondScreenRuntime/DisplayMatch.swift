import AppKit
import SecondScreenCore

/// The area a full-screen window gets on a physical display, offered as a
/// match target so the full-screen preview shows the virtual display pixel
/// for pixel. On displays with a camera housing that area excludes the strip
/// beside it, so it is shorter than the display itself.
public struct DisplayMatch {
    public let name: String
    public let mode: VirtualDisplay.Mode
    public let hiDPI: Bool

    public var title: String { "Match \(name) Full Screen — \(mode)\(hiDPI ? " HiDPI" : "")" }

    /// Every connected display except `excluding` (the virtual display itself).
    @MainActor
    public static func connected(excluding displayID: CGDirectDisplayID?) -> [DisplayMatch] {
        NSScreen.screens.compactMap { screen in
            guard screen.displayID != displayID else { return nil }
            return DisplayMatch(
                name: screen.localizedName,
                mode: VirtualDisplay.Mode(
                    width: Int(screen.frame.width),
                    height: Int(screen.frame.height - screen.safeAreaInsets.top)),
                hiDPI: screen.backingScaleFactor > 1)
        }
    }
}
