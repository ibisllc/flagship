// swift-tools-version:5.9
import PackageDescription

// FlagshipMobile — iOS-only Swift package. Holds the bits that touch
// Argon2Kit (the `.flagshipkey` UMK backup KDF), LocalAuthentication
// (BiometricGate), AuthenticationServices (Recovery / WebAuthn), and
// the full SwiftUI FlagshipUI surface (UIKit + ActivityKit etc.).
//
// platforms: iOS + macOS ONLY — deliberately omits watchOS so SPM
// never tries to resolve Argon2Kit (which doesn't ship a watchOS
// slice) or compile iOS-only LocalAuthentication APIs against the
// watchOS SDK. The Watch app's Xcode target links the SEPARATE
// `apps/mobile/shared/Package.swift` (FlagshipShared) directly for
// cross-platform protocol + wire types.
let package = Package(
    name: "FlagshipMobile",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "Flagship", targets: ["Flagship"]),
        .library(name: "FlagshipUI", targets: ["FlagshipUI"])
    ],
    dependencies: [
        .package(url: "https://github.com/rkreutz/Argon2Kit.git", exact: "0.1.1"),
        // Cross-platform protocol + HTTP + wire types. Path-pinned to
        // the sibling package so this monorepo doesn't need a registry.
        .package(name: "FlagshipShared", path: "../shared")
    ],
    targets: [
        // Flagship — iOS-only crypto + keystore + biometric gate.
        // Pulls Argon2Kit + LocalAuthentication + AuthenticationServices.
        // Never linked from a watchOS target; the watch has no analogue.
        .target(
            name: "Flagship",
            dependencies: [
                .product(name: "FlagshipCore", package: "FlagshipShared"),
                .product(name: "Argon2Kit", package: "Argon2Kit")
            ],
            path: "Sources/Flagship"
        ),
        .target(
            name: "FlagshipUI",
            dependencies: [
                "Flagship",
                .product(name: "FlagshipAPI", package: "FlagshipShared"),
                .product(name: "FlagshipCore", package: "FlagshipShared")
            ],
            path: "Sources/FlagshipUI"
        ),
        .testTarget(
            name: "FlagshipMobileTests",
            dependencies: [
                "Flagship",
                "FlagshipUI",
                .product(name: "FlagshipAPI", package: "FlagshipShared"),
                .product(name: "FlagshipCore", package: "FlagshipShared")
            ],
            path: "Tests/FlagshipMobileTests"
        )
    ]
)
