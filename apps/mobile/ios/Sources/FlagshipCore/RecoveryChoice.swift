import Foundation

/// The user's choice after a successful WebAuthn-PRF recovery on a
/// new (or re-joining) device. The three options have distinct
/// cryptographic consequences — see docs/multi-device.md (landed in
/// Phase F1) for the threat-model breakdown.
public enum RecoveryChoice: Hashable, Sendable {
    /// **No rotation.** Both this device and any other trusted
    /// devices keep working as peers. Default for the "I got a new
    /// phone and want to use Flagship there too" case.
    case keepBothDevices

    /// **IRK rotation.** Derives a new IRK from the (still shared)
    /// UMK with a bumped HKDF salt; J.3 walks every server; the
    /// previous IRK stops verifying. Pick this when the prior
    /// device is gone, lost, or sold, but you trust your iCloud
    /// passkey to remain yours.
    case replaceLostDevice

    /// **UMK + recovery-passkey rotation (v1.1).** Generates a brand-
    /// new UMK and a brand-new WebAuthn credential, retires the old
    /// envelope on .com, then runs the IRK rotation. Even an
    /// attacker holding the old device AND the old passkey is
    /// locked out. Pick this when biometric coercion or iCloud
    /// breach is on the table.
    case wipeAndRestart
}
