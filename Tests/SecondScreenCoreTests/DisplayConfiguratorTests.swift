import Foundation
import Testing
@testable import SecondScreenCore

/// Scheduling of display configuration, with no display: a "transaction" is
/// a closure that may block like a WindowServer call that never returns.
struct DisplayConfiguratorTests {
    /// A clock the test moves by hand.
    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = Date(timeIntervalSince1970: 1_000)
        func now() -> Date { lock.lock(); defer { lock.unlock() }; return value }
        func advance(_ seconds: TimeInterval) { lock.lock(); value += seconds; lock.unlock() }
    }

    /// Retries the test runs by hand instead of after a delay.
    final class Later: @unchecked Sendable {
        private let lock = NSLock()
        private var blocks: [() -> Void] = []
        var count: Int { lock.lock(); defer { lock.unlock() }; return blocks.count }
        func schedule(_ delay: TimeInterval, _ block: @escaping () -> Void) { lock.lock(); blocks.append(block); lock.unlock() }
        /// Run the oldest scheduled retry; false if none is waiting.
        @discardableResult
        func runNext() -> Bool {
            lock.lock()
            guard !blocks.isEmpty else { lock.unlock(); return false }
            let block = blocks.removeFirst()
            lock.unlock()
            block()
            return true
        }
    }

    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
        func add() { lock.lock(); value += 1; lock.unlock() }
    }

    private func make() -> (DisplayConfigurator, DispatchQueue, Clock) {
        let queue = DispatchQueue(label: "test.display-configuration")
        let clock = Clock()
        return (DisplayConfigurator(queue: queue, now: clock.now), queue, clock)
    }

    @Test func aHungTransactionNeitherBlocksTheCallerNorLetsOthersQueueBehindIt() throws {
        let (configurator, queue, clock) = make()
        let release = DispatchSemaphore(value: 0)
        // A failed expectation below must not leave the queue blocked; an extra signal is harmless.
        defer { release.signal() }
        let entered = DispatchSemaphore(value: 0)
        let ran = Counter()
        // Like CGCompleteDisplayConfiguration waiting on WindowServer.
        let first = configurator.submit("mode for display 352") {
            entered.signal()
            release.wait()
        }
        #expect(first == .started, "submit returned while the transaction is still running")
        entered.wait()
        clock.advance(5)
        let pending = try #require(configurator.pending)
        #expect(pending.label == "mode for display 352")
        #expect(pending.since == Date(timeIntervalSince1970: 1_000))
        #expect(configurator.stalled(longerThan: 2) == pending)
        #expect(configurator.stalled(longerThan: 10) == nil)
        // Every other submission is refused while it is outstanding, and dropped rather than queued.
        for k in 0..<20 {
            #expect(configurator.submit("retry \(k)") { ran.add() } == .busy(pending))
        }
        release.signal()
        queue.sync {}
        #expect(ran.count == 0, "nothing refused ran after the hung transaction returned")
        #expect(configurator.pending == nil)
        #expect(configurator.finishedCount == 1)
        #expect(configurator.submit("next") { ran.add() } == .started)
        queue.sync {}
        #expect(ran.count == 1)
    }

    @Test func completionRunsAfterTheConfiguratorIsFreeAgain() {
        let (configurator, queue, _) = make()
        let busyInCompletion = Counter()
        configurator.submit("one", {}) {
            if configurator.pending == nil { busyInCompletion.add() }
        }
        queue.sync {}
        #expect(busyInCompletion.count == 1)
    }

    @Test func modeStepPicksTheVariantOfTheRequestedScale() {
        let variants = [
            ModeSelection.Variant(width: 1440, height: 900, pixelWidth: 1440, id: 7),
            ModeSelection.Variant(width: 1440, height: 900, pixelWidth: 2880, id: 8),
        ]
        #expect(ModeSelection.step(width: 1440, height: 900, hiDPI: true, variants: variants, current: 7) == .switchTo(8))
        #expect(ModeSelection.step(width: 1440, height: 900, hiDPI: true, variants: variants, current: 8) == .settled)
        #expect(ModeSelection.step(width: 1440, height: 900, hiDPI: false, variants: variants, current: 8) == .switchTo(7))
        #expect(ModeSelection.step(width: 1920, height: 1080, hiDPI: true, variants: variants, current: 8) == .notListed)
        #expect(ModeSelection.step(width: 1440, height: 900, hiDPI: true, variants: [], current: nil) == .notListed)
    }

    private func selection(_ configurator: DisplayConfigurator, later: Later, generation: Int = 1, current: @escaping (Int) -> Bool = { _ in true },
                           reads: Counter, selects: Counter, listed: @escaping () -> [ModeSelection.Variant], now: @escaping () -> Int32?) -> ModeSelection {
        ModeSelection(label: "mode", width: 1440, height: 900, hiDPI: true, generation: generation, configurator: configurator,
                      read: { reads.add(); return (listed(), now()) }, select: { _ in selects.add() },
                      isCurrent: current, after: later.schedule)
    }

    @Test func modeSelectionStopsOnceSettledAndRetriesABoundedNumberOfTimes() {
        let (configurator, queue, _) = make()
        let later = Later()
        let reads = Counter(), selects = Counter()
        let hi = ModeSelection.Variant(width: 1440, height: 900, pixelWidth: 2880, id: 8)
        // Listed late, then switched, then current.
        var current: Int32? = 7
        var listed: [ModeSelection.Variant] = []
        let mode = selection(configurator, later: later, reads: reads, selects: selects, listed: { listed }, now: { current })
        mode.start(attempts: 30)
        queue.sync {}
        #expect(reads.count == 1 && selects.count == 0 && later.count == 1, "not listed yet: one retry scheduled")
        listed = [hi]
        later.runNext(); queue.sync {}
        #expect(selects.count == 1, "listed: switched once")
        current = 8
        later.runNext(); queue.sync {}
        #expect(reads.count == 3 && later.count == 0, "settled: no further attempt")

        // Never listed: exactly the attempt budget, then nothing more.
        let reads2 = Counter(), selects2 = Counter()
        selection(configurator, later: later, reads: reads2, selects: selects2, listed: { [] }, now: { nil }).start(attempts: 4)
        queue.sync {}
        while later.runNext() { queue.sync {} }
        #expect(reads2.count == 4)
        #expect(selects2.count == 0)
    }

    @Test func whileATransactionHangsModeAttemptsAreSpentWithoutQueueing() {
        let (configurator, queue, _) = make()
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let entered = DispatchSemaphore(value: 0)
        configurator.submit("hung") { entered.signal(); release.wait() }
        entered.wait()
        let later = Later()
        let reads = Counter(), selects = Counter()
        selection(configurator, later: later, reads: reads, selects: selects, listed: { [] }, now: { nil }).start(attempts: 5)
        // Each busy attempt schedules the next try itself; the budget ends the loop.
        var attempts = 1
        while later.runNext() { attempts += 1 }
        #expect(attempts == 5)
        release.signal()
        queue.sync {}
        #expect(reads.count == 0, "no attempt ran behind the hung transaction")
        #expect(configurator.finishedCount == 1)
    }

    @Test func aNewerRequestOrAReleasedDisplayEndsTheOldSelection() {
        let (configurator, queue, _) = make()
        let later = Later()
        let generation = Generation()
        let first = generation.bump()
        let reads = Counter(), selects = Counter()
        selection(configurator, later: later, generation: first, current: { generation.is($0) },
                  reads: reads, selects: selects, listed: { [] }, now: { nil }).start(attempts: 30)
        queue.sync {}
        #expect(reads.count == 1 && later.count == 1)
        generation.bump() // a resize, or deinit
        while later.runNext() { queue.sync {} }
        #expect(reads.count == 1, "the stale selection read nothing more")
        #expect(selects.count == 0)
    }
}
