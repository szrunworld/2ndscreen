import AppKit
import ApplicationServices

/// Private WindowServer calls that reach a window without bringing its app
/// to the front. Loaded at run time; a missing symbol turns that route off.
/// The recipes follow cua-driver (MIT, trycua/cua) and yabai.
enum SkyLight {
    private static let handle: UnsafeMutableRawPointer? = dlopen(
        "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL)

    private static func symbol<T>(_ name: String, as type: T.Type) -> T? {
        _ = handle
        guard let pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }  // RTLD_DEFAULT
        return unsafeBitCast(pointer, to: type)
    }

    typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
    typealias SetAuthMessage = @convention(c) (CGEvent, AnyObject) -> Void
    typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    typealias SetIntegerField = @convention(c) (CGEvent, UInt32, Int64) -> Void
    typealias MainConnection = @convention(c) () -> UInt32
    typealias SetFrontProcess = @convention(c) (UnsafePointer<ProcessSerialNumber>, UInt32, UInt32) -> OSStatus
    typealias WindowOwner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> OSStatus
    typealias ConnectionPSN = @convention(c) (UInt32, UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus
    typealias PostEventRecord = @convention(c) (UnsafePointer<ProcessSerialNumber>, UnsafePointer<UInt8>) -> OSStatus
    typealias GetFrontProcess = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus
    typealias ProcessForPID = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus
    typealias AuthMessageFactory = @convention(c) (AnyClass, Selector, UnsafeMutableRawPointer, Int32, UInt32) -> Unmanaged<AnyObject>?

    static let postToPid = symbol("SLEventPostToPid", as: PostToPid.self)
    static let setAuthMessage = symbol("SLEventSetAuthenticationMessage", as: SetAuthMessage.self)
    static let setWindowLocation = symbol("CGEventSetWindowLocation", as: SetWindowLocation.self)
    static let setIntegerField = symbol("SLEventSetIntegerValueField", as: SetIntegerField.self)
        ?? symbol("CGEventSetIntegerValueField", as: SetIntegerField.self)
    static let mainConnection = symbol("CGSMainConnectionID", as: MainConnection.self)
    static let setFrontProcess = symbol("SLPSSetFrontProcessWithOptions", as: SetFrontProcess.self)
    static let windowOwner = symbol("SLSGetWindowOwner", as: WindowOwner.self)
    static let connectionPSN = symbol("SLSGetConnectionPSN", as: ConnectionPSN.self)
    static let postEventRecord = symbol("SLPSPostEventRecordTo", as: PostEventRecord.self)
    static let getFrontProcess = symbol("_SLPSGetFrontProcess", as: GetFrontProcess.self)
    static let processForPID = symbol("GetProcessForPID", as: ProcessForPID.self)
    static let authMessageFactory = symbol("objc_msgSend", as: AuthMessageFactory.self)

    // MARK: Event fields

    /// Undocumented fields WindowServer routes by, alongside the public ones.
    enum Field: UInt32 {
        case mouseEventNumber = 0
        case clickState = 1
        case buttonNumber = 3
        case subtype = 7
        case targetPID = 40
        case windowNumber = 51
        case clickGroup = 58
        case windowUnderPointer = 91
        case windowUnderPointerThatCanHandle = 92
    }

    static func set(_ event: CGEvent, _ field: Field, _ value: Int64) {
        if let setIntegerField {
            setIntegerField(event, field.rawValue, value)
        } else if let public_ = CGEventField(rawValue: field.rawValue) {
            event.setIntegerValueField(public_, value: value)
        }
    }

    // MARK: Posting

    /// Post a mouse event to the process: through SkyLight, which reaches
    /// Chromium and Catalyst windows, and with `alsoPublic`, through the
    /// public call too, which some AppKit targets need instead.
    static func postMouse(_ event: CGEvent, to pid: pid_t, alsoPublic: Bool) {
        if let postToPid {
            postToPid(pid, event)
            if alsoPublic { event.postToPid(pid) }
        } else {
            event.postToPid(pid)
        }
    }

    /// Post a key event with WindowServer's authentication message, which
    /// apps on macOS 15 and later require of keys sent to a background
    /// process. Such events skip the HID path, so NSMenu never sees them:
    /// menu key equivalents need `postKeyWithoutAuth` while the app is front.
    static func postKey(_ event: CGEvent, to pid: pid_t) {
        guard let postToPid else {
            event.postToPid(pid)
            return
        }
        if let setAuthMessage, let factory = authMessageFactory,
           let messageClass = NSClassFromString("SLSEventAuthenticationMessage") {
            let selector = NSSelectorFromString("messageWithEventRecord:pid:version:")
            // The selector exists from macOS 15; calling it on 14 would crash.
            if class_respondsToSelector(object_getClass(messageClass), selector), let record = eventRecord(event),
               let message = factory(messageClass, selector, record, pid, 0) {
                setAuthMessage(event, message.takeUnretainedValue())
            }
        }
        postToPid(pid, event)
    }

    static func postKeyWithoutAuth(_ event: CGEvent, to pid: pid_t) {
        if let postToPid { postToPid(pid, event) } else { event.postToPid(pid) }
    }

    /// The SLSEventRecord inside a CGEvent: `{CFRuntimeBase, uint32_t,
    /// SLSEventRecord *}`, so at offset 24 on 64-bit, with 32 and 16 as
    /// fallbacks for other layouts.
    private static func eventRecord(_ event: CGEvent) -> UnsafeMutableRawPointer? {
        let base = Unmanaged.passUnretained(event).toOpaque()
        for offset in [24, 32, 16] {
            if let record = base.load(fromByteOffset: offset, as: UnsafeMutableRawPointer?.self) { return record }
        }
        return nil
    }

    // MARK: Focus

    /// The process serial number of the app owning `windowID`.
    static func psn(windowID: CGWindowID, pid: pid_t) -> ProcessSerialNumber? {
        var psn = ProcessSerialNumber()
        if let mainConnection, let windowOwner, let connectionPSN {
            var owner: UInt32 = 0
            if windowOwner(mainConnection(), windowID, &owner) == 0, owner != 0, connectionPSN(owner, &psn) == 0 {
                return psn
            }
        }
        if let processForPID, processForPID(pid, &psn) == 0 { return psn }
        return nil
    }

    static func frontPSN() -> ProcessSerialNumber? {
        guard let getFrontProcess else { return nil }
        var psn = ProcessSerialNumber()
        return getFrontProcess(&psn) == 0 ? psn : nil
    }

    /// A 0xF8-byte focus event record for `windowID`; `kind` 1 focuses, 2 defocuses.
    private static func focusRecord(windowID: CGWindowID, kind: UInt8) -> [UInt8] {
        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = 0x0D
        withUnsafeBytes(of: windowID.littleEndian) { bytes in
            for (offset, byte) in bytes.enumerated() { record[0x3C + offset] = byte }
        }
        record[0x8A] = kind
        return record
    }

    private static func post(_ record: [UInt8], to psn: ProcessSerialNumber) -> Bool {
        guard let postEventRecord else { return false }
        var psn = psn
        return record.withUnsafeBufferPointer { postEventRecord(&psn, $0.baseAddress!) } == 0
    }

    /// Make `windowID` its app's key window without raising it or making
    /// the app frontmost: tell the front app it lost focus and the target
    /// that it gained it (yabai's recipe). Skipping SetFrontProcess keeps
    /// Chromium's user-activation gate open.
    @discardableResult
    static func focusWithoutRaise(windowID: CGWindowID, pid: pid_t) -> Bool {
        guard let front = frontPSN(), let target = psn(windowID: windowID, pid: pid) else { return false }
        let defocused = post(focusRecord(windowID: windowID, kind: 2), to: front)
        let focused = post(focusRecord(windowID: windowID, kind: 1), to: target)
        return defocused && focused
    }

    /// Undo `focusWithoutRaise`: give focus back to the user's key window,
    /// which otherwise stays deaf to typing.
    static func restoreFocus(after windowID: CGWindowID, pid: pid_t, user: NSRunningApplication) {
        guard let target = psn(windowID: windowID, pid: pid),
              let userWindow = keyWindow(of: user.processIdentifier),
              let userPSN = psn(windowID: userWindow, pid: user.processIdentifier)
        else { return }
        _ = post(focusRecord(windowID: windowID, kind: 2), to: target)
        _ = post(focusRecord(windowID: userWindow, kind: 1), to: userPSN)
    }

    /// Bring the app to the front with `windowID` key, for the foreground
    /// paths only. Returns the previous front process to restore.
    static func bringToFront(windowID: CGWindowID, pid: pid_t) -> ProcessSerialNumber? {
        guard let setFrontProcess, var target = psn(windowID: windowID, pid: pid) else { return nil }
        let previous = frontPSN()
        guard setFrontProcess(&target, windowID, 0x200) == 0 else { return nil }  // kCPSUserGenerated
        for kind: UInt8 in [1, 2] {
            var record = [UInt8](repeating: 0, count: 0xF8)
            record[0x04] = 0xF8
            record[0x08] = kind
            record[0x3A] = 0x10
            for offset in 0x20...0x2F { record[offset] = 0xFF }
            withUnsafeBytes(of: windowID.littleEndian) { bytes in
                for (offset, byte) in bytes.enumerated() { record[0x3C + offset] = byte }
            }
            _ = post(record, to: target)
        }
        return previous
    }

    /// Make a process front again without picking a window.
    static func setFront(_ psn: ProcessSerialNumber) {
        guard let setFrontProcess else { return }
        var psn = psn
        _ = setFrontProcess(&psn, 0, 0x400)  // kCPSNoWindows
    }

    /// Briefly make the app front, so a key event can reach its menus, then
    /// put the previous app back. The front app changes for well under a
    /// millisecond: the event only has to be queued while it is front.
    static func withMenuShortcutActivation(windowID: CGWindowID, pid: pid_t, _ body: () -> Void) {
        guard let setFrontProcess, var target = psn(windowID: windowID, pid: pid), let previous = frontPSN() else {
            body()
            return
        }
        _ = setFrontProcess(&target, 0, 0x400)
        body()
        setFront(previous)
    }

    /// The key window of an app, else its frontmost normal window.
    static func keyWindow(of pid: pid_t) -> CGWindowID? {
        let app = AXUIElementCreateApplication(pid)
        if let window: AXUIElement = WindowMover.copyAttribute(app, kAXFocusedWindowAttribute),
           let id = WindowMover.windowID(of: window) {
            return id
        }
        return WindowMover.windows(ofPID: pid).first?.windowID
    }
}
