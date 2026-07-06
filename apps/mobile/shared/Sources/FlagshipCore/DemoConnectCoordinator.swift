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
            let block = try await pollUntilUpUpdatingPod(
                username: username,
                appState: appState,
                pollIntervalSeconds: pollIntervalSeconds,
                timeoutSeconds: timeoutSeconds
            )
            state = .up(fqdn: block.fqdn)
            updatePod(appState, fqdn: block.fqdn, status: .online, demoServer: block)
        } catch DemoConnectError.timedOut(let last) {
            state = .failed(reason: "Still booting (last status: \(last)). Try again in a minute.")
        } catch DemoConnectError.demoServerWentAway {
            state = .failed(reason: "This demo was removed. Sign out and try a different username.")
        } catch {
            state = .failed(reason: "poll failed: \(error)")
        }
    }

    /// Poll `/api/users/check` ourselves (rather than via
    /// `pollUntilUp`) so we can refresh the matching pod's `demoServer`
    /// block on EVERY tick — that's what advances the Home progress bar
    /// + the detail step list while provisioning, instead of jumping
    /// straight from "pending" to "online".
    private func pollUntilUpUpdatingPod(
        username: String,
        appState: AppState,
        pollIntervalSeconds: Double,
        timeoutSeconds: Double
    ) async throws -> DemoServerBlock {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        var lastStatus = "provisioning"
        while Date() < deadline {
            let resp = try await server.usernameAvailable(username)
            guard let block = resp.demoServer else {
                throw DemoConnectError.demoServerWentAway
            }
            lastStatus = block.status
            state = .polling(lastStatus: block.status)
            // Mirror the latest block (phase + metadata) onto the pod so
            // the UI re-renders the bar + steps. Keep status as the
            // mapped lifecycle so a still-provisioning pod stays pending.
            updatePod(
                appState,
                fqdn: block.fqdn,
                status: DemoFixtures.mapStatus(block.lifecycle),
                demoServer: block
            )
            if block.lifecycle == .up { return block }
            try await Task.sleep(nanoseconds: UInt64(pollIntervalSeconds * 1_000_000_000))
        }
        throw DemoConnectError.timedOut(lastStatus: lastStatus)
    }

    /// Replace the matching pod (matched on FQDN — the demo-mode podId is
    /// synthetic) with an updated status + demoServer block.
    private func updatePod(
        _ appState: AppState,
        fqdn: String,
        status: PodInfo.Status,
        demoServer: DemoServerBlock?
    ) {
        for idx in appState.pods.indices where appState.pods[idx].fqdn == fqdn {
            appState.pods[idx] = PodInfo(
                podId: appState.pods[idx].podId,
                name: appState.pods[idx].name,
                description: appState.pods[idx].description,
                fqdn: appState.pods[idx].fqdn,
                status: status,
                pendingAuthCodeSerial: appState.pods[idx].pendingAuthCodeSerial,
                demoServer: demoServer ?? appState.pods[idx].demoServer
            )
        }
    }

    /// "Cancel this device" — POST `/api/dev/sample-user/{u}/cancel`,
    /// then drop the demo pod from AppState so the UI returns to the
    /// empty/list state. Public demo capability (knowing the name);
    /// scoped to demo_users on the Worker. Returns true on success.
    public func cancel(username: String, appState: AppState) async -> Bool {
        do {
            try await demoConnect.cancel(username: username)
        } catch {
            state = .failed(reason: "cancel failed: \(error)")
            return false
        }
        // Remove the demo pod(s) — matched on the synthetic podId prefix
        // OR the home FQDN, since cancel tears the box down entirely.
        let fqdn = Endpoints.serverFqdn(server: "home", user: username.lowercased())
        appState.pods.removeAll { $0.fqdn == fqdn || $0.podId == "demo-server-\(username.lowercased())" }
        state = .idle
        return true
    }
}
