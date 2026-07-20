// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "VisionBridge",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "VisionBridge",
            type: .static,
            targets: ["VisionBridge"])
    ],
    targets: [
        .target(
            name: "VisionBridge",
            path: "Sources/VisionBridge",
            publicHeadersPath: "include")
    ]
)
