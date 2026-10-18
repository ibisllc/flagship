#if DEBUG
import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// The pending server `-smoke-pending-pod` adds to Home.
    public static let pendingPodName = "Shed"
    static let pendingSerial = "GYMPENDING0001"

    /// Home seams for GymSweepHomeTests.
    static func home(_ args: [String], _ app: AppState, _ operations: ActiveOperationsCenter, _ mocks: GymMocks) {
        let user = app.currentUser ?? "smoketest"

        // A demo account (the operator runs it; its device holds no keys):
        // Add/Import shows, a server order stays on the device, and `.com`
        // takes the IRK because a demo account pins no admin root.
        if args.contains("-smoke-demo-account") || args.contains("-smoke-demo-installing") {
            let block = DemoServerBlock(
                fqdn: "home.\(user).flagship.services",
                status: args.contains("-smoke-demo-installing") ? "provisioning" : "up",
                phase: args.contains("-smoke-demo-installing") ? "installing" : nil,
                phaseAt: args.contains("-smoke-demo-installing") ? Date().timeIntervalSince1970 * 1000 : nil,
                ip: "203.0.113.7", region: "fsn1", serverType: "cx22"
            )
            let pods = args.contains("-smoke-demo-installing")
                ? [DemoFixtures.samplePodFromDemoServer(block, username: user)]
                : app.pods
            app.completeOnboarding(username: user, pods: pods, demoServer: block)
            mocks.screens.unreachablePodIds = Set(app.pods.filter { $0.status != .online }.map(\.podId))
            MockOrderSigners.shared.pin(adminRoot: nil, irk: Keystore.gymIRK()?.publicKey)
        }

        // Every server gets an STK, so a server order names them and is signed
        // (an order over servers without one stays on the device).
        if args.contains("-smoke-pod-keys") {
            app.pods = app.pods.map { pod in
                guard pod.status != .pending else { return pod }
                let seed = SHA256.hash(data: Data("gym-stk|\(pod.fqdn)".utf8))
                let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: Data(seed))
                return withIdentity(pod, HexUtil.encode(key?.publicKey.rawRepresentation ?? Data()))
            }
        }

        // `.com` refuses this device's status reads until it unlocks once:
        // Home says status is paused; unlocking reads again.
        if args.contains("-smoke-status-paused") {
            app.accountStatusPaused = true
            // `-smoke-unlock-fails`: `.com` still refuses after the unlock.
            let fails = args.contains("-smoke-unlock-fails")
            app.retryAccountRead = { await MainActor.run { if !fails { app.accountStatusPaused = false } } }
        }

        // Nothing cached and the list refused: Home says it's locked and
        // offers Show my servers, which reads the list again.
        if args.contains("-smoke-list-locked") {
            let saved = app.pods
            app.pods = []
            app.accountStatusPaused = true
            app.retryAccountRead = {
                await MainActor.run {
                    app.pods = saved
                    app.accountStatusPaused = false
                }
            }
        }

        // An ordered server that hasn't booted yet, as `.com` lists it.
        if args.contains("-smoke-pending-pod") {
            let fqdn = "shed.\(user).flagship.services"
            _ = app.upsertPendingPod(name: pendingPodName, description: "Ordered, not booted yet", fqdn: fqdn,
                                     serial: pendingSerial)
            mocks.mailbox.directoryPending = [PendingPodEntry(
                orderRef: OrderRef.compute(serial: pendingSerial), serverName: pendingPodName, fqdn: fqdn,
                phase: nil, createdAt: Int64(Date().timeIntervalSince1970 * 1000))]
        }

        // `-smoke-install-stopped`: that pending server's install stopped, with
        // the box's own words (shell line number and all).
        if args.contains("-smoke-install-stopped") {
            mocks.server?.provisionStatusScripts[pendingSerial] = [
                (phase: .installing, detail: nil),
                (phase: .error, detail: "Setup stopped while Expanding the disk to 68 GB (line 66)"),
            ]
        }

        // Another device removed this one: the danger banner asks to sign in again.
        if args.contains("-smoke-account-reset") {
            app.accountWasReset = true
        }

        // Forget a persistent "Not now" on the backup banner from an earlier run.
        if args.contains("-smoke-banners-fresh") {
            UserDefaults.standard.removeObject(forKey: "flagship.recoveryBanner.dismissed.v1")
        }

        // The Apple Watch asked to approve Home's start-up and waits for the
        // session's first unlock.
        // Asked once the shell is up, as a real watch request arrives: an
        // alert raised while the launch still presents is dropped.
        if args.contains("-smoke-watch-waiting") {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                WatchApprovalPrompt.shared.watchIsWaiting(serverFqdn: "home.\(user).flagship.services")
            }
        }

        // Activity: the box's own log, account events on `.com` and a
        // finished re-attach report.
        if args.contains("-smoke-activity") {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            mocks.screens.mockBoxActivity = [
                BoxActivityEntry(seq: 4, ts: now - 60_000, action: "server.backup.created", kind: "server.backup.created",
                                 detail: "1.2 GB, 3 apps"),
                BoxActivityEntry(seq: 3, ts: now - 120_000, actor: .init(kind: "share", label: "Sam"),
                                 action: "app.installed", kind: "app.installed", target: "bright-maple--plants"),
                BoxActivityEntry(seq: 2, ts: now - 180_000, action: "server.update.refused", kind: "server.update.refused",
                                 detail: "Not endorsed", ok: false),
                BoxActivityEntry(seq: 1, ts: now - 240_000, action: "post /api/screens/services", kind: nil),
            ]
            // 35 account events: the feed shows the newest 20, the audit log
            // pages 30 at a time, and only the oldest is a transfer claim.
            var events: [AuditEvent] = []
            for seq in 1...35 {
                let kind = seq == 1 ? "server-transfer-claimed" : (seq.isMultiple(of: 2) ? "server-online" : "server-created")
                events.append(AuditEvent(seq: seq, eventKind: kind, detail: "home.\(user).flagship.services",
                                         devicePrefix: "d0d0", postedAt: now - Int64(36 - seq) * 3_600_000))
            }
            mocks.server?.auditEventsByUser[user.lowercased()] = events
            mocks.screens.postRecoveryReport = PostRecoverySnapshot(
                currentIrkPubHex: String(repeating: "ab", count: 32),
                state: WatcherState(lastSeen: nil, lastSwapTo: nil, lastSwapAt: now - 600_000,
                                    lastPolledAt: now - 60_000, lastError: nil),
                lastReissue: ReissuanceReportPayload(
                    startedAt: now - 700_000, completedAt: now - 600_000, status: "complete",
                    oldIrkPrefix: "0123456789ab", newIrkPrefix: "ba9876543210", apps: [],
                    totalRewritten: 12, reattachedCount: 2, unchangedCount: 1, undoWindowExpiresAt: now + 86_400_000))
        }
    }

    private static func withIdentity(_ p: PodInfo, _ stk: String) -> PodInfo {
        PodInfo(podId: p.podId, name: p.name, description: p.description, fqdn: p.fqdn, status: p.status,
                pendingAuthCodeSerial: p.pendingAuthCodeSerial, demoServer: p.demoServer, cameOnline: p.cameOnline,
                registeredAt: p.registeredAt, awaitingUnlock: p.awaitingUnlock, liveness: p.liveness,
                lastSeenMsAgo: p.lastSeenMsAgo, lastReported: p.lastReported, identityPubKeyHex: stk,
                leadsServices: p.leadsServices, revokedAt: p.revokedAt, revocationReason: p.revocationReason)
    }
}
#endif
