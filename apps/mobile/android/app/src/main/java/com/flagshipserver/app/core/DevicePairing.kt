// Phase 3b — cross-device QR pairing primitives (collaborators, no
// shared iCloud / Google sync).
//
// A business adds a collaborator's OWN phone to a multi-device account
// out-of-band: the admin shows a pairing QR; the collaborator scans it.
// The QR carries a universal/app link
//
//     https://flagshipserver.com/join?sid=<relaySid>&pk=<adminX25519EphemeralPubB64u>
//
// so the collaborator's NATIVE camera can open it straight into the app
// (App Links), or they use the in-app scanner. The link alone is NOT
// sufficient to join — the admin must still confirm the SAS match + seal
// the key material over the relay (see DeviceAdmit + the pairing VMs).
//
// This file holds the pure, testable seams:
//   - [JoinLink]      parse + build of the join universal/app link.
//   - [PairingBundle] the sealed payload the admin delivers to the
//                     incoming device: { umkSeedHex, admit, admitSig }.
//   - [PairingQr]     a dependency-light QR-bitmap encoder (zxing core)
//                     for the admin's QR window.

package com.flagshipserver.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The cross-device pairing link. Mirrors the QrRelay session shape but
 * carries the pairing semantics: a relay session id [sid] + the admin's
 * ephemeral X25519 public key [adminPubKey] (raw 32 bytes), the same
 * material that drives the SAS derivation. The incoming device parses
 * this from a scanned QR or an App-Links deeplink; the admin builds it.
 */
data class JoinLink(val sid: String, val adminPubKey: ByteArray) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is JoinLink) return false
        return sid == other.sid && adminPubKey.contentEquals(other.adminPubKey)
    }

    override fun hashCode(): Int = sid.hashCode() * 31 + adminPubKey.contentHashCode()

    companion object {
        /** Control apex host, via [Endpoints] (prod-default + test override). */
        val HOST: String get() = Endpoints.controlHost
        const val PATH = "/join"

        /** Build the universal/app link the admin renders as a QR. The
         *  admin's ephemeral X25519 pubkey is base64url-encoded so the
         *  whole thing is a clean URL. */
        fun build(sid: String, adminPubKey: ByteArray): String {
            require(adminPubKey.size == 32) { "admin pubkey must be 32 raw X25519 bytes" }
            val pk = Base64URL.encode(adminPubKey)
            return "https://$HOST$PATH?sid=$sid&pk=$pk"
        }

        /**
         * Parse a scanned QR / deeplink string into a [JoinLink].
         * Accepts:
         *   https://flagshipserver.com/join?sid=<sid>&pk=<pkB64u>
         *   flagship://join?sid=<sid>&pk=<pkB64u>
         *   sid=<sid>&pk=<pkB64u>
         *
         * Returns null on anything that isn't a well-formed join link
         * (so the scanner can surface "that QR isn't a Flagship invite"
         * rather than throwing).
         */
        fun parse(raw: String): JoinLink? {
            val text = raw.trim()
            if (text.isEmpty()) return null
            // Only accept our /join path (or the flagship://join host),
            // so an unrelated URL with sid=/pk= query params can't be
            // mistaken for an invite.
            val query: String = when {
                text.startsWith("https://$HOST$PATH") || text.startsWith("http://$HOST$PATH") ->
                    text.substringAfter('?', "")
                text.startsWith("flagship://join") ->
                    text.substringAfter('?', "")
                "?" !in text && "=" in text && "sid=" in text ->
                    text
                else -> return null
            }
            if (query.isEmpty()) return null
            var sid: String? = null
            var pk: String? = null
            query.split('&').forEach { pair ->
                val idx = pair.indexOf('=')
                if (idx <= 0) return@forEach
                val key = pair.substring(0, idx)
                val value = pair.substring(idx + 1)
                when (key) {
                    "sid" -> sid = value
                    "pk" -> pk = value
                }
            }
            val s = sid?.takeIf { it.isNotEmpty() } ?: return null
            val pkB64 = pk?.takeIf { it.isNotEmpty() } ?: return null
            val pubKey = Base64URL.decode(pkB64) ?: return null
            if (pubKey.size != 32) return null
            return JoinLink(s, pubKey)
        }
    }
}

/**
 * The sealed payload the admin delivers to the incoming device over the
 * relay. Carries the account master key seed (so the new device joins
 * the SAME user identity), plus the IRK-signed DeviceAdmit envelope the
 * incoming device replays to .com.
 *
 * Wire-encoded as compact JSON; the admin AEAD-seals the bytes under the
 * QR-relay kEnc (so the relay never sees it) and the incoming device
 * decrypts + parses.
 */
@Serializable
data class PairingBundle(
    /** 32-byte account UMK seed, lowercased hex. The incoming device
     *  installs this into a NEW per-profile slot. */
    val umkSeedHex: String,
    /** The IRK-signed admit binding the incoming device's fresh pubkey. */
    val admit: DeviceAdmit,
    /** Ed25519 signature over the admit, lowercased hex (64 bytes). */
    val admitSig: String,
    /** Slice D (docs/device-admin-tier-spec.md §4.2, D-4) — the ADMIN MASTER
     *  ROOT seed (32 bytes, lowercased hex) when the admin chose to PROMOTE the
     *  joining device to admin in this synchronous SAS ceremony; null otherwise
     *  (the default). Sealed the SAME way the UMK is — it rides inside this
     *  bundle, which the admin AEAD-seals under the QR-relay kEnc, so `.com` /
     *  the relay never see it. Promote is offered ONLY here (high-assurance,
     *  admin-initiated, SAS-confirmed), never on an async approve-a-request
     *  join. The incoming device unwraps it → [Keystore.importAdminRoot] ⇒ it
     *  becomes a bare-root admin. */
    val wrappedAdminRoot: String? = null,
) {
    fun toJsonBytes(): ByteArray = JSON.encodeToString(serializer(), this).toByteArray(Charsets.UTF_8)

    companion object {
        private val JSON = Json { encodeDefaults = true; ignoreUnknownKeys = true }

        fun fromJsonBytes(bytes: ByteArray): PairingBundle =
            JSON.decodeFromString(serializer(), bytes.decodeToString())
    }
}
