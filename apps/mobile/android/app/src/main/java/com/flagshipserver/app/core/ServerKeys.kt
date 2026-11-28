// Kotlin mirror of the phone-side key derivations in packages/protocol/src/keys.ts
// (deriveSWK, the IRK, the account and per-app ids, the household key).
//
//   SWK = HKDF-SHA256(ikm = UMK seed, salt = empty, info = "flagship.swk.v1|<serverId>", 32)
//
// A server's identity key (STK) is NOT derived here or anywhere on the phone: every box
// makes a random one at install, and the phone pins it at the server's first blessing
// (ServerKeyPins, docs/first-contact.md). ServerKeyPinsSourceScanTest keeps it that way.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign

object ServerKeys {
    private const val INFO_SWK = "flagship.swk.v1"
    private const val INFO_IRK = "flagship.irk.v1"
    private const val INFO_ACCOUNT_ID = "flagship/account-id/v1"
    private const val INFO_APP_ID = "flagship/app-aid/v2"
    private const val INFO_HOUSEHOLD_KEY = "flagship/household-key/v1"

    /** Stable Account Identity Key (AID) SEED (32 bytes) — the NON-rotating
     *  account identity for service-access gating (docs/service-access-gating.md).
     *  Ed25519 over HKDF-SHA256(umkSeed, salt=empty, info="flagship/account-id/v1").
     *  Survives the IRK's rotations (re-pair / wipe-restart derive a fresh IRK
     *  from the same UMK); resets only on a brand-new account. Mirrors
     *  ServiceInvite.swift `deriveAccountIdSeed` + protocol keys.ts. */
    fun deriveAccountIdSeed(umkSeed: ByteArray): ByteArray {
        require(umkSeed.size == 32) { "UMK seed must be 32 bytes" }
        return hkdfSha256(umkSeed, INFO_ACCOUNT_ID.toByteArray(Charsets.UTF_8))
    }

    /** A Tink Ed25519 signer over the AID seed (the friend's redeem/visit
     *  signer; the author's recorded identity). */
    fun deriveAccountId(umkSeed: ByteArray): Ed25519Sign =
        Ed25519Sign(deriveAccountIdSeed(umkSeed))

    /** The stable AID Ed25519 PUBLIC key (32 bytes) — the allow-list/invite key. */
    fun deriveAccountIdPub(umkSeed: ByteArray): ByteArray =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(deriveAccountIdSeed(umkSeed)).publicKey

    private val APP_REF = Regex("^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$")

    /** Whether [ref] is a service id (`<creator>--<slug>`: lowercase, digits, dashes). */
    fun isAppRef(ref: String?): Boolean = ref != null && APP_REF.matches(ref)

    private const val DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    private val DNS_LABEL_RE = Regex("^$DNS_LABEL$")
    private val ACCOUNT_ZONE = Regex("^(?=.{3,253}$)$DNS_LABEL(?:\\.$DNS_LABEL)+$")

    /** Whether [zone] is an account zone (`<account>.<data apex>`, lowercase). */
    fun isAccountZone(zone: String?): Boolean = zone != null && ACCOUNT_ZONE.matches(zone)

    /** The hosting account's zone for a box name: the label just left of
     *  [dataApex] plus the apex (`home.alice.flagship.services` →
     *  `alice.flagship.services`), or null for a name outside the data apex
     *  (a direct `fshp.app` name, a custom domain). Mirrors protocol keys.ts
     *  `appAccountZone`. */
    fun appAccountZone(serverId: String, dataApex: String): String? {
        val host = serverId.trim().lowercase().removeSuffix(".")
        val apex = dataApex.trim().lowercase().removePrefix(".").removeSuffix(".")
        if (apex.isEmpty() || !host.endsWith(".$apex")) return null
        val labels = host.dropLast(apex.length + 1).split(".")
        if (!labels.all { DNS_LABEL_RE.matches(it) }) return null
        val zone = "${labels.last()}.$apex"
        return zone.takeIf { isAccountZone(it) }
    }

    /** App Account Id SEED (32 bytes) — the identity a visitor presents to ONE
     *  app on ONE hosting account (redeem, visit, knock, acceptance):
     *  HKDF-SHA256(umkSeed, salt=empty, info="flagship/app-aid/v2|<accountZone>|<appRef>").
     *  accountZone = [appAccountZone] of the box we sign for and post to (never
     *  a link parameter); appRef = the app's service id. Two apps, or one app id
     *  on two accounts, see unrelated ids, and the owner's and a co-manager's
     *  invites to one app bind the same id (docs/service-access-gating.md,
     *  "Per-app identity"). Mirrors protocol keys.ts `deriveAppAccountId`. */
    fun deriveAppAccountIdSeed(umkSeed: ByteArray, accountZone: String, appRef: String): ByteArray {
        require(umkSeed.size == 32) { "UMK seed must be 32 bytes" }
        require(isAccountZone(accountZone)) { "account zone must be <account>.<data apex>" }
        require(isAppRef(appRef)) { "app ref must be a service id" }
        return hkdfSha256(umkSeed, "$INFO_APP_ID|$accountZone|$appRef".toByteArray(Charsets.UTF_8))
    }

    /** A Tink Ed25519 signer over the per-app id seed. */
    fun deriveAppAccountId(umkSeed: ByteArray, accountZone: String, appRef: String): Ed25519Sign =
        Ed25519Sign(deriveAppAccountIdSeed(umkSeed, accountZone, appRef))

    /** The per-app id's PUBLIC key (32 bytes) — what the app's allow-list binds. */
    fun deriveAppAccountIdPub(umkSeed: ByteArray, accountZone: String, appRef: String): ByteArray =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(deriveAppAccountIdSeed(umkSeed, accountZone, appRef)).publicKey

    /** The household AEAD key (32 bytes) — HKDF-SHA256(umkSeed, salt=empty,
     *  info="flagship/household-key/v1"). Every device of the account derives
     *  the same key (so a sibling opens the sealed bundle); .com never holds the
     *  UMK -> stores ciphertext only. */
    fun deriveHouseholdKey(umkSeed: ByteArray): ByteArray {
        require(umkSeed.size == 32) { "UMK seed must be 32 bytes" }
        return hkdfSha256(umkSeed, INFO_HOUSEHOLD_KEY.toByteArray(Charsets.UTF_8))
    }

    /** The owner IRK seed (32 bytes) derived from the UMK seed the PROTOCOL way
     *  — Ed25519 over HKDF-SHA256(umkSeed, salt=empty, info="flagship.irk.v1").
     *  This is DISTINCT from the Android Keystore's slash-form `deriveIRK`
     *  (salt="flagship/irk/vN", info="ed25519-seed"); a box provisioned by
     *  @flagship/protocol (the webapp / live gym) is owned by THIS derivation.
     *  Mirrors ServerKeys.swift `deriveProtocolIrk` + protocol keys.ts. */
    fun deriveProtocolIrkSeed(umkSeed: ByteArray): ByteArray {
        require(umkSeed.size == 32) { "UMK seed must be 32 bytes" }
        return hkdfSha256(umkSeed, INFO_IRK.toByteArray(Charsets.UTF_8))
    }

    /** A Tink Ed25519 signer over the protocol IRK seed (signs box orders /
     *  journal / power / front-page for a protocol-provisioned box). */
    fun deriveProtocolIrk(umkSeed: ByteArray): Ed25519Sign =
        Ed25519Sign(deriveProtocolIrkSeed(umkSeed))

    /** The protocol IRK Ed25519 PUBLIC key (32 bytes) for the UMK seed. */
    fun deriveProtocolIrkPub(umkSeed: ByteArray): ByteArray =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(deriveProtocolIrkSeed(umkSeed)).publicKey

    fun deriveSwk(umkSeed: ByteArray, serverId: String): ByteArray {
        require(umkSeed.size == 32) { "UMK seed must be 32 bytes" }
        return hkdfSha256(umkSeed, "$INFO_SWK|$serverId".toByteArray(Charsets.UTF_8))
    }

    /** HKDF-SHA256(ikm, empty salt, info) -> 32 bytes: the derivation every
     *  `flagship/<purpose>/v1` key under a server key uses (peer backup's PBK
     *  and root key). */
    fun hkdf32(ikm: ByteArray, info: String): ByteArray = hkdfSha256(ikm, info.toByteArray(Charsets.UTF_8))

    /**
     * RFC 5869 HKDF-SHA256 with an EMPTY salt — the TS protocol passes
     * `new Uint8Array(0)`. HMAC zero-pads short keys to the block size, so a
     * 32-zero-byte key is byte-identical to the empty key Java's
     * SecretKeySpec refuses to hold.
     */
    private fun hkdfSha256(ikm: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(javax.crypto.spec.SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var counter = 1
        var written = 0
        while (written < length) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - written)
            System.arraycopy(t, 0, out, written, n)
            written += n
            counter++
        }
        return out
    }
}
