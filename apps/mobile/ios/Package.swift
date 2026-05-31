// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FlagshipMobile",
    platforms: [
        .iOS(.v17),
        .watchOS(.v10),
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
        // Flagship — iOS-only crypto + keystore + biometric gate.
        // Pulls in Argon2Kit, LocalAuthentication, AuthenticationServices.
        // Never linked from a watchOS target — the iOS shell links it
        // for SE-keypair / biometric / `.flagshipkey` import-export
        // flows; the watch has no analogue.
        .target(
            name: "Flagship",
            dependencies: [
                "FlagshipCore",
                .product(name: "Argon2Kit", package: "Argon2Kit")
            ],
            path: "Sources/Flagship"
        ),
        .target(
            name: "FlagshipAPI",
            path: "Sources/FlagshipAPI"
        ),
        // FlagshipCore is the CROSS-PLATFORM module — usable from iOS,
        // watchOS, and macOS targets. It depends only on FlagshipAPI
        // (also cross-platform) and pure system frameworks (Foundation,
        // CryptoKit, Security). Anything that needs LocalAuthentication,
        // Argon2Kit, AuthenticationServices, UIKit or ActivityKit lives
        // in `Flagship` (iOS-only) or `FlagshipUI` (iOS-only) so the
        // watchOS build pass never has to compile incompatible code.
        .target(
            name: "FlagshipCore",
            dependencies: ["FlagshipAPI"],
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
