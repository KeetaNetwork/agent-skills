// swift-tools-version: 6.0
// Pure logic shared by the macOS app and its tests: the RPC contract types,
// JSON-RPC framing, signature encoding and amount formatting.
// The Xcode project (project.yml) compiles the same sources as a framework.

import PackageDescription

let package = Package(
    name: "KeetaComputeKit",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "KeetaComputeKit", targets: ["KeetaComputeKit"])
    ],
    targets: [
        .target(name: "KeetaComputeKit", path: "Sources/KeetaComputeKit"),
        .testTarget(name: "KeetaComputeKitTests", dependencies: ["KeetaComputeKit"], path: "Tests/KeetaComputeKitTests")
    ],
    swiftLanguageModes: [.v5]
)
