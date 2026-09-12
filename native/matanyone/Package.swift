// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RecordMatte",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../.cache/MatAnyone2Kit")],
    targets: [.executableTarget(name: "RecordMatte", dependencies: [
        .product(name: "MatAnyoneKitCoreML", package: "MatAnyone2Kit")
    ], path: "Sources"),
    .testTarget(name: "RecordMatteTests", dependencies: ["RecordMatte"], path: "Tests")]
)
