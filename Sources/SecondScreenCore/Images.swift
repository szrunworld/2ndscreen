import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// PNG helpers for screenshots, which the app takes of whole screens in pixels.
public enum Images {
    /// Decoded now: an image read lazily goes blank once its file is
    /// deleted, as screenshot scratch files are.
    public static func load(_ path: String) throws -> CGImage {
        let options = [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, options)
        else { throw ImageError("cannot read \(path)") }
        return image
    }

    public static func png(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
        else { throw ImageError("cannot encode PNG") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw ImageError("cannot encode PNG") }
        return data as Data
    }

    /// The image redrawn at `size`.
    public static func scaled(_ image: CGImage, to size: CGSize) throws -> CGImage {
        let width = max(Int(size.width.rounded()), 1)
        let height = max(Int(size.height.rounded()), 1)
        if image.width == width, image.height == height { return image }
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw ImageError("cannot scale the image") }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else { throw ImageError("cannot scale the image") }
        return scaled
    }

    /// Write the part of a screen screenshot at `path` that shows `frame`,
    /// both in global points, to `output`.
    public static func crop(_ path: String, to output: String, frame: Frame, screenFrame: Frame) throws {
        let image = try load(path)
        let scale = Double(image.width) / screenFrame.width
        let rect = CGRect(x: (frame.x - screenFrame.x) * scale, y: (frame.y - screenFrame.y) * scale,
                          width: frame.width * scale, height: frame.height * scale).integral
        guard let cropped = image.cropping(to: rect) else { throw ImageError("the window is off its screen") }
        try png(cropped).write(to: URL(fileURLWithPath: output))
    }
}

public struct ImageError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
