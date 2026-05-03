// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Flagship",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(name: "Flagship", targets: ["Flagship"])
    ],
    dependencies: [],
    targets: [
        .target(
            name: "Flagship",
            path: "Sources/Flagship"
        ),
        .testTarget(
            name: "FlagshipTests",
            dependencies: ["Flagship"],
            path: "Tests/FlagshipTests"
        )
    ]
)
