// Kotlin mirror of packages/protocol/src/serverShare.ts (docs/share-a-server.md):
// sharing a server with another account. B's identity toward the server is a
// per-share key derived from B's UMK; twelve '|'-joined envelopes; the link
// secret's derivations; the six digits both phones show; and the sealed JSON
// payloads `.com` relays without being able to read them.
//
// packages/protocol/test-vectors/server-share/vectors.json is the reference;
// ServerShareVectorsTest runs every case; test-vectors/server-share-accept-admin
// (#12, ServerShareAcceptAdminVectorsTest) the admin-only acceptance.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object ServerShare {
    const val TAG_SERVER_SHARE = "flagship/server-share/v1"
    const val TAG_SERVER_SHARE_REVOKE = "flagship/server-share-revoke/v1"
    const val TAG_SERVER_SHARE_ACCEPT = "flagship/server-share-accept/v1"
    const val TAG_SERVER_SHARE_LEAVE = "flagship/server-share-leave/v1"
    const val TAG_SERVER_SHARE_SESSION = "flagship/server-share-session/v1"
    const val TAG_SERVER_SHARE_OFFER = "flagship/server-share-offer/v1"
    const val TAG_SERVER_SHARE_LIST = "flagship/server-share-list/v1"
    const val TAG_SERVER_SHARE_UNLOCK = "flagship/server-share-unlock/v1"
    const val TAG_SHARE_INBOX = "flagship/share-inbox/v1"
    const val TAG_SERVER_SHARE_PUSH = "flagship/server-share-push/v1"
    const val TAG_SERVER_SHARE_UPDATE = "flagship/server-share-update/v1"
    const val TAG_SERVER_SHARE_ACCEPT_ADMIN = "flagship/server-share-accept-admin/v1"
    const val KEY_KIND_ADMIN_ROOT = "admin-root"
    const val KEY_KIND_IRK = "irk"
    val KEY_KINDS: List<String> = listOf(KEY_KIND_ADMIN_ROOT, KEY_KIND_IRK)

    private const val INFO_MEMBER = "flagship/server-share-member/v1"
    private const val INFO_TOKEN = "flagship/server-share/token/v1"
    private const val INFO_LINK_KEY = "flagship/server-share/link-key/v1"
    private const val INFO_INBOX = "flagship/share-inbox/v1"
    private const val INFO_INBOX_KEY = "flagship/share-inbox-key/v1"
    const val INFO_INVITE_BUNDLE = "flagship/share-invite-bundle/v1"
    private const val SAS_TAG = "flagship/server-share/sas/v1"
    const val AAD_SHARE_OFFER = "flagship/server-share/offer/v1"
    const val AAD_SHARE_ACCEPTANCE = "flagship/server-share/acceptance/v1"
    const val AAD_SHARE_OWNER = "flagship/server-share/owner/v1"
    const val AAD_SHARE_INBOX_ENTRY = "flagship/share-inbox/entry/v1"

    /** How long B has to accept a link. */
    const val SHARE_OFFER_TTL_MS = 7L * 24 * 3600 * 1000
    const val SHARE_LABEL_MAX = 64
    /** `sealedSha256` value that withdraws B's boot copy. */
    const val SHARE_UNLOCK_OFF = "off"

    const val LEVEL_VIEW = "view"
    const val LEVEL_MANAGE = "manage"
    val SHARE_LEVELS: List<String> = listOf(LEVEL_VIEW, LEVEL_MANAGE)

    const val OP_PUT = "put"
    const val OP_LIST = "list"
    const val OP_DELETE = "delete"

    val SHARE_PUSH_PLATFORMS: List<String> = listOf("apns", "fcm", "webpush")

    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private val HEX32 = Regex("[0-9a-f]{32}")
    private val HEX40 = Regex("[0-9a-f]{40}")
    private val HEX64 = Regex("[0-9a-f]{64}")
    private val HEX128 = Regex("[0-9a-f]{128}")
    private val HEX_BYTES = Regex("([0-9a-f]{2})+")
    private val rng = SecureRandom()

    /** Encodes payloads in declaration order with `v` included (JSON.stringify's shape). */
    val json: Json = Json { encodeDefaults = true; explicitNulls = false }

    // ── Keys ──────────────────────────────────────────────────────────────

    /** B's identity toward one share (so one server): unlinkable everywhere else. */
    fun deriveShareMemberKeySeed(umkSeed: ByteArray, shareId: String): ByteArray {
        checkShareId(shareId)
        return hk(umkSeed, "$INFO_MEMBER|$shareId")
    }

    fun deriveShareMemberKey(umkSeed: ByteArray, shareId: String): Ed25519Sign =
        Ed25519Sign(deriveShareMemberKeySeed(umkSeed, shareId))

    fun deriveShareMemberPub(umkSeed: ByteArray, shareId: String): ByteArray =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(deriveShareMemberKeySeed(umkSeed, shareId)).publicKey

    /** Signs B's "Shared with me" inbox requests; its public key is the inbox id. */
    fun deriveShareInboxKeySeed(umkSeed: ByteArray): ByteArray = hk(umkSeed, INFO_INBOX)

    fun deriveShareInboxKey(umkSeed: ByteArray): Ed25519Sign = Ed25519Sign(deriveShareInboxKeySeed(umkSeed))

    fun deriveShareInboxPub(umkSeed: ByteArray): ByteArray =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(deriveShareInboxKeySeed(umkSeed)).publicKey

    /** Seals B's inbox entries. */
    fun deriveShareInboxSealKey(umkSeed: ByteArray): ByteArray = hk(umkSeed, INFO_INBOX_KEY)

    /** Seals the names of the people B invites to the shared server's apps
     *  (AES-256-GCM key). Only B's devices derive it; the owner can't read them. */
    fun deriveShareInviteBundleKey(umkSeed: ByteArray, shareId: String): ByteArray {
        checkShareId(shareId)
        return hk(umkSeed, "$INFO_INVITE_BUNDLE|$shareId")
    }

    /** Seals A's owner records: the household key (ServerKeys.deriveHouseholdKey). */
    fun deriveShareOwnerRecordKey(umkSeed: ByteArray): ByteArray = ServerKeys.deriveHouseholdKey(umkSeed)

    /** The bearer token the link grants (`x-flagship-share-token`), lowercase hex. */
    fun shareTokenFromSecret(secret: ByteArray): String {
        checkSecret(secret)
        return HexUtil.encode(hk(secret, INFO_TOKEN))
    }

    /** What `.com` stores for the token: SHA-256 hex of the token's bytes. */
    fun shareTokenHash(tokenHex: String): String {
        require(HEX64.matches(tokenHex)) { "server-share: token must be 64 lowercase hex" }
        return HexUtil.encode(sha256(HexUtil.decode(tokenHex)!!))
    }

    /** AES-256-GCM key for the offer and the acceptance. */
    fun shareLinkKey(secret: ByteArray): ByteArray {
        checkSecret(secret)
        return hk(secret, INFO_LINK_KEY)
    }

    /** The six digits both phones show, as `"123456"`. */
    fun shareSas(shareId: String, memberPubHex: String, secret: ByteArray): String {
        checkShareId(shareId)
        checkHex64("memberPubHex", memberPubHex)
        checkSecret(secret)
        val d = sha256(listOf(SAS_TAG, shareId, memberPubHex, HexUtil.encode(secret)).joinToString("|").toByteArray(Charsets.UTF_8))
        val n = ByteBuffer.wrap(d, 0, 4).int.toLong() and 0xFFFFFFFFL
        return (n % 1_000_000L).toString().padStart(6, '0')
    }

    /** `"123456"` → `"123 456"`. */
    fun formatShareSas(sas: String): String = "${sas.take(3)} ${sas.drop(3)}"

    // ── Sealed JSON payloads (lowercase hex `nonce12 || ct+tag`) ─────────

    fun shareAad(prefix: String, id: String): ByteArray {
        legacyFieldGuard("aad id", id)
        return "$prefix|$id".toByteArray(Charsets.UTF_8)
    }

    /** Seals [plaintext] exactly as given; [nonce] is random unless fixed (tests). */
    fun sealShareJson(key: ByteArray, aad: ByteArray, plaintext: ByteArray, nonce: ByteArray? = null): String {
        require(key.size == 32) { "server-share: key must be 32 bytes" }
        val n = nonce ?: ByteArray(12).also(rng::nextBytes)
        require(n.size == 12) { "server-share: nonce must be 12 bytes" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, n))
        cipher.updateAAD(aad)
        return HexUtil.encode(n + cipher.doFinal(plaintext))
    }

    fun sealShareJson(key: ByteArray, aad: ByteArray, jsonText: String, nonce: ByteArray? = null): String =
        sealShareJson(key, aad, jsonText.toByteArray(Charsets.UTF_8), nonce)

    /** The opened plaintext bytes. Throws on a wrong key, wrong AAD or tampered ciphertext. */
    fun openShareBytes(key: ByteArray, aad: ByteArray, sealedHex: String): ByteArray {
        require(key.size == 32) { "server-share: key must be 32 bytes" }
        require(HEX_BYTES.matches(sealedHex)) { "server-share: sealed payload must be hex" }
        val buf = HexUtil.decode(sealedHex)!!
        require(buf.size >= 12 + 16) { "server-share: sealed payload too short" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, buf.copyOfRange(0, 12)))
        cipher.updateAAD(aad)
        return cipher.doFinal(buf, 12, buf.size - 12)
    }

    /** Throws on a wrong key, wrong AAD, tampered ciphertext, bad UTF-8 or bad JSON. */
    fun openShareJson(key: ByteArray, aad: ByteArray, sealedHex: String): JsonElement {
        val plain = openShareBytes(key, aad, sealedHex)
        val text = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(plain))
            .toString()
        return Json.parseToJsonElement(text)
    }

    @Serializable
    data class OfferPayload(
        val v: Int = 1,
        val serverDomain: String,
        /** A's short name for the server, as A's app shows it. */
        val serverName: String,
        /** The box STK, so B seals boot approvals only for it (.com can't swap it). */
        val stkPubHex: String,
        val level: String,
        val unlockAtBoot: Boolean,
        val seeAppData: Boolean,
        val expiresAt: Long,
    ) {
        fun toJson(): String = json.encodeToString(OfferPayload.serializer(), this)
    }

    @Serializable
    data class OwnerRecord(
        val v: Int = 1,
        val secretHex: String,
        val label: String,
        val level: String,
        val unlockAtBoot: Boolean,
        val seeAppData: Boolean,
    ) {
        fun toJson(): String = json.encodeToString(OwnerRecord.serializer(), this)
    }

    /**
     * `.com`'s CA-signed attestation that [keyPubHex] is an account's current
     * sensitive key (docs/share-a-server.md §4). It names no account. The app
     * only carries it: the shared server checks the CA signature.
     */
    @Serializable
    data class AccountKeyAttestation(
        val kind: String = "AccountKeyAttestation",
        val version: Int = 1,
        val keyKind: String,
        val keyPubHex: String,
        val issuedAt: Long,
        val expiresAt: Long,
        val signedBy: String,
        val signature: String,
    )

    /** The joining account's admin proof sealed with an acceptance (§5.1). */
    @Serializable
    data class AcceptAdminProof(
        val admit: AcceptAdmin,
        val signature: String,
        val attestation: AccountKeyAttestation,
    )

    @Serializable
    data class AcceptancePayload(
        val v: Int = 1,
        val accept: Accept,
        val signature: String,
        /** Absent only from an app older than the admin-only rule; the box then refuses. */
        val admin: AcceptAdminProof? = null,
    ) {
        fun toJson(): String = json.encodeToString(AcceptancePayload.serializer(), this)
    }

    @Serializable
    data class InboxEntry(
        val v: Int = 1,
        val shareId: String,
        val secretHex: String,
        val serverDomain: String,
        val serverName: String,
        val acceptedAt: Long,
    ) {
        fun toJson(): String = json.encodeToString(InboxEntry.serializer(), this)
    }

    fun parseShareOfferPayload(v: JsonElement?): OfferPayload? {
        val o = obj(v) ?: return null
        if (!isOne(o["v"])) return null
        val serverDomain = str(o["serverDomain"])?.takeIf { it.isNotEmpty() } ?: return null
        val serverName = str(o["serverName"]) ?: return null
        val stkPubHex = str(o["stkPubHex"])?.takeIf { HEX64.matches(it) } ?: return null
        val level = level(o["level"]) ?: return null
        val unlockAtBoot = bool(o["unlockAtBoot"]) ?: return null
        val seeAppData = bool(o["seeAppData"]) ?: return null
        val expiresAt = time(o["expiresAt"]) ?: return null
        return OfferPayload(1, serverDomain, serverName, stkPubHex, level, unlockAtBoot, seeAppData, expiresAt)
    }

    fun parseShareOwnerRecord(v: JsonElement?): OwnerRecord? {
        val o = obj(v) ?: return null
        if (!isOne(o["v"])) return null
        val secretHex = str(o["secretHex"])?.takeIf { HEX64.matches(it) } ?: return null
        val label = str(o["label"])?.takeIf { normalizeShareLabel(it) != null } ?: return null
        val level = level(o["level"]) ?: return null
        val unlockAtBoot = bool(o["unlockAtBoot"]) ?: return null
        val seeAppData = bool(o["seeAppData"]) ?: return null
        return OwnerRecord(1, secretHex, label, level, unlockAtBoot, seeAppData)
    }

    fun parseShareAcceptancePayload(v: JsonElement?): AcceptancePayload? {
        val o = obj(v) ?: return null
        if (!isOne(o["v"])) return null
        val signature = str(o["signature"])?.takeIf { HEX128.matches(it) } ?: return null
        val accept = parseServerShareAccept(o["accept"]) ?: return null
        if (!o.containsKey("admin")) return AcceptancePayload(1, accept, signature)
        val admin = parseShareAcceptAdminProof(o["admin"]) ?: return null
        return AcceptancePayload(1, accept, signature, admin)
    }

    /** Shape only: the shared server verifies the CA signature. */
    fun parseAccountKeyAttestation(v: JsonElement?): AccountKeyAttestation? {
        val o = obj(v) ?: return null
        if (str(o["kind"]) != "AccountKeyAttestation" || !isOne(o["version"])) return null
        val keyKind = str(o["keyKind"])?.takeIf { it in KEY_KINDS } ?: return null
        val keyPubHex = str(o["keyPubHex"])?.takeIf { HEX64.matches(it) } ?: return null
        val signedBy = str(o["signedBy"])?.takeIf { HEX64.matches(it) } ?: return null
        val signature = str(o["signature"])?.takeIf { HEX128.matches(it) } ?: return null
        val issuedAt = time(o["issuedAt"]) ?: return null
        val expiresAt = time(o["expiresAt"])?.takeIf { it > issuedAt } ?: return null
        return AccountKeyAttestation("AccountKeyAttestation", 1, keyKind, keyPubHex, issuedAt, expiresAt, signedBy, signature)
    }

    fun parseShareAcceptAdminProof(v: JsonElement?): AcceptAdminProof? {
        val o = obj(v) ?: return null
        val signature = str(o["signature"])?.takeIf { HEX128.matches(it) } ?: return null
        val admit = parseServerShareAcceptAdmin(o["admit"]) ?: return null
        val attestation = parseAccountKeyAttestation(o["attestation"]) ?: return null
        return AcceptAdminProof(admit, signature, attestation)
    }

    fun parseShareInboxEntry(v: JsonElement?): InboxEntry? {
        val o = obj(v) ?: return null
        if (!isOne(o["v"])) return null
        val shareId = str(o["shareId"])?.takeIf { HEX32.matches(it) } ?: return null
        val secretHex = str(o["secretHex"])?.takeIf { HEX64.matches(it) } ?: return null
        val serverDomain = str(o["serverDomain"]) ?: return null
        val serverName = str(o["serverName"]) ?: return null
        val acceptedAt = time(o["acceptedAt"]) ?: return null
        return InboxEntry(1, shareId, secretHex, serverDomain, serverName, acceptedAt)
    }

    // ── The link: https://<apex>/share#s=<shareId>&k=<secretHex> ─────────

    data class ShareLink(val shareId: String, val secretHex: String)

    fun buildShareLink(apexOrigin: String, shareId: String, secret: ByteArray): String {
        checkShareId(shareId)
        checkSecret(secret)
        return "${apexOrigin.trimEnd('/')}/share#s=$shareId&k=${HexUtil.encode(secret)}"
    }

    private val HTTP_PREFIX = Regex("^https?://", RegexOption.IGNORE_CASE)
    private val APP_PREFIX = Regex("^flagship://share", RegexOption.IGNORE_CASE)

    /**
     * Accepts the https link (fragment), `flagship://share?s=&k=`, or a bare
     * `s=…&k=…`. Returns null for anything else.
     */
    fun parseShareLink(text: String): ShareLink? {
        val t = jsTrim(text)
        val hash = t.indexOf('#')
        val q = t.indexOf('?')
        val params: String = when {
            HTTP_PREFIX.containsMatchIn(t) -> {
                if (hash < 0) return null
                if (httpPath(t) != "/share") return null
                t.substring(hash + 1)
            }
            APP_PREFIX.containsMatchIn(t) -> when {
                q >= 0 -> t.substring(q + 1)
                hash >= 0 -> t.substring(hash + 1)
                else -> ""
            }
            else -> t
        }
        var s: String? = null
        var k: String? = null
        for (part in params.split('&')) {
            val eq = part.indexOf('=')
            if (eq < 0) continue
            val key = part.substring(0, eq)
            val value = part.substring(eq + 1).lowercase()
            if (key == "s") s = value
            if (key == "k") k = value
        }
        if (s == null || k == null || !HEX32.matches(s) || !HEX64.matches(k)) return null
        return ShareLink(s, k)
    }

    /** The URL path of an http(s) link (what WHATWG `new URL(t).pathname` gives for
     *  ordinary links): from the end of the authority to the first `?` or `#`. */
    private fun httpPath(t: String): String {
        val afterScheme = t.indexOf("://") + 3
        var i = afterScheme
        while (i < t.length && t[i] != '/' && t[i] != '\\' && t[i] != '?' && t[i] != '#') i++
        var end = i
        while (end < t.length && t[end] != '?' && t[end] != '#') end++
        val path = t.substring(i, end).replace('\\', '/')
        return path.ifEmpty { "/" }
    }

    // ── Envelopes ────────────────────────────────────────────────────────

    sealed interface Envelope {
        /** The signed bytes; throws IllegalArgumentException on an invalid field. */
        fun canonicalBytes(): ByteArray
    }

    /** #1 — signed by A's sensitive key; the box keeps the newest per shareId. */
    @Serializable
    data class Grant(
        val serverDomain: String,
        val shareId: String,
        val memberPubHex: String,
        val level: String,
        val unlockAtBoot: Boolean,
        val seeAppData: Boolean,
        /** A's name for B on this server. */
        val label: String,
        val issuedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            domain(serverDomain)
            checkShareId(shareId)
            checkHex64("memberPubHex", memberPubHex)
            require(level == LEVEL_VIEW || level == LEVEL_MANAGE) { "server-share: level must be view or manage" }
            require(normalizeShareLabel(label) == label) { "server-share: label must be 1-64 trimmed characters" }
            checkTime("issuedAt", issuedAt)
            return join(
                TAG_SERVER_SHARE,
                serverDomain, shareId, memberPubHex, level,
                if (unlockAtBoot) "1" else "0",
                if (seeAppData) "1" else "0",
                label, issuedAt.toString(),
            )
        }
    }

    /** #2 — signed by A's sensitive key; ends the share id forever. */
    @Serializable
    data class Revoke(
        val serverDomain: String,
        val shareId: String,
        val issuedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            domain(serverDomain)
            checkShareId(shareId)
            checkTime("issuedAt", issuedAt)
            return join(TAG_SERVER_SHARE_REVOKE, serverDomain, shareId, issuedAt.toString())
        }
    }

    /** #3 — signed by B's member key. */
    @Serializable
    data class Accept(
        val serverDomain: String,
        val shareId: String,
        val memberPubHex: String,
        val acceptedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            domain(serverDomain)
            checkShareId(shareId)
            checkHex64("memberPubHex", memberPubHex)
            checkTime("acceptedAt", acceptedAt)
            return join(TAG_SERVER_SHARE_ACCEPT, serverDomain, shareId, memberPubHex, acceptedAt.toString())
        }
    }

    /**
     * #12 — signed by the joining account's sensitive key (its admin root, or
     * its IRK when it pins none): only an admin device accepts a share. #3's
     * fields plus which key signs.
     */
    @Serializable
    data class AcceptAdmin(
        val serverDomain: String,
        val shareId: String,
        val memberPubHex: String,
        val acceptedAt: Long,
        val keyKind: String,
        val keyPubHex: String,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            domain(serverDomain)
            checkShareId(shareId)
            checkHex64("memberPubHex", memberPubHex)
            checkTime("acceptedAt", acceptedAt)
            require(keyKind in KEY_KINDS) { "server-share: keyKind must be admin-root or irk" }
            checkHex64("keyPubHex", keyPubHex)
            return join(TAG_SERVER_SHARE_ACCEPT_ADMIN, serverDomain, shareId, memberPubHex, acceptedAt.toString(), keyKind, keyPubHex)
        }
    }

    /** #4 — signed by B's member key; ends the share id forever. */
    @Serializable
    data class Leave(
        val serverDomain: String,
        val shareId: String,
        val memberPubHex: String,
        val issuedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            domain(serverDomain)
            checkShareId(shareId)
            checkHex64("memberPubHex", memberPubHex)
            checkTime("issuedAt", issuedAt)
            return join(TAG_SERVER_SHARE_LEAVE, serverDomain, shareId, memberPubHex, issuedAt.toString())
        }
    }

    /** #5 — signed by B's member key over a box nonce. */
    @Serializable
    data class Session(
        val serverDomain: String,
        val shareId: String,
        val memberPubHex: String,
        val nonceHex: String,
        val issuedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            domain(serverDomain)
            checkShareId(shareId)
            checkHex64("memberPubHex", memberPubHex)
            checkHex64("nonceHex", nonceHex)
            checkTime("issuedAt", issuedAt)
            return join(TAG_SERVER_SHARE_SESSION, serverDomain, shareId, memberPubHex, nonceHex, issuedAt.toString())
        }
    }

    /** #6 — signed by A's sensitive key; creates the `.com` offer row. */
    @Serializable
    data class Offer(
        val username: String,
        val serverDomain: String,
        val shareId: String,
        val tokenHash: String,
        /** SHA-256 hex of the sealed offer hex. */
        val offerSha256: String,
        /** SHA-256 hex of the sealed owner-record hex. */
        val ownerSha256: String,
        val expiresAt: Long,
        val issuedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            nonEmpty("username", username)
            domain(serverDomain)
            checkShareId(shareId)
            checkHex64("tokenHash", tokenHash)
            checkHex64("offerSha256", offerSha256)
            checkHex64("ownerSha256", ownerSha256)
            checkTime("expiresAt", expiresAt)
            checkTime("issuedAt", issuedAt)
            return join(
                TAG_SERVER_SHARE_OFFER,
                username, serverDomain, shareId, tokenHash, offerSha256, ownerSha256,
                expiresAt.toString(), issuedAt.toString(),
            )
        }
    }

    /** #7 — signed by A; lists A's offer rows. */
    @Serializable
    data class ListRequest(
        val username: String,
        val issuedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            nonEmpty("username", username)
            checkTime("issuedAt", issuedAt)
            return join(TAG_SERVER_SHARE_LIST, username, issuedAt.toString())
        }
    }

    /** #8 — signed by A's sensitive key; puts or withdraws B's boot copy. */
    @Serializable
    data class Unlock(
        val serverDomain: String,
        val shareId: String,
        val memberPubHex: String,
        /** SHA-256 hex of the sealed copy's hex, or `off`. */
        val sealedSha256: String,
        val issuedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            domain(serverDomain)
            checkShareId(shareId)
            checkHex64("memberPubHex", memberPubHex)
            if (sealedSha256 != SHARE_UNLOCK_OFF) checkHex64("sealedSha256", sealedSha256)
            checkTime("issuedAt", issuedAt)
            return join(TAG_SERVER_SHARE_UNLOCK, serverDomain, shareId, memberPubHex, sealedSha256, issuedAt.toString())
        }
    }

    /** #9 — signed by B's inbox key. */
    @Serializable
    data class InboxRequest(
        val inboxPubHex: String,
        val op: String,
        /** 32 hex, or "" for `list`. */
        val entryId: String,
        /** SHA-256 hex of the entry ciphertext's hex for `put`, else "". */
        val ctSha256: String,
        val issuedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            checkHex64("inboxPubHex", inboxPubHex)
            require(op == OP_PUT || op == OP_LIST || op == OP_DELETE) { "share-inbox: op must be put, list or delete" }
            if (op == OP_LIST) {
                require(entryId == "") { "share-inbox: list takes no entryId" }
            } else {
                require(HEX32.matches(entryId)) { "share-inbox: entryId must be 32 lowercase hex" }
            }
            if (op == OP_PUT) checkHex64("ctSha256", ctSha256)
            else require(ctSha256 == "") { "share-inbox: only put carries ctSha256" }
            checkTime("issuedAt", issuedAt)
            return join(TAG_SHARE_INBOX, inboxPubHex, op, entryId, ctSha256, issuedAt.toString())
        }
    }

    /**
     * #10 — signed by B's member key; registers (or drops) one device's push
     * token for this share's start-up approvals.
     */
    @Serializable
    data class Push(
        val serverDomain: String,
        val shareId: String,
        val memberPubHex: String,
        val op: String,
        val platform: String,
        /** SHA-256 hex of the provider token's UTF-8 bytes (the token travels beside it on `put`). */
        val tokenSha256: String,
        val issuedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            domain(serverDomain)
            checkShareId(shareId)
            checkHex64("memberPubHex", memberPubHex)
            require(op == OP_PUT || op == OP_DELETE) { "server-share: push op must be put or delete" }
            require(platform in SHARE_PUSH_PLATFORMS) { "server-share: push platform must be apns, fcm or webpush" }
            checkHex64("tokenSha256", tokenSha256)
            checkTime("issuedAt", issuedAt)
            return join(TAG_SERVER_SHARE_PUSH, serverDomain, shareId, memberPubHex, op, platform, tokenSha256, issuedAt.toString())
        }
    }

    /** #11 — signed by B's member key at manage level; the box checks the endorsement. */
    @Serializable
    data class Update(
        val serverDomain: String,
        val shareId: String,
        val memberPubHex: String,
        val targetCommit: String,
        val fromCommit: String,
        val nonce: String,
        val issuedAt: Long,
    ) : Envelope {
        override fun canonicalBytes(): ByteArray {
            domain(serverDomain)
            checkShareId(shareId)
            checkHex64("memberPubHex", memberPubHex)
            require(HEX40.matches(targetCommit)) { "server-share: targetCommit must be 40 lowercase hex" }
            require(HEX40.matches(fromCommit)) { "server-share: fromCommit must be 40 lowercase hex" }
            checkHex64("nonce", nonce)
            checkTime("issuedAt", issuedAt)
            return join(TAG_SERVER_SHARE_UPDATE, serverDomain, shareId, memberPubHex, targetCommit, fromCommit, nonce, issuedAt.toString())
        }
    }

    /** The Ed25519 signature over [envelope]'s canonical bytes. Throws on an invalid envelope. */
    fun sign(envelope: Envelope, key: Ed25519Sign): ByteArray = key.sign(envelope.canonicalBytes())

    fun signHex(envelope: Envelope, key: Ed25519Sign): String = HexUtil.encode(sign(envelope, key))

    /** False for an invalid envelope, a bad key or a bad signature; never throws. */
    fun verify(envelope: Envelope, signature: ByteArray, pub: ByteArray): Boolean = try {
        Ed25519Verify(pub).verify(signature, envelope.canonicalBytes())
        true
    } catch (_: Exception) {
        false
    }

    // ── Untrusted JSON → envelope (shape only; the canonical builder re-checks) ──

    private fun <T : Envelope> checked(build: () -> T?): T? {
        val out = build() ?: return null
        return try {
            out.canonicalBytes()
            out
        } catch (_: Exception) {
            null
        }
    }

    fun parseServerShareGrant(v: JsonElement?): Grant? = checked {
        val o = obj(v) ?: return@checked null
        Grant(
            serverDomain = str(o["serverDomain"]) ?: return@checked null,
            shareId = str(o["shareId"]) ?: return@checked null,
            memberPubHex = str(o["memberPubHex"]) ?: return@checked null,
            level = level(o["level"]) ?: return@checked null,
            unlockAtBoot = bool(o["unlockAtBoot"]) ?: return@checked null,
            seeAppData = bool(o["seeAppData"]) ?: return@checked null,
            label = str(o["label"]) ?: return@checked null,
            issuedAt = time(o["issuedAt"]) ?: return@checked null,
        )
    }

    fun parseServerShareRevoke(v: JsonElement?): Revoke? = checked {
        val o = obj(v) ?: return@checked null
        Revoke(
            serverDomain = str(o["serverDomain"]) ?: return@checked null,
            shareId = str(o["shareId"]) ?: return@checked null,
            issuedAt = time(o["issuedAt"]) ?: return@checked null,
        )
    }

    fun parseServerShareAccept(v: JsonElement?): Accept? = checked {
        val o = obj(v) ?: return@checked null
        Accept(
            serverDomain = str(o["serverDomain"]) ?: return@checked null,
            shareId = str(o["shareId"]) ?: return@checked null,
            memberPubHex = str(o["memberPubHex"]) ?: return@checked null,
            acceptedAt = time(o["acceptedAt"]) ?: return@checked null,
        )
    }

    fun parseServerShareAcceptAdmin(v: JsonElement?): AcceptAdmin? = checked {
        val o = obj(v) ?: return@checked null
        AcceptAdmin(
            serverDomain = str(o["serverDomain"]) ?: return@checked null,
            shareId = str(o["shareId"]) ?: return@checked null,
            memberPubHex = str(o["memberPubHex"]) ?: return@checked null,
            acceptedAt = time(o["acceptedAt"]) ?: return@checked null,
            keyKind = str(o["keyKind"])?.takeIf { it in KEY_KINDS } ?: return@checked null,
            keyPubHex = str(o["keyPubHex"]) ?: return@checked null,
        )
    }

    fun parseServerShareLeave(v: JsonElement?): Leave? = checked {
        val o = obj(v) ?: return@checked null
        Leave(
            serverDomain = str(o["serverDomain"]) ?: return@checked null,
            shareId = str(o["shareId"]) ?: return@checked null,
            memberPubHex = str(o["memberPubHex"]) ?: return@checked null,
            issuedAt = time(o["issuedAt"]) ?: return@checked null,
        )
    }

    fun parseServerShareSession(v: JsonElement?): Session? = checked {
        val o = obj(v) ?: return@checked null
        Session(
            serverDomain = str(o["serverDomain"]) ?: return@checked null,
            shareId = str(o["shareId"]) ?: return@checked null,
            memberPubHex = str(o["memberPubHex"]) ?: return@checked null,
            nonceHex = str(o["nonceHex"]) ?: return@checked null,
            issuedAt = time(o["issuedAt"]) ?: return@checked null,
        )
    }

    fun parseServerShareOffer(v: JsonElement?): Offer? = checked {
        val o = obj(v) ?: return@checked null
        Offer(
            username = str(o["username"]) ?: return@checked null,
            serverDomain = str(o["serverDomain"]) ?: return@checked null,
            shareId = str(o["shareId"]) ?: return@checked null,
            tokenHash = str(o["tokenHash"]) ?: return@checked null,
            offerSha256 = str(o["offerSha256"]) ?: return@checked null,
            ownerSha256 = str(o["ownerSha256"]) ?: return@checked null,
            expiresAt = time(o["expiresAt"]) ?: return@checked null,
            issuedAt = time(o["issuedAt"]) ?: return@checked null,
        )
    }

    fun parseServerShareList(v: JsonElement?): ListRequest? = checked {
        val o = obj(v) ?: return@checked null
        ListRequest(
            username = str(o["username"]) ?: return@checked null,
            issuedAt = time(o["issuedAt"]) ?: return@checked null,
        )
    }

    fun parseServerShareUnlock(v: JsonElement?): Unlock? = checked {
        val o = obj(v) ?: return@checked null
        Unlock(
            serverDomain = str(o["serverDomain"]) ?: return@checked null,
            shareId = str(o["shareId"]) ?: return@checked null,
            memberPubHex = str(o["memberPubHex"]) ?: return@checked null,
            sealedSha256 = str(o["sealedSha256"]) ?: return@checked null,
            issuedAt = time(o["issuedAt"]) ?: return@checked null,
        )
    }

    fun parseShareInboxRequest(v: JsonElement?): InboxRequest? = checked {
        val o = obj(v) ?: return@checked null
        InboxRequest(
            inboxPubHex = str(o["inboxPubHex"]) ?: return@checked null,
            op = str(o["op"])?.takeIf { it == OP_PUT || it == OP_LIST || it == OP_DELETE } ?: return@checked null,
            entryId = str(o["entryId"]) ?: return@checked null,
            ctSha256 = str(o["ctSha256"]) ?: return@checked null,
            issuedAt = time(o["issuedAt"]) ?: return@checked null,
        )
    }

    fun parseServerSharePush(v: JsonElement?): Push? = checked {
        val o = obj(v) ?: return@checked null
        Push(
            serverDomain = str(o["serverDomain"]) ?: return@checked null,
            shareId = str(o["shareId"]) ?: return@checked null,
            memberPubHex = str(o["memberPubHex"]) ?: return@checked null,
            op = str(o["op"])?.takeIf { it == OP_PUT || it == OP_DELETE } ?: return@checked null,
            platform = str(o["platform"]) ?: return@checked null,
            tokenSha256 = str(o["tokenSha256"]) ?: return@checked null,
            issuedAt = time(o["issuedAt"]) ?: return@checked null,
        )
    }

    fun parseServerShareUpdate(v: JsonElement?): Update? = checked {
        val o = obj(v) ?: return@checked null
        Update(
            serverDomain = str(o["serverDomain"]) ?: return@checked null,
            shareId = str(o["shareId"]) ?: return@checked null,
            memberPubHex = str(o["memberPubHex"]) ?: return@checked null,
            targetCommit = str(o["targetCommit"]) ?: return@checked null,
            fromCommit = str(o["fromCommit"]) ?: return@checked null,
            nonce = str(o["nonce"]) ?: return@checked null,
            issuedAt = time(o["issuedAt"]) ?: return@checked null,
        )
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /** Trimmed label, or null when it can't be a label (empty, too long, `|`, control chars). */
    fun normalizeShareLabel(raw: String): String? {
        val t = jsTrim(raw)
        if (t.isEmpty() || t.codePointCount(0, t.length) > SHARE_LABEL_MAX) return null
        if (t.any { it == '|' || it.code <= 0x1f || it.code == 0x7f }) return null
        return t
    }

    /** SHA-256 hex of a string's UTF-8 bytes (the `*Sha256` fields). */
    fun shareSha256Hex(s: String): String = HexUtil.encode(sha256(s.toByteArray(Charsets.UTF_8)))

    /** 16 random bytes as 32 lowercase hex (share ids, inbox entry ids). */
    fun randomShareId(): String = HexUtil.encode(ByteArray(16).also(rng::nextBytes))

    /** Same characters as JS `String.prototype.trim` (WhiteSpace + LineTerminator). */
    private fun isJsSpace(c: Char): Boolean = when (c) {
        '\t', '\n', '\u000b', '\u000c', '\r', ' ', ' ', ' ', ' ', ' ',
        ' ', ' ', '　', '﻿' -> true
        else -> c in ' '..' '
    }

    private fun jsTrim(s: String): String = s.trim(::isJsSpace)

    private fun hk(ikm: ByteArray, info: String): ByteArray {
        require(ikm.size == 32) { "server-share: key material must be 32 bytes" }
        // An all-zero 32-byte HMAC key is the empty salt (HMAC zero-pads short keys).
        return QrRelay.hkdfSha256(ikm, ByteArray(32), info.toByteArray(Charsets.UTF_8), 32)
    }

    private fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    private fun join(tag: String, vararg fields: String): ByteArray =
        (listOf(tag) + fields).joinToString("|").toByteArray(Charsets.UTF_8)

    private fun legacyFieldGuard(name: String, value: String) {
        value.forEachIndexed { i, c ->
            require(c != '|') { "canonical-bytes field \"$name\" contains separator '|' at index $i" }
            require(c.code > 0x1f && c.code != 0x7f) {
                "canonical-bytes field \"$name\" contains control char 0x${c.code.toString(16)} at index $i"
            }
        }
    }

    private fun domain(v: String) = nonEmpty("serverDomain", v)

    private fun nonEmpty(name: String, v: String) {
        require(v.isNotEmpty()) { "server-share: empty $name" }
        legacyFieldGuard(name, v)
    }

    private fun checkShareId(v: String) =
        require(HEX32.matches(v)) { "server-share: shareId must be 32 lowercase hex" }

    private fun checkHex64(name: String, v: String) =
        require(HEX64.matches(v)) { "server-share: $name must be 64 lowercase hex" }

    private fun checkSecret(s: ByteArray) =
        require(s.size == 32) { "server-share: link secret must be 32 bytes" }

    private fun checkTime(name: String, v: Long) =
        require(v in 0..MAX_SAFE_INTEGER) { "server-share: bad $name" }

    private fun obj(v: JsonElement?): JsonObject? = v as? JsonObject

    private fun str(v: JsonElement?): String? = (v as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun bool(v: JsonElement?): Boolean? = (v as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    private fun level(v: JsonElement?): String? = str(v)?.takeIf { it == LEVEL_VIEW || it == LEVEL_MANAGE }

    /** A JSON number that is a non-negative safe integer (JS `Number.isSafeInteger(v) && v >= 0`). */
    private fun time(v: JsonElement?): Long? {
        val p = (v as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
        val n = p.longOrNull ?: p.doubleOrNull?.takeIf { it == Math.floor(it) && !it.isInfinite() && Math.abs(it) <= MAX_SAFE_INTEGER }?.toLong()
        return n?.takeIf { it in 0..MAX_SAFE_INTEGER }
    }

    private fun isOne(v: JsonElement?): Boolean {
        val p = (v as? JsonPrimitive)?.takeIf { !it.isString } ?: return false
        return p.longOrNull == 1L || p.doubleOrNull == 1.0
    }
}
