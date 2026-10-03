import AppKit
import ApplicationServices

/// One element of a window's accessibility tree, as agents see it.
public struct AXElementInfo: Codable {
    /// The element's number in its snapshot, for `--index`; -1 for elements
    /// that are only context (plain groups, unlabelled containers).
    public var index: Int
    public var role: String
    public var label: String?
    public var value: String?
    public var actions: [String]?
    /// Global top-left-origin points.
    public var frame: Frame?
}

/// Processes this app has asked to expose web content, so the first read waits for it once.
private var enabledWebAccessibility = Set<pid_t>()
private let enabledWebAccessibilityLock = NSLock()

/// A snapshot of one window's accessibility tree. The app keeps the last
/// snapshot per window, so the indexes it hands out stay valid until the
/// next `state` of that window.
public final class AXSnapshot {
    public let windowID: CGWindowID
    public let elements: [AXElementInfo]
    /// An indented outline, one element a line, with `[N]` before indexed ones.
    public let tree: String
    /// The live elements behind `elements`, by index.
    let handles: [Int: AXUIElement]
    /// Indexes of elements inside web content (an AXWebArea). Chromium
    /// answers accessibility actions there with success while the page,
    /// in a background window, never sees them; such elements take events.
    let web: Set<Int>

    /// Deep apps (Electron, web views) have thousands of nodes; these bound
    /// the walk so a snapshot stays fast and the tree readable.
    static let maxDepth = 40
    static let maxNodes = 4000

    private init(windowID: CGWindowID, elements: [AXElementInfo], tree: String, handles: [Int: AXUIElement],
                 web: Set<Int>) {
        self.windowID = windowID
        self.elements = elements
        self.tree = tree
        self.handles = handles
        self.web = web
    }

    /// Walk `window`'s tree. Fails without the Accessibility permission or
    /// when the app does not expose the window.
    public static func capture(_ window: WindowInfo, query: String? = nil) throws -> AXSnapshot {
        guard AXIsProcessTrusted() else {
            throw AccessibilityError("2ndscreen needs the Accessibility permission to read and drive apps")
        }
        guard let root = WindowMover.axWindow(for: window) else {
            throw AccessibilityError("\(window.appName) does not expose window \(window.windowID) to accessibility")
        }
        // A busy app can block an AX call for its full default timeout (6 s).
        let app = AXUIElementCreateApplication(window.pid)
        AXUIElementSetMessagingTimeout(app, 2)
        let justEnabled = enableWebAccessibility(app, pid: window.pid)

        var walker = Walker(query: query?.lowercased())
        walker.visit(root, depth: 0, inWeb: false)
        // Right after asking, the renderer is still building the page's tree: read again
        // for up to two seconds until web content shows up.
        if justEnabled {
            for _ in 0..<8 where walker.web.isEmpty {
                Thread.sleep(forTimeInterval: 0.25)
                walker = Walker(query: query?.lowercased())
                walker.visit(root, depth: 0, inWeb: false)
            }
        }
        return AXSnapshot(windowID: window.windowID, elements: walker.elements,
                          tree: walker.lines.joined(separator: "\n"), handles: walker.handles, web: walker.web)
    }

    /// Chromium and Electron expose a page's tree only once a client asks for it; until then
    /// a browser window shows its toolbar and nothing of the page. Electron answers
    /// AXManualAccessibility. Chromium browsers answer only AXEnhancedUserInterface, which in
    /// other apps can slow window animations and moves, so it is set for them alone.
    /// Returns whether it asked just now, so the caller can wait for the tree.
    private static func enableWebAccessibility(_ app: AXUIElement, pid: pid_t) -> Bool {
        enabledWebAccessibilityLock.lock()
        let first = enabledWebAccessibility.insert(pid).inserted
        enabledWebAccessibilityLock.unlock()
        guard first else { return false }
        if AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
            return true
        }
        guard isChromium(pid) else { return false }
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        return true
    }

    /// Whether the app bundles a Chromium framework (Chrome, Edge, Brave and the like).
    private static func isChromium(_ pid: pid_t) -> Bool {
        guard let bundle = NSRunningApplication(processIdentifier: pid)?.bundleURL else { return false }
        let frameworks = bundle.appendingPathComponent("Contents/Frameworks")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: frameworks.path)) ?? []
        return names.contains { name in
            name.hasSuffix(" Framework.framework") || name.contains("Chromium") || name.contains("Electron")
        }
    }

    public func element(index: Int) -> AXElementInfo? {
        elements.first { $0.index == index }
    }

    /// The element whose text best matches: an exact label or value first,
    /// then one containing the text, then the nearest indexed ancestor of an
    /// unindexed element containing it. Web and Electron apps often put the
    /// visible text in an unindexed child of the actionable link or row.
    public func element(text: String) -> AXElementInfo? {
        let needle = text.lowercased()
        func matches(_ element: AXElementInfo, exact: Bool) -> Bool {
            [element.label, element.value].contains { candidate in
                guard let candidate = candidate?.lowercased() else { return false }
                return exact ? candidate == needle : candidate.contains(needle)
            }
        }
        let indexed = elements.filter { $0.index >= 0 }
        if let exact = indexed.first(where: { matches($0, exact: true) }) { return exact }
        if let partial = indexed.first(where: { matches($0, exact: false) }) { return partial }
        let lines = tree.components(separatedBy: "\n")
        for (number, line) in lines.enumerated() where line.lowercased().contains(needle) {
            let indent = line.prefix { $0 == " " }.count
            for candidate in lines[...number].reversed() {
                let candidateIndent = candidate.prefix { $0 == " " }.count
                guard candidate == line || candidateIndent < indent, let index = Self.leadingIndex(candidate)
                else { continue }
                return element(index: index)
            }
        }
        return nil
    }

    func handle(_ index: Int) -> AXUIElement? { handles[index] }

    public func isWeb(_ index: Int) -> Bool { web.contains(index) }

    private static func leadingIndex(_ line: String) -> Int? {
        let trimmed = line.drop { $0 == " " || $0 == "-" }
        guard trimmed.first == "[", let close = trimmed.firstIndex(of: "]") else { return nil }
        return Int(trimmed[trimmed.index(after: trimmed.startIndex)..<close])
    }

    private struct Walker {
        let query: String?
        var elements: [AXElementInfo] = []
        var lines: [String] = []
        var handles: [Int: AXUIElement] = [:]
        var web: Set<Int> = []
        var visited = 0
        var nextIndex = 0

        /// Roles worth an index even without a label: things one acts on.
        static let actionable: Set<String> = [
            "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem",
            "AXMenuBarItem", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSlider",
            "AXLink", "AXTab", "AXRow", "AXCell", "AXDisclosureTriangle", "AXIncrementor", "AXColorWell",
            "AXSecureTextField", "AXDateField", "AXStepper", "AXSegmentedControl",
        ]

        mutating func visit(_ element: AXUIElement, depth: Int, inWeb: Bool) {
            guard depth <= AXSnapshot.maxDepth, visited < AXSnapshot.maxNodes else { return }
            visited += 1
            let role: String = attribute(element, kAXRoleAttribute) ?? "AXUnknown"
            let subrole: String? = attribute(element, kAXSubroleAttribute)
            var label: String?
            for name in [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", kAXHelpAttribute] {
                if let text: String = attribute(element, name), !text.isEmpty {
                    label = text
                    break
                }
            }
            let value = Self.text(of: element)
            let actions = Self.actionNames(element)
            let frame = WindowMover.frame(of: element)
            let hidden = (frame.map { $0.width < 1 || $0.height < 1 }) ?? false

            let interesting = Self.actionable.contains(role) || (role == "AXStaticText" && value != nil)
                || label != nil || actions.contains("AXPress")
            let shown = !hidden && (query.map { query in
                [label, value, role].contains { $0?.lowercased().contains(query) ?? false }
            } ?? true)

            var index = -1
            if interesting, !hidden {
                index = nextIndex
                nextIndex += 1
                handles[index] = element
                if inWeb { web.insert(index) }
            }
            if shown, interesting || role != "AXGroup" {
                var info = AXElementInfo(index: index, role: subrole.map { "\(role)/\($0)" } ?? role)
                info.label = label
                info.value = value
                info.actions = actions.isEmpty ? nil : actions
                info.frame = frame.map(Frame.init)
                elements.append(info)
                lines.append(Self.line(info, depth: depth))
            }

            let children: [AXUIElement] = attribute(element, kAXChildrenAttribute) ?? []
            for child in children { visit(child, depth: depth + 1, inWeb: inWeb || role == "AXWebArea") }
        }

        static func line(_ info: AXElementInfo, depth: Int) -> String {
            var parts = [String(repeating: "  ", count: depth) + "-"]
            if info.index >= 0 { parts.append("[\(info.index)]") }
            parts.append(info.role)
            if let label = info.label { parts.append("\"\(clip(label))\"") }
            if let value = info.value, value != info.label { parts.append("= \"\(clip(value))\"") }
            return parts.joined(separator: " ")
        }

        static func clip(_ text: String) -> String {
            let flat = text.replacingOccurrences(of: "\n", with: " ")
            return flat.count > 120 ? String(flat.prefix(117)) + "..." : flat
        }

        /// The value as text: strings as they are, numbers and booleans spelled.
        static func text(of element: AXUIElement) -> String? {
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &raw) == .success,
                  let raw else { return nil }
            if let string = raw as? String { return string.isEmpty ? nil : string }
            if let number = raw as? NSNumber { return number.stringValue }
            return nil
        }

        static func actionNames(_ element: AXUIElement) -> [String] {
            var names: CFArray?
            guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
            return (names as? [String]) ?? []
        }

        func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
            WindowMover.copyAttribute(element, name)
        }
    }
}

extension AXElementInfo {
    public init(index: Int, role: String, label: String? = nil, value: String? = nil, frame: CGRect? = nil) {
        self.index = index
        self.role = role
        self.label = label
        self.value = value
        self.frame = frame.map(Frame.init)
    }

    public var center: CGPoint? {
        frame.map { CGPoint(x: $0.x + $0.width / 2, y: $0.y + $0.height / 2) }
    }
}

public struct AccessibilityError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Actions through accessibility, which reach an element without any input
/// event and so work whatever app is in front.
public enum AXActions {
    /// Press the element, retrying while the app reports it busy
    /// (kAXErrorCannotComplete, which apps return mid-update).
    public static func press(_ snapshot: AXSnapshot, index: Int) -> Bool {
        guard let element = snapshot.handle(index) else { return false }
        for attempt in 1...3 {
            let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
            if result == .success { return true }
            guard result == .cannotComplete, attempt < 3 else { return false }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return false
    }

    /// Insert `text` at the element's caret, as typing would, replacing any
    /// selection. Falls back to appending to the value. Returns false if the
    /// element takes neither, so the caller can type with keys instead.
    public static func insert(_ text: String, into snapshot: AXSnapshot, index: Int) -> Bool {
        guard let element = snapshot.handle(index) else { return false }
        AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let before: String = WindowMover.copyAttribute(element, kAXValueAttribute) ?? ""
        // Some apps accept a write and drop it; only the value read back counts.
        func landed() -> Bool {
            let after: String = WindowMover.copyAttribute(element, kAXValueAttribute) ?? ""
            return after != before && after.contains(text)
        }
        var settable: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success,
           settable.boolValue,
           AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString) == .success,
           landed() {
            return true
        }
        if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
           settable.boolValue,
           AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, (before + text) as CFString) == .success {
            return landed()
        }
        return false
    }

    /// Set the element's whole text to `value`, and read it back. The page in
    /// an Electron or Chromium window receives the write as an `input` event.
    public static func replace(with value: String, in snapshot: AXSnapshot, index: Int) -> Bool {
        guard let element = snapshot.handle(index) else { return false }
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
              settable.boolValue,
              AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success
        else { return false }
        // Chromium applies the write a moment later: an immediate read can
        // still return the old text (BOSS直聘 cleared its box yet read back
        // the draft), so give it half a second.
        for attempt in 0..<10 {
            let now: String = WindowMover.copyAttribute(element, kAXValueAttribute) ?? ""
            if now == value { return true }
            if attempt < 9 { Thread.sleep(forTimeInterval: 0.05) }
        }
        return false
    }

    /// The element's current text value, read live rather than from the snapshot.
    public static func value(_ snapshot: AXSnapshot, index: Int) -> String? {
        guard let element = snapshot.handle(index) else { return nil }
        return WindowMover.copyAttribute(element, kAXValueAttribute)
    }

    /// Whether the element has keyboard focus in its app.
    public static func isFocused(_ snapshot: AXSnapshot, index: Int) -> Bool {
        guard let element = snapshot.handle(index) else { return false }
        let focused: Bool? = WindowMover.copyAttribute(element, kAXFocusedAttribute)
        return focused ?? false
    }

    /// Whether the element can be pressed through accessibility.
    public static func canPress(_ info: AXElementInfo) -> Bool {
        info.actions?.contains(kAXPressAction as String) ?? false
    }

    /// Whether the element holds editable text.
    public static func isText(_ info: AXElementInfo) -> Bool {
        let base = info.role.split(separator: "/").first.map(String.init) ?? info.role
        return ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField"].contains(base)
    }
}
