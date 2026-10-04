import CoreGraphics
import Foundation
import IOKit.pwr_mgt

/// Display sleep and the work that changes displays.
///
/// P0 (macOS 15.1): with the user's displays asleep, creating a virtual
/// display blocked in `CGCompleteDisplayConfiguration` until the displays
/// were woken, and stayed blocked through a wake too short to cover it.
/// So display work refuses to start while the user's displays are asleep
/// (it never wakes them: that would light the user's screens from the
/// background), and holds an assertion that keeps them from going to sleep
/// while it runs.
public enum DisplaySleep {
    /// One online display, as far as sleep is concerned.
    public struct Online: Equatable {
        public let id: CGDirectDisplayID
        /// In the active list: drawable now. A closed or idle built-in panel, or a
        /// hardware-mirroring secondary, is online but not active.
        public let active: Bool
        public let asleep: Bool
        /// A 2ndscreen virtual display (any instance's, or one an exited process left), not a screen the user looks at.
        public let virtual: Bool

        public init(id: CGDirectDisplayID, active: Bool, asleep: Bool, virtual: Bool) {
            self.id = id
            self.active = active
            self.asleep = asleep
            self.virtual = virtual
        }
    }

    public enum State: Equatable {
        /// A physical display is active and awake, or there is no physical display (headless, deliberately allowed).
        case awake
        /// No physical display is active and awake, and at least one reports asleep.
        case asleep
        /// Nothing proves either: the displays could not be read, or every physical display is inactive without
        /// reporting sleep.
        case unknown(String)
    }

    /// The user's displays' sleep state from the online displays (`nil`: the
    /// list could not be read), physical ones only, in this order:
    /// 1. none: headless, treated as awake on purpose;
    /// 2. one is active and not asleep: someone can be using it, awake. An
    ///    inactive panel beside it (a closed lid, a mirroring secondary) does
    ///    not count either way;
    /// 3. otherwise one reports asleep: asleep. P0 (macOS 15.1, after a wake
    ///    expired): external display active 0 asleep 1, built-in active 0
    ///    asleep 0; an earlier reading had both inactive while a leftover
    ///    virtual display stayed active. Requiring every physical display
    ///    to report asleep missed this, since the idle built-in panel does not;
    /// 4. otherwise (all inactive, none asleep): unknown, not headless.
    public static func state(_ displays: [Online]?) -> State {
        guard let displays else { return .unknown("the online displays could not be listed") }
        let physical = displays.filter { !$0.virtual }
        if physical.isEmpty { return .awake }
        if physical.contains(where: { $0.active && !$0.asleep }) { return .awake }
        if physical.contains(where: \.asleep) { return .asleep }
        return .unknown("no physical display is active, and none reports asleep")
    }

    /// Every online display now, or nil if the list cannot be read. Read only.
    public static func online() -> [Online]? {
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(UInt32(ids.count), &ids, &count) == .success else { return nil }
        return ids.prefix(Int(count)).map { id in
            // CGVirtualDisplay reports the descriptor's vendor and product, which mark 2ndscreen's own.
            // Any other display, including other software displays, counts as physical.
            let virtual = CGDisplayVendorNumber(id) == 0x3256 && CGDisplayModelNumber(id) == 0x0002
            return Online(id: id, active: CGDisplayIsActive(id) != 0, asleep: CGDisplayIsAsleep(id) != 0, virtual: virtual)
        }
    }

    public static func stateNow() -> State { state(online()) }
}

/// Holding the system's "prevent idle display sleep" assertion.
public protocol DisplaySleepAssertions: AnyObject {
    /// Take an assertion; nil if the system refused one.
    func hold(reason: String) -> UInt32?
    func release(_ id: UInt32)
}

/// The real assertions, through IOKit power management.
public final class PowerManagementAssertions: DisplaySleepAssertions {
    public init() {}

    public func hold(reason: String) -> UInt32? {
        var id = IOPMAssertionID(0)
        let result = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                                                 IOPMAssertionLevel(kIOPMAssertionLevelOn), reason as CFString, &id)
        return result == kIOReturnSuccess ? id : nil
    }

    public func release(_ id: UInt32) {
        IOPMAssertionRelease(id)
    }
}

/// The preconditions and the sleep hold around one piece of display work
/// (creating or resizing a screen).
///
/// Before the work: wait up to `waitLimit`, without blocking the caller's
/// thread, for any display configuration still outstanding to return, and
/// refuse if it does not (a started transaction cannot be cancelled, and
/// new display work could wait behind it); refuse while the user's displays
/// are asleep or their state cannot be read. Then take a
/// prevent-idle-display-sleep assertion, refusing if the system will not
/// give one, and check the sleep state again with it held (the hold does
/// not wake a display that fell asleep in between). The assertion is
/// released when the work returns or throws; it covers the work, not
/// configuration left running on the configurator afterwards.
public final class DisplayWork {
    public enum Refusal: Equatable {
        case configurationPending(DisplayConfigurator.Pending)
        case displaysAsleep
        case sleepStateUnknown(String)
        case assertionUnavailable

        /// What to tell the caller.
        public func message(now: Date = Date()) -> String {
            switch self {
            case .configurationPending(let pending):
                return "WindowServer has not finished a display configuration (\(pending.label)) started"
                    + " \(Int(now.timeIntervalSince(pending.since))) s ago; it cannot be cancelled, so nothing was changed"
            case .displaysAsleep:
                return "the displays are asleep, and macOS does not finish configuring a display while they sleep;"
                    + " nothing was changed. Wake the displays and keep them awake (for example caffeinate -u -d -t 600), then retry"
            case .sleepStateUnknown(let why):
                return "whether the displays are asleep is unknown (\(why)); nothing was changed"
            case .assertionUnavailable:
                return "macOS did not grant an assertion keeping the displays awake during the change; nothing was changed"
            }
        }
    }

    public let configurator: DisplayConfigurator
    public let waitLimit: TimeInterval
    private let assertions: DisplaySleepAssertions
    private let sleepState: () -> DisplaySleep.State
    private let pollNanoseconds: UInt64

    public init(configurator: DisplayConfigurator = .shared, waitLimit: TimeInterval = 2,
                assertions: DisplaySleepAssertions = PowerManagementAssertions(),
                sleepState: @escaping () -> DisplaySleep.State = DisplaySleep.stateNow,
                pollNanoseconds: UInt64 = 50_000_000) {
        self.configurator = configurator
        self.waitLimit = waitLimit
        self.assertions = assertions
        self.sleepState = sleepState
        self.pollNanoseconds = pollNanoseconds
    }

    private func sleepRefusal() -> Refusal? {
        switch sleepState() {
        case .awake: return nil
        case .asleep: return .displaysAsleep
        case .unknown(let why): return .sleepStateUnknown(why)
        }
    }

    /// The outstanding configuration, once `waitLimit` has passed without it returning.
    private func stillPending() async -> DisplayConfigurator.Pending? {
        let deadline = Date().addingTimeInterval(waitLimit)
        while let pending = configurator.pending {
            if Date() >= deadline { return pending }
            try? await Task.sleep(nanoseconds: pollNanoseconds)
        }
        return nil
    }

    /// Run `body` holding the sleep assertion, or return `refused` without running it.
    public func run<T>(_ reason: String, refused: (Refusal) -> T, _ body: () async throws -> T) async rethrows -> T {
        if let pending = await stillPending() { return refused(.configurationPending(pending)) }
        if let refusal = sleepRefusal() { return refused(refusal) }
        guard let held = assertions.hold(reason: reason) else { return refused(.assertionUnavailable) }
        defer { assertions.release(held) }
        if let refusal = sleepRefusal() { return refused(refusal) }
        return try await body()
    }
}
