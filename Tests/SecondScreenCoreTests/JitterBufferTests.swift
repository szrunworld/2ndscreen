import Testing
@testable import SecondScreenCore

/// A phone sending 48 kHz AAC, 1024 samples a packet, through a network that
/// holds packets back during `stalls` (start, length in seconds) and then
/// delivers them at once. The player's clock runs at the buffer's rate.
struct Stream {
    static let duration = 1024.0 / 48000

    var buffer = JitterBuffer()
    var events: [JitterBuffer.Event] = []
    var underruns: Int { events.filter { if case .grew = $0 { true } else { false } }.count }
    var drops: Int { events.filter { if case .dropped = $0 { true } else { false } }.count }

    mutating func run(seconds: Double, from start: Double = 0, stalls: [(Double, Double)] = []) {
        var clock = clockAtEnd
        var lastArrival = start
        var rate: Float = lastRate
        let count = Int(seconds / Self.duration)
        for index in 0..<count {
            let sent = start + Double(index) * Self.duration
            var arrival = sent
            for (stallStart, length) in stalls where sent >= stallStart && sent < stallStart + length {
                arrival = stallStart + length
            }
            arrival = max(arrival, lastArrival)
            clock += (arrival - lastArrival) * Double(rate)
            lastArrival = arrival
            let decision = buffer.schedule(now: clock, duration: Self.duration)
            rate = decision.rate
            if let event = decision.event { events.append(event) }
        }
        clockAtEnd = clock + (start + seconds - lastArrival) * Double(rate)
        lastRate = rate
    }

    private var clockAtEnd = 0.0
    private var lastRate: Float = 1
}

@Suite struct JitterBufferTests {
    @Test func aSteadyNetworkKeepsTheShortestBuffer() {
        var stream = Stream()
        stream.run(seconds: 60)
        #expect(stream.underruns == 0)
        #expect(stream.drops == 0)
        #expect(stream.buffer.latency == 0.2)
    }

    @Test func oneStallGrowsTheBufferEnoughForTheNext() {
        var stream = Stream()
        stream.run(seconds: 30, stalls: [(10, 1.2), (20, 1.2)])
        #expect(stream.underruns == 1)
        #expect(stream.buffer.latency >= 1.2)
        #expect(stream.drops == 0)
    }

    @Test func aSteadyNetworkAfterStallsShrinksTheBufferAgain() {
        var stream = Stream()
        stream.run(seconds: 20, stalls: [(5, 1.5)])
        let grown = stream.buffer.latency
        #expect(grown >= 1.5)
        stream.run(seconds: 120, from: 20)
        #expect(stream.underruns == 1)
        #expect(stream.buffer.latency < 0.5)
        #expect(stream.events.contains { if case .shrank = $0 { true } else { false } })
    }

    @Test func theBufferStopsAtTheMaximum() {
        var stream = Stream()
        stream.run(seconds: 11, stalls: [(5, 5)])
        #expect(stream.buffer.latency == 2.0)
    }

    @Test func shortJitterNeverRunsDry() {
        // Wi-Fi with its power saving on: a 150 ms hold every second.
        var stream = Stream()
        let stalls = (1..<60).map { (Double($0), 0.15) }
        stream.run(seconds: 60, stalls: stalls)
        #expect(stream.underruns == 0)
        #expect(stream.drops == 0)
    }

    @Test func startingOverKeepsTheBuffer() {
        var stream = Stream()
        stream.run(seconds: 20, stalls: [(5, 1.0)])
        let grown = stream.buffer.latency
        stream.buffer.restart()
        let first = stream.buffer.schedule(now: 0, duration: Stream.duration)
        #expect(first.at == grown)
        #expect(first.event == nil)
    }

    @Test func extraDelayMovesTheSoundLater() {
        var stream = Stream()
        stream.run(seconds: 10)
        let before = stream.buffer.next!
        stream.buffer.setExtraDelay(0.5)
        #expect(abs(stream.buffer.next! - (before + 0.5)) < 1e-9)
        #expect(abs(stream.buffer.latency - 0.7) < 1e-9)
        stream.run(seconds: 30, from: 10)
        #expect(stream.underruns == 0)
        #expect(stream.drops == 0)
        #expect(stream.buffer.latency >= 0.7)
        stream.buffer.setExtraDelay(0)
        #expect(abs(stream.buffer.latency - 0.2) < 1e-9)
    }
}
