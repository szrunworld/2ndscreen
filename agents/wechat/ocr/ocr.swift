// ocr: read a PNG screenshot for the WeChat assistant.
//
//   ocr IMAGE.png [x y w h]          text in the image (or the rectangle), with Apple's Vision
//   ocr IMAGE.png color x y w h      how much of the rectangle is WeChat green, red, or white
//
// Text comes as a JSON array of {"text", "x", "y", "w", "h", "confidence"} in
// the image's pixel space, top-left origin. Languages: Simplified Chinese,
// English. Colours come as {"green", "red", "white"}: each the share of the
// rectangle's pixels of that colour, 0 to 1.
import AppKit
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(2)
}

let args = CommandLine.arguments
guard args.count >= 2, let image = NSImage(contentsOfFile: args[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fail("usage: ocr IMAGE.png [x y w h] | ocr IMAGE.png color x y w h") }
let width = Double(cg.width), height = Double(cg.height)

func rectangle(_ words: ArraySlice<String>) -> CGRect {
    let numbers = words.compactMap(Double.init)
    guard numbers.count == 4 else { fail("the rectangle needs x y w h") }
    let rect = CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
        .intersection(CGRect(x: 0, y: 0, width: width, height: height))
    guard !rect.isNull, rect.width >= 1, rect.height >= 1 else { fail("the rectangle lies outside the image") }
    return rect
}

func emit(_ object: Any) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
    print(String(data: data, encoding: .utf8)!)
}

if args.count == 7, args[2] == "color" {
    let rect = rectangle(args[3...])
    guard let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { fail("cannot read pixels") }
    let bpp = cg.bitsPerPixel / 8, stride = cg.bytesPerRow
    // Where red, green and blue sit depends on the PNG's byte order.
    let (ri, gi, bi): (Int, Int, Int) = cg.bitmapInfo.contains(.byteOrder32Little) ? (2, 1, 0) : (0, 1, 2)
    var green = 0, red = 0, white = 0, total = 0
    for y in Int(rect.minY)..<Int(rect.maxY) {
        for x in Int(rect.minX)..<Int(rect.maxX) {
            let p = y * stride + x * bpp
            let r = Int(bytes[p + ri]), g = Int(bytes[p + gi]), b = Int(bytes[p + bi])
            total += 1
            // WeChat's green (#07C160 and its hover shades), the unread red, and light text.
            if g > 140 && r < 90 && b < 130 && g > r + 60 { green += 1 }
            else if r > 200 && g < 90 && b < 90 { red += 1 }
            else if r > 200 && g > 200 && b > 200 { white += 1 }
        }
    }
    let n = Double(max(total, 1))
    emit(["green": Double(green) / n, "red": Double(red) / n, "white": Double(white) / n])
    exit(0)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
if args.count == 6 {
    let r = rectangle(args[2...])
    // Vision regions are normalised with a bottom-left origin.
    request.regionOfInterest = CGRect(x: r.minX / width, y: 1 - r.maxY / height,
                                      width: r.width / width, height: r.height / height)
        .intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
} else if args.count != 2 {
    fail("usage: ocr IMAGE.png [x y w h] | ocr IMAGE.png color x y w h")
}

do {
    try VNImageRequestHandler(cgImage: cg).perform([request])
} catch {
    fail("ocr failed: \(error)")
}

var out: [[String: Any]] = []
for observation in request.results ?? [] {
    guard let best = observation.topCandidates(1).first else { continue }
    // Normalised, bottom-left origin, relative to the region of interest.
    let roi = request.regionOfInterest
    let local = observation.boundingBox
    let box = CGRect(x: roi.minX + local.minX * roi.width, y: roi.minY + local.minY * roi.height,
                     width: local.width * roi.width, height: local.height * roi.height)
    out.append([
        "text": best.string,
        "x": box.minX * width, "y": (1 - box.maxY) * height,
        "w": box.width * width, "h": box.height * height,
        "confidence": best.confidence,
    ])
}
emit(out)
