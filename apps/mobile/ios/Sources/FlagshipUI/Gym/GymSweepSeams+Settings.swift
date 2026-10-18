#if DEBUG
import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// `.com`'s rate-limit refusal, as the Worker sends it.
    public static let rateLimitedBody =
        #"{"error":"rate-limited","limit":"ip","retryAfterSec":720,"message":"Too many tries from your network. Try again in about 12 minutes."}"#
    public static let rateLimitedSentence = "Too many tries from your network. Try again in about 12 minutes."

    /// The other device `-smoke-trusted-devices` lists beside this one.
    public static let otherDeviceId = String(repeating: "ab", count: 16)
    /// The docked browser `-smoke-companions` lists on Remote.
    public static let companionPrefix = "c0ffee12"
    /// The open secured session `-smoke-secured-session` seeds.
    public static let securedSessionId = String(repeating: "5e", count: 32)

    /// Settings seams for GymSweepSettingsTests.
    static func settings(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        let user = app.currentUser ?? "smoketest"
        let now = Int64(Date().timeIntervalSince1970 * 1000)

        // Trusted devices: this device and one Android the account added.
        if args.contains("-smoke-trusted-devices"), let me = app.activeProfile?.deviceId, let server = mocks.server {
            func device(_ id: String, _ pub: UInt8, _ platform: String, _ code: String, _ created: Int64) -> String {
                #"{"accountId":"\#(user)","deviceId":"\#(id)","devicePubHex":"\#(String(repeating: String(format: "%02x", pub), count: 32))","platformClass":"\#(platform)","createdAt":\#(created),"lastSeenAt":\#(created + 60_000),"supportCode":"\#(code)"}"#
            }
            let json = #"{"accountId":"\#(user)","devices":[\#(device(me, 0xd0, "ios", "AAAA-1111", now - 86_400_000 * 30)),\#(device(otherDeviceId, 0xe1, "android", "BBBB-2222", now - 86_400_000 * 2))],"grants":[],"selfProfiles":[],"managedProfiles":[]}"#
            if let dir = try? JSONDecoder().decode(AccountDirectoryResponse.self, from: Data(json.utf8)) {
                server.accountDirectories[user.lowercased()] = dir
            }
        }

        // A device replacement whose grace window has passed.
        if args.contains("-smoke-repair-pending"), let server = mocks.server {
            server.pendingRePairByUser[user.lowercased()] = PendingRePairInfo(
                newIrkPub: String(repeating: "11", count: 32), oldIrkPub: String(repeating: "22", count: 32),
                initiatedAt: now - 86_400_000 * 2, completesAt: now - 60_000)
            // The phone holds the rotation it started, so Complete can sign it.
            try? Keystore.setPendingIrkRotationVersion(Keystore.currentIrkVersion() + 1)
        }

        // `.com` knows the account (a single-device one, or with 2FA on).
        if args.contains("-smoke-account-claimed") || args.contains("-smoke-totp-enrolled"), let server = mocks.server {
            if args.contains("-smoke-totp-enrolled") {
                server.accountTypeByUser[user.lowercased()] = "multi"
                server.totpEnrolledAtByUser[user.lowercased()] = now - 86_400_000
                server.totpSecretByUser[user.lowercased()] = "JBSWY3DPEHPK3PXP"
            }
            let irkPub = Keystore.gymIRK().map { HexUtil.encode($0.publicKey.rawRepresentation) } ?? String(repeating: "00", count: 32)
            Task {
                try? await server.claimUsername(UsernameClaimRequest(
                    request: .init(username: user.lowercased(), irkPub: irkPub, issuedAt: now),
                    signature: String(repeating: "00", count: 64)))
            }
        }

        // `.com` refuses one call with its 429 rate-limit body.
        if let which = value(args, "-smoke-rate-limited"), let server = mocks.server {
            let refusal = ScreensClientError.http(status: 429, message: rateLimitedBody)
            switch which {
            case "totp": server.totpEnrollBeginError = refusal
            case "re-pair": server.rePairBehavior = .rateLimited(body: rateLimitedBody)
            default: break
            }
        }

        // A demo account (Flagship runs its server; no admin root pinned).
        if args.contains("-smoke-demo-account"), let first = app.pods.first {
            app.completeOnboarding(username: user, pods: app.pods,
                                   demoServer: DemoServerBlock(fqdn: first.fqdn, status: "up", ttlIdleMinutes: 30))
            MockOrderSigners.shared.pin(adminRoot: nil, irk: Keystore.gymIRK()?.publicKey)
        }

        // Remote: one docked browser, and two writes it asked for.
        if args.contains("-smoke-companions") {
            mocks.screens.companionListFixture = CompanionListResponse(companions: [
                CompanionSummary(tokenPrefix: companionPrefix, redeemedAt: now - 3_600_000, lastSeenMs: now - 60_000,
                                 expiresAt: now + 3 * 3_600_000, userAgent: "Mozilla/5.0 (Macintosh)"),
            ])
            let music = app.pods.first(where: { $0.name == "Music" })?.fqdn ?? "music.\(user).flagship.services"
            let office = app.pods.first(where: { $0.name == "Office" })?.fqdn ?? "office.\(user).flagship.services"
            mocks.screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending: [
                CompanionPendingWrite(requestId: "rq-release", companionTokenPrefix: companionPrefix, kind: "release-server",
                                      intent: ["serverDomain": AnyCodable(music), "username": AnyCodable(user)],
                                      queuedAt: now - 120_000, expiresAt: now + 600_000),
                CompanionPendingWrite(requestId: "rq-revoke", companionTokenPrefix: companionPrefix, kind: "revoke-server",
                                      intent: ["revokedServerId": AnyCodable(office), "reason": AnyCodable("lost"),
                                               "userId": AnyCodable(user)],
                                      queuedAt: now - 60_000, expiresAt: now + 600_000),
            ])
        }

        // A browser this phone signed in to a private app.
        let secured = UserDefaultsSecuredSessionStore()
        // Sessions an earlier launch's knock left in the simulator's defaults.
        for old in secured.list() { secured.remove(secretId: old.secretId) }
        if args.contains("-smoke-secured-session") {
            let home = app.pods.first?.fqdn ?? "home.\(user).flagship.services"
            secured.put(SecuredSession(secretId: securedSessionId, serverId: home, serviceRef: "\(user)--plants",
                                       serviceUrl: "https://plants.\(home)", browserAgent: "Mozilla/5.0 (Macintosh) Safari",
                                       startedAt: now - 600_000))
        }

        // `-smoke-pairing-unavailable`: no live pairing transport, as in a release build.
        if args.contains("-smoke-pairing-unavailable") {
            mocks.pairingRelay?.behavior = .unavailable
        }

        // Add a device: the new phone has already scanned and sent its key.
        if args.contains("-smoke-pairing-peer") {
            // X25519 key | device signing key | 16-byte device id, as the joiner sends it.
            let raw = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
                + Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
                + Data(repeating: 0xcd, count: 16)
            mocks.pairingRelay?.provideRawIncomingPubkey(raw)
        }
    }
}
#endif
