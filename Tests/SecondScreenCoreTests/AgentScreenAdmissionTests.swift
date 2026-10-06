import Foundation
import Testing
@testable import SecondScreenCore

/// Concurrent screen requests against the real DisplayWork wait and the real
/// admission check. The registry mirrors AgentScreens.create: check, await
/// the display work (which can wait for a pending configuration), check
/// again, then append with no suspension in between. No display is made.
@MainActor
struct AgentScreenAdmissionTests {
    final class Assertions: DisplaySleepAssertions, @unchecked Sendable {
        func hold(reason: String) -> UInt32? { 1 }
        func release(_ id: UInt32) {}
    }

    @MainActor
    final class Registry {
        var names: [String] = []
        var prechecksPassed = 0
        let work: DisplayWork
        let limit: Int
        var ownerAlive: (pid_t) -> Bool = { _ in true }

        init(work: DisplayWork, limit: Int) {
            self.work = work
            self.limit = limit
        }

        /// nil when created, else why not.
        func create(_ name: String, owner: pid_t? = nil, recheck: Bool = true) async -> String? {
            if let refused = AgentScreenAdmission.failure(name: name, existing: names, limit: limit, ownerPID: owner, ownerAlive: ownerAlive) {
                return refused
            }
            prechecksPassed += 1
            return await work.run("create \(name)", refused: { $0.message() }) { () async -> String? in
                if recheck, let refused = AgentScreenAdmission.failure(name: name, existing: names, limit: limit, ownerPID: owner, ownerAlive: ownerAlive) {
                    return refused
                }
                names.append(name)
                return nil
            }
        }
    }

    /// A configurator with a transaction outstanding until the returned semaphore is signalled, so DisplayWork waits.
    nonisolated static func busy() -> (DisplayConfigurator, DispatchSemaphore) {
        let configurator = DisplayConfigurator(queue: DispatchQueue(label: "test"))
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        configurator.submit("arrangement") { entered.signal(); _ = release.wait(timeout: .now() + 5) }
        entered.wait()
        return (configurator, release)
    }

    func registry(limit: Int = 8) -> (Registry, DispatchSemaphore) {
        let (configurator, release) = Self.busy()
        return (Registry(work: DisplayWork(configurator: configurator, waitLimit: 5, assertions: Assertions(),
                                           sleepState: { .awake }, pollNanoseconds: 5_000_000), limit: limit), release)
    }

    /// Let other tasks run until `done` holds (bounded).
    func until(_ done: () -> Bool) async {
        for _ in 0..<1_000 where !done() { try? await Task.sleep(nanoseconds: 1_000_000) }
    }

    @Test func twoCreatesOfOneNameWhileTheWorkWaitsMakeOneScreen() async {
        let (r, release) = registry()
        defer { release.signal() }
        async let a = r.create("agent-1")
        async let b = r.create("agent-1")
        // Both are past the first check and waiting before the configuration returns.
        await until { r.prechecksPassed == 2 }
        release.signal()
        let results = await [a, b]
        #expect(r.prechecksPassed == 2, "both passed the first check while the other was waiting")
        #expect(r.names == ["agent-1"])
        #expect(results.filter { $0 == nil }.count == 1)
        #expect(results.contains("a screen named \"agent-1\" already exists"))
    }

    @Test func theLastSlotGoesToOneRequest() async {
        let (r, release) = registry(limit: 1)
        defer { release.signal() }
        async let a = r.create("agent-1")
        async let b = r.create("agent-2")
        await until { r.prechecksPassed == 2 }
        release.signal()
        let results = await [a, b]
        #expect(r.prechecksPassed == 2)
        #expect(r.names.count == 1)
        #expect(results.contains("at most 1 agent screens can exist at once"))
    }

    @Test func anOwnerThatExitsDuringTheWaitIsRefused() async {
        let (r, release) = registry()
        defer { release.signal() }
        var alive = true
        r.ownerAlive = { _ in alive }
        let pending = Task { await r.create("agent-1", owner: 4242) }
        await until { r.prechecksPassed == 1 }
        #expect(r.prechecksPassed == 1, "alive at the first check")
        alive = false
        release.signal()
        #expect(await pending.value == "owner pid 4242 is not running")
        #expect(r.names.isEmpty)
    }

    @Test func withoutTheSecondCheckBothWouldBeAdded() async {
        // The race the second check closes: the first check alone admits both.
        let (r, release) = registry()
        defer { release.signal() }
        async let a = r.create("agent-1", recheck: false)
        async let b = r.create("agent-1", recheck: false)
        await until { r.prechecksPassed == 2 }
        release.signal()
        _ = await [a, b]
        #expect(r.names == ["agent-1", "agent-1"])
    }

    @Test func admissionRules() {
        #expect(AgentScreenAdmission.failure(name: "a", existing: [], limit: 8, ownerPID: nil) == nil)
        #expect(AgentScreenAdmission.failure(name: "", existing: [], limit: 8, ownerPID: nil) != nil)
        #expect(AgentScreenAdmission.failure(name: "2ndscreen", existing: [], limit: 8, ownerPID: nil) != nil)
        #expect(AgentScreenAdmission.failure(name: "a", existing: ["a"], limit: 8, ownerPID: nil) == "a screen named \"a\" already exists")
        #expect(AgentScreenAdmission.failure(name: "b", existing: ["a"], limit: 1, ownerPID: nil) == "at most 1 agent screens can exist at once")
        #expect(AgentScreenAdmission.failure(name: "b", existing: [], limit: 8, ownerPID: 7, ownerAlive: { _ in false }) == "owner pid 7 is not running")
        #expect(AgentScreenAdmission.failure(name: "b", existing: [], limit: 8, ownerPID: getpid()) == nil, "the default check sees a live pid")
    }
}
