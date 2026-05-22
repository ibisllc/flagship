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
            path: "Sources/FlagshipBurnerCore"
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
            path: "Tests/FlagshipBurnerTests"
        )
    ]
)
