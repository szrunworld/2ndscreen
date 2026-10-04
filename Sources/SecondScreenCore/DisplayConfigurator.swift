import CoreGraphics
import Foundation

/// Runs display configuration transactions (`CGBeginDisplayConfiguration`
/// … `CGCompleteDisplayConfiguration`) away from the main thread, one at a
/// time for the whole process.
///
/// `CGCompleteDisplayConfiguration` waits for WindowServer, and it can wait
/// indefinitely (P0, macOS 15.1: blocked in
/// `SLSCompleteDisplayConfigurationWithOption` while creating a display).
/// On the main thread that froze every control request. Here a stuck
/// transaction blocks only this configurator's queue, and while it is
/// outstanding every further submission is refused rather than queued, so
/// calls cannot pile up behind it. A transaction that has started cannot be
/// cancelled; `pending` reports it, with when it started, until it returns.
public final class DisplayConfigurator: @unchecked Sendable {
    /// The configurator every display in this process goes through.
    public static let shared = DisplayConfigurator()

    public struct Pending: Equatable {
        public let label: String
        public let since: Date
    }

    public enum Submission: Equatable {
        /// The work was handed to the configurator's queue.
        case started
        /// Another transaction is still outstanding; the work was dropped.
        case busy(Pending)
    }

    private let queue: DispatchQueue
    private let now: () -> Date
    private let lock = NSLock()
    private var current: Pending?
    private var finished = 0

    public init(queue: DispatchQueue = DispatchQueue(label: "2ndscreen.display-configuration", qos: .userInitiated),
                now: @escaping () -> Date = Date.init) {
        self.queue = queue
        self.now = now
    }

    /// Run `work` on the configurator's queue unless a transaction is
    /// outstanding. `completion` runs on the same queue right after `work`,
    /// once the configurator is free again.
    @discardableResult
    public func submit(_ label: String, _ work: @escaping () -> Void, completion: (() -> Void)? = nil) -> Submission {
        lock.lock()
        if let current {
            lock.unlock()
            return .busy(current)
        }
        current = Pending(label: label, since: now())
        lock.unlock()
        queue.async { [self] in
            work()
            lock.lock()
            current = nil
            finished += 1
            lock.unlock()
            completion?()
        }
        return .started
    }

    /// The transaction outstanding now, if any.
    public var pending: Pending? {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    /// The outstanding transaction, if it has been running longer than `limit`.
    public func stalled(longerThan limit: TimeInterval) -> Pending? {
        guard let pending, now().timeIntervalSince(pending.since) > limit else { return nil }
        return pending
    }

    /// Transactions that have returned since this configurator was made.
    public var finishedCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return finished
    }

    /// One transaction: begin, let `configure` add to it, complete for the session.
    public static func transaction(_ configure: (CGDisplayConfigRef?) -> Void) {
        var config: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&config) == .success else { return }
        configure(config)
        CGCompleteDisplayConfiguration(config, .forSession)
    }
}

/// Bringing a display to the system mode that matches its requested size
/// and scale, in bounded attempts through a `DisplayConfigurator`. Each
/// attempt reads the display's modes and, if the wanted variant is not
/// current, asks for it; an attempt the configurator refuses (busy) is
/// skipped, not queued. Attempts stop once the mode is current, after
/// `attempts` tries, or as soon as a newer request (`generation`) replaces
/// this one, so a resize or a released display ends the old loop.
public struct ModeSelection {
    public struct Variant: Equatable {
        public let width: Int
        public let height: Int
        public let pixelWidth: Int
        public let id: Int32

        public init(width: Int, height: Int, pixelWidth: Int, id: Int32) {
            self.width = width
            self.height = height
            self.pixelWidth = pixelWidth
            self.id = id
        }
    }

    public enum Step: Equatable {
        /// The wanted variant is current.
        case settled
        /// Ask for this variant.
        case switchTo(Int32)
        /// macOS lists no such variant yet.
        case notListed
    }

    /// What to do given the listed variants and the current one.
    public static func step(width: Int, height: Int, hiDPI: Bool, variants: [Variant], current: Int32?) -> Step {
        let pixelWidth = hiDPI ? width * 2 : width
        guard let wanted = variants.first(where: { $0.width == width && $0.height == height && $0.pixelWidth == pixelWidth })
        else { return .notListed }
        return current == wanted.id ? .settled : .switchTo(wanted.id)
    }

    public let label: String
    public let width: Int
    public let height: Int
    public let hiDPI: Bool
    /// The request this selection serves; it stops once `isCurrent` says another replaced it.
    public let generation: Int
    public let configurator: DisplayConfigurator
    /// Reads the listed variants and the current one. Runs on the configurator's queue.
    public let read: () -> (variants: [Variant], current: Int32?)
    /// Switches to a variant. Runs on the configurator's queue.
    public let select: (Int32) -> Void
    /// Whether `generation` is still the display's latest request.
    public let isCurrent: (Int) -> Bool
    /// Runs a block after a delay (the retry interval).
    public let after: (TimeInterval, @escaping () -> Void) -> Void
    public let interval: TimeInterval

    public init(label: String, width: Int, height: Int, hiDPI: Bool, generation: Int, configurator: DisplayConfigurator,
                read: @escaping () -> (variants: [Variant], current: Int32?), select: @escaping (Int32) -> Void,
                isCurrent: @escaping (Int) -> Bool,
                after: @escaping (TimeInterval, @escaping () -> Void) -> Void = { delay, block in
                    DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: block)
                },
                interval: TimeInterval = 0.2) {
        self.label = label
        self.width = width
        self.height = height
        self.hiDPI = hiDPI
        self.generation = generation
        self.configurator = configurator
        self.read = read
        self.select = select
        self.isCurrent = isCurrent
        self.after = after
        self.interval = interval
    }

    /// Start with `attempts` tries. Never blocks the caller.
    public func start(attempts: Int) {
        attempt(left: attempts)
    }

    private func attempt(left: Int) {
        guard left > 0, isCurrent(generation) else { return }
        var done = false
        let submitted = configurator.submit(label, {
            guard isCurrent(generation) else { done = true; return }
            let seen = read()
            switch Self.step(width: width, height: height, hiDPI: hiDPI, variants: seen.variants, current: seen.current) {
            case .settled: done = true
            case .switchTo(let id): select(id)
            case .notListed: break
            }
        }, completion: {
            if !done, left > 1 { after(interval) { attempt(left: left - 1) } }
        })
        // Refused while another transaction is outstanding: this try is spent, nothing waits in line.
        if case .busy = submitted, left > 1 { after(interval) { attempt(left: left - 1) } }
    }
}
