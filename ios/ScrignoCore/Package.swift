// swift-tools-version:5.9
import PackageDescription

// Nucleo condiviso (crittografia, vault, passkey, TOTP): compilato anche dentro l'app e l'estensione.
let package = Package(
    name: "ScrignoCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ScrignoCore", targets: ["ScrignoCore"])],
    targets: [
        .target(name: "ScrignoCore"),
        .testTarget(name: "ScrignoCoreTests", dependencies: ["ScrignoCore"], resources: [.copy("fixture-vault.json")]),
    ]
)
