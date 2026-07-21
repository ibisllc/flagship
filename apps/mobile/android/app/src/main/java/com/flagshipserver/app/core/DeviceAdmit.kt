// Phase 3b — vouched cross-device device-admit envelope.
//
// Kotlin mirror of packages/protocol/src/auth.ts `DeviceAdmit` +
// signDeviceAdmit / verifyDeviceAdmit. A collaborator joins an account
// by scanning the admin's pairing QR. Over the sealed QrRelay the
// incoming device sends its FRESH device pubkey; the admin confirms the
// SAS and signs a DeviceAdmit binding THAT pubkey, with the account
// IRK. The incoming device presents the envelope to .com on register;
// .com verifies it under the account's CURRENT IRK and admits the
// device QUARANTINED (14-day non-admin peer window).
//
// The envelope is the unforgeable vouch: only a holder of the account's
// IRK private key can mint it, and it commits to the exact
// `newDevicePubHex` so a captured admit can't be re-aimed at a
// different device. Canonical bytes MUST stay byte-identical to the
// Worker verifier:
//
//     "flagship/device-admit/v2" | username | deviceId | newDevicePubHex | issuedAt

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable

/** Mirror of the Worker `DeviceAdmit` interface. `newDevicePubHex` is
 *  the incoming device's freshly-minted Ed25519 pubkey, lowercased hex
 *  (32 bytes). */
@Serializable
data class DeviceAdmit(
    val username: String,
    val deviceId: String,
    val newDevicePubHex: String,
    val issuedAt: Long,
)

object DeviceAdmitClaim {
    const val CANONICAL_TAG = "flagship/device-admit/v2"

    fun canonicalBytes(admit: DeviceAdmit): ByteArray = listOf(
        CANONICAL_TAG,
        admit.username,
        admit.deviceId,
        admit.newDevicePubHex,
        admit.issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    /** Sign with the account's CURRENT IRK (the vouching admin device).
     *  Returns the 64-byte Ed25519 signature. */
    fun sign(admit: DeviceAdmit, irk: Ed25519Sign): ByteArray =
        irk.sign(canonicalBytes(admit))

    /** Verify a DeviceAdmit signature under the account's IRK pubkey
     *  (32 bytes). Returns false on any malformed input — never throws,
     *  matching the Worker's try/catch verifier. */
    fun verify(admit: DeviceAdmit, signature: ByteArray, irkPubKey: ByteArray): Boolean =
        try {
            Ed25519Verify(irkPubKey).verify(signature, canonicalBytes(admit))
            true
        } catch (_: Throwable) {
            false
        }
}
