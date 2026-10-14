import XCTest
import SwiftUI
import UIKit
@testable import Flagship
@testable import FlagshipUI
@testable import FlagshipAPI

/// Renders the build chat with the model menu open, the image switch alert,
/// and staged attachments with the notice, as PNGs for a visual check. Runs
/// only when `FLAGSHIP_SNAPSHOT_DIR` is set (pass it to xcodebuild as
/// `TEST_RUNNER_FLAGSHIP_SNAPSHOT_DIR`).
@MainActor
final class ModelMenuSnapshotTests: XCTestCase {

    /// What's drawn over the screen. The package test host has no window
    /// scene, so SwiftUI can't present a popover or alert there: the open
    /// menu is the real `ModelMenuPanel` placed where the popover opens, and
    /// the alert a real `UIAlertController` with the same title and buttons.
    enum Overlay {
        case menu(ModelMenuModel)
        case alert(VisionDecision)
    }

    private func snapshot<V: View>(_ view: V, name: String, dir: String, overlay: Overlay? = nil) async throws {
        let window = UIWindow()
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let host = UIHostingController(rootView: view)
        host.view.frame = window.bounds
        window.rootViewController = host
        window.makeKeyAndVisible()
        try await Task.sleep(nanoseconds: 2_000_000_000)
        switch overlay {
        case .menu(let menu):
            let panel = UIHostingController(rootView: ModelMenuPanel(menu: menu)
                .clipShape(RoundedRectangle(cornerRadius: 14)))
            panel.view.backgroundColor = .clear
            let size = panel.sizeThatFits(in: CGSize(width: 320, height: 460))
            panel.view.frame = CGRect(x: 393 - 16 - 320, y: 104, width: 320, height: size.height)
            panel.view.layer.shadowColor = UIColor.black.cgColor
            panel.view.layer.shadowOpacity = 0.18
            panel.view.layer.shadowRadius = 18
            panel.view.layer.shadowOffset = CGSize(width: 0, height: 6)
            host.addChild(panel)
            host.view.addSubview(panel.view)
        case .alert(let decision):
            let dim = UIView(frame: window.bounds)
            dim.backgroundColor = UIColor.black.withAlphaComponent(0.2)
            host.view.addSubview(dim)
            let alert = UIAlertController(title: decision.message, message: nil, preferredStyle: .alert)
            if case .offerSwitch = decision {
                alert.addAction(UIAlertAction(title: "Switch", style: .default))
                alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            } else {
                alert.addAction(UIAlertAction(title: "OK", style: .cancel))
            }
            // The alert's glass doesn't render off screen: back it with the
            // plain fill it shows over a light screen.
            let card = UIView()
            card.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.97)
            card.layer.cornerRadius = 22
            card.translatesAutoresizingMaskIntoConstraints = false
            host.view.addSubview(card)
            host.addChild(alert)
            alert.view.translatesAutoresizingMaskIntoConstraints = false
            host.view.addSubview(alert.view)
            NSLayoutConstraint.activate([
                card.leadingAnchor.constraint(equalTo: alert.view.leadingAnchor),
                card.trailingAnchor.constraint(equalTo: alert.view.trailingAnchor),
                card.topAnchor.constraint(equalTo: alert.view.topAnchor),
                card.bottomAnchor.constraint(equalTo: alert.view.bottomAnchor),
                alert.view.centerXAnchor.constraint(equalTo: host.view.centerXAnchor),
                alert.view.centerYAnchor.constraint(equalTo: host.view.centerYAnchor),
                alert.view.widthAnchor.constraint(equalToConstant: 270),
            ])
            alert.didMove(toParent: host)
        case nil:
            break
        }
        try await Task.sleep(nanoseconds: 600_000_000)
        host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { ctx in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) {
                host.view.layer.render(in: ctx.cgContext)
            }
        }
        let data = try XCTUnwrap(image.pngData())
        try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
        window.isHidden = true
        try await Task.sleep(nanoseconds: 300_000_000)
    }

    private func client() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.vibeCodeSessionStateFixture = VibeCodeSessionPublicState(
            id: "vc_snap", appId: "harry--plants", status: "awaiting-tool-response",
            messages: [
                VibeCodeSessionMessage(role: "user", text: "A plant tracker: when I last watered each plant.",
                                       timestamp: 1),
                VibeCodeSessionMessage(role: "assistant",
                                       text: "Got it. I'll keep one row per plant with the last watering date.",
                                       timestamp: 2, credits: 2.8),
                VibeCodeSessionMessage(role: "user", text: "Use this layout, and these plants.", timestamp: 3,
                                       attachments: [
                                           .image(name: "mockup.png", mediaType: "image/png", data: Data([0])),
                                           .data(name: "plants.csv", mediaType: "text/csv", text: "name\n"),
                                       ]),
                VibeCodeSessionMessage(role: "assistant", text: "Done: the list matches your mockup.",
                                       timestamp: 4, credits: 1),
            ],
            pendingRequest: .talkToUser(toolUseId: "tu1", message: "Should watering reminders go out by push?"),
            model: "medium", effort: nil)
        return c
    }

    private func screen(_ c: MockScreensClient, menu: ModelMenuModel, stager: ChatAttachmentStager? = nil) -> some View {
        let s = VibeCodeSessionScreen(
            stream: VibeCodeStreamViewModel(sessionId: "vc_snap", client: c),
            serverFqdn: "home.harry.flagship.services", client: c,
            signEnvelope: { _ in "" }, menu: menu, attachments: stager)
        return NavigationStack { s }
    }

    func test_snapshot_modelMenu() async throws {
        guard let dir = ProcessInfo.processInfo.environment["FLAGSHIP_SNAPSHOT_DIR"], !dir.isEmpty else {
            throw XCTSkip("set FLAGSHIP_SNAPSHOT_DIR to render the screenshots")
        }
        let c = client()
        let catalog = InferenceCatalogResponse.mock

        let menu = ModelMenuModel(source: .flagship(catalog), initial: ModelChoice(model: "low", effort: "high"))
        try await snapshot(screen(c, menu: menu), name: "models-menu-ios.png", dir: dir, overlay: .menu(menu))

        let textOnly = ModelMenuModel(source: .flagship(catalog), initial: ModelChoice(model: "medium", effort: nil))
        let staged = ChatAttachmentStager(staged: [
            .image(name: "mockup.png", mediaType: "image/png", data: Data([0])),
        ])
        try await snapshot(screen(c, menu: textOnly, stager: staged), name: "models-switch-ios.png", dir: dir,
                           overlay: .alert(textOnly.visionDecision(hasImage: true)))

        let attach = ChatAttachmentStager(staged: [
            .image(name: "mockup.png", mediaType: "image/png", data: Data([0])),
            .data(name: "plants.csv", mediaType: "text/csv", text: "name\n"),
            .document(name: "watering-guide.pdf", data: Data([0])),
        ])
        attach.fail(ChatAttachmentRules.Refusal.tooBig(name: "holiday.jpg", kind: .image).message)
        let low = ModelMenuModel(source: .flagship(catalog), initial: ModelChoice(model: "low", effort: nil))
        try await snapshot(screen(c, menu: low, stager: attach), name: "models-attach-ios.png", dir: dir)

        let ownMenu = ModelMenuModel(source: .own(AiModelsResponse(
            provider: "openai", kind: "own", listed: true, models: ModelOption.mockOwn, defaultModel: "gpt-5.4-mini")))
        try await snapshot(screen(c, menu: ownMenu), name: "models-menu-own-ios.png", dir: dir, overlay: .menu(ownMenu))
    }
}
