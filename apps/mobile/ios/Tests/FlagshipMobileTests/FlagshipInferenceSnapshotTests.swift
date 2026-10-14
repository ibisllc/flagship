import XCTest
import SwiftUI
import UIKit
import CryptoKit
@testable import Flagship
@testable import FlagshipUI
@testable import FlagshipAPI

/// Renders Settings → AI keys and the AI-key step with the built-in Flagship
/// Inference entry first and one saved key, as PNGs for a visual check. Runs
/// only when `FLAGSHIP_SNAPSHOT_DIR` is set (pass it to xcodebuild as
/// `TEST_RUNNER_FLAGSHIP_SNAPSHOT_DIR`).
@MainActor
final class FlagshipInferenceSnapshotTests: XCTestCase {

    private func snapshot<V: View>(_ view: V, name: String, dir: String) async throws {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let host = UIHostingController(rootView: view)
        host.view.frame = window.bounds
        window.rootViewController = host
        window.makeKeyAndVisible()
        try await Task.sleep(nanoseconds: 1_500_000_000)
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { ctx in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) {
                host.view.layer.render(in: ctx.cgContext)
            }
        }
        let data = try XCTUnwrap(image.pngData())
        try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
        window.isHidden = true
    }

    func test_snapshot_providerLists() async throws {
        guard let dir = ProcessInfo.processInfo.environment["FLAGSHIP_SNAPSHOT_DIR"], !dir.isEmpty else {
            throw XCTSkip("set FLAGSHIP_SNAPSHOT_DIR to render the screenshots")
        }
        let store = SavedKeyStore()
        store.clear()
        defer { store.clear() }
        _ = try store.add(provider: "anthropic", label: "Personal", apiKey: "sk-ant-api03-abcdefgh1234")
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let key = Curve25519.Signing.PrivateKey()
        let service = FreeAiCreditsService(client: server, username: { "harry" },
                                           sign: { try key.signature(for: $0) })

        try await snapshot(
            NavigationStack { AiKeysScreen(vm: AiKeysViewModel(store: store), freeAiService: service) },
            name: "credits-ios-settings.png", dir: dir)

        let vm = BuildKeyViewModel(store: store, freeAiService: service)
        try await snapshot(
            NavigationStack {
                BuildKeyScreen(vm: vm, contextLabel: "Start from scratch with AI", freeAiService: service,
                               serverFqdn: "home.harry.flagship.services") { _ in }
            },
            name: "credits-ios-key-step.png", dir: dir)

        server.freeAiEnded = true
        let ended = BuildKeyViewModel(store: store, freeAiService: service)
        try await snapshot(
            NavigationStack {
                BuildKeyScreen(vm: ended, contextLabel: "Start from scratch with AI", freeAiService: service,
                               serverFqdn: "home.harry.flagship.services") { _ in }
            },
            name: "credits-ios-ended.png", dir: dir)
    }
}
