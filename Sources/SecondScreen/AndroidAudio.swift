import AVFoundation
import CoreMedia

/// Plays a phone's AAC audio stream on the Mac.
///
/// Packets are timed on the Mac's clock rather than the phone's: each one is
/// due right after the one before, a little ahead of now. The two clocks
/// drift apart, and the phone sends nothing while it is silent, so playing to
/// the phone's timestamps would slowly add delay or leave gaps. Instead,
/// running dry starts a fresh short buffer, and running too far ahead drops
/// packets.
/// Thread use: the mirror's audio reader thread only.
final class AndroidAudioPlayer {
    /// How far ahead of now playback restarts after running dry.
    private static let latency = CMTime(value: 60, timescale: 1000)
    /// Packets due later than this are dropped.
    private static let maxAhead = CMTime(value: 250, timescale: 1000)

    private let renderer = AVSampleBufferAudioRenderer()
    private let synchronizer = AVSampleBufferRenderSynchronizer()
    private var format: CMAudioFormatDescription?
    private var packetDuration = CMTime(value: 1024, timescale: 48000)
    private var next = CMTime.invalid

    init() {
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

    /// Queue one AAC packet.
    func play(_ packet: Data) {
        guard let format, !packet.isEmpty else { return }
        if renderer.status == .failed { renderer.flush() }
        let now = synchronizer.currentTime()
        if synchronizer.rate == 0 {
            synchronizer.setRate(1, time: .zero)
            next = Self.latency
        } else if !next.isValid || next < now + CMTime(value: 10, timescale: 1000) {
            next = now + Self.latency
        } else if next > now + Self.maxAhead {
            return
        }
        guard let sample = sampleBuffer(packet, format: format, at: next) else { return }
        renderer.enqueue(sample)
        next = next + packetDuration
    }

    func stop() {
        synchronizer.setRate(0, time: .zero)
        renderer.flush()
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
