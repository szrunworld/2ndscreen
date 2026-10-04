import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// On-device image reading for the task runtime: Apple Vision OCR, comparing
/// two screenshots for scroll progress, and composing a scrolled page from
/// its screens. It reads image files the runtime already has. It never takes
/// a screenshot, never sends input, never calls a model or the network.
///
/// Every rect is in pixels of the image passed in, origin top-left, y down.
/// A comparison or a compose reports what the pixels show; whether a capture
/// is complete is the caller's decision from independent evidence. Two
/// identical screens are only "no progress", never proof of the bottom.
public enum LocalVision {
    public static let protocolVersion = 1

    public struct Limits: Sendable {
        public var maxFileBytes = 64 << 20
        public var maxSide = 16_384
        public var maxPixels = 64_000_000
        public var maxFrames = 64
        public var maxOutputPixels = 60_000_000
        public var maxLanguages = 8
        public var maxRequestBytes = 1 << 20
        public init() {}
    }

    public struct Failure: Error, Equatable, CustomStringConvertible {
        /// One of the runtime's error codes: invalid_input, not_found, io, conflict, cancelled.
        public let code: String
        public let message: String
        public init(_ code: String, _ message: String) {
            self.code = code
            self.message = message
        }
        public var description: String { "\(code): \(message)" }
    }

    public struct PixelRect: Equatable, Sendable {
        public var x: Int
        public var y: Int
        public var width: Int
        public var height: Int
        public init(x: Int, y: Int, width: Int, height: Int) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }
        var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    }

    /// A rect as the caller sent it, before it is checked against an image.
    public struct RequestedRect: Equatable, Sendable {
        public var x, y, width, height: Double
        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }
    }

    public struct ImageInfo: Equatable {
        public let widthPx: Int
        public let heightPx: Int
        public let bytes: Int
        public let sha256: String
        /// Uniform type, e.g. public.png.
        public let type: String
    }

    public struct OcrLine: Equatable {
        public let text: String
        public let box: CGRect
        public let confidence: Double
    }

    public struct OcrResult {
        public let lines: [OcrLine]
        public let image: ImageInfo
    }

    public struct Comparison: Equatable {
        /// Share of pixels, 0...1, whose grey level differs by at most
        /// `Tuning.equalTolerance` at zero shift; 1 is pixel-identical.
        public let similarity: Double
        /// How far content moved up, in pixels, when a shift was proven by an
        /// overlap of at least `minOverlap` textured rows; negative is down.
        public let verticalShiftPx: Int?
        /// Mean grey difference over the proven overlap, 0 is exact.
        public let overlapMeanDiff: Double?
    }

    public enum Placement: String {
        case first, placed, duplicate, gap
    }

    public struct ComposedFrame: Equatable {
        public let index: Int
        public let placement: Placement
        public let outputY: Int
        public let rows: Int
        public let overlapPx: Int?
    }

    public struct Composed {
        public let path: String
        public let widthPx: Int
        public let heightPx: Int
        public let sha256: String
        public let frames: [ComposedFrame]
        public var hasGap: Bool { frames.contains { $0.placement == .gap } }
    }

    /// Thresholds for deciding that two screens continue each other.
    enum Tuning {
        static let equalTolerance = 2
        static let bands = 16
        /// Mean grey difference over a proven overlap.
        static let maxOverlapDiff = 3.0
        /// Rows whose band profile varies less than this are blank and prove nothing.
        static let minRowTexture = 1.5
        /// A proven overlap must have at least this share of textured rows.
        static let minTexturedShare = 0.15
        /// The best shift must beat any shift further than `ambiguityRadius` by this much.
        static let ambiguityMargin = 0.75
        static let ambiguityRadius = 3
        static let duplicateSimilarity = 0.999
    }

    public static let defaultLanguages = ["zh-Hans", "en-US"]
    public static let defaultMinOverlap = 48

    // MARK: Reading images

    struct Loaded {
        let image: CGImage
        let info: ImageInfo
    }

    static func checkPath(_ path: String, what: String) throws -> URL {
        guard path.hasPrefix("/"), !path.contains("\0") else {
            throw Failure("invalid_input", "\(what) must be an absolute path")
        }
        return URL(fileURLWithPath: path).standardizedFileURL
    }

    static func load(_ path: String, limits: Limits, what: String = "image") throws -> Loaded {
        let url = try checkPath(path, what: what)
        let values: URLResourceValues
        do {
            values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        } catch {
            throw Failure("not_found", "\(what) \(path) does not exist")
        }
        guard values.isRegularFile == true else { throw Failure("invalid_input", "\(what) \(path) is not a regular file") }
        if let size = values.fileSize, size > limits.maxFileBytes {
            throw Failure("invalid_input", "\(what) \(path) is \(size) bytes, over the \(limits.maxFileBytes) limit")
        }
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw Failure("io", "cannot read \(path)") }
        guard data.count <= limits.maxFileBytes else {
            throw Failure("invalid_input", "\(what) \(path) is over the \(limits.maxFileBytes) byte limit")
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) >= 1,
              let type = CGImageSourceGetType(source) as String?
        else { throw Failure("invalid_input", "\(what) \(path) is not an image") }
        let allowed: [UTType] = [.png, .jpeg, .tiff, .heic]
        guard allowed.contains(where: { $0.identifier == type }) else {
            throw Failure("invalid_input", "\(what) \(path) is \(type); only PNG, JPEG, TIFF and HEIC are read")
        }
        // Size from the header, so an oversized image is refused before it is decoded.
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        guard let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0
        else { throw Failure("invalid_input", "\(what) \(path) has no pixel size") }
        try checkSize(width: width, height: height, limits: limits, what: "\(what) \(path)")
        if let orientation = properties[kCGImagePropertyOrientation] as? Int, orientation != 1 {
            // Pixel coordinates would not match what a viewer shows.
            throw Failure("invalid_input", "\(what) \(path) has EXIF orientation \(orientation); only upright images are read")
        }
        let options = [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, options),
              image.width == width, image.height == height
        else { throw Failure("invalid_input", "cannot decode \(what) \(path)") }
        let info = ImageInfo(widthPx: width, heightPx: height, bytes: data.count, sha256: sha256(data), type: type)
        return Loaded(image: image, info: info)
    }

    static func checkSize(width: Int, height: Int, limits: Limits, what: String) throws {
        if width > limits.maxSide || height > limits.maxSide {
            throw Failure("invalid_input", "\(what) is \(width)x\(height) px, over the \(limits.maxSide) px side limit")
        }
        if width * height > limits.maxPixels {
            throw Failure("invalid_input", "\(what) is \(width * height) px, over the \(limits.maxPixels) pixel limit")
        }
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// The region of interest snapped outward to whole pixels. Up to one
    /// pixel past an edge is float noise from converting points and is
    /// clipped; anything more is refused rather than silently moved.
    public static func resolveROI(_ roi: RequestedRect?, width: Int, height: Int) throws -> PixelRect {
        guard let roi else { return PixelRect(x: 0, y: 0, width: width, height: height) }
        let values = [roi.x, roi.y, roi.width, roi.height]
        guard values.allSatisfy(\.isFinite) else { throw Failure("invalid_input", "roi must be finite numbers") }
        guard roi.width > 0, roi.height > 0 else { throw Failure("invalid_input", "roi must have a positive width and height") }
        guard roi.x >= -1, roi.y >= -1, roi.x + roi.width <= Double(width) + 1, roi.y + roi.height <= Double(height) + 1 else {
            throw Failure("invalid_input",
                          "roi \(roi.x),\(roi.y) \(roi.width)x\(roi.height) is outside the \(width)x\(height) px image")
        }
        let left = max(0, Int(roi.x.rounded(.down)))
        let top = max(0, Int(roi.y.rounded(.down)))
        let right = min(width, Int((roi.x + roi.width).rounded(.up)))
        let bottom = min(height, Int((roi.y + roi.height).rounded(.up)))
        guard right > left, bottom > top else { throw Failure("invalid_input", "roi is empty inside the image") }
        return PixelRect(x: left, y: top, width: right - left, height: bottom - top)
    }

    public static func metadata(_ path: String, limits: Limits = Limits()) throws -> ImageInfo {
        try load(path, limits: limits).info
    }

    // MARK: OCR

    public static func supportedLanguages() -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        return (try? request.supportedRecognitionLanguages()) ?? []
    }

    public static func ocr(_ path: String, roi: RequestedRect? = nil, languages: [String]? = nil,
                           limits: Limits = Limits()) throws -> OcrResult {
        let languages = languages ?? defaultLanguages
        guard !languages.isEmpty, languages.count <= limits.maxLanguages else {
            throw Failure("invalid_input", "languages must list 1 to \(limits.maxLanguages) languages")
        }
        let supported = Set(supportedLanguages())
        let unsupported = languages.filter { !supported.contains($0) }
        guard unsupported.isEmpty else {
            throw Failure("invalid_input", "unsupported OCR languages: \(unsupported.joined(separator: ", "))")
        }
        let loaded = try load(path, limits: limits)
        let region = try resolveROI(roi, width: loaded.info.widthPx, height: loaded.info.heightPx)
        guard let cropped = loaded.image.cropping(to: region.cgRect) else { throw Failure("io", "cannot crop \(path)") }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = languages
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = false
        let handler = VNImageRequestHandler(cgImage: cropped, orientation: .up, options: [:])
        do { try handler.perform([request]) } catch {
            throw Failure("io", "Vision could not read \(path): \(error.localizedDescription)")
        }
        let width = Double(region.width), height = Double(region.height)
        var lines: [OcrLine] = []
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            // Vision is normalized with a bottom-left origin inside the crop.
            let box = observation.boundingBox
            let rect = CGRect(x: Double(region.x) + box.minX * width,
                              y: Double(region.y) + (1 - box.maxY) * height,
                              width: box.width * width, height: box.height * height)
            lines.append(OcrLine(text: text, box: rect, confidence: Double(candidate.confidence)))
        }
        lines.sort { a, b in
            abs(a.box.minY - b.box.minY) > min(a.box.height, b.box.height) / 2 ? a.box.minY < b.box.minY : a.box.minX < b.box.minX
        }
        return OcrResult(lines: lines, image: loaded.info)
    }

    // MARK: Comparing screens

    /// An 8-bit grey copy of a region, row 0 at the top.
    struct Grey {
        let width: Int
        let height: Int
        let pixels: [UInt8]

        init(_ image: CGImage, region: PixelRect) throws {
            guard let cropped = image.cropping(to: region.cgRect) else { throw Failure("io", "cannot crop the image") }
            let width = region.width, height = region.height
            self.width = width
            self.height = height
            var buffer = [UInt8](repeating: 0, count: width * height)
            let drawn = buffer.withUnsafeMutableBytes { raw -> Bool in
                guard let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                              bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                                              bitmapInfo: CGImageAlphaInfo.none.rawValue)
                else { return false }
                context.interpolationQuality = .none
                context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))
                return true
            }
            guard drawn else { throw Failure("io", "cannot convert the image to grey") }
            pixels = buffer
        }

        /// Mean grey of each of `bands` column bands, per row.
        func profile(bands: Int) -> [Double] {
            let bands = max(1, min(bands, width))
            var out = [Double](repeating: 0, count: height * bands)
            for row in 0..<height {
                let base = row * width
                for band in 0..<bands {
                    let start = band * width / bands, end = (band + 1) * width / bands
                    var sum = 0
                    for column in start..<end { sum += Int(pixels[base + column]) }
                    out[row * bands + band] = Double(sum) / Double(end - start)
                }
            }
            return out
        }
    }

    public static func compare(_ before: String, _ after: String, roi: RequestedRect? = nil,
                               minOverlap: Int = defaultMinOverlap, limits: Limits = Limits()) throws -> Comparison {
        let first = try load(before, limits: limits, what: "before")
        let second = try load(after, limits: limits, what: "after")
        guard first.info.widthPx == second.info.widthPx, first.info.heightPx == second.info.heightPx else {
            throw Failure("invalid_input", "before is \(first.info.widthPx)x\(first.info.heightPx) px but after is "
                + "\(second.info.widthPx)x\(second.info.heightPx) px; compare screens of one size")
        }
        let region = try resolveROI(roi, width: first.info.widthPx, height: first.info.heightPx)
        return try compare(Grey(first.image, region: region), Grey(second.image, region: region), minOverlap: minOverlap)
    }

    static func compare(_ a: Grey, _ b: Grey, minOverlap: Int) throws -> Comparison {
        let similarity = equalShare(a, b)
        let shift = findShift(a, b, minOverlap: minOverlap)
        return Comparison(similarity: similarity, verticalShiftPx: shift?.shift, overlapMeanDiff: shift?.meanDiff)
    }

    static func equalShare(_ a: Grey, _ b: Grey) -> Double {
        var equal = 0
        for index in 0..<a.pixels.count where abs(Int(a.pixels[index]) - Int(b.pixels[index])) <= Tuning.equalTolerance {
            equal += 1
        }
        return a.pixels.isEmpty ? 1 : Double(equal) / Double(a.pixels.count)
    }

    /// Rows of `a` from `s` on line up with rows of `b` from 0 (content moved
    /// up by `s`); negative `s` the other way.
    @inline(__always)
    static func overlapRows(_ s: Int, height: Int) -> (a: Int, b: Int, count: Int) {
        s >= 0 ? (s, 0, height - s) : (0, -s, height + s)
    }

    /// The vertical shift that maps `a` onto `b`, if one is proven: a band
    /// profile search over every shift, then an exact pixel check of the
    /// overlap. Blank overlaps, and overlaps that match about as well at a
    /// different shift (repeating content), prove nothing and return nil.
    static func findShift(_ a: Grey, _ b: Grey, minOverlap: Int) -> (shift: Int, meanDiff: Double)? {
        let height = a.height
        let minOverlap = max(1, minOverlap)
        guard height >= minOverlap else { return nil }
        let bands = max(1, min(Tuning.bands, a.width))
        let pa = a.profile(bands: bands), pb = b.profile(bands: bands)
        let limit = height - minOverlap
        var costs: [(shift: Int, cost: Double)] = []
        costs.reserveCapacity(2 * limit + 1)
        for s in -limit...limit {
            let (ra, rb, count) = overlapRows(s, height: height)
            var sum = 0.0
            pa.withUnsafeBufferPointer { pa in
                pb.withUnsafeBufferPointer { pb in
                    let offsetA = ra * bands, offsetB = rb * bands
                    for index in 0..<(count * bands) { sum += abs(pa[offsetA + index] - pb[offsetB + index]) }
                }
            }
            costs.append((s, sum / Double(count * bands)))
        }
        guard let best = costs.min(by: { $0.cost < $1.cost }) else { return nil }
        let rival = costs.filter { abs($0.shift - best.shift) > Tuning.ambiguityRadius }.map(\.cost).min() ?? .infinity
        guard rival - best.cost >= Tuning.ambiguityMargin else { return nil }

        let (ra, rb, count) = overlapRows(best.shift, height: height)
        var textured = 0
        for row in 0..<count {
            let base = (ra + row) * bands
            let values = pa[base..<(base + bands)]
            let mean = values.reduce(0, +) / Double(bands)
            let spread = values.reduce(0) { $0 + abs($1 - mean) } / Double(bands)
            // A row is textured when its bands differ or it differs from the row above.
            let step = row > 0 ? zip(values, pa[(base - bands)..<base]).reduce(0) { $0 + abs($1.0 - $1.1) } / Double(bands) : 0
            if spread >= Tuning.minRowTexture || step >= Tuning.minRowTexture { textured += 1 }
        }
        guard Double(textured) >= Double(count) * Tuning.minTexturedShare else { return nil }

        var diff = 0
        a.pixels.withUnsafeBufferPointer { pa in
            b.pixels.withUnsafeBufferPointer { pb in
                let offsetA = ra * a.width, offsetB = rb * b.width
                for index in 0..<(count * a.width) { diff += abs(Int(pa[offsetA + index]) - Int(pb[offsetB + index])) }
            }
        }
        let meanDiff = Double(diff) / Double(count * a.width)
        guard meanDiff <= Tuning.maxOverlapDiff else { return nil }
        return (best.shift, meanDiff)
    }

    // MARK: Composing a scrolled page

    /// Stacks screens of one scrolled region into one PNG, top to bottom.
    /// Each screen after the first is placed only by a proven overlap with
    /// the screen before it; a screen with no new rows is a duplicate and is
    /// skipped; a screen with no proven overlap is appended whole and marked
    /// a gap, which the caller must treat as an incomplete capture.
    ///
    /// The PNG is written to a hidden partial file next to `output`, named
    /// by this call's `nonce`, and linked into place, so `output` only ever
    /// holds a whole image and is never replaced. Only a partial file this
    /// call created itself is ever deleted: one that already exists, from
    /// any other compose, is a conflict and is left alone. The runtime
    /// passes its own nonce so it can delete exactly this call's partial
    /// file if it had to SIGKILL the helper. `tempFile` hears the partial
    /// path once this call owns it, for a signal handler to delete;
    /// `isCancelled` is checked between screens.
    public static func compose(_ frames: [String], output: String, roi: RequestedRect? = nil,
                               minOverlap: Int = defaultMinOverlap, limits: Limits = Limits(),
                               nonce: String = UUID().uuidString,
                               isCancelled: () -> Bool = { false },
                               tempFile: (String?) -> Void = { _ in }) throws -> Composed {
        guard !frames.isEmpty, frames.count <= limits.maxFrames else {
            throw Failure("invalid_input", "frames must list 1 to \(limits.maxFrames) images")
        }
        let outputURL = try checkPath(output, what: "output")
        guard outputURL.pathExtension.lowercased() == "png" else { throw Failure("invalid_input", "output must be a .png path") }
        let directory = outputURL.deletingLastPathComponent()
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw Failure("not_found", "the output directory \(directory.path) does not exist")
        }
        guard !FileManager.default.fileExists(atPath: outputURL.path) else {
            throw Failure("conflict", "\(outputURL.path) already exists")
        }
        guard isValidNonce(nonce) else { throw Failure("invalid_input", "nonce must be 8 to 64 letters, digits or dashes") }
        let partial = partialPath(for: outputURL.path, nonce: nonce)

        // Pass 1: placements from grey copies, two screens in memory at a time.
        var placements: [ComposedFrame] = []
        var hashes: [String] = []
        var region: PixelRect?
        var previous: Grey?
        var height = 0
        for (index, path) in frames.enumerated() {
            if isCancelled() { throw Failure("cancelled", "compose was cancelled") }
            let loaded = try load(path, limits: limits, what: "frame \(index)")
            let frameRegion = try resolveROI(roi, width: loaded.info.widthPx, height: loaded.info.heightPx)
            if let region, region != frameRegion {
                throw Failure("invalid_input", "frame \(index) is \(loaded.info.widthPx)x\(loaded.info.heightPx) px; "
                    + "every frame must be the same size")
            }
            region = frameRegion
            hashes.append(loaded.info.sha256)
            let grey = try Grey(loaded.image, region: frameRegion)
            let placement: ComposedFrame
            if let previous {
                let shift = findShift(previous, grey, minOverlap: minOverlap)
                if let shift, shift.shift == 0 {
                    placement = ComposedFrame(index: index, placement: .duplicate, outputY: height, rows: 0, overlapPx: grey.height)
                } else if let shift, shift.shift > 0 {
                    placement = ComposedFrame(index: index, placement: .placed, outputY: height, rows: shift.shift,
                                              overlapPx: grey.height - shift.shift)
                } else if shift == nil, equalShare(previous, grey) >= Tuning.duplicateSimilarity {
                    // Identical blank screens: nothing new to add, and nothing proven either.
                    placement = ComposedFrame(index: index, placement: .duplicate, outputY: height, rows: 0, overlapPx: nil)
                } else {
                    placement = ComposedFrame(index: index, placement: .gap, outputY: height, rows: grey.height, overlapPx: nil)
                }
            } else {
                placement = ComposedFrame(index: index, placement: .first, outputY: 0, rows: grey.height, overlapPx: nil)
            }
            placements.append(placement)
            height += placement.rows
            previous = grey
        }
        guard let region else { throw Failure("invalid_input", "no frames") }
        if region.width * height > limits.maxOutputPixels || height > Int(Int32.max) {
            throw Failure("invalid_input", "the composed image would be \(region.width)x\(height) px, over the "
                + "\(limits.maxOutputPixels) pixel limit; compose fewer frames or a smaller roi")
        }

        // Pass 2: draw the new rows of each screen in colour.
        guard let context = CGContext(data: nil, width: region.width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw Failure("io", "cannot allocate a \(region.width)x\(height) px image") }
        context.interpolationQuality = .none
        for (placement, path) in zip(placements, frames) where placement.rows > 0 {
            if isCancelled() { throw Failure("cancelled", "compose was cancelled") }
            let loaded = try load(path, limits: limits, what: "frame \(placement.index)")
            guard loaded.info.sha256 == hashes[placement.index] else {
                throw Failure("conflict", "frame \(placement.index) changed while it was being composed")
            }
            // The bottom `rows` rows of the screen's region are new.
            let source = CGRect(x: region.x, y: region.y + region.height - placement.rows, width: region.width, height: placement.rows)
            guard let slice = loaded.image.cropping(to: source) else { throw Failure("io", "cannot crop frame \(placement.index)") }
            let y = height - placement.outputY - placement.rows
            context.draw(slice, in: CGRect(x: 0, y: y, width: region.width, height: placement.rows))
        }
        guard let image = context.makeImage() else { throw Failure("io", "cannot finish the composed image") }
        if isCancelled() { throw Failure("cancelled", "compose was cancelled") }

        let data: Data
        do { data = try Images.png(image) } catch { throw Failure("io", "cannot encode the composed PNG") }
        // O_EXCL: the partial file is created by this call or not at all.
        let fd = open(partial, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644)
        guard fd >= 0 else {
            if errno == EEXIST { throw Failure("conflict", "\(partial) already exists; it belongs to another compose") }
            throw Failure("io", "cannot create \(partial): \(String(cString: strerror(errno)))")
        }
        tempFile(partial)
        defer {
            unlink(partial)
            tempFile(nil)
        }
        let written = data.withUnsafeBytes { raw -> Bool in
            var offset = 0
            while offset < raw.count {
                let n = write(fd, raw.baseAddress! + offset, raw.count - offset)
                if n < 0 { if errno == EINTR { continue }; return false }
                offset += n
            }
            return fsync(fd) == 0
        }
        let closed = close(fd) == 0
        guard written, closed else { throw Failure("io", "cannot write \(partial): \(String(cString: strerror(errno)))") }
        // link(2) fails when the target exists, unlike rename, so a file that
        // appeared meanwhile is never replaced.
        guard link(partial, outputURL.path) == 0 else {
            if errno == EEXIST { throw Failure("conflict", "\(outputURL.path) already exists") }
            throw Failure("io", "cannot move the composed image to \(outputURL.path): \(String(cString: strerror(errno)))")
        }
        return Composed(path: outputURL.path, widthPx: region.width, heightPx: height, sha256: sha256(data), frames: placements)
    }

    /// Where the compose with `nonce` writes before linking: hidden, next to
    /// the output. The runtime computes the same path to clean up after a kill.
    public static func partialPath(for output: String, nonce: String) -> String {
        let url = URL(fileURLWithPath: output)
        return url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(nonce).partial").path
    }

    static func isValidNonce(_ nonce: String) -> Bool {
        (8...64).contains(nonce.count) && nonce.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }
}

// MARK: - Wire protocol

/// The helper's wire format, one JSON request in and one JSON reply out:
///
///   {"v":1,"op":"ocr","image":"/abs.png","roi":{"x":0,"y":0,"width":10,"height":10},"languages":["zh-Hans"]}
///   {"v":1,"op":"compare","before":"/a.png","after":"/b.png","roi":{...},"minOverlapPx":48}
///   {"v":1,"op":"compose","frames":["/a.png","/b.png"],"output":"/out.png","roi":{...},"minOverlapPx":48,"nonce":"<uuid>"}
///   {"v":1,"op":"metadata","image":"/abs.png"}
///
/// Replies are {"v":1,"ok":true,"result":{...}} or
/// {"v":1,"ok":false,"error":{"code":"invalid_input","message":"..."}}.
/// Rects are image pixels with a top-left origin. Unknown fields are refused.
extension LocalVision {
    public struct Reply {
        public let json: Data
        /// 0 done, 1 failed, 2 the request was invalid.
        public let exitCode: Int32
    }

    public static func handle(_ line: Data, limits: Limits = Limits(), isCancelled: () -> Bool = { false },
                              tempFile: (String?) -> Void = { _ in }) -> Reply {
        do {
            guard line.count <= limits.maxRequestBytes else {
                throw Failure("invalid_input", "the request is over \(limits.maxRequestBytes) bytes")
            }
            guard let request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
                throw Failure("invalid_input", "the request is not a JSON object")
            }
            let result = try perform(request, limits: limits, isCancelled: isCancelled, tempFile: tempFile)
            return Reply(json: encode(["v": protocolVersion, "ok": true, "result": result]), exitCode: 0)
        } catch let failure as Failure {
            let body: [String: Any] = ["v": protocolVersion, "ok": false, "error": ["code": failure.code, "message": failure.message]]
            return Reply(json: encode(body), exitCode: failure.code == "invalid_input" ? 2 : 1)
        } catch {
            let body: [String: Any] = ["v": protocolVersion, "ok": false, "error": ["code": "io", "message": "\(error)"]]
            return Reply(json: encode(body), exitCode: 1)
        }
    }

    static func perform(_ request: [String: Any], limits: Limits, isCancelled: () -> Bool,
                        tempFile: (String?) -> Void) throws -> [String: Any] {
        guard let version = request["v"] as? Int, version == protocolVersion else {
            throw Failure("invalid_input", "v must be \(protocolVersion)")
        }
        let fields = Fields(request)
        switch request["op"] as? String {
        case "ocr":
            try fields.only(["v", "op", "image", "roi", "languages"])
            let image = try fields.string("image")
            let roi = try fields.rect("roi")
            let languages = try fields.strings("languages")
            let result = try ocr(image, roi: roi, languages: languages, limits: limits)
            return [
                "lines": result.lines.map { ["text": $0.text, "box": json($0.box), "confidence": round($0.confidence, 4)] },
                "imageSha256": result.image.sha256,
                "widthPx": result.image.widthPx,
                "heightPx": result.image.heightPx,
            ]
        case "compare":
            try fields.only(["v", "op", "before", "after", "roi", "minOverlapPx"])
            let comparison = try compare(try fields.string("before"), try fields.string("after"), roi: try fields.rect("roi"),
                                         minOverlap: try fields.minOverlap(), limits: limits)
            var result: [String: Any] = ["similarity": round(comparison.similarity, 6)]
            if let shift = comparison.verticalShiftPx { result["verticalShiftPx"] = shift }
            if let diff = comparison.overlapMeanDiff { result["overlapMeanDiff"] = round(diff, 4) }
            return result
        case "compose":
            try fields.only(["v", "op", "frames", "output", "roi", "minOverlapPx", "nonce"])
            guard let frames = try fields.strings("frames") else { throw Failure("invalid_input", "frames is required") }
            let composed = try compose(frames, output: try fields.string("output"), roi: try fields.rect("roi"),
                                       minOverlap: try fields.minOverlap(), limits: limits,
                                       nonce: try fields.optionalString("nonce") ?? UUID().uuidString,
                                       isCancelled: isCancelled, tempFile: tempFile)
            return [
                "path": composed.path,
                "widthPx": composed.widthPx,
                "heightPx": composed.heightPx,
                "sha256": composed.sha256,
                "hasGap": composed.hasGap,
                "frames": composed.frames.map { frame -> [String: Any] in
                    var out: [String: Any] = ["index": frame.index, "placement": frame.placement.rawValue,
                                              "outputY": frame.outputY, "rows": frame.rows]
                    if let overlap = frame.overlapPx { out["overlapPx"] = overlap }
                    return out
                },
            ]
        case "metadata":
            try fields.only(["v", "op", "image"])
            let info = try metadata(try fields.string("image"), limits: limits)
            return ["widthPx": info.widthPx, "heightPx": info.heightPx, "bytes": info.bytes, "sha256": info.sha256, "type": info.type]
        default:
            throw Failure("invalid_input", "op must be ocr, compare, compose or metadata")
        }
    }

    struct Fields {
        let raw: [String: Any]
        init(_ raw: [String: Any]) { self.raw = raw }

        func only(_ allowed: Set<String>) throws {
            let unknown = raw.keys.filter { !allowed.contains($0) }.sorted()
            if !unknown.isEmpty { throw Failure("invalid_input", "unknown fields: \(unknown.joined(separator: ", "))") }
        }

        func string(_ key: String) throws -> String {
            guard let value = raw[key] as? String, !value.isEmpty else { throw Failure("invalid_input", "\(key) must be a path") }
            return value
        }

        func optionalString(_ key: String) throws -> String? {
            guard let value = raw[key] else { return nil }
            guard let string = value as? String else { throw Failure("invalid_input", "\(key) must be a string") }
            return string
        }

        func strings(_ key: String) throws -> [String]? {
            guard let value = raw[key] else { return nil }
            guard let list = value as? [Any], let strings = list as? [String], strings.allSatisfy({ !$0.isEmpty }) else {
                throw Failure("invalid_input", "\(key) must be a list of strings")
            }
            return strings
        }

        func rect(_ key: String) throws -> RequestedRect? {
            guard let value = raw[key] else { return nil }
            guard let object = value as? [String: Any], Set(object.keys) == ["x", "y", "width", "height"],
                  let x = number(object["x"]), let y = number(object["y"]),
                  let width = number(object["width"]), let height = number(object["height"])
            else { throw Failure("invalid_input", "\(key) must be {x, y, width, height} in pixels") }
            return RequestedRect(x: x, y: y, width: width, height: height)
        }

        func minOverlap() throws -> Int {
            guard let value = raw["minOverlapPx"] else { return defaultMinOverlap }
            guard let number = number(value), number == number.rounded(), number >= 1, number <= 4096 else {
                throw Failure("invalid_input", "minOverlapPx must be a whole number from 1 to 4096")
            }
            return Int(number)
        }

        private func number(_ value: Any?) -> Double? {
            // JSONSerialization gives NSNumber; refuse booleans posing as numbers.
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            return number.doubleValue
        }
    }

    static func json(_ rect: CGRect) -> [String: Any] {
        ["x": round(rect.minX, 2), "y": round(rect.minY, 2), "width": round(rect.width, 2), "height": round(rect.height, 2)]
    }

    static func round(_ value: Double, _ places: Int) -> Double {
        let scale = pow(10, Double(places))
        return (value * scale).rounded() / scale
    }

    static func encode(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]))
            ?? Data(#"{"v":1,"ok":false,"error":{"code":"io","message":"cannot encode the reply"}}"#.utf8)
    }
}
