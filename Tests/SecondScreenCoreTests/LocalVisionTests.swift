import CoreGraphics
import CoreText
import CryptoKit
import Foundation
import Testing
@testable import SecondScreenCore

/// Synthetic images only: a "page" of pseudo-random text-like blocks that a
/// test scrolls through, and rendered text for OCR. No real screenshots.
private enum Fixture {
    static func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("localvision-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func context(width: Int, height: Int, white: Bool = true) -> CGContext {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(gray: white ? 1 : 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return context
    }

    /// Lines of dark blocks of varying widths every 24 rows, like text; the
    /// pattern never repeats, so every scroll offset is unambiguous.
    static func page(width: Int = 240, height: Int = 1400, seed: UInt64 = 7) -> CGImage {
        let context = context(width: width, height: height)
        var state = seed
        func next() -> Int {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Int(state >> 33)
        }
        var top = 6
        while top + 14 < height {
            var x = 8
            while x < width - 20 {
                let w = 6 + next() % 30
                let h = 8 + next() % 7
                let shade = CGFloat(next() % 120) / 255
                context.setFillColor(CGColor(red: shade, green: shade * 0.5, blue: 0.3, alpha: 1))
                // CG's origin is bottom-left; `top` counts from the top.
                context.fill(CGRect(x: x, y: height - top - h, width: min(w, width - 8 - x), height: h))
                x += w + 4 + next() % 9
            }
            top += 24
        }
        return context.makeImage()!
    }

    static func rows(_ image: CGImage, from top: Int, count: Int) -> CGImage {
        image.cropping(to: CGRect(x: 0, y: top, width: image.width, height: count))!
    }

    static func text(_ lines: [(String, CGFloat)], width: Int = 900, height: Int = 300, size: CGFloat = 44) -> CGImage {
        let context = context(width: width, height: height)
        let font = CTFontCreateWithName("PingFang SC" as CFString, size, nil)
        for (string, top) in lines {
            let attributed = NSAttributedString(string: string, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
            ])
            let line = CTLineCreateWithAttributedString(attributed)
            context.textPosition = CGPoint(x: 30, y: CGFloat(height) - top - size)
            CTLineDraw(line, context)
        }
        return context.makeImage()!
    }

    @discardableResult
    static func write(_ image: CGImage, _ dir: URL, _ name: String) throws -> String {
        let path = dir.appendingPathComponent(name).path
        try Images.png(image).write(to: URL(fileURLWithPath: path))
        return path
    }
}

private func partials(in dir: URL) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".partial") }
}

private func expectFailure(_ code: String, _ body: () throws -> Void) {
    do {
        try body()
        Issue.record("expected \(code)")
    } catch let failure as LocalVision.Failure {
        #expect(failure.code == code, "\(failure)")
    } catch {
        Issue.record("unexpected \(error)")
    }
}

@Suite struct LocalVisionInputTests {
    @Test func metadataReportsHeaderSizeAndFileHash() throws {
        let dir = try Fixture.directory()
        let path = try Fixture.write(Fixture.page(width: 120, height: 80), dir, "a.png")
        let info = try LocalVision.metadata(path)
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        #expect(info.widthPx == 120 && info.heightPx == 80)
        #expect(info.bytes == data.count)
        #expect(info.sha256 == SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
        #expect(info.type == "public.png")
    }

    @Test func refusesBadPathsAndFilesBeforeDecoding() throws {
        let dir = try Fixture.directory()
        expectFailure("invalid_input") { _ = try LocalVision.metadata("relative.png") }
        expectFailure("not_found") { _ = try LocalVision.metadata(dir.appendingPathComponent("missing.png").path) }
        expectFailure("invalid_input") { _ = try LocalVision.metadata(dir.path) }
        let text = dir.appendingPathComponent("note.png")
        try Data("not an image".utf8).write(to: text)
        expectFailure("invalid_input") { _ = try LocalVision.metadata(text.path) }

        let big = try Fixture.write(Fixture.page(width: 300, height: 200), dir, "big.png")
        var limits = LocalVision.Limits()
        limits.maxSide = 256
        expectFailure("invalid_input") { _ = try LocalVision.metadata(big, limits: limits) }
        limits = LocalVision.Limits()
        limits.maxPixels = 300 * 200 - 1
        expectFailure("invalid_input") { _ = try LocalVision.metadata(big, limits: limits) }
        limits = LocalVision.Limits()
        limits.maxFileBytes = 10
        expectFailure("invalid_input") { _ = try LocalVision.metadata(big, limits: limits) }
    }

    @Test func roiSnapsOutwardAndRefusesRectsOffTheImage() throws {
        let full = try LocalVision.resolveROI(nil, width: 100, height: 50)
        #expect(full == .init(x: 0, y: 0, width: 100, height: 50))
        let snapped = try LocalVision.resolveROI(.init(x: 10.4, y: 5.6, width: 20.2, height: 10), width: 100, height: 50)
        #expect(snapped == .init(x: 10, y: 5, width: 21, height: 11))
        // Float noise from points-to-pixels at an edge is clipped, not refused.
        let edge = try LocalVision.resolveROI(.init(x: 0, y: 0, width: 100.0000001, height: 50.4), width: 100, height: 50)
        #expect(edge == .init(x: 0, y: 0, width: 100, height: 50))
        expectFailure("invalid_input") { _ = try LocalVision.resolveROI(.init(x: 90, y: 0, width: 20, height: 10), width: 100, height: 50) }
        expectFailure("invalid_input") { _ = try LocalVision.resolveROI(.init(x: -5, y: 0, width: 20, height: 10), width: 100, height: 50) }
        expectFailure("invalid_input") { _ = try LocalVision.resolveROI(.init(x: 0, y: 0, width: 0, height: 10), width: 100, height: 50) }
        expectFailure("invalid_input") { _ = try LocalVision.resolveROI(.init(x: .nan, y: 0, width: 5, height: 10), width: 100, height: 50) }
    }

    @Test func greyRowsStartAtTheTop() throws {
        let context = Fixture.context(width: 4, height: 4)
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 3, width: 4, height: 1)) // the top row in CG's bottom-left space
        let grey = try LocalVision.Grey(context.makeImage()!, region: .init(x: 0, y: 0, width: 4, height: 4))
        #expect(grey.pixels[0..<4].allSatisfy { $0 < 10 })
        #expect(grey.pixels[12..<16].allSatisfy { $0 > 245 })
    }
}

@Suite struct LocalVisionOcrTests {
    @Test func readsChineseAndEnglishWithTopLeftPixelBoxes() throws {
        let dir = try Fixture.directory()
        let image = Fixture.text([("张三 软件工程师", 40), ("Resume 2026 Swift", 180)])
        let path = try Fixture.write(image, dir, "text.png")
        let result = try LocalVision.ocr(path)
        #expect(result.image.widthPx == 900 && result.image.heightPx == 300)
        let joined = result.lines.map(\.text).joined(separator: "\n")
        #expect(joined.contains("张三"), "\(joined)")
        #expect(joined.contains("Resume 2026"), "\(joined)")
        let chinese = try #require(result.lines.first { $0.text.contains("张三") })
        let english = try #require(result.lines.first { $0.text.contains("Resume") })
        // Drawn 40 and 180 px from the top: boxes are top-left image pixels.
        #expect(chinese.box.minY > 20 && chinese.box.minY < 70, "\(chinese.box)")
        #expect(english.box.minY > 160 && english.box.minY < 210, "\(english.box)")
        #expect(chinese.box.minX > 15 && chinese.box.minX < 60)
        #expect(result.lines.first?.text == chinese.text, "lines sort top to bottom")
        #expect(result.lines.allSatisfy { $0.confidence > 0 && $0.confidence <= 1 })
    }

    @Test func roiLimitsTheTextAndKeepsFullImageCoordinates() throws {
        let dir = try Fixture.directory()
        let path = try Fixture.write(Fixture.text([("张三 软件工程师", 40), ("Resume 2026 Swift", 180)]), dir, "text.png")
        let result = try LocalVision.ocr(path, roi: .init(x: 0, y: 150, width: 900, height: 150), languages: ["en-US"])
        #expect(!result.lines.contains { $0.text.contains("张三") })
        let english = try #require(result.lines.first { $0.text.contains("Resume") })
        #expect(english.box.minY > 160 && english.box.minY < 210, "\(english.box)")
        #expect(english.box.maxY <= 300)
    }

    @Test func blankImageHasNoLinesAndBadLanguagesAreRefused() throws {
        let dir = try Fixture.directory()
        let path = try Fixture.write(Fixture.context(width: 200, height: 100).makeImage()!, dir, "blank.png")
        #expect(try LocalVision.ocr(path).lines.isEmpty)
        expectFailure("invalid_input") { _ = try LocalVision.ocr(path, languages: ["xx-Klingon"]) }
        expectFailure("invalid_input") { _ = try LocalVision.ocr(path, languages: []) }
    }
}

@Suite struct LocalVisionCompareTests {
    let page = Fixture.page()

    @Test func findsHowFarAScrollMovedTheContent() throws {
        let dir = try Fixture.directory()
        let before = try Fixture.write(Fixture.rows(page, from: 100, count: 400), dir, "before.png")
        let after = try Fixture.write(Fixture.rows(page, from: 337, count: 400), dir, "after.png")
        let down = try LocalVision.compare(before, after)
        #expect(down.verticalShiftPx == 237)
        #expect(down.overlapMeanDiff == 0)
        #expect(down.similarity < 0.99)
        let up = try LocalVision.compare(after, before)
        #expect(up.verticalShiftPx == -237)
    }

    @Test func identicalScreensAreNoProgressNotTheEnd() throws {
        let dir = try Fixture.directory()
        let frame = Fixture.rows(page, from: 0, count: 300)
        let a = try Fixture.write(frame, dir, "a.png"), b = try Fixture.write(frame, dir, "b.png")
        let same = try LocalVision.compare(a, b)
        #expect(same.similarity == 1)
        #expect(same.verticalShiftPx == 0)
    }

    @Test func blankScreensProveNoShift() throws {
        let dir = try Fixture.directory()
        let blank = Fixture.context(width: 200, height: 300).makeImage()!
        let a = try Fixture.write(blank, dir, "a.png"), b = try Fixture.write(blank, dir, "b.png")
        let result = try LocalVision.compare(a, b)
        #expect(result.similarity == 1)
        #expect(result.verticalShiftPx == nil)
    }

    @Test func unrelatedScreensHaveNoShift() throws {
        let dir = try Fixture.directory()
        let a = try Fixture.write(Fixture.rows(page, from: 0, count: 300), dir, "a.png")
        let b = try Fixture.write(Fixture.rows(Fixture.page(seed: 99), from: 0, count: 300), dir, "b.png")
        #expect(try LocalVision.compare(a, b).verticalShiftPx == nil)
    }

    @Test func roiExcludesAFixedHeader() throws {
        let dir = try Fixture.directory()
        func screen(_ top: Int) -> CGImage {
            let context = Fixture.context(width: 240, height: 400)
            context.draw(Fixture.rows(page, from: top, count: 340), in: CGRect(x: 0, y: 0, width: 240, height: 340))
            context.setFillColor(CGColor(red: 0.1, green: 0.4, blue: 0.9, alpha: 1))
            context.fill(CGRect(x: 0, y: 340, width: 240, height: 60)) // a sticky header on top
            return context.makeImage()!
        }
        let a = try Fixture.write(screen(0), dir, "a.png"), b = try Fixture.write(screen(150), dir, "b.png")
        let result = try LocalVision.compare(a, b, roi: .init(x: 0, y: 60, width: 240, height: 340))
        #expect(result.verticalShiftPx == 150)
    }

    @Test func screensOfDifferentSizesAreRefused() throws {
        let dir = try Fixture.directory()
        let a = try Fixture.write(Fixture.rows(page, from: 0, count: 300), dir, "a.png")
        let b = try Fixture.write(Fixture.rows(page, from: 0, count: 301), dir, "b.png")
        expectFailure("invalid_input") { _ = try LocalVision.compare(a, b) }
    }
}

@Suite struct LocalVisionComposeTests {
    let page = Fixture.page()

    func grey(_ path: String) throws -> LocalVision.Grey {
        let image = try Images.load(path)
        return try LocalVision.Grey(image, region: .init(x: 0, y: 0, width: image.width, height: image.height))
    }

    @Test func stacksScrolledScreensIntoThePageExactly() throws {
        let dir = try Fixture.directory()
        let tops = [0, 280, 280, 590, 860, 1000] // 280 twice: a scroll that did not move
        let frames = try tops.enumerated().map { try Fixture.write(Fixture.rows(page, from: $1, count: 400), dir, "f\($0).png") }
        let output = dir.appendingPathComponent("resume.png").path
        let composed = try LocalVision.compose(frames, output: output)
        #expect(composed.widthPx == 240 && composed.heightPx == 1400)
        #expect(!composed.hasGap)
        #expect(composed.frames.map(\.placement) == [.first, .placed, .duplicate, .placed, .placed, .placed])
        #expect(composed.frames.map(\.outputY) == [0, 400, 680, 680, 990, 1260])
        #expect(composed.frames.map(\.rows) == [400, 280, 0, 310, 270, 140])
        #expect(composed.frames[1].overlapPx == 120)
        #expect(try grey(output).pixels == LocalVision.Grey(page, region: .init(x: 0, y: 0, width: 240, height: 1400)).pixels)
        let data = try Data(contentsOf: URL(fileURLWithPath: output))
        #expect(composed.sha256 == SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
        #expect(try partials(in: dir).isEmpty)
    }

    @Test func aScreenWithNoProvenOverlapIsAGap() throws {
        let dir = try Fixture.directory()
        let frames = [
            try Fixture.write(Fixture.rows(page, from: 0, count: 300), dir, "a.png"),
            try Fixture.write(Fixture.rows(page, from: 290, count: 300), dir, "b.png"), // 10 rows overlap, under 48
            try Fixture.write(Fixture.rows(page, from: 400, count: 300), dir, "c.png"),
        ]
        let composed = try LocalVision.compose(frames, output: dir.appendingPathComponent("out.png").path)
        #expect(composed.hasGap)
        #expect(composed.frames.map(\.placement) == [.first, .gap, .placed])
        #expect(composed.heightPx == 300 + 300 + 110)
    }

    @Test func oneFrameWithAnROIIsACrop() throws {
        let dir = try Fixture.directory()
        let frame = try Fixture.write(Fixture.rows(page, from: 0, count: 300), dir, "a.png")
        let output = dir.appendingPathComponent("crop.png").path
        let composed = try LocalVision.compose([frame], output: output, roi: .init(x: 20, y: 30, width: 100, height: 50))
        #expect(composed.widthPx == 100 && composed.heightPx == 50)
        let expected = try LocalVision.Grey(Fixture.rows(page, from: 0, count: 300), region: .init(x: 20, y: 30, width: 100, height: 50))
        #expect(try grey(output).pixels == expected.pixels)
    }

    @Test func refusesUnsafeOutputsAndOversizedResults() throws {
        let dir = try Fixture.directory()
        let frame = try Fixture.write(Fixture.rows(page, from: 0, count: 300), dir, "a.png")
        expectFailure("conflict") { _ = try LocalVision.compose([frame], output: frame) }
        expectFailure("invalid_input") { _ = try LocalVision.compose([frame], output: dir.appendingPathComponent("out.jpg").path) }
        expectFailure("not_found") { _ = try LocalVision.compose([frame], output: dir.appendingPathComponent("no/out.png").path) }
        expectFailure("invalid_input") { _ = try LocalVision.compose([], output: dir.appendingPathComponent("out.png").path) }
        var limits = LocalVision.Limits()
        limits.maxOutputPixels = 240 * 299
        expectFailure("invalid_input") { _ = try LocalVision.compose([frame], output: dir.appendingPathComponent("out.png").path, limits: limits) }
        limits = LocalVision.Limits()
        limits.maxFrames = 1
        expectFailure("invalid_input") { _ = try LocalVision.compose([frame, frame], output: dir.appendingPathComponent("out.png").path, limits: limits) }
        let other = try Fixture.write(Fixture.rows(page, from: 0, count: 301), dir, "b.png")
        expectFailure("invalid_input") { _ = try LocalVision.compose([frame, other], output: dir.appendingPathComponent("out.png").path) }
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("out.png").path))
    }

    @Test func cancellationLeavesNoFile() throws {
        let dir = try Fixture.directory()
        let frames = try [0, 200].enumerated().map { try Fixture.write(Fixture.rows(page, from: $1, count: 300), dir, "f\($0).png") }
        let output = dir.appendingPathComponent("out.png").path
        var checks = 0
        expectFailure("cancelled") {
            _ = try LocalVision.compose(frames, output: output, isCancelled: { checks += 1; return checks > 2 })
        }
        #expect(!FileManager.default.fileExists(atPath: output))
        #expect(try partials(in: dir).isEmpty)
    }

    @Test func reportsThePartialFileWhileItExists() throws {
        let dir = try Fixture.directory()
        let frame = try Fixture.write(Fixture.rows(page, from: 0, count: 100), dir, "a.png")
        let output = dir.appendingPathComponent("out.png").path
        var seen: [String?] = []
        _ = try LocalVision.compose([frame], output: output, nonce: "nonce-0001", tempFile: { seen.append($0) })
        #expect(seen == [LocalVision.partialPath(for: output, nonce: "nonce-0001"), nil])
        #expect(seen[0]?.hasPrefix(dir.path + "/.out.png.") == true, "the partial file stays in the output directory")
    }

    @Test func partialFilesItDidNotCreateAreLeftAlone() throws {
        let dir = try Fixture.directory()
        let frame = try Fixture.write(Fixture.rows(page, from: 0, count: 100), dir, "a.png")
        let output = dir.appendingPathComponent("out.png").path
        // Another compose's files: the old fixed name and another nonce.
        let legacy = dir.appendingPathComponent(".out.png.partial").path
        let other = LocalVision.partialPath(for: output, nonce: "other-nonce-1")
        for path in [legacy, other] { try Data("someone else's".utf8).write(to: URL(fileURLWithPath: path)) }

        // A nonce whose partial file already exists is a conflict, and that file survives.
        expectFailure("conflict") { _ = try LocalVision.compose([frame], output: output, nonce: "other-nonce-1") }
        #expect(!FileManager.default.fileExists(atPath: output))
        _ = try LocalVision.compose([frame], output: output, nonce: "mine-nonce-1")
        expectFailure("conflict") { _ = try LocalVision.compose([frame], output: output, nonce: "mine-nonce-2") }
        for path in [legacy, other] {
            #expect(try Data(contentsOf: URL(fileURLWithPath: path)) == Data("someone else's".utf8))
        }
        #expect(try partials(in: dir).sorted() == [".out.png.other-nonce-1.partial", ".out.png.partial"])
        expectFailure("invalid_input") { _ = try LocalVision.compose([frame], output: dir.appendingPathComponent("b.png").path, nonce: "../../x") }
        expectFailure("invalid_input") { _ = try LocalVision.compose([frame], output: dir.appendingPathComponent("b.png").path, nonce: "short") }
    }

    @Test func concurrentComposesToOneOutputNeverOverwrite() throws {
        let dir = try Fixture.directory()
        let frames = try [0, 200].enumerated().map { try Fixture.write(Fixture.rows(page, from: $1, count: 300), dir, "f\($0).png") }
        let output = dir.appendingPathComponent("out.png").path
        let lock = NSLock()
        var outcomes: [Result<LocalVision.Composed, LocalVision.Failure>] = []
        DispatchQueue.concurrentPerform(iterations: 4) { index in
            let outcome: Result<LocalVision.Composed, LocalVision.Failure>
            do {
                outcome = .success(try LocalVision.compose(frames, output: output, nonce: "racer-000\(index)"))
            } catch let failure as LocalVision.Failure {
                outcome = .failure(failure)
            } catch {
                outcome = .failure(.init("io", "\(error)"))
            }
            lock.lock(); outcomes.append(outcome); lock.unlock()
        }
        let winners = outcomes.compactMap { try? $0.get() }
        #expect(winners.count == 1)
        for case .failure(let failure) in outcomes { #expect(failure.code == "conflict", "\(failure)") }
        let data = try Data(contentsOf: URL(fileURLWithPath: output))
        #expect(LocalVision.sha256(data) == winners.first?.sha256)
        #expect(try partials(in: dir).isEmpty)
    }
}

@Suite struct LocalVisionProtocolTests {
    func reply(_ object: Any) throws -> (json: [String: Any], code: Int32) {
        let reply = LocalVision.handle(try JSONSerialization.data(withJSONObject: object))
        return (try #require(JSONSerialization.jsonObject(with: reply.json) as? [String: Any]), reply.exitCode)
    }

    @Test func answersMetadataAndCompare() throws {
        let dir = try Fixture.directory()
        let page = Fixture.page()
        let a = try Fixture.write(Fixture.rows(page, from: 0, count: 300), dir, "a.png")
        let b = try Fixture.write(Fixture.rows(page, from: 120, count: 300), dir, "b.png")
        let meta = try reply(["v": 1, "op": "metadata", "image": a])
        #expect(meta.code == 0)
        let info = try #require(meta.json["result"] as? [String: Any])
        #expect(info["widthPx"] as? Int == 240 && info["heightPx"] as? Int == 300)
        let compared = try reply(["v": 1, "op": "compare", "before": a, "after": b, "roi": ["x": 0, "y": 0, "width": 240, "height": 300]])
        let result = try #require(compared.json["result"] as? [String: Any])
        #expect(result["verticalShiftPx"] as? Int == 120)
    }

    @Test func invalidRequestsExitTwoWithACode() throws {
        let cases: [Any] = [
            ["v": 2, "op": "metadata", "image": "/x.png"],
            ["v": 1, "op": "screenshot"],
            ["v": 1, "op": "metadata", "image": "/x.png", "extra": true],
            ["v": 1, "op": "compare", "before": "/a.png", "after": "/b.png", "roi": ["x": true, "y": 0, "width": 1, "height": 1]],
            ["v": 1, "op": "compare", "before": "/a.png", "after": "/b.png", "minOverlapPx": 1.5],
            ["v": 1, "op": "compose", "output": "/o.png"],
        ]
        for request in cases {
            let (json, code) = try reply(request)
            #expect(code == 2, "\(request)")
            #expect((json["error"] as? [String: Any])?["code"] as? String == "invalid_input")
        }
        let garbage = LocalVision.handle(Data("not json".utf8))
        #expect(garbage.exitCode == 2)
    }

    @Test func missingFilesFailWithNotFound() throws {
        let (json, code) = try reply(["v": 1, "op": "metadata", "image": "/nonexistent-\(UUID().uuidString).png"])
        #expect(code == 1)
        #expect((json["error"] as? [String: Any])?["code"] as? String == "not_found")
    }
}
