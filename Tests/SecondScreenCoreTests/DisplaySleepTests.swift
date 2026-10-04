import CoreGraphics
import Foundation
import Testing
@testable import SecondScreenCore

/// The display-sleep preconditions and hold, with fake assertions and a fake
/// sleep state. No power assertion is taken and no display is read.
struct DisplaySleepTests {
    final class FakeAssertions: DisplaySleepAssertions, @unchecked Sendable {
        private let lock = NSLock()
        var refuse = false
        private var heldIDs: [UInt32: String] = [:]
        private var takenCount = 0
        private var releasedCount = 0
        private var next: UInt32 = 1
        var held: [UInt32: String] { lock.lock(); defer { lock.unlock() }; return heldIDs }
        var taken: Int { lock.lock(); defer { lock.unlock() }; return takenCount }
        var released: Int { lock.lock(); defer { lock.unlock() }; return releasedCount }
        func hold(reason: String) -> UInt32? {
            lock.lock(); defer { lock.unlock() }
            guard !refuse else { return nil }
            defer { next += 1 }
            heldIDs[next] = reason
            takenCount += 1
            return next
        }
        func release(_ id: UInt32) {
            lock.lock()
            let known = heldIDs.removeValue(forKey: id) != nil
            releasedCount += 1
            lock.unlock()
            #expect(known, "released only what was held, once")
        }
    }

    final class States: @unchecked Sendable {
        var queue: [DisplaySleep.State]
        init(_ states: [DisplaySleep.State]) { queue = states }
        func next() -> DisplaySleep.State { queue.count > 1 ? queue.removeFirst() : queue[0] }
    }

    struct Failure: Error {}

    /// Start a transaction that blocks until the returned semaphore is signalled.
    static func hang(_ configurator: DisplayConfigurator, _ label: String) -> DispatchSemaphore {
        let release = DispatchSemaphore(value: 0)
        let entered = DispatchSemaphore(value: 0)
        // Refused (another transaction still outstanding) or never started: fail rather than wait forever.
        guard configurator.submit(label, { entered.signal(); release.wait() }) == .started,
              entered.wait(timeout: .now() + 5) == .success
        else { Issue.record("the blocking transaction did not start"); return release }
        return release
    }

    private func work(_ assertions: FakeAssertions, _ states: States, configurator: DisplayConfigurator = DisplayConfigurator(queue: DispatchQueue(label: "test")),
                      waitLimit: TimeInterval = 0.2) -> DisplayWork {
        DisplayWork(configurator: configurator, waitLimit: waitLimit, assertions: assertions, sleepState: states.next, pollNanoseconds: 5_000_000)
    }

    private func physical(_ id: CGDirectDisplayID, active: Bool, asleep: Bool) -> DisplaySleep.Online {
        .init(id: id, active: active, asleep: asleep, virtual: false)
    }

    private func virtual(_ id: CGDirectDisplayID, active: Bool = true, asleep: Bool = false) -> DisplaySleep.Online {
        .init(id: id, active: active, asleep: asleep, virtual: true)
    }

    @Test func sleepIsJudgedOnActiveAndAsleepPhysicalDisplays() {
        // P0 after a wake expired: external (vendor 19501) inactive and asleep, built-in (vendor 1552) inactive, not asleep.
        #expect(DisplaySleep.state([physical(1, active: false, asleep: false), physical(2, active: false, asleep: true)]) == .asleep)
        // P0 earlier: both physical inactive and asleep, leftover virtual displays active and awake.
        #expect(DisplaySleep.state([physical(1, active: false, asleep: true), physical(2, active: false, asleep: true),
                                    virtual(352, active: false), virtual(355)]) == .asleep)
        // Normal use: an active, awake display.
        #expect(DisplaySleep.state([physical(1, active: true, asleep: false)]) == .awake)
        #expect(DisplaySleep.state([physical(1, active: true, asleep: false), physical(2, active: true, asleep: false), virtual(900)]) == .awake)
        // Closed lid with an external display in use: the idle built-in panel does not count.
        #expect(DisplaySleep.state([physical(1, active: false, asleep: false), physical(2, active: true, asleep: false)]) == .awake)
        // Hardware mirroring: the secondary is online but not active.
        #expect(DisplaySleep.state([physical(1, active: true, asleep: false), physical(2, active: false, asleep: false)]) == .awake)
        // One display asleep beside one in use is not display sleep.
        #expect(DisplaySleep.state([physical(1, active: true, asleep: false), physical(2, active: false, asleep: true)]) == .awake)
        // Every physical display inactive and none says asleep: not proved either way, and not headless.
        #expect(DisplaySleep.state([physical(1, active: false, asleep: false), virtual(355)])
                == .unknown("no physical display is active, and none reports asleep"))
        // No physical display at all: headless, on purpose; virtual displays' own state does not matter.
        #expect(DisplaySleep.state([virtual(352, active: false, asleep: true)]) == .awake)
        #expect(DisplaySleep.state([]) == .awake)
        #expect(DisplaySleep.state(nil) == .unknown("the online displays could not be listed"), "an unreadable list proves nothing")
    }

    @Test func asleepOrUnknownRefusesBeforeAnyWorkTransactionOrAssertion() async {
        for (state, prefix) in [(DisplaySleep.State.asleep, "the displays are asleep"), (.unknown("x"), "whether the displays are asleep is unknown (x)")] {
            let assertions = FakeAssertions()
            let configurator = DisplayConfigurator(queue: DispatchQueue(label: "test"))
            var ran = false
            let result = await work(assertions, States([state]), configurator: configurator).run("create", refused: { $0.message() }) { () async -> String in
                ran = true
                configurator.submit("transaction") {}
                return "created"
            }
            #expect(!ran, "nothing was created")
            #expect(result.hasPrefix(prefix), Comment(rawValue: result))
            #expect(configurator.finishedCount == 0 && configurator.pending == nil, "no native transaction")
            #expect(assertions.taken == 0, "the displays are neither woken nor held")
        }
    }

    @Test func sleepIsCheckedAgainWithTheHoldTaken() async {
        // Awake at the first check, asleep by the time the hold is in place: the hold does not wake it.
        let assertions = FakeAssertions()
        var ran = false
        let result = await work(assertions, States([.awake, .asleep])).run("create", refused: { $0 }) { () async -> DisplayWork.Refusal? in
            ran = true
            return nil
        }
        #expect(result == .displaysAsleep)
        #expect(!ran)
        #expect(assertions.taken == 1 && assertions.released == 1, "the hold taken for the recheck is released")
    }

    @Test func anUnavailableAssertionRefusesTheWork() async {
        let assertions = FakeAssertions()
        assertions.refuse = true
        var ran = false
        let result = await work(assertions, States([.awake])).run("create", refused: { $0 }) { () async -> DisplayWork.Refusal? in ran = true; return nil }
        #expect(result == .assertionUnavailable)
        #expect(!ran && assertions.released == 0)
    }

    /// A clock that only moves when the wait pauses; `onPause` runs at each pause with its number.
    final class PollClock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = Date(timeIntervalSince1970: 0)
        private(set) var pauses = 0
        var onPause: (Int) -> Void = { _ in }
        func now() -> Date { lock.lock(); defer { lock.unlock() }; return value }
        func pause(_ nanoseconds: UInt64) async {
            onPause(advance(nanoseconds))
        }
        private func advance(_ nanoseconds: UInt64) -> Int {
            lock.lock(); defer { lock.unlock() }
            pauses += 1
            value += TimeInterval(nanoseconds) / 1_000_000_000
            return pauses
        }
    }

    private func clocked(_ assertions: FakeAssertions, _ configurator: DisplayConfigurator, waitLimit: TimeInterval, _ clock: PollClock) -> DisplayWork {
        DisplayWork(configurator: configurator, waitLimit: waitLimit, assertions: assertions, sleepState: { .awake },
                    pollNanoseconds: 50_000_000, now: clock.now, pause: clock.pause)
    }

    @Test func aPendingConfigurationIsWaitedForBrieflyThenRefused() async {
        // Real configurator queue, no real time: the wait's clock moves 50 ms per poll, and the
        // test decides at which poll the outstanding transaction returns.
        let queue = DispatchQueue(label: "test")
        let configurator = DisplayConfigurator(queue: queue)
        let assertions = FakeAssertions()

        // Returns at the third poll, well within the 2 s limit: the work runs after it.
        let quick = Self.hang(configurator, "arrangement of 2 display(s)")
        defer { quick.signal() }
        let clock = PollClock()
        clock.onPause = { count in
            guard count == 3 else { return }
            quick.signal()
            queue.sync {} // the transaction has returned and the configurator is free
        }
        var ran = false
        let ok = await clocked(assertions, configurator, waitLimit: 2, clock).run("create", refused: { _ in false }) { () async -> Bool in
            ran = configurator.pending == nil
            return true
        }
        #expect(ok && ran, "ran only once the earlier transaction had returned")
        #expect(clock.pauses == 3)

        // Never returns: refused once the clock passes the limit. 0.12 s lies between poll steps,
        // so exactly three 50 ms pauses happen, with no rounding at the boundary.
        let stuck = Self.hang(configurator, "mode 1440×900 HiDPI for display 356")
        defer { stuck.signal() }
        let stuckClock = PollClock()
        var ranStuck = false
        let refusal = await clocked(assertions, configurator, waitLimit: 0.12, stuckClock).run("create", refused: { $0 }) { () async -> DisplayWork.Refusal? in
            ranStuck = true
            return nil
        }
        #expect(!ranStuck)
        #expect(stuckClock.pauses == 3, "bounded by the wait limit on the injected clock")
        guard case .configurationPending(let pending)? = refusal else { Issue.record("expected configurationPending"); return }
        #expect(pending.label == "mode 1440×900 HiDPI for display 356")
        #expect(refusal!.message().contains("it cannot be cancelled"))
        #expect(assertions.taken == 1, "only the first run took a hold")
    }

    @Test func theHoldIsReleasedOnReturnAndOnThrow() async throws {
        let assertions = FakeAssertions()
        let w = work(assertions, States([.awake]))
        let value = await w.run("create screen a", refused: { _ in -1 }) { () async -> Int in
            #expect(assertions.held.values.contains("create screen a"), "held while the work runs")
            return 7
        }
        #expect(value == 7)
        #expect(assertions.taken == 1 && assertions.released == 1 && assertions.held.isEmpty)
        await #expect(throws: Failure.self) {
            try await w.run("create screen b", refused: { _ in -1 }) { () async throws -> Int in throw Failure() }
        }
        #expect(assertions.taken == 2 && assertions.released == 2 && assertions.held.isEmpty, "released after a throw too")
        async let one = w.run("c", refused: { _ in -1 }) { () async -> Int in try? await Task.sleep(nanoseconds: 2_000_000); return 1 }
        async let two = w.run("d", refused: { _ in -1 }) { () async -> Int in try? await Task.sleep(nanoseconds: 1_000_000); return 2 }
        #expect(await one + two == 3)
        #expect(assertions.taken == 4 && assertions.released == 4 && assertions.held.isEmpty, "each overlapping run holds and releases its own")
    }
}
