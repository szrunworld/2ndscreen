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

    @Test func sleepIsJudgedOnOnlinePhysicalDisplays() {
        // P0: physical 1 and 2 online, inactive and asleep; leftover virtual displays awake and active.
        let p0: [DisplaySleep.Online] = [
            .init(id: 1, asleep: true, virtual: false), .init(id: 2, asleep: true, virtual: false),
            .init(id: 352, asleep: false, virtual: true), .init(id: 355, asleep: false, virtual: true),
        ]
        #expect(DisplaySleep.state(p0) == .asleep)
        #expect(DisplaySleep.state([.init(id: 1, asleep: true, virtual: false), .init(id: 2, asleep: false, virtual: false)]) == .awake,
                "one physical display awake is not display sleep")
        #expect(DisplaySleep.state([.init(id: 352, asleep: true, virtual: true)]) == .awake, "headless, on purpose")
        #expect(DisplaySleep.state([]) == .awake, "headless, on purpose")
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

    @Test func aPendingConfigurationIsWaitedForBrieflyThenRefused() async {
        let configurator = DisplayConfigurator(queue: DispatchQueue(label: "test"))
        let assertions = FakeAssertions()
        // Returns within the wait: the work runs after it.
        let quick = Self.hang(configurator, "arrangement of 2 display(s)")
        defer { quick.signal() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.03) { quick.signal() }
        var ran = false
        let ok = await work(assertions, States([.awake]), configurator: configurator, waitLimit: 2).run("create", refused: { _ in false }) { () async -> Bool in
            ran = configurator.pending == nil
            return true
        }
        #expect(ok && ran, "ran only once the earlier transaction had returned")
        // Never returns within the wait: refused, with what is known.
        let stuck = Self.hang(configurator, "mode 1440×900 HiDPI for display 356")
        // A failed expectation below must not leave the queue blocked; an extra signal is harmless.
        defer { stuck.signal() }
        let started = Date()
        var ranStuck = false
        let refusal = await work(assertions, States([.awake]), configurator: configurator, waitLimit: 0.1).run("create", refused: { $0 }) { () async -> DisplayWork.Refusal? in
            ranStuck = true
            return nil
        }
        #expect(!ranStuck)
        #expect(Date().timeIntervalSince(started) < 1, "bounded by the wait limit")
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
