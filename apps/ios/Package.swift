// swift-tools-version:5.9
// The platform-independent core of the Autark iPhone app (relay, pairing, peer channel, local entrance) as a Swift package,
// so its tests also run on Linux (WSL, ubuntu runners) where no Xcode exists. The app itself is built from project.yml
// (XcodeGen); this package is the same sources under Autark/Core plus the tests under Tests/CoreTests.
import PackageDescription

#if os(Linux)
let dependencies: [Package.Dependency] = [.package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0")]
let coreDependencies: [Target.Dependency] = [.product(name: "Crypto", package: "swift-crypto")]
#else
let dependencies: [Package.Dependency] = []
let coreDependencies: [Target.Dependency] = []
#endif

let package = Package(
    name: "AutarkCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "AutarkCore", targets: ["AutarkCore"])],
    dependencies: dependencies,
    targets: [
        .target(name: "AutarkCore", dependencies: coreDependencies, path: "Autark/Core"),
        // The WebSocket of the app (URLSession) compiled on Linux too, so it can be tried against a real server there; the keychain is Apple only.
        .target(name: "AutarkPlatform", dependencies: ["AutarkCore"], path: "Autark/Platform", exclude: ["KeychainStore.swift"]),
        .testTarget(name: "AutarkCoreTests", dependencies: ["AutarkCore"], path: "Tests/CoreTests"),
    ]
)
