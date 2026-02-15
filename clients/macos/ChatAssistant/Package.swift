// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ChatAssistant",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ChatAssistant", targets: ["ChatAssistant"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "ChatAssistant",
            swiftSettings: [.enableExperimentalFeature("BareSlashRegexLiterals")]
        )
    ]
)
