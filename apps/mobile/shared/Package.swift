// swift-tools-version:5.9
import PackageDescription

// FlagshipShared — cross-platform (iOS + watchOS + macOS) Swift package
// for protocol envelopes, canonical bytes, the
// provision-timeline ladder projection, and the HTTP/wire-type surface
// that both the iPhone app + the Watch app + the Watch widget extension
// consume.
//
// Lives in a SEPARATE package from `apps/mobile/ios/Package.swift` (the
// iOS-only package, which holds Keystore + BiometricGate + Keyfile +
// FlagshipUI) so the watchOS build pass never has to resolve iOS-only
// transitive deps like Argon2Kit or LocalAuthentication. The iOS
// package depends on THIS one via a path reference; the Watch app's
// Xcode target links THIS package directly.
//
// Source-level platform conditionals (`#if os(iOS)` etc.) are
// DELIBERATELY ABSENT from every file in this package — any iOS-only
// API belongs in the iOS package, not here.
let package = Package(
    name: "FlagshipShared",
    platforms: [
        .iOS(.v17),
        .watchOS(.v10),
        .macOS(.v14)
    ],
    products: [
        .library(name: "FlagshipAPI", targets: ["FlagshipAPI"]),
        .library(name: "FlagshipCore", targets: ["FlagshipCore"])
    ],
    targets: [
        .target(
            name: "FlagshipAPI",
            path: "Sources/FlagshipAPI"
        ),
        .target(
            name: "FlagshipCore",
            dependencies: ["FlagshipAPI"],
            path: "Sources/FlagshipCore"
        )
    ]
)
