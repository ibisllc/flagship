// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FlagshipBurner",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "FlagshipBurner", targets: ["FlagshipBurner"]),
        .executable(name: "FlagshipBurnerHelper", targets: ["FlagshipBurnerHelper"]),
        .library(name: "FlagshipBurnerCore", targets: ["FlagshipBurnerCore"])
    ],
    dependencies: [],
    targets: [
        .target(
            name: "FlagshipBurnerCore",
            path: "Sources/FlagshipBurnerCore",
            resources: [
                // The single canonical preseed/user-data generator, run via
                // JavaScriptCore. GENERATED — a verbatim copy of
                // packages/flagship-burner/engine/preseed-engine.js. Must stay in
                // sync; PreseedEngineTests asserts byte-identity against the
                // canonical source AND against the shared Node golden vectors.
                .copy("Resources/preseed-engine.js")
            ]
        ),
        .executableTarget(
            name: "FlagshipBurner",
            dependencies: ["FlagshipBurnerCore"],
            path: "Sources/FlagshipBurner"
        ),
        .executableTarget(
            name: "FlagshipBurnerHelper",
            dependencies: ["FlagshipBurnerCore"],
            path: "Sources/FlagshipBurnerHelper"
        ),
        .testTarget(
            name: "FlagshipBurnerTests",
            dependencies: ["FlagshipBurnerCore"],
            path: "Tests/FlagshipBurnerTests",
            resources: [
                // Shared cross-platform golden vectors (Node-produced). The
                // engine test asserts JavaScriptCore reproduces these exactly.
                .copy("Resources/preseed-vectors.json")
            ]
        )
    ]
)
