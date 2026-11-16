// swift-tools-version:5.9
import Foundation
import PackageDescription

// voi.ci call media (docs/voici-calls.md §4): our WebRTC.xcframework and the TURN responder's FlagshipTurn.xcframework,
// built by .github/workflows/libwebrtc.yml. By default SwiftPM downloads them from the pinned GitHub pre-release and
// refuses them unless their SHA-256 matches (`webrtcRelease`, written by tools/libwebrtc/pin-release.sh from
// tools/libwebrtc/artifacts.sha256; never edit it by hand). For development, tools/libwebrtc/use-artifacts.sh unpacks
// a CI run (checked against the same pin) into Vendor/WebRTC (git-ignored), which wins. With neither, FlagshipUI builds
// with StubCallMediaEngine: calls ring but never connect (`#if canImport(WebRTC)` in WebRTCCallMediaEngine.swift).
let webrtcRelease: (base: String, webrtc: String, turn: String)? = nil
let vendorWebRTC = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vendor/WebRTC")
let webrtcLocal = ["WebRTC.xcframework", "FlagshipTurn.xcframework"].allSatisfy {
    FileManager.default.fileExists(atPath: vendorWebRTC.appendingPathComponent($0).path)
}
let callMediaTargets: [Target] = webrtcLocal ? [
    .binaryTarget(name: "WebRTC", path: "Vendor/WebRTC/WebRTC.xcframework"),
    .binaryTarget(name: "FlagshipTurn", path: "Vendor/WebRTC/FlagshipTurn.xcframework")
] : webrtcRelease.map { r in [
    .binaryTarget(name: "WebRTC", url: "\(r.base)/WebRTC.xcframework.zip", checksum: r.webrtc),
    .binaryTarget(name: "FlagshipTurn", url: "\(r.base)/FlagshipTurn.xcframework.zip", checksum: r.turn)
] } ?? []
let webrtcBundled = !callMediaTargets.isEmpty
let callMediaDependencies: [Target.Dependency] = webrtcBundled ? ["WebRTC", "FlagshipTurn"] : []

// FlagshipMobile — iOS-only Swift package. Holds the bits that touch
// argon2 (the `.flagshipkey` UMK backup KDF, via the locally-vendored
// CArgon2 + FlagshipArgon2 targets — see Vendor/CArgon2/VENDORED.md),
// LocalAuthentication (BiometricGate), AuthenticationServices (Recovery /
// WebAuthn), and the full SwiftUI FlagshipUI surface (UIKit + ActivityKit etc.).
//
// argon2 used to come from the external `Argon2Kit` SPM package, which pulled
// the phc-winner-argon2 C library as a git SUBMODULE — SPM's submodule clone
// was intermittently flaky here and broke the build ("Missing package product
// 'Argon2Kit'"). It is now vendored locally (byte-identical: same source, same
// pinned revision, same portable ref.c build), so SPM never clones a submodule.
//
// platforms: iOS + macOS ONLY — deliberately omits watchOS (iOS-only
// LocalAuthentication APIs). The Watch app's Xcode target links the SEPARATE
// `apps/mobile/shared/Package.swift` (FlagshipShared) directly for
// cross-platform protocol + wire types.
let package = Package(
    name: "FlagshipMobile",
    platforms: [
        .iOS("18.0"),
        .macOS("15.0")
    ],
    products: [
        .library(name: "Flagship", targets: ["Flagship"]),
        .library(name: "FlagshipUI", targets: ["FlagshipUI"])
    ],
    dependencies: [
        // Cross-platform protocol + HTTP + wire types. Path-pinned to
        // the sibling package so this monorepo doesn't need a registry.
        .package(name: "FlagshipShared", path: "../shared")
    ],
    targets: [
        // CArgon2 — locally-vendored phc-winner-argon2 reference C library
        // (portable ref.c build). Replaces the former Argon2Kit submodule.
        .target(
            name: "CArgon2",
            path: "Vendor/CArgon2",
            sources: [
                "src/argon2.c",
                "src/core.c",
                "src/encoding.c",
                "src/ref.c",
                "src/thread.c",
                "src/blake2/blake2b.c"
            ],
            publicHeadersPath: "include",
            cSettings: [
                .headerSearchPath("src"),
                .headerSearchPath("include")
            ]
        ),
        // FlagshipArgon2 — thin Swift wrapper exposing the Argon2.hash(...)
        // surface the call sites use (mirrors the old Argon2Kit API).
        .target(
            name: "FlagshipArgon2",
            dependencies: ["CArgon2"],
            path: "Sources/FlagshipArgon2"
        ),
        // Flagship — iOS-only crypto + keystore + biometric gate.
        // Uses FlagshipArgon2 + LocalAuthentication + AuthenticationServices.
        // Never linked from a watchOS target; the watch has no analogue.
        .target(
            name: "Flagship",
            dependencies: [
                .product(name: "FlagshipAPI", package: "FlagshipShared"),
                .product(name: "FlagshipCore", package: "FlagshipShared"),
                "FlagshipArgon2"
            ],
            path: "Sources/Flagship"
        ),
        .target(
            name: "FlagshipUI",
            dependencies: [
                "Flagship",
                .product(name: "FlagshipAPI", package: "FlagshipShared"),
                .product(name: "FlagshipCore", package: "FlagshipShared")
            ] + callMediaDependencies,
            path: "Sources/FlagshipUI"
        ),
        .testTarget(
            name: "FlagshipMobileTests",
            dependencies: [
                "Flagship",
                "FlagshipUI",
                "FlagshipArgon2",
                .product(name: "FlagshipAPI", package: "FlagshipShared"),
                .product(name: "FlagshipCore", package: "FlagshipShared")
            ],
            path: "Tests/FlagshipMobileTests"
        )
    ] + callMediaTargets
)
