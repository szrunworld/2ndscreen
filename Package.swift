// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SecondScreen",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "2ndscreen", targets: ["ScreenCLI"]),
        .executable(name: "vdisplay", targets: ["vdisplay"]),
        .executable(name: "SecondScreen", targets: ["SecondScreen"]),
        // For apps that embed 2ndscreen as their agent runtime instead of
        // shipping 2ndscreen.app beside themselves.
        .library(name: "SecondScreenCore", targets: ["SecondScreenCore"]),
        .library(name: "SecondScreenRuntime", targets: ["SecondScreenRuntime"]),
        .library(name: "TarsAgent", targets: ["TarsAgent"]),
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
        // Agent screens, input into the apps on them, the agent cursor, and
        // the control socket: what a host app embeds to give agents screens.
        .target(
            name: "SecondScreenRuntime",
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
            dependencies: ["SecondScreenCore", "SecondScreenRuntime", "TarsAgent"]
        ),
        .testTarget(
            name: "TarsAgentTests",
            dependencies: ["TarsAgent"]
        ),
        .testTarget(
            name: "SecondScreenCoreTests",
            dependencies: ["SecondScreenCore"]
        ),
        .testTarget(
            name: "SecondScreenRuntimeTests",
            dependencies: ["SecondScreenRuntime"]
        ),
    ]
)
