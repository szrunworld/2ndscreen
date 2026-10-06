import CoreGraphics

/// Keeps the user's display arrangement intact while agent screens come and go.
///
/// macOS puts a new display right of the main one and shifts every display
/// already there further out. Windows keep their global coordinates, so a
/// window the user had on a shifted display ends up on the new display,
/// where they cannot see it. Removing a display can shift the rest back the
/// other way.
public enum DisplayLayout {
    /// The origin of every active display.
    public static func origins() -> [CGDirectDisplayID: CGPoint] {
        Dictionary(uniqueKeysWithValues: activeDisplays().map { ($0, CGDisplayBounds($0).origin) })
    }

    /// Where a display goes so that it touches the arrangement without
    /// overlapping or displacing it: right of the rightmost display, top-aligned
    /// with it.
    static func slot(beside frames: [CGRect]) -> CGPoint {
        guard let rightmost = frames.max(by: { $0.maxX < $1.maxX }) else { return .zero }
        return CGPoint(x: rightmost.maxX, y: rightmost.minY)
    }

    /// Return every display still active to its origin in `before`, and put
    /// `newDisplay`, which `before` did not have, beside them. Returns true
    /// once nothing needed moving, false after it asked macOS to rearrange
    /// or while `configurator` is still busy with an earlier transaction.
    /// The rearrangement runs on `configurator`, never on the caller's thread.
    @discardableResult
    public static func place(_ newDisplay: CGDirectDisplayID?, restoring before: [CGDirectDisplayID: CGPoint],
                             configurator: DisplayConfigurator = .shared) -> Bool {
        let active = Set(activeDisplays())
        let kept = before.filter { $0.key != newDisplay && active.contains($0.key) }
        var wanted = kept
        if let newDisplay, active.contains(newDisplay) {
            let frames = kept.map { CGRect(origin: $0.value, size: CGDisplayBounds($0.key).size) }
            wanted[newDisplay] = slot(beside: frames)
        }
        let moves = wanted.filter { CGDisplayBounds($0.key).origin != $0.value }
        guard !moves.isEmpty else { return true }
        // The main display anchors global coordinates at 0,0; it never moves.
        let main = CGMainDisplayID()
        let origins = wanted.filter { $0.key != main }
        // Busy: this round is skipped; callers check again on their next round.
        configurator.submit("arrangement of \(origins.count) display(s)") {
            DisplayConfigurator.transaction { config in
                for (id, origin) in origins { CGConfigureDisplayOrigin(config, id, Int32(origin.x), Int32(origin.y)) }
            }
        }
        return false
    }

    private static func activeDisplays() -> [CGDirectDisplayID] {
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(UInt32(ids.count), &ids, &count) == .success else { return [] }
        return Array(ids.prefix(Int(count)))
    }
}
