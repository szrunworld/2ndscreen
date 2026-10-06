import CoreGraphics
import Testing
@testable import SecondScreenCore

@Suite struct WindowContainmentTests {
    let screen = CGRect(x: 1920, y: 0, width: 1280, height: 800)

    @Test func aWindowInsideItsScreen() {
        #expect(WindowContainment.contains(screen, CGRect(x: 1920, y: 25, width: 1280, height: 775)))
        #expect(WindowContainment.overhang(of: CGRect(x: 2000, y: 100, width: 400, height: 300), beyond: screen) == nil)
    }

    @Test func aWindowReachingPastTheScreen() {
        let frame = CGRect(x: 2600, y: 500, width: 700, height: 400)  // 100 past the right, 100 past the bottom
        #expect(!WindowContainment.contains(screen, frame))
        #expect(WindowContainment.overhang(of: frame, beyond: screen) == "100 points past the right edge and 100 points past the bottom edge")
        #expect(WindowContainment.overhang(of: CGRect(x: 1900, y: -10, width: 100, height: 100), beyond: screen)
            == "20 points past the left edge and 10 points past the top edge")
    }

    @Test func croppingRefusesAClippedWindow() throws {
        let context = CGContext(data: nil, width: 200, height: 100, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        let picture = context.makeImage()!  // a 100x50-point screen at 2x
        let screenFrame = Frame(CGRect(x: 1000, y: 0, width: 100, height: 50))
        let inside = try Images.crop(picture, frame: Frame(CGRect(x: 1010, y: 5, width: 40, height: 20)), screenFrame: screenFrame)
        #expect(inside.width == 80 && inside.height == 40)
        #expect(throws: ImageError.self) {
            try Images.crop(picture, frame: Frame(CGRect(x: 1080, y: 5, width: 40, height: 20)), screenFrame: screenFrame)
        }
    }
}
