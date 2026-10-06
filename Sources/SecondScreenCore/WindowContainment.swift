import CoreGraphics

/// Whether a window lies wholly within its screen. A window that reaches past
/// its screen is clipped in every screenshot of the screen, so the points an
/// agent works out from such a screenshot miss, and element frames beyond the
/// edge are not what the picture shows. Frames are global top-left points.
public enum WindowContainment {
    public static func contains(_ bounds: CGRect, _ frame: CGRect) -> Bool {
        frame.minX >= bounds.minX && frame.minY >= bounds.minY
            && frame.maxX <= bounds.maxX && frame.maxY <= bounds.maxY
    }

    /// How far the window reaches past the screen, for messages: "40 points
    /// past the right edge and 12 past the bottom edge". Nil when it is inside.
    public static func overhang(of frame: CGRect, beyond bounds: CGRect) -> String? {
        var parts: [String] = []
        if frame.minX < bounds.minX { parts.append("\(Int(bounds.minX - frame.minX)) points past the left edge") }
        if frame.minY < bounds.minY { parts.append("\(Int(bounds.minY - frame.minY)) points past the top edge") }
        if frame.maxX > bounds.maxX { parts.append("\(Int(frame.maxX - bounds.maxX)) points past the right edge") }
        if frame.maxY > bounds.maxY { parts.append("\(Int(frame.maxY - bounds.maxY)) points past the bottom edge") }
        return parts.isEmpty ? nil : parts.joined(separator: " and ")
    }
}
