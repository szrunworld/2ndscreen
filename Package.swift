// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "2ndscreen",
    platforms: [.macOS(.v14)],
    targets: [
        // Declarations for CoreGraphics' private CGVirtualDisplay classes.
        .target(name: "CGVirtualDisplayPrivate"),
        // Virtual display lifecycle and live preview, shared by the CLI and app.
        .target(
            name: "SecondScreenCore",
            dependencies: ["CGVirtualDisplayPrivate"]
        ),
        .executableTarget(
            name: "vdisplay",
            dependencies: ["SecondScreenCore"]
        ),
        // Menu bar app; scripts/bundle-app.sh wraps it in 2ndscreen.app.
        .executableTarget(
            name: "SecondScreen",
            dependencies: ["SecondScreenCore"]
        ),
    ]
)
