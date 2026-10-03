import Foundation

/// When to play each packet of a live audio stream that arrives unevenly,
/// as a phone's does over Wi-Fi: steady for a while, then held back for up
/// to two seconds and delivered in a burst.
///
/// The buffer is as long as the network needs and no longer. Running dry
/// means it was too short for that hold-up, which lasted the buffer plus
/// how late the packet came: playing resumes after `margin`, and the
/// packets held back, which arrive together, fill the buffer to that length
/// again, so it grows by itself without dropping any. Staying well ahead
/// means it is too long: every
/// `window` seconds without running dry, it gives back half of the least
/// headroom it had, down to `minimum`. What it then has queued beyond the
/// new length plays a little faster until it is caught up, so nothing is
/// cut.
///
/// Times are seconds on the player's clock. Pure, so it is tested without
/// audio or a network.
public struct JitterBuffer {
    public var minimum = 0.2
    public var maximum = 2.0
    /// How soon playing resumes after running dry.
    public var margin = 0.15
    /// How long to watch the headroom before shrinking.
    public var window = 20.0
    /// Play faster while more than this is queued beyond the buffer, until
    /// at most `caughtUp` is.
    public var catchUpAbove = 0.12
    public var caughtUp = 0.03
    public var catchUpRate: Float = 1.05
    /// Packets queued this far beyond the buffer are dropped.
    public var dropAbove = 0.5

    /// Delay added on top of the buffer, to line the sound up with a
    /// picture that comes later; `setExtraDelay` changes it while playing.
    public private(set) var extraDelay = 0.0
    /// The buffer's length now, the extra delay included.
    public private(set) var latency: Double
    /// When the next packet is due; nil until the first.
    public private(set) var next: Double?
    private var rate: Float = 1
    private var windowStart = 0.0
    private var leastHeadroom = Double.infinity

    public enum Event: Equatable {
        /// Ran dry: the packet came this late, and the buffer grew.
        case grew(late: Double, to: Double)
        /// Steady: the buffer shrank.
        case shrank(to: Double)
        case dropped(queued: Double)
    }

    public struct Decision {
        /// When to play the packet, or nil to drop it.
        public var at: Double?
        /// The playback rate from now on.
        public var rate: Float
        public var event: Event?
    }

    public init(latency: Double = 0.2) {
        self.latency = latency
    }

    /// Change the extra delay. A longer one pauses the sound once by the
    /// difference; a shorter one is played off faster, like any excess.
    public mutating func setExtraDelay(_ delay: Double) {
        let change = max(0, delay) - extraDelay
        guard change != 0 else { return }
        extraDelay += change
        minimum += change
        maximum += change
        latency = max(minimum, latency + change)
        if change > 0, let due = next { next = due + change }
    }

    /// Start over on a new clock, keeping the buffer's length.
    public mutating func restart() {
        next = nil
    }

    /// Schedule a packet lasting `duration` that arrived at `now`.
    public mutating func schedule(now: Double, duration: Double) -> Decision {
        var event: Event?
        guard let due = next else {
            start(at: now)
            return play(at: now + latency, duration: duration, event: nil)
        }
        let headroom = due - now
        if headroom < 0.01 {
            // Ran dry, or about to: the hold-up outlasted the buffer.
            let late = max(-headroom, 0)
            latency = min(maximum, latency + late + margin)
            event = .grew(late: late, to: latency)
            rate = 1
            windowStart = now
            leastHeadroom = .infinity
            return play(at: now + margin, duration: duration, event: event)
        }
        if headroom > latency + dropAbove {
            return Decision(at: nil, rate: rate, event: .dropped(queued: headroom))
        }
        leastHeadroom = min(leastHeadroom, headroom)
        if now - windowStart >= window {
            // A whole window without running dry; keep half the spare.
            let spare = leastHeadroom - minimum
            if spare > 0.05 {
                latency = max(minimum, latency - spare / 2)
                event = .shrank(to: latency)
            }
            windowStart = now
            leastHeadroom = .infinity
        }
        if headroom > latency + catchUpAbove {
            rate = catchUpRate
        } else if headroom <= latency + caughtUp {
            rate = 1
        }
        return play(at: due, duration: duration, event: event)
    }

    private mutating func start(at now: Double) {
        windowStart = now
        leastHeadroom = .infinity
        rate = 1
    }

    private mutating func play(at time: Double, duration: Double, event: Event?) -> Decision {
        next = time + duration
        return Decision(at: time, rate: rate, event: event)
    }
}
