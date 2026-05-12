// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FlagshipMobile",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(name: "Flagship", targets: ["Flagship"]),
        .library(name: "FlagshipAPI", targets: ["FlagshipAPI"]),
        .library(name: "FlagshipCore", targets: ["FlagshipCore"]),
        .library(name: "FlagshipUI", targets: ["FlagshipUI"])
    ],
    dependencies: [],
    targets: [
        .target(
            name: "Flagship",
            path: "Sources/Flagship"
        ),
        .target(
            name: "FlagshipAPI",
            path: "Sources/FlagshipAPI"
        ),
        .target(
            name: "FlagshipCore",
            dependencies: ["FlagshipAPI"],
            path: "Sources/FlagshipCore"
        ),
        .target(
            name: "FlagshipUI",
            dependencies: ["Flagship", "FlagshipAPI", "FlagshipCore"],
            path: "Sources/FlagshipUI"
        )
    ]
)
