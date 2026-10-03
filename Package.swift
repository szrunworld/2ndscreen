// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SecondScreen",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "2ndscreen", targets: ["ScreenCLI"]),
        .executable(name: "vdisplay", targets: ["vdisplay"]),
        .executable(name: "SecondScreen", targets: ["SecondScreen"]),
    ],
    targets: [
        // Declarations for CoreGraphics' private CGVirtualDisplay classes.
        .target(name: "CGVirtualDisplayPrivate"),
        // Virtual display lifecycle and live preview, shared by the CLI and app.
        .target(
            name: "SecondScreenCore",
            dependencies: ["CGVirtualDisplayPrivate"]
        ),
        // The UI-TARS agent loop: prompt, model client, reply parser, and the
        // mapping from model actions to 2ndscreen input.
        .target(
            name: "TarsAgent",
            dependencies: ["SecondScreenCore"]
        ),
        .executableTarget(
            name: "vdisplay",
            dependencies: ["SecondScreenCore"]
        ),
        // Agent-facing CLI; talks to the running app over a Unix socket.
        .executableTarget(
            name: "ScreenCLI",
            dependencies: ["SecondScreenCore", "TarsAgent"]
        ),
        // Menu bar app; scripts/bundle-app.sh wraps it in 2ndscreen.app.
        .executableTarget(
            name: "SecondScreen",
            dependencies: ["SecondScreenCore", "TarsAgent"]
        ),
        .testTarget(
            name: "TarsAgentTests",
            dependencies: ["TarsAgent"]
        ),
        .testTarget(
            name: "SecondScreenCoreTests",
            dependencies: ["SecondScreenCore"]
        ),
    ]
)
