import Foundation
import Observation
import FlagshipAPI

/// Plan A — orchestrates the connect-and-wait flow for the single
/// demo device.
///
///   1. POST `/api/dev/sample-user/{username}/connect` (no auth, no
///      body) → tells the Worker to (re)provision the Hetzner VPS.
///   2. Poll `/api/users/check` every `pollIntervalSeconds` seconds
///      until `demoServer.status == "up"` OR `timeoutSeconds`
///      elapses, then surface a clear "still booting" error.
///   3. On success, flip the matching pod's status in `AppState` from
///      `.pending` to `.online` so the home-screen leader picks land
///      on a non-pending detail page.
///
/// The coordinator is observable so SwiftUI views can render its
/// `state` directly. Hosts instantiate one per tap on the demo
/// device's "Connect" CTA; cancelling the surrounding view
/// cancels the in-flight Task.
@MainActor
@Observable
public final class DemoConnectCoordinator {
    public enum State: Equatable {
        case idle
        case connecting
        case polling(lastStatus: String)
        case up(fqdn: String)
        case failed(reason: String)
    }

    public private(set) var state: State = .idle

    private let server: any FlagshipServerClient
    private let demoConnect: any DemoConnectClient

    public init(
        server: any FlagshipServerClient,
        demoConnect: any DemoConnectClient
    ) {
        self.server = server
        self.demoConnect = demoConnect
    }

    /// Kick off the connect-and-wait sequence for [username].
    ///
    /// On success flips the [appState] pod whose FQDN matches the
    /// server's reported one from `.pending` to `.online`. On failure
    /// the pod is left untouched; the coordinator's `state` carries
    /// the reason so the view can render an inline error.
    public func connect(
        username: String,
        appState: AppState,
        pollIntervalSeconds: Double = 3.0,
        timeoutSeconds: Double = 300.0
    ) async {
        state = .connecting
        do {
            try await demoConnect.connect(username: username)
        } catch let err as ScreensClientError {
            // Surface the HTTP status precisely so the view can
            // distinguish 409 ("not yet provisioned") from 429
            // (rate-limited) from a generic 5xx.
            switch err {
            case .http(let status, let message):
                state = .failed(reason: "connect failed (HTTP \(status)): \(message)")
            default:
                state = .failed(reason: "connect failed: \(err)")
            }
            return
        } catch {
            state = .failed(reason: "connect failed: \(error)")
            return
        }
        state = .polling(lastStatus: "provisioning")
        do {
            let block = try await demoConnect.pollUntilUp(
                username: username,
                pollIntervalSeconds: pollIntervalSeconds,
                timeoutSeconds: timeoutSeconds
            )
            state = .up(fqdn: block.fqdn)
            // Flip the matching pod's status. Pods are matched on
            // FQDN, not podId, because the demo-mode podId is a
            // synthetic value built in DemoFixtures.
            for idx in appState.pods.indices where appState.pods[idx].fqdn == block.fqdn {
                appState.pods[idx] = PodInfo(
                    podId: appState.pods[idx].podId,
                    name: appState.pods[idx].name,
                    description: appState.pods[idx].description,
                    fqdn: appState.pods[idx].fqdn,
                    status: .online,
                    pendingAuthCodeSerial: appState.pods[idx].pendingAuthCodeSerial
                )
            }
        } catch DemoConnectError.timedOut(let last) {
            state = .failed(reason: "Still booting (last status: \(last)). Try again in a minute.")
        } catch DemoConnectError.demoServerWentAway {
            state = .failed(reason: "This demo was removed. Sign out and try a different username.")
        } catch {
            state = .failed(reason: "poll failed: \(error)")
        }
    }
}
