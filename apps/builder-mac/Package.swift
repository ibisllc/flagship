// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FlagshipBuilder",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "FlagshipBuilder", targets: ["FlagshipBuilder"]),
        .executable(name: "FlagshipBuilderHelper", targets: ["FlagshipBuilderHelper"]),
        .library(name: "FlagshipBuilderCore", targets: ["FlagshipBuilderCore"])
    ],
    dependencies: [],
    targets: [
        .target(
            name: "FlagshipBuilderCore",
            path: "Sources/FlagshipBuilderCore",
            resources: [
                // The single canonical preseed/user-data generator, run via
                // JavaScriptCore. GENERATED — a verbatim copy of
                // packages/flagship-builder/engine/preseed-engine.js. Must stay in
                // sync; PreseedEngineTests asserts byte-identity against the
                // canonical source AND against the shared Node golden vectors.
                .copy("Resources/preseed-engine.js")
            ]
        ),
        .executableTarget(
            name: "FlagshipBuilder",
            dependencies: ["FlagshipBuilderCore"],
            path: "Sources/FlagshipBuilder"
        ),
        .executableTarget(
            name: "FlagshipBuilderHelper",
            dependencies: ["FlagshipBuilderCore"],
            path: "Sources/FlagshipBuilderHelper"
        ),
        .testTarget(
            name: "FlagshipBuilderTests",
            dependencies: ["FlagshipBuilderCore"],
            path: "Tests/FlagshipBuilderTests",
            resources: [
                // Shared cross-platform golden vectors (Node-produced). The
                // engine test asserts JavaScriptCore reproduces these exactly.
                .copy("Resources/preseed-vectors.json")
            ]
        )
    ]
)
