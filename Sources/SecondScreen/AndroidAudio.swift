import AVFoundation
import CoreMedia
import os
import SecondScreenCore

/// Plays a phone's AAC audio stream on the Mac.
///
/// Packets are timed on the Mac's clock rather than the phone's: each one is
/// due right after the one before, a little ahead of now. The two clocks
/// drift apart, and the phone sends nothing while it is silent, so playing to
/// the phone's timestamps would slowly add delay or leave gaps.
///
/// Over Wi-Fi the phone's packets come in bursts after hold-ups of up to two
/// seconds, as long as its power saving or the network likes. A
/// `JitterBuffer` decides when each plays: it grows the buffer to cover the
/// hold-ups it meets and shrinks it again while the network is steady,
/// playing the excess off at 5% faster, pitch kept.
/// Thread use: the mirror's audio reader thread only.
final class AndroidAudioPlayer {
    /// Delay added to line the sound up with the picture, in seconds. The
    /// phone's player holds its picture back by its speaker's latency, which
    /// the captured sound skips, so the sound comes early: 1 s lined it up by
    /// ear on a Honor phone over Wi-Fi. Set from the menu (Android Phones →
    /// Sound Delay) or `defaults write io.github.szrunworld.2ndscreen
    /// androidAudioDelay -float SECONDS`; it takes effect at once.
    static var extraDelay: Double {
        get { UserDefaults.standard.object(forKey: "androidAudioDelay") as? Double ?? 1 }
        set { UserDefaults.standard.set(newValue, forKey: "androidAudioDelay") }
    }

    /// How the buffer grows and shrinks, for `log stream --predicate 'category == "android-audio"'`.
    private static let log = Logger(subsystem: "io.github.szrunworld.2ndscreen", category: "android-audio")

    private let renderer = AVSampleBufferAudioRenderer()
    private let synchronizer = AVSampleBufferRenderSynchronizer()
    private var format: CMAudioFormatDescription?
    private var packetDuration = CMTime(value: 1024, timescale: 48000)
    private var jitter = JitterBuffer()
    /// The rate last set. The synchronizer's own reads back 0 for a while
    /// after a change to anything but 1.
    private var rate: Float = 0
    /// The clock's last reading, and when on the host clock it changed.
    private var lastClock = -1.0
    private var lastClockChange = CACurrentMediaTime()

    init() {
        renderer.audioTimePitchAlgorithm = .timeDomain
        // By default the clock waits for enough audio before it moves; with
        // the buffer judging by the clock, a wait that drops what arrives
        // never ends.
        synchronizer.delaysRateChangeUntilHasSufficientMediaData = false
        synchronizer.addRenderer(renderer)
    }

    /// Take the stream's AudioSpecificConfig, from scrcpy's config packet.
    func configure(_ config: Data) {
        let bytes = [UInt8](config)
        guard bytes.count >= 2 else { return }
        // 5 bits object type, 4 bits sample rate index, 4 bits channels.
        let rates: [Float64] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
        let rateIndex = Int((bytes[0] & 0x07) << 1 | bytes[1] >> 7)
        let channels = UInt32((bytes[1] >> 3) & 0x0F)
        guard rateIndex < rates.count, channels > 0 else { return }
        var description = AudioStreamBasicDescription(
            mSampleRate: rates[rateIndex], mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0,
            mBytesPerPacket: 0, mFramesPerPacket: 1024, mBytesPerFrame: 0,
            mChannelsPerFrame: channels, mBitsPerChannel: 0, mReserved: 0)
        var format: CMAudioFormatDescription?
        let status = bytes.withUnsafeBytes {
            CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault, asbd: &description, layoutSize: 0, layout: nil,
                magicCookieSize: bytes.count, magicCookie: $0.baseAddress, extensions: nil,
                formatDescriptionOut: &format)
        }
        guard status == noErr else { return }
        self.format = format
        packetDuration = CMTime(value: 1024, timescale: CMTimeScale(rates[rateIndex]))
    }

    /// Queue one AAC packet; returns how long until it plays, or nil if dropped.
    @discardableResult
    func play(_ packet: Data) -> Double? {
        guard let format, !packet.isEmpty else { return nil }
        if renderer.status == .failed { renderer.flush() }
        if rate == 0 { setRate(1, time: .zero) }
        jitter.setExtraDelay(Self.extraDelay)
        var now = synchronizer.currentTime()
        let host = CACurrentMediaTime()
        if now.seconds != lastClock {
            lastClock = now.seconds
            lastClockChange = host
        } else if host - lastClockChange > 1 {
            // The clock stopped anyway; start a new one.
            Self.log.info("clock stopped; starting again")
            renderer.flush()
            setRate(1, time: .zero)
            jitter.restart()
            now = .zero
            lastClock = 0
            lastClockChange = host
        }
        let decision = jitter.schedule(now: now.seconds, duration: packetDuration.seconds)
        switch decision.event {
        case .grew(let late, let latency):
            Self.log.info("ran dry, \(Int(late * 1000)) ms late; buffer now \(Int(latency * 1000)) ms")
        case .shrank(let latency):
            Self.log.info("steady; buffer now \(Int(latency * 1000)) ms")
        case .dropped(let queued):
            Self.log.info("dropped a packet, \(Int(queued * 1000)) ms queued")
        case nil:
            break
        }
        if decision.rate != rate { setRate(decision.rate, time: now) }
        guard let at = decision.at,
              let sample = sampleBuffer(packet, format: format, at: CMTime(seconds: at, preferredTimescale: 48000))
        else { return nil }
        renderer.enqueue(sample)
        return (at - now.seconds) / Double(rate == 0 ? 1 : rate)
    }

    func stop() {
        setRate(0, time: .zero)
        renderer.flush()
    }

    private func setRate(_ rate: Float, time: CMTime) {
        self.rate = rate
        synchronizer.setRate(rate, time: time)
    }

    private func sampleBuffer(_ packet: Data, format: CMAudioFormatDescription, at time: CMTime) -> CMSampleBuffer? {
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: packet.count,
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
            dataLength: packet.count, flags: kCMBlockBufferAssureMemoryNowFlag,
            blockBufferOut: &block) == noErr, let block else { return nil }
        let copied = packet.withUnsafeBytes {
            CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block,
                                          offsetIntoDestination: 0, dataLength: packet.count)
        }
        guard copied == noErr else { return nil }
        var description = AudioStreamPacketDescription(
            mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))
        var sample: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
            sampleCount: 1, presentationTimeStamp: time, packetDescriptions: &description,
            sampleBufferOut: &sample) == noErr else { return nil }
        return sample
    }
}
