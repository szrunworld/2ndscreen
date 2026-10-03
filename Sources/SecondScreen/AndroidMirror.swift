import CoreMedia
import os
import QuartzCore
import Foundation
import SecondScreenCore

/// One mirroring session with an Android device, speaking scrcpy's protocol.
///
/// adb pushes scrcpy-server to the device and runs it there with shell
/// rights, which let it capture the screen with the hardware encoder and
/// inject input without any app or prompt on the phone. Up to three sockets
/// come back through an adb forward: H.264 video, AAC audio, and control
/// messages the other way. See doc/develop.md in scrcpy's repository.
/// Thread use: the reader threads own the sockets' read sides, writes go
/// through `controlQueue`, `lock` guards the rest that they share, and the
/// sizes and callbacks belong to the main queue.
final class AndroidMirror: @unchecked Sendable {
    /// Must match the bundled scrcpy-server (scripts/fetch-android-tools.sh).
    static let serverVersion = "4.1"
    private static let devicePath = "/data/local/tmp/scrcpy-server.jar"

    enum Failure: LocalizedError {
        case setup(String)

        var errorDescription: String? {
            switch self {
            case .setup(let message): return message
            }
        }
    }

    let serial: String
    private(set) var deviceName = ""
    /// The display's size in pixels in its natural orientation, as
    /// `adb shell input` and `screencap` use it. The video may be smaller.
    private(set) var deviceSize = CGSize.zero
    /// The video size in pixels; touches are sent in this space. Main queue only.
    private(set) var videoSize = CGSize.zero

    /// Called on the main queue when the video size changes, such as when
    /// the device rotates.
    var onVideoSize: ((CGSize) -> Void)?
    /// Called on the reader thread for each frame, ready to enqueue.
    var onFrame: ((CMSampleBuffer) -> Void)?
    /// Called once on the main queue when the session ends, with the reason
    /// if it was not `stop()`.
    var onEnd: ((String?) -> Void)?

    private var server: Process?
    private var serverLog = Data()
    private var port: UInt16 = 0
    private var videoFD: Int32 = -1
    private var audioFD: Int32 = -1
    private var controlFD: Int32 = -1
    /// Set once the phone has agreed to send audio.
    private var audioPlayer: AndroidAudioPlayer?
    private let controlQueue = DispatchQueue(label: "2ndscreen.android.control")
    private let lock = NSLock()
    private var stopped = false
    private let avSkew = AVSkew()
    private var video = true
    private var audio = true

    init(serial: String) {
        self.serial = serial
    }

    /// Start the server and open both sockets. Blocks for a few seconds;
    /// call off the main thread, then `startStreaming()`.
    /// - Parameter video: false for a control-only session, which streams
    ///   nothing and only types and presses keys for agents.
    /// - Parameter audio: also play the phone's sound on the Mac, with
    ///   video only. The phone goes quiet meanwhile, as it does with
    ///   scrcpy's default source, which is the only one that captures every app.
    func start(maxSize: Int, video: Bool = true, audio: Bool = true) throws {
        self.video = video
        self.audio = video && audio
        guard let server = Bundle.main.url(forResource: "scrcpy-server", withExtension: nil,
                                           subdirectory: "android") else {
            throw Failure.setup("scrcpy-server is missing from the app; rebuild it with scripts/bundle-app.sh")
        }
        let push = try ADB.run(["-s", serial, "push", server.path, Self.devicePath], timeout: 60)
        guard push.ok else { throw Failure.setup("Could not copy the mirroring server to the phone: \(push.message)") }

        // "Override size" wins over "Physical size" when both are listed.
        let size = try ADB.run(["-s", serial, "shell", "wm", "size"], timeout: 15).output
        if let line = size.split(separator: "\n").last(where: { $0.contains("size:") }),
           let dimensions = line.split(separator: ":").last?.trimmingCharacters(in: .whitespaces) {
            let parts = dimensions.split(separator: "x").compactMap { Double($0) }
            if parts.count == 2 { deviceSize = CGSize(width: parts[0], height: parts[1]) }
        }

        let scid = String(format: "%08x", UInt32.random(in: 0..<0x8000_0000))
        let forward = try ADB.run(["-s", serial, "forward", "tcp:0", "localabstract:scrcpy_\(scid)"])
        guard forward.ok, let port = UInt16(forward.output.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw Failure.setup("Could not open a tunnel to the phone: \(forward.message)")
        }
        self.port = port

        let process = try ADB.makeProcess([
            "-s", serial, "shell", "CLASSPATH=\(Self.devicePath)", "app_process", "/",
            "com.genymobile.scrcpy.Server", Self.serverVersion, "scid=\(scid)", "log_level=info",
            "tunnel_forward=true", "audio=\(self.audio)", "audio_codec=aac", "video=\(video)", "video_codec=h264", "video_bit_rate=3000000", "max_size=\(maxSize)",
            "clipboard_autosync=false",
        ])
        // Keep the server's output for the error message if it fails.
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        process.standardInput = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil  // end of output
                return
            }
            guard let self else { return }
            self.lock.withLock {
                self.serverLog.append(data)
                if self.serverLog.count > 16_384 { self.serverLog.removeFirst(self.serverLog.count - 16_384) }
            }
        }
        try process.run()
        self.server = process

        do {
            // The forward accepts at once but closes the connection until the
            // server listens; the dummy byte shows the server is there.
            // The device name comes on the first socket, once the server
            // has accepted every socket it expects.
            let first = try connectWhenReady(process: process)
            if video {
                videoFD = first
                if audio { audioFD = try openSocket() }
                controlFD = try openSocket()
            } else {
                controlFD = first
            }
            var name = try readExactly(first, 64)
            name = name.prefix { $0 != 0 }
            deviceName = String(decoding: name, as: UTF8.self)
            guard video else {
                setReceiveTimeout(first, seconds: 0)
                return
            }
            let codec = try readExactly(videoFD, 4).bigEndianUInt32(at: 0)
            guard codec == 0x6832_3634 else {  // "h264"
                throw Failure.setup(codec <= 1
                    ? "The phone could not start screen capture.\(serverError())"
                    : "The phone sent an unexpected video format.")
            }
            if audioFD >= 0 {
                // 0 means the phone cannot capture audio (before Android
                // 11), 1 that capture failed; mirror without sound then.
                let audioCodec = try readExactly(audioFD, 4).bigEndianUInt32(at: 0)
                if audioCodec == 0x0061_6163 {  // "\0aac"
                    audioPlayer = AndroidAudioPlayer()
                }
            }
            // Video stops while the screen does not change, audio while the
            // phone is silent, and the control socket is quiet; wait as long
            // as it takes.
            for fd in [videoFD, audioFD, controlFD] where fd >= 0 {
                setReceiveTimeout(fd, seconds: 0)
            }
        } catch {
            stop()
            throw error
        }

    }

    /// Start reading video once the callbacks are set: the first key frame
    /// comes right away, and without it nothing shows until the next one.
    func startStreaming() {
        if video {
            Thread.detachNewThread { [weak self] in self?.readVideo() }
        }
        if audioPlayer != nil {
            Thread.detachNewThread { [weak self] in self?.readAudio() }
        }
        Thread.detachNewThread { [weak self] in self?.drainControl() }
    }

    func stop() {
        let alreadyStopped = lock.withLock {
            defer { stopped = true }
            return stopped
        }
        guard !alreadyStopped else { return }
        // Shutting the sockets down wakes the reader threads.
        for fd in [videoFD, audioFD, controlFD] where fd >= 0 {
            shutdown(fd, SHUT_RDWR)
        }
        server?.terminate()
        if port != 0 {
            let serial = serial, port = port
            DispatchQueue.global().async {
                _ = try? ADB.run(["-s", serial, "forward", "--remove", "tcp:\(port)"], timeout: 5)
            }
        }
    }

    private var isStopped: Bool { lock.withLock { stopped } }

    private func end(_ reason: String?) {
        let wasStopped = isStopped
        stop()
        DispatchQueue.main.async { [weak self] in
            self?.onEnd?(wasStopped ? nil : reason)
            self?.onEnd = nil
        }
    }

    private func serverError() -> String {
        let log = lock.withLock { String(decoding: serverLog, as: UTF8.self) }
        let errors = log.split(separator: "\n").filter { $0.contains("ERROR") || $0.contains("Exception") }
        return errors.isEmpty ? "" : "\n\n" + errors.suffix(3).joined(separator: "\n")
    }

    // MARK: Sockets

    private func openSocket() throws -> Int32 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure.setup("socket: \(String(cString: strerror(errno)))") }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard connected == 0 else {
            close(fd)
            throw Failure.setup("Could not reach the tunnel: \(String(cString: strerror(errno)))")
        }
        var one: Int32 = 1
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
        // Setup gives up rather than hang on a slow or stuck phone; the
        // sockets go back to blocking once it is done.
        setReceiveTimeout(fd, seconds: 10)
        return fd
    }

    private func setReceiveTimeout(_ fd: Int32, seconds: Int) {
        var timeout = timeval(tv_sec: seconds, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    }

    private func connectWhenReady(process: Process) throws -> Int32 {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            guard process.isRunning else {
                throw Failure.setup("The mirroring server stopped on the phone.\(serverError())")
            }
            if let fd = try? openSocket() {
                if (try? readExactly(fd, 1)) != nil { return fd }
                close(fd)
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw Failure.setup("The phone did not start the mirroring server in time.\(serverError())")
    }

    // MARK: Video

    private func readVideo() {
        var format: CMVideoFormatDescription?
        do {
            while true {
                let header = try readExactly(videoFD, 12)
                if header[header.startIndex] & 0x80 != 0 {
                    // A session packet: a new capture, such as after rotation.
                    let size = CGSize(width: Int(header.bigEndianUInt32(at: 4)),
                                      height: Int(header.bigEndianUInt32(at: 8)))
                    // Touches are built on the main queue, so the size lives there.
                    DispatchQueue.main.async { [weak self] in
                        self?.videoSize = size
                        self?.onVideoSize?(size)
                    }
                    continue
                }
                let isConfig = header[header.startIndex] & 0x40 != 0
                let length = Int(header.bigEndianUInt32(at: 8))
                let packet = try readExactly(videoFD, length)
                var units = H264.nalUnits(in: packet)
                // Parameter sets come in config packets, and some encoders
                // repeat them before key frames.
                let sps = units.last { H264.type(of: $0) == 7 }
                let pps = units.last { H264.type(of: $0) == 8 }
                if let sps, let pps {
                    format = H264.formatDescription(sps: sps, pps: pps) ?? format
                }
                units.removeAll { [7, 8].contains(H264.type(of: $0)) }
                guard !isConfig, !units.isEmpty, let format,
                      let sample = H264.sampleBuffer(units: units, format: format) else { continue }
                avSkew.video(pts: header.pts, at: CACurrentMediaTime())
                onFrame?(sample)
            }
        } catch {
            end("The connection to the phone was lost.\(serverError())")
        }
    }

    // MARK: Audio

    /// Play audio packets until the socket closes. Losing audio alone
    /// leaves the mirror running; the video reader reports the phone going away.
    private func readAudio() {
        guard let audioPlayer else { return }
        defer { audioPlayer.stop() }
        while let header = try? readExactly(audioFD, 12),
              let packet = try? readExactly(audioFD, Int(header.bigEndianUInt32(at: 8))) {
            let flags = header[header.startIndex]
            if flags & 0x80 != 0 { continue }  // a session packet; video's concern
            if flags & 0x40 != 0 {
                audioPlayer.configure(packet)
            } else {
                let arrival = CACurrentMediaTime()
                if let queued = audioPlayer.play(packet) {
                    avSkew.audio(pts: header.pts, playsAt: arrival + queued)
                }
            }
        }
    }

    /// The device sends clipboard messages on the control socket; read and
    /// drop them so they never fill its buffer.
    private func drainControl() {
        var buffer = [UInt8](repeating: 0, count: 4096)
        while read(controlFD, &buffer, buffer.count) > 0 {}
        // Without video, nothing else notices the phone going away.
        if !video { end("The connection to the phone was lost.") }
    }

    // MARK: Control

    enum TouchAction: UInt8 {
        case down = 0, up = 1, move = 2
    }

    /// A point in device pixels, as agents and `adb shell input` give them,
    /// in video pixels. Comparing long sides works in either orientation.
    func videoPoint(fromDevice point: CGPoint) -> CGPoint? {
        let device = max(deviceSize.width, deviceSize.height)
        let video = max(videoSize.width, videoSize.height)
        guard device > 0, video > 0 else { return nil }
        return CGPoint(x: point.x * video / device, y: point.y * video / device)
    }

    /// A finger touch at a point in video pixels.
    func touch(_ action: TouchAction, at point: CGPoint) {
        guard let message = touchMessage(action, at: point) else { return }
        send(message)
    }

    /// Press, slide to `end` in even steps over `duration`, and lift, all
    /// in video pixels. Returns once the last step is sent.
    func swipe(from start: CGPoint, to end: CGPoint, duration: TimeInterval) async {
        let steps = max(2, Int(duration * 60))
        var messages = [touchMessage(.down, at: start)]
        for step in 1...steps {
            let t = CGFloat(step) / CGFloat(steps)
            messages.append(touchMessage(.move, at: CGPoint(x: start.x + (end.x - start.x) * t,
                                                           y: start.y + (end.y - start.y) * t)))
        }
        messages.append(touchMessage(.up, at: end))
        let interval = useconds_t(duration / Double(steps) * 1_000_000)
        let ready = messages.compactMap { $0 }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            controlQueue.async { [weak self] in
                for message in ready {
                    self?.write(message)
                    usleep(interval)
                }
                done.resume()
            }
        }
    }

    /// Wait until every message so far has been written.
    func flush() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            controlQueue.async { done.resume() }
        }
    }

    private func touchMessage(_ action: TouchAction, at point: CGPoint) -> Data? {
        guard videoSize.width > 0 else { return nil }
        var message = Data([2, action.rawValue])
        message.appendBigEndian(UInt64.max - 1)  // a generic finger, not the mouse
        appendPosition(point, to: &message)
        message.appendBigEndian(UInt16(action == .up ? 0 : 0xFFFF))  // pressure
        message.appendBigEndian(UInt32(0))  // action button
        message.appendBigEndian(UInt32(0))  // buttons
        return message
    }

    /// Scroll amounts are in wheel notches, clamped to ±16.
    func scroll(at point: CGPoint, horizontal: Double, vertical: Double) {
        guard videoSize.width > 0 else { return }
        func fixedPoint(_ value: Double) -> UInt16 {
            let clamped = max(-1, min(1, value / 16))
            return UInt16(bitPattern: Int16(max(-0x8000, min(0x7FFF, clamped * 0x8000))))
        }
        var message = Data([3])
        appendPosition(point, to: &message)
        message.appendBigEndian(fixedPoint(horizontal))
        message.appendBigEndian(fixedPoint(vertical))
        message.appendBigEndian(UInt32(0))
        send(message)
    }

    /// Press and release an Android key, such as `AndroidKey.home`.
    func press(_ keycode: UInt32, metaState: UInt32 = 0) {
        for action: UInt8 in [0, 1] {
            var message = Data([0, action])
            message.appendBigEndian(keycode)
            message.appendBigEndian(UInt32(0))  // repeat
            message.appendBigEndian(metaState)
            send(message)
        }
    }

    /// Back, or turn the screen on if it is off.
    func back() {
        send(Data([4, 0]))
        send(Data([4, 1]))
    }

    /// Type text. Android can only inject characters its keyboard map has,
    /// so other text, such as Chinese, goes through the clipboard and is pasted.
    func type(_ text: String) {
        guard !text.isEmpty else { return }
        if text.unicodeScalars.allSatisfy({ $0.isASCII && $0.value >= 0x20 }) {
            for chunk in text.utf8.chunked(300) {
                var message = Data([1])
                message.appendBigEndian(UInt32(chunk.count))
                message.append(contentsOf: chunk)
                send(message)
            }
        } else {
            paste(text)
        }
    }

    /// Put text on the phone's clipboard and paste it into the focused field.
    func paste(_ text: String) {
        let bytes = Array(text.utf8.prefix(200_000))
        var message = Data([9])
        message.appendBigEndian(UInt64(0))  // no acknowledgement wanted
        message.append(1)  // paste
        message.appendBigEndian(UInt32(bytes.count))
        message.append(contentsOf: bytes)
        send(message)
    }

    private func appendPosition(_ point: CGPoint, to message: inout Data) {
        message.appendBigEndian(UInt32(bitPattern: Int32(point.x.rounded())))
        message.appendBigEndian(UInt32(bitPattern: Int32(point.y.rounded())))
        message.appendBigEndian(UInt16(videoSize.width))
        message.appendBigEndian(UInt16(videoSize.height))
    }

    private func send(_ message: Data) {
        controlQueue.async { [weak self] in self?.write(message) }
    }

    /// On the control queue only.
    private func write(_ message: Data) {
        guard !isStopped, controlFD >= 0 else { return }
        try? writeAll(controlFD, message)
    }

    deinit {
        stop()
        for fd in [videoFD, audioFD, controlFD] where fd >= 0 {
            close(fd)
        }
    }
}

/// Android keycodes used by the mirror window and agents.
enum AndroidKey {
    /// A keycode from a name such as "home", "KEYCODE_HOME" or "3".
    static func code(named name: String) -> UInt32? {
        let key = name.lowercased().replacingOccurrences(of: "keycode_", with: "")
        if let number = UInt32(key) { return number }
        let names: [String: UInt32] = [
            "home": home, "back": back, "up": up, "down": down, "left": left, "right": right,
            "volume_up": volumeUp, "volume_down": volumeDown, "power": power, "tab": tab,
            "enter": enter, "return": enter, "del": delete, "delete": delete, "backspace": delete,
            "forward_del": forwardDelete, "page_up": pageUp, "page_down": pageDown,
            "move_home": moveHome, "move_end": moveEnd, "app_switch": appSwitch, "recents": appSwitch,
            "escape": 111, "menu": 82, "search": 84, "space": 62, "wakeup": 224, "sleep": 223,
        ]
        return names[key]
    }


    static let home: UInt32 = 3
    static let back: UInt32 = 4
    static let up: UInt32 = 19
    static let down: UInt32 = 20
    static let left: UInt32 = 21
    static let right: UInt32 = 22
    static let volumeUp: UInt32 = 24
    static let volumeDown: UInt32 = 25
    static let power: UInt32 = 26
    static let tab: UInt32 = 61
    static let enter: UInt32 = 66
    static let delete: UInt32 = 67
    static let pageUp: UInt32 = 92
    static let pageDown: UInt32 = 93
    static let forwardDelete: UInt32 = 112
    static let moveHome: UInt32 = 122
    static let moveEnd: UInt32 = 123
    static let appSwitch: UInt32 = 187
}

/// Turns the Annex B stream MediaCodec produces into what VideoToolbox takes.
enum H264 {
    /// Split on 00 00 01 / 00 00 00 01 start codes.
    static func nalUnits(in data: Data) -> [Data] {
        let bytes = [UInt8](data)
        var units: [Data] = []
        var start: Int?
        var i = 0
        while i + 2 < bytes.count {
            if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 1 {
                if let start {
                    // A four-byte start code leaves a zero on the previous unit.
                    var end = i
                    if end > start, bytes[end - 1] == 0 { end -= 1 }
                    units.append(Data(bytes[start..<end]))
                }
                i += 3
                start = i
            } else {
                i += 1
            }
        }
        if let start, start < bytes.count {
            units.append(Data(bytes[start...]))
        }
        return units
    }

    static func type(of unit: Data) -> UInt8 {
        (unit.first ?? 0) & 0x1F
    }

    static func formatDescription(sps: Data, pps: Data) -> CMVideoFormatDescription? {
        var format: CMVideoFormatDescription?
        let status = sps.withUnsafeBytes { spsBytes in
            pps.withUnsafeBytes { ppsBytes in
                let pointers = [spsBytes.bindMemory(to: UInt8.self).baseAddress!,
                                ppsBytes.bindMemory(to: UInt8.self).baseAddress!]
                let sizes = [sps.count, pps.count]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: kCFAllocatorDefault, parameterSetCount: 2,
                    parameterSetPointers: pointers, parameterSetSizes: sizes,
                    nalUnitHeaderLength: 4, formatDescriptionOut: &format)
            }
        }
        return status == noErr ? format : nil
    }

    /// One frame as length-prefixed NAL units, shown as soon as it decodes.
    static func sampleBuffer(units: [Data], format: CMVideoFormatDescription) -> CMSampleBuffer? {
        var payload = Data()
        for unit in units {
            payload.appendBigEndian(UInt32(unit.count))
            payload.append(unit)
        }
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: payload.count,
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
            dataLength: payload.count, flags: kCMBlockBufferAssureMemoryNowFlag,
            blockBufferOut: &block) == noErr, let block else { return nil }
        let copied = payload.withUnsafeBytes {
            CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block,
                                          offsetIntoDestination: 0, dataLength: payload.count)
        }
        guard copied == noErr else { return nil }

        var sample: CMSampleBuffer?
        var size = payload.count
        guard CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
            sampleCount: 1, sampleTimingEntryCount: 0, sampleTimingArray: nil,
            sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample) == noErr,
            let sample else { return nil }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dictionary,
                                 Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        return sample
    }
}

// MARK: Byte helpers

private func readExactly(_ fd: Int32, _ count: Int) throws -> Data {
    var data = Data(count: count)
    var offset = 0
    while offset < count {
        let received = data.withUnsafeMutableBytes { read(fd, $0.baseAddress! + offset, count - offset) }
        guard received > 0 else { throw AndroidMirror.Failure.setup("connection closed") }
        offset += received
    }
    return data
}

private extension Data {
    mutating func appendBigEndian<T: FixedWidthInteger>(_ value: T) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }

    func bigEndianUInt32(at offset: Int) -> UInt32 {
        let start = startIndex + offset
        return self[start..<start + 4].reduce(0) { $0 << 8 | UInt32($1) }
    }
}

private extension Sequence where Element == UInt8 {
    /// Splits UTF-8 into chunks of at most `size` bytes without cutting a character.
    func chunked(_ size: Int) -> [[UInt8]] {
        var chunks: [[UInt8]] = []
        var current: [UInt8] = []
        for byte in self {
            // Continuation bytes (10xxxxxx) stay with their character.
            if current.count >= size, byte & 0xC0 != 0x80 {
                chunks.append(current)
                current = []
            }
            current.append(byte)
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
}

/// How far the phone's sound plays ahead of or behind its picture. Both
/// streams carry the phone's own microsecond clock, so (when shown on the
/// Mac) - (when taken on the phone) is comparable between them.
final class AVSkew: @unchecked Sendable {
    private static let log = Logger(subsystem: "io.github.szrunworld.2ndscreen", category: "android-av")
    private let lock = NSLock()
    private var videoOffsets: [Double] = []
    private var audioOffsets: [Double] = []
    private var lastReport = CACurrentMediaTime()

    func video(pts: UInt64, at host: Double) {
        add(host - Double(pts) / 1e6, video: true)
    }

    func audio(pts: UInt64, playsAt host: Double) {
        add(host - Double(pts) / 1e6, video: false)
    }

    private func add(_ offset: Double, video: Bool) {
        lock.withLock {
            if video { videoOffsets.append(offset) } else { audioOffsets.append(offset) }
            let now = CACurrentMediaTime()
            guard now - lastReport >= 2, !videoOffsets.isEmpty, !audioOffsets.isEmpty else { return }
            func median(_ values: [Double]) -> Double { values.sorted()[values.count / 2] }
            let v = median(videoOffsets), a = median(audioOffsets)
            let vMin = videoOffsets.min()!, vMax = videoOffsets.max()!
            Self.log.info("audio \(Int((a - v) * 1000)) ms vs video (negative: sound early); video lag spread \(Int((vMax - vMin) * 1000)) ms over \(self.videoOffsets.count) frames")
            videoOffsets.removeAll()
            audioOffsets.removeAll()
            lastReport = now
        }
    }
}

private extension Data {
    /// A packet header's timestamp, in the phone's microseconds, without its flags.
    var pts: UInt64 {
        self[startIndex..<startIndex + 8].reduce(0) { $0 << 8 | UInt64($1) } & ((1 << 60) - 1)
    }
}
