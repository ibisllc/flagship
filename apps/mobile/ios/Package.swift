// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FlagshipMobile",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "Flagship", targets: ["Flagship"]),
        .library(name: "FlagshipAPI", targets: ["FlagshipAPI"]),
        .library(name: "FlagshipCore", targets: ["FlagshipCore"]),
        .library(name: "FlagshipUI", targets: ["FlagshipUI"])
    ],
    dependencies: [
        // argon2id KDF for the `.flagshipkey` UMK backup format. Pinned
        // to a tagged release. Argon2Kit is a thin Swift wrapper that
        // VENDORS the canonical phc-winner-argon2 reference C source as
        // its own SwiftPM target (no unstable transitive dependency), so
        // it pins cleanly and builds on our iOS-17 floor. Supports
        // explicit m/t/p + argon2id + V13, which the byte-compatible
        // `.flagshipkey` format requires.
        .package(url: "https://github.com/rkreutz/Argon2Kit.git", exact: "0.1.1")
    ],
    targets: [
        .target(
            name: "Flagship",
            dependencies: [
                .product(name: "Argon2Kit", package: "Argon2Kit")
            ],
            path: "Sources/Flagship"
        ),
        .target(
            name: "FlagshipAPI",
            path: "Sources/FlagshipAPI"
        ),
        .target(
            name: "FlagshipCore",
            dependencies: ["FlagshipAPI", "Flagship"],
            path: "Sources/FlagshipCore"
        ),
        .target(
            name: "FlagshipUI",
            dependencies: ["Flagship", "FlagshipAPI", "FlagshipCore"],
            path: "Sources/FlagshipUI"
        ),
        .testTarget(
            name: "FlagshipMobileTests",
            dependencies: ["Flagship", "FlagshipAPI", "FlagshipCore", "FlagshipUI"],
            path: "Tests/FlagshipMobileTests"
        )
    ]
)
