// Phase 3b — phone↔phone pairing relay transport seam.
//
// The CreateServer relay ([QrRelayClient]) is single-direction (the
// phone HELLOs then DELIVERs to a browser that only RECEIVES). Cross-
// device pairing is phone↔phone and BIDIRECTIONAL: the incoming device
// sends its fresh device pubkey, the admin receives it, derives the SAS,
// and ONLY THEN seals + delivers the key bundle.
//
// We model that with two role-specific transports over the same
// `/qr-pipe/<sid>` relay (admin shows the QR ⇒ admin is the session
// owner / receiver-of-hello; incoming scans ⇒ incoming sends hello +
// receives the deliver). The VMs depend on these interfaces only; tests
// drive the [MockDevicePairingRelay] seam. The live wiring lands once
// the relay server's phone↔phone roles are finalized (the existing
// frame protocol already carries peer-hello / peer-deliver — see
// apps/web/public/webapp/lib/pairingRelay.js).

package com.flagshipserver.app.core

/** Admin (QR-shower) side of the pairing relay. The admin opens the
 *  session, waits for the incoming device's hello (its fresh X25519
 *  pubkey), then — after the user confirms the SAS — delivers the sealed
 *  bundle. */
interface AdminPairingRelay {
    /** Open the relay for [sid] and BLOCK until the incoming device
     *  connects + sends its ephemeral X25519 pubkey (raw 32 bytes).
     *  Returns that pubkey. */
    suspend fun awaitPeerHello(sid: String): ByteArray

    /** Push the AEAD-sealed bundle to the incoming device + await its
     *  open-ack. */
    suspend fun deliver(ciphertextBase64Url: String, nonceBase64Url: String)

    /** Idempotent close. */
    fun close()
}

/** Incoming (scanner) side of the pairing relay. The incoming device
 *  connects, sends its ephemeral X25519 pubkey, then — after the user
 *  verifies the SAS — receives the sealed bundle. */
interface IncomingPairingRelay {
    /** Connect to [sid] and send our ephemeral X25519 pubkey (raw 32
     *  bytes) as the hello. Returns once the relay acks. */
    suspend fun connectAndHello(sid: String, ephemeralPubKey: ByteArray)

    /** BLOCK until the admin delivers the sealed bundle; returns the
     *  base64url (ciphertext, nonce) pair. */
    suspend fun awaitDelivery(): Pair<String, String>

    /** Idempotent close. */
    fun close()
}

/** Errors surfaced by the pairing relay. Mirrors [QrRelayError] copy so
 *  the two surfaces read identically. */
sealed class PairingRelayError(message: String) : RuntimeException(message) {
    data class ConnectionFailed(val why: String) : PairingRelayError("Couldn't reach the relay: $why")
    object PeerMissing : PairingRelayError("The other device isn't connected yet — keep this screen open.")
    object SessionExpired : PairingRelayError("This pairing code expired. Generate a fresh one and try again.")
    data class RelayErr(val msg: String) : PairingRelayError("Relay: $msg")
}
