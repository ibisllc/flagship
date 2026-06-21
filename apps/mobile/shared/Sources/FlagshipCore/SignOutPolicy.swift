import Foundation

/// #52 — the Tier-2 "Sign out" gate.
///
/// Tier-2 sign-out wipes this device's local key material (Keystore.wipe()).
/// On an account with NO cloud recovery that key is the ONLY copy of the
/// identity — wiping it orphans the account (and a later sign-in re-pairs
/// under a brand-new IRK, observed live 2026-06-09). So when recovery isn't
/// enrolled the sign-out must be BLOCKED outright, not merely scare-copied:
/// the UI replaces the destructive confirm with a route into recovery
/// enrollment, and the action layer (the closure that wipes) re-evaluates
/// this policy so no code path can wipe the only key.
///
/// Demo/mock sessions are exempt: they never wrap a real UMK (nothing of
/// value is lost on wipe), and sign-out is a routine way to leave the
/// sandbox.
public enum SignOutPolicy: Equatable, Sendable {
    case allowed
    case blockedNoRecovery
    /// Account DEATH. No cloud recovery AND this is the LAST device, so wiping
    /// the local key destroys the only copy of the identity for good. A plain
    /// Tier-2/3 wipe here would silently orphan the account; instead the UI
    /// must run the deletion ceremony (docs/account-deletion-and-name-reclaim.md
    /// §2): a full-page irreversible warning → typed-username + biometric →
    /// owner-IRK self-delete bundle → local wipe → Welcome. The name frees
    /// immediately. (With recovery OR another device the key survives elsewhere,
    /// so it's a normal Tier-2/3 action — `.allowed` / `.blockedNoRecovery`.)
    case deletionCeremony

    /// GYM-ONLY override. The UI gym needs to exercise the recovery-gating UX
    /// (greyed tier-2/3 buttons → recovery-required toast, D3-C1 / §7-A seed
    /// state), but a `-smoke-mode` session is demo-classified and therefore
    /// always `.allowed` — so the gated branch is otherwise unreachable offline.
    /// When the gym launches with `-smoke-no-recovery`, FlagshipApp sets this
    /// true so `evaluate` returns `.blockedNoRecovery` even for the demo
    /// session, making the greyed/toast path testable. Production never flips it
    /// (the only writer is the smoke-mode launch seam), so the demo-exemption is
    /// unchanged for real users.
    public nonisolated(unsafe) static var gymForceBlockNoRecovery = false

    /// `isLastDevice` distinguishes the two no-recovery shapes (docs §2):
    /// when there is NO cloud recovery, a wipe on the LAST device is account
    /// DEATH (`.deletionCeremony`) — the local key is the only copy — whereas
    /// another device on the account means the key survives elsewhere, so the
    /// wipe is merely "set up recovery first" (`.blockedNoRecovery`). The
    /// FOUNDING device never appears in the device roster (docs §0), so callers
    /// derive last-device from `trustedDevices.count <= 1`. The default is
    /// `false` so the legacy two-argument call site keeps its exact behaviour
    /// (`.blockedNoRecovery`).
    public static func evaluate(
        hasCloudRecovery: Bool,
        isDemoAccount: Bool = false,
        isLastDevice: Bool = false
    ) -> SignOutPolicy {
        if gymForceBlockNoRecovery { return .blockedNoRecovery }
        if isDemoAccount { return .allowed }
        if hasCloudRecovery { return .allowed }
        return isLastDevice ? .deletionCeremony : .blockedNoRecovery
    }
}
