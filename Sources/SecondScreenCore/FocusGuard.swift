import AppKit

/// Keeps an app an agent acts on from taking the foreground from the user.
///
/// Background input still makes some apps activate themselves. While an
/// action runs, and briefly after, the guard puts the user's app back when
/// another app activates. An activation that follows the user's own mouse
/// or modifier input within `userSwitchWindow` is the user switching apps,
/// so the guard adopts it as the app to keep in front instead of undoing it.
public final class FocusGuard {
    public static let shared = FocusGuard()

    /// How recent real input must be for an activation to count as the user's.
    public var userSwitchWindow: TimeInterval = 0.8

    private struct Lease {
        let id: UUID
        /// Only this pid's activations are undone; nil means any app other
        /// than `restoreTo`.
        let target: pid_t?
        /// An app allowed to activate, such as the one being clicked.
        let allowed: pid_t?
        var restoreTo: pid_t
        let deadline: Date
    }

    private var leases: [Lease] = []
    private let lock = NSLock()
    private var observer: NSObjectProtocol?
    /// Activations arrive here, not on the main queue, which may be busy.
    private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "2ndscreen.focus-guard"
        return queue
    }()

    private init() {}

    private func start() {
        guard observer == nil else { return }
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: queue
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.activated(app.processIdentifier)
        }
    }

    /// Run `body` with the user's current front app protected, and keep it
    /// protected for `linger` after, since apps activate asynchronously.
    public func protect<T>(target: pid_t?, allowing allowed: pid_t? = nil, linger: TimeInterval = 1,
                           _ body: () throws -> T) rethrows -> T {
        guard let front = NSWorkspace.shared.frontmostApplication?.processIdentifier, front != target
        else { return try body() }
        start()
        let id = UUID()
        lock.lock()
        // A wildcard lease, which also catches other apps the target
        // launches, and a targeted one, which the allowance cannot excuse.
        leases.append(Lease(id: id, target: nil, allowed: allowed, restoreTo: front, deadline: .distantFuture))
        if let target, target != allowed {
            leases.append(Lease(id: id, target: target, allowed: nil, restoreTo: front, deadline: .distantFuture))
        }
        lock.unlock()
        defer {
            let deadline = Date().addingTimeInterval(linger)
            lock.lock()
            leases = leases.map { lease in
                lease.id == id ? Lease(id: id, target: lease.target, allowed: lease.allowed,
                                       restoreTo: lease.restoreTo, deadline: deadline) : lease
            }
            lock.unlock()
        }
        return try body()
    }

    /// Whether real mouse or modifier input happened within the window. The
    /// agent's events go to a process and leave the HID state alone; plain
    /// key presses are left out, so typing in the user's app does not count.
    public func userActedRecently() -> Bool {
        guard userSwitchWindow > 0 else { return false }
        let types: [CGEventType] = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .otherMouseDown, .flagsChanged]
        let since = types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? .infinity
        return since <= userSwitchWindow
    }

    private func activated(_ pid: pid_t) {
        let now = Date()
        lock.lock()
        leases.removeAll { $0.deadline <= now }
        if userActedRecently() {
            // The user chose this app: keep it, and stop guarding against it.
            leases.removeAll { $0.target == pid }
            for index in leases.indices { leases[index].restoreTo = pid }
            lock.unlock()
            return
        }
        let restore = leases.filter { lease in
            guard lease.allowed != pid else { return false }
            return lease.target.map { $0 == pid } ?? (pid != lease.restoreTo)
        }.map(\.restoreTo)
        lock.unlock()
        for pid in Set(restore) {
            NSRunningApplication(processIdentifier: pid)?.activate(options: [])
        }
    }
}
