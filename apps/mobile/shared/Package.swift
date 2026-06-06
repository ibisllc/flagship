// swift-tools-version:5.9
import PackageDescription

// FlagshipShared — cross-platform (iOS + watchOS + macOS) Swift package
// for protocol envelopes, canonical bytes, NFC pair crypto, the
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
        .iOS("18.0"),
        .watchOS("11.0"),
        .macOS("15.0")
    ],
    products: [
        .library(name: "FlagshipAPI", targets: ["FlagshipAPI"]),
        .library(name: "FlagshipCore", targets: ["FlagshipCore"])
    ],
    targets: [
        // CFlagshipPQ — software ML-DSA-65 / ML-KEM-768 (vendored mldsa-native + mlkem-native,
        // see Sources/CFlagshipPQ/vendor/VENDORED.md), SHA3/SHAKE and the Ed25519 strict-point
        // check behind the architecture-v2 hybrid suites. CryptoKit's PQ types need iOS 26.
        .target(
            name: "CFlagshipPQ",
            path: "Sources/CFlagshipPQ",
            exclude: ["vendor"],
            sources: ["pq_mldsa.c", "pq_mlkem.c", "pq_ed25519.c"],
            publicHeadersPath: "include",
            cSettings: [
                .headerSearchPath("vendor/mldsa"),
                .headerSearchPath("vendor/mlkem")
            ]
        ),
        .target(
            name: "FlagshipAPI",
            path: "Sources/FlagshipAPI"
        ),
        .target(
            name: "FlagshipCore",
            dependencies: ["FlagshipAPI", "CFlagshipPQ"],
            path: "Sources/FlagshipCore"
        ),
        .testTarget(
            name: "FlagshipSharedTests",
            dependencies: ["FlagshipAPI", "FlagshipCore"],
            path: "Tests/FlagshipSharedTests"
        )
    ]
)
