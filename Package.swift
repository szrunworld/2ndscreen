// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "2ndscreen",
    platforms: [.macOS(.v14)],
    targets: [
        // Declarations for CoreGraphics' private CGVirtualDisplay classes.
        .target(name: "CGVirtualDisplayPrivate"),
        .executableTarget(
            name: "vdisplay",
            dependencies: ["CGVirtualDisplayPrivate"]
        ),
    ]
)
