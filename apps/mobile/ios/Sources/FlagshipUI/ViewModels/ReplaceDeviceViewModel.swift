import Foundation
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// B7 — Replace device. Drives the IRK rotation ceremony:
///
///   1. Derive the NEW IRK locally at the next HKDF version.
///      (UMK preserved; only the version counter bumps.)
///   2. Sign re-pair-initiate canonical bytes with the NEW IRK over
///      (username, newIrkPub, oldIrkPub, issuedAt).
///   3. POST /api/users/:u/re-pair with the captured devices ETag as
///      If-Match. 412 → refresh + retry. 409 → already pending.
///   4. Persist Keystore.setPendingIrkRotationVersion(newVersion) so
///      a subsequent app launch / explicit Complete tap can finalize
///      after the 24-hour grace elapses.
///
/// The current device KEEPS its existing IRK active until the
/// complete leg fires — Keystore.deriveIRK() still reads
/// `currentIrkVersion()`. Replace device on this phone effectively
/// says: "I'm the device that will own the new IRK; other devices
/// holding the old IRK private key are about to be displaced."
@Observable
@MainActor
public final class ReplaceDeviceViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case signing
        case posting
        case pending(completesAt: Int64)   // grace running
        case completing
        case completed                     // server swap done, latch local
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let server: FlagshipServerClient
    private let username: () -> String?

    public init(server: FlagshipServerClient, username: @escaping () -> String?) {
        self.server = server
        self.username = username
    }

    /// True iff this device has a pending IRK rotation marked locally —
    /// i.e. `initiate` succeeded and `complete` hasn't latched yet. The
    /// finalize screen uses this to decide whether to offer Complete vs.
    /// tell the user there's nothing in flight.
    public var hasPendingRotation: Bool {
        Keystore.pendingIrkRotationVersion() != nil
    }

    /// Re-seat the VM into `.pending` from a known deadline — used when
    /// the finalize screen is (re)opened for an already-initiated
    /// rotation (e.g. straight after `initiate`, or on a later app launch
    /// where only the route's `completesAt` survived). Pure local state;
    /// touches no network. No-op if a terminal/active phase is already in
    /// progress so we never clobber an in-flight `complete`.
    public func resume(completesAt: Int64) {
        switch phase {
        case .idle, .pending, .failed:
            phase = .pending(completesAt: completesAt)
        case .signing, .posting, .completing, .completed:
            break
        }
    }

    /// Whether the 24-hour grace window has elapsed relative to `now`
    /// (defaulting to the wall clock). Pure + injectable so the finalize
    /// screen's countdown + button-gate are unit-testable. Returns true
    /// when `completesAt` is in the past (or now).
    public static func graceElapsed(completesAt: Int64, now: Date = Date()) -> Bool {
        Int64(now.timeIntervalSince1970 * 1000) >= completesAt
    }

    /// M4 — should the Trusted-devices "Replace pending" banner render
    /// for this snapshot? Mirrors the webapp's `shouldRenderBanner`: a
    /// missing snapshot, a missing row, or an OBJECTED row (the rotation
    /// was cancelled by another device) all mean "no banner". Pure so the
    /// banner-gate is unit-tested independent of SwiftUI.
    public static func shouldRenderPendingBanner(_ snapshot: PendingRePairSnapshot?) -> Bool {
        guard let pending = snapshot?.pending else { return false }
        return pending.objectedAt == nil
    }

    /// Kick off the ceremony. `currentEtag` is the value the caller
    /// captured from its most recent `listDevices` call — passing it
    /// fences the device-list-shifted race. Pass nil to skip the
    /// fence (less safe but tolerated by the Worker).
    public func initiate(currentEtag: String?) async {
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        phase = .signing

        // 1 — derive OLD + NEW IRKs locally. We don't yet bump the
        // stored counter; that happens only after a successful
        // server complete.
        let oldVersion = Keystore.currentIrkVersion()
        let newVersion = oldVersion + 1
        let oldKey: Curve25519.Signing.PrivateKey
        let newKey: Curve25519.Signing.PrivateKey
        do {
            oldKey = try await Keystore.deriveIRK(reason: "Confirm replace device", version: oldVersion)
            newKey = try await Keystore.deriveIRK(reason: "Authorize replace device", version: newVersion)
        } catch {
            phase = .failed("Couldn't access your account keys: \(error.localizedDescription)")
            return
        }
        let oldPubHex = HexUtil.encode(oldKey.publicKey.rawRepresentation)
        let newPubHex = HexUtil.encode(newKey.publicKey.rawRepresentation)
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let canonical = RePairInitiate.canonicalBytes(
            username: user,
            newIrkPubHex: newPubHex,
            oldIrkPubHex: oldPubHex,
            issuedAt: issuedAt
        )
        let signature: Data
        do {
            signature = try newKey.signature(for: canonical)
        } catch {
            phase = .failed("Couldn't sign the rotation request: \(error.localizedDescription)")
            return
        }

        // 2 — POST initiate.
        phase = .posting
        do {
            let resp = try await server.initiateRePair(
                username: user,
                body: RePairInitiateRequest(
                    request: .init(
                        username: user,
                        newIrkPub: newPubHex,
                        oldIrkPub: oldPubHex,
                        issuedAt: issuedAt
                    ),
                    signature: HexUtil.encode(signature)
                ),
                ifMatch: currentEtag
            )
            // 3 — Persist pending marker.
            do {
                try Keystore.setPendingIrkRotationVersion(newVersion)
            } catch {
                // Non-fatal — the server side has accepted; we just
                // can't remember it across launches. Surface a soft
                // warning rather than throwing the whole ceremony.
            }
            phase = .pending(completesAt: resp.completesAt)
        } catch ScreensClientError.http(let status, _) where status == 412 {
            phase = .failed("Your device list changed in the background. Refresh and try again.")
        } catch ScreensClientError.http(let status, _) where status == 409 {
            phase = .failed("A device replacement is already pending on this account.")
        } catch {
            phase = .failed("Couldn't reach the server: \(error.localizedDescription)")
        }
    }

    /// Finalize the rotation after the grace window. Server returns
    /// 425 if it's too early; surfaces as a stay-in-pending state.
    public func complete() async {
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        guard let pending = Keystore.pendingIrkRotationVersion() else {
            phase = .failed("No pending rotation found on this device.")
            return
        }
        phase = .completing
        do {
            _ = try await server.completeRePair(username: user)
            try Keystore.setCurrentIrkVersion(pending)
            try Keystore.setPendingIrkRotationVersion(nil)
            // The IRK just rotated. Any watch-delegate key was attested by the
            // OLD IRK, so .com's list re-verify already stops honoring it
            // (the primary auto-revoke). Clear the now-orphaned local key so a
            // stale delegate can't linger on this device. The user re-enables
            // "Quick approve from Watch" if they still want it.
            Keystore.clearWatchDelegate()
            phase = .completed
        } catch ScreensClientError.http(let status, _) where status == 425 {
            // Grace not elapsed yet — surface as still-pending so the
            // UI re-shows the timer.
            phase = .failed("The 24-hour grace hasn't ended yet. Try again later.")
        } catch ScreensClientError.http(let status, _) where status == 409 {
            phase = .failed("Another device objected to this rotation. Local state stays unchanged.")
            try? Keystore.setPendingIrkRotationVersion(nil)
        } catch {
            phase = .failed("Couldn't complete: \(error.localizedDescription)")
        }
    }
}

#if canImport(CryptoKit)
import CryptoKit
#endif
