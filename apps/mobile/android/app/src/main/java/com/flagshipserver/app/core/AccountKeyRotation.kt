package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.AssurancePolicy
import com.flagshipserver.app.core.pq.PqAuthorityRecords
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.core.pq.PqTrust
import com.flagshipserver.app.core.pq.PqTrustException
import com.google.crypto.tink.subtle.X25519
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Account master-key rotation: Kotlin twin of `packages/protocol/src/accountKeyRotation.ts`.
 *
 * The hop `flagship/account-key-rotation/v1` moves the account from key epoch N to N+1. Only the
 * pinned admin root authorises it, never an IRK; the new IRK and new AID sign the same bytes.
 * Kept devices receive the new UMK in `flagship/umk-rotation-delivery/v1`, sealed with X-Wing to
 * their receive key (`flagship/device-receive-key/v1`) or to their Ed25519 identity key. The
 * hybrid companion is `flagship/account-key-rotation/v2`. The follow-ups
 * `flagship/device-key-rotate/v1`, `flagship/cgk-rekey/v1`, `flagship/swk-rekey/v1` and
 * `flagship/luks-rekey-confirm/v1` are here for their canonical bytes and signatures.
 * Vectors: `packages/protocol/test-vectors/account-key-rotation/vectors.json`.
 */
object AccountKeyRotation {
    const val TAG_ROTATION = "flagship/account-key-rotation/v1"
    const val TAG_ROTATION_V2 = "flagship/account-key-rotation/v2"
    const val TAG_DELIVERY = "flagship/umk-rotation-delivery/v1"
    const val TAG_DEVICE_KEY_ROTATE = "flagship/device-key-rotate/v1"
    const val TAG_DEVICE_RECEIVE_KEY = "flagship/device-receive-key/v1"
    const val TAG_CGK_REKEY = "flagship/cgk-rekey/v1"
    const val TAG_SWK_REKEY = "flagship/swk-rekey/v1"
    const val TAG_LUKS_REKEY_CONFIRM = "flagship/luks-rekey-confirm/v1"
    private const val SEAL_TAG = "flagship.seal.v1"
    private const val MAX_SAFE = 9_007_199_254_740_991L

    enum class IrkScheme(val wire: String, val byte: Int) {
        WEB("web", 1), IOS("ios", 2), ANDROID("android", 3);
        companion object {
            fun of(wire: String) = entries.firstOrNull { it.wire == wire }
        }
    }

    /** A refusal; [code] matches the other ports and the vectors. */
    class Failure(val code: String) : Exception(code)

    private val HEX32 = Regex("^[0-9a-f]{64}$")
    private val HEX16 = Regex("^[0-9a-f]{32}$")
    private val HEX64 = Regex("^[0-9a-f]{128}$")
    private val HEX = Regex("^(?:[0-9a-f]{2})+$")
    private val DOMAIN = Regex("^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")

    private fun need(ok: Boolean, field: String) = require(ok) { "account-key-rotation: invalid $field" }
    private fun hex32(v: String, f: String): String { need(HEX32.matches(v), f); return v }
    private fun uint(v: Long, f: String): String { need(v in 0..MAX_SAFE, f); return v.toString() }
    private fun deviceId(v: String): String { need(HEX16.matches(v), "deviceId"); return v }
    private fun domain(v: String): String { need(DOMAIN.matches(v), "serverDomain"); return v }
    private fun sealedHex(v: String): String { need(HEX.matches(v), "sealedHex"); return v }
    private fun username(u: String): String {
        need(u.isNotEmpty() && u.length <= 64 && u == u.lowercase() && u.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }, "username")
        return u
    }
    private fun join(parts: List<String>): ByteArray = parts.joinToString("|").toByteArray(Charsets.UTF_8)
    private fun bytes(h: String): ByteArray = PqHex.decode(h) ?: ByteArray(0)
    private fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
    private fun sha256Hex(b: ByteArray): String = PqHex.encode(sha256(b))

    /** 32 bytes, canonical, not of small order (strict: also torsion-free). */
    fun isAcceptableEd25519Key(pubHex: String): Boolean = HEX32.matches(pubHex) && PqHybrid.strictPoint(bytes(pubHex))

    internal fun verifyEd(sigHex: String, msg: ByteArray, pubHex: String): Boolean =
        HEX64.matches(sigHex) && isAcceptableEd25519Key(pubHex) && PqHybrid.ed25519VerifyStrict(bytes(sigHex), msg, bytes(pubHex))

    private fun pubHex(seed: ByteArray): String = PqHex.encode(PqHybrid.ed25519PublicKey(seed))

    /** A signer over a raw 32-byte Ed25519 seed (deterministic). */
    fun seedSigner(seed: ByteArray): (ByteArray) -> ByteArray = { msg -> PqHybrid.ed25519Sign(seed, msg) }

    // ── The hop ─────────────────────────────────────────────────────────

    data class Rotation(
        val username: String,
        val fromEpoch: Long,
        val toEpoch: Long,
        val oldIrkPubHex: String,
        val newIrkPubHex: String,
        val newIrkScheme: String,
        val oldAidPubHex: String,
        val newAidPubHex: String,
        val adminRootPubHex: String,
        val removedDeviceIds: List<String>,
        val keptDevicesDigestHex: String,
        val recoveryRecordDigestHex: String?,
        val nonceHex: String,
        val issuedAt: Long,
    )

    data class Signatures(val adminRootSignatureHex: String, val newIrkSignatureHex: String, val newAidSignatureHex: String)

    /** What the verifier holds now. [aidPubHex] null: the hop's old AID is not checked. */
    data class KeyState(val username: String, val epoch: Long, val irkPubHex: String, val aidPubHex: String?, val adminRootPubHex: String)

    private fun rotationFields(r: Rotation): List<String> {
        need(IrkScheme.of(r.newIrkScheme) != null, "newIrkScheme")
        val removed = r.removedDeviceIds.map(::deviceId).sorted()
        need(removed.toSet().size == removed.size, "removedDeviceIds")
        r.recoveryRecordDigestHex?.let { need(HEX32.matches(it), "recoveryRecordDigestHex") }
        need(HEX16.matches(r.nonceHex), "nonceHex")
        return listOf(
            username(r.username), uint(r.fromEpoch, "fromEpoch"), uint(r.toEpoch, "toEpoch"),
            hex32(r.oldIrkPubHex, "oldIrkPubHex"), hex32(r.newIrkPubHex, "newIrkPubHex"), r.newIrkScheme,
            hex32(r.oldAidPubHex, "oldAidPubHex"), hex32(r.newAidPubHex, "newAidPubHex"),
            hex32(r.adminRootPubHex, "adminRootPubHex"), if (removed.isEmpty()) "none" else removed.joinToString(","),
            hex32(r.keptDevicesDigestHex, "keptDevicesDigestHex"), r.recoveryRecordDigestHex ?: "none",
            r.nonceHex, uint(r.issuedAt, "issuedAt"),
        )
    }

    fun canonical(r: Rotation): ByteArray = join(listOf(TAG_ROTATION) + rotationFields(r))

    fun digestHex(r: Rotation): String = sha256Hex(canonical(r))

    fun sign(r: Rotation, adminRoot: (ByteArray) -> ByteArray, newIrk: (ByteArray) -> ByteArray, newAid: (ByteArray) -> ByteArray): Signatures {
        val msg = canonical(r)
        return Signatures(PqHex.encode(adminRoot(msg)), PqHex.encode(newIrk(msg)), PqHex.encode(newAid(msg)))
    }

    /** One hop against the verifier's own state; throws [Failure]. */
    fun verify(r: Rotation, s: Signatures, st: KeyState) {
        val user = st.username.lowercase()
        val irk = st.irkPubHex.lowercase()
        val aid = st.aidPubHex?.lowercase()
        val root = st.adminRootPubHex.lowercase()
        val msg = try { canonical(r) } catch (_: IllegalArgumentException) { throw Failure("malformed") }
        if (r.username != user) throw Failure("wrong-account")
        if (r.adminRootPubHex == irk || r.adminRootPubHex == r.oldIrkPubHex || r.adminRootPubHex == r.oldAidPubHex) throw Failure("signed-by-irk")
        if (r.adminRootPubHex != root) throw Failure("wrong-admin-root")
        if (r.fromEpoch < st.epoch) throw Failure("stale-epoch")
        if (r.fromEpoch > st.epoch) throw Failure("epoch-gap")
        if (r.toEpoch != r.fromEpoch + 1) throw Failure("bad-epoch-step")
        if (r.oldIrkPubHex != irk) throw Failure("wrong-old-irk")
        if (!aid.isNullOrEmpty() && r.oldAidPubHex != aid) throw Failure("wrong-old-aid")
        if (!isAcceptableEd25519Key(r.newIrkPubHex) || !isAcceptableEd25519Key(r.newAidPubHex)) throw Failure("weak-key")
        val keys = listOf(r.oldIrkPubHex, r.newIrkPubHex, r.oldAidPubHex, r.newAidPubHex, r.adminRootPubHex)
        if (keys.toSet().size != keys.size) throw Failure("key-not-new")
        if (!verifyEd(s.adminRootSignatureHex, msg, r.adminRootPubHex)) throw Failure("bad-admin-signature")
        if (!verifyEd(s.newIrkSignatureHex, msg, r.newIrkPubHex)) throw Failure("bad-new-irk-signature")
        if (!verifyEd(s.newAidSignatureHex, msg, r.newAidPubHex)) throw Failure("bad-new-aid-signature")
    }

    // ── Hybrid companion ────────────────────────────────────────────────

    fun canonicalV2(r: Rotation, newIrkKeyIdHex: String): ByteArray {
        need(HEX32.matches(newIrkKeyIdHex), "newIrkKeyIdHex")
        return join(listOf(TAG_ROTATION_V2) + rotationFields(r) + newIrkKeyIdHex)
    }

    /** The companion; [adminRootSign] is the admin root's hybrid signer (purpose, payload) → signature. */
    fun signPq(r: Rotation, newIrkBinding: PqTrust.Wire, adminRootSign: (String, ByteArray) -> ByteArray): JsonObject {
        val kid = PqAuthorityRecords.bindingKeyIdHex(newIrkBinding.ed25519PubHex, newIrkBinding.mldsaPubHex)
        val sig = adminRootSign(TAG_ROTATION_V2, canonicalV2(r, kid))
        return buildJsonObject {
            put("signature", buildJsonObject { put("suite", PqTrust.SUITE_HYBRID); put("signature", PqHex.encode(sig)) })
            put("newIrkBinding", newIrkBinding.toJson())
        }
    }

    private fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    /**
     * Verifies the companion under the verifier's own binding for the admin root and returns the new
     * IRK's verified binding. Throws [PqTrustException].
     */
    fun verifyPq(r: Rotation, pq: JsonElement?, adminRootBinding: PqTrust.VerifiedBinding?, policy: AssurancePolicy.PolicyState, now: Long): PqTrust.VerifiedBinding {
        val o = pq as? JsonObject ?: throw PqTrustException("strict-requires-hybrid")
        val e = o["signature"] as? JsonObject ?: throw PqTrustException("bad-signature")
        val suite = str(e["suite"]) ?: throw PqTrustException("bad-signature")
        val sig = str(e["signature"]) ?: throw PqTrustException("bad-signature")
        if (suite != PqTrust.SUITE_HYBRID) throw PqTrustException(if (suite == PqTrust.SUITE_ED25519) "strict-requires-hybrid" else "unknown-suite")
        val binding = PqTrust.verifyPqKeyBinding(o["newIrkBinding"], PqTrust.Expectation("account-irk", r.username, r.newIrkPubHex, now = now))
        val msg = try { canonicalV2(r, binding.keyIdHex) } catch (_: IllegalArgumentException) { throw PqTrustException("bad-signature") }
        PqTrust.verifyCriticalSignature(msg, TAG_ROTATION_V2, PqTrust.SignatureEnvelope(PqTrust.SUITE_HYBRID, sig), r.adminRootPubHex, adminRootBinding, policy)
        return binding
    }

    // ── Kept devices, derived keys ──────────────────────────────────────

    data class KeptDevice(val deviceId: String, val devicePubHex: String)

    fun keptDevicesLines(devices: List<KeptDevice>): String {
        need(devices.isNotEmpty(), "kept devices")
        val sorted = devices.map { deviceId(it.deviceId) to hex32(it.devicePubHex, "devicePubHex") }.sortedBy { it.first }
        need(sorted.map { it.first }.toSet().size == sorted.size, "kept devices")
        return sorted.joinToString("") { "${it.first}:${it.second}\n" }
    }

    fun keptDevicesDigestHex(devices: List<KeptDevice>): String = sha256Hex(keptDevicesLines(devices).toByteArray(Charsets.UTF_8))

    fun verifyKept(r: Rotation, kept: List<KeptDevice>, self: KeptDevice) {
        val digest = try { keptDevicesDigestHex(kept) } catch (_: IllegalArgumentException) { throw Failure("malformed") }
        if (digest != r.keptDevicesDigestHex) throw Failure("kept-digest-mismatch")
        if (self !in kept) throw Failure("not-kept")
    }

    private fun hkdf(ikm: ByteArray, salt: String, info: String): ByteArray {
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val prk = extract.doFinal(ikm)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(prk, "HmacSHA256"))
        expand.update(info.toByteArray(Charsets.UTF_8))
        expand.update(1)
        return expand.doFinal()
    }

    /** True when the device key is `HKDF(umk, flagship/account-device-key/v1|acct|id)`. */
    fun deviceKeyIsUmkDerived(umk: ByteArray, accountName: String, deviceId: String, devicePubHex: String): Boolean {
        if (umk.size != 32 || !HEX16.matches(deviceId) || !HEX32.matches(devicePubHex)) return false
        return pubHex(hkdf(umk, "", "flagship/account-device-key/v1|${accountName.lowercase()}|$deviceId")) == devicePubHex
    }

    fun irkSeed(umk: ByteArray, scheme: IrkScheme, version: Int = 1): ByteArray = when (scheme) {
        IrkScheme.WEB -> hkdf(umk, "", "flagship.irk.v$version")
        IrkScheme.IOS -> hkdf(umk, "", "flagship/irk/v$version")
        IrkScheme.ANDROID -> hkdf(umk, "flagship/irk/v$version", "ed25519-seed")
    }

    fun aidSeed(umk: ByteArray): ByteArray = hkdf(umk, "", "flagship/account-id/v1")

    /** After opening: the UMK must yield the hop's new IRK (its scheme, v1) and new AID. */
    fun checkRotatedUmk(r: Rotation, p: Plaintext) {
        if (p.irkScheme.wire != r.newIrkScheme ||
            pubHex(irkSeed(p.umk, p.irkScheme)) != r.newIrkPubHex ||
            pubHex(aidSeed(p.umk)) != r.newAidPubHex
        ) throw Failure("umk-mismatch")
    }

    // ── The delivery ────────────────────────────────────────────────────

    class Plaintext(val umk: ByteArray, val irkScheme: IrkScheme, val adminRootSeed: ByteArray? = null)

    /** `umk(32) | irkScheme(1) | flags(1) | [adminRootSeed(32)]`. */
    fun encodePlaintext(p: Plaintext): ByteArray {
        need(p.umk.size == 32, "umk")
        p.adminRootSeed?.let { need(it.size == 32, "adminRootSeed") }
        return p.umk + byteArrayOf(p.irkScheme.byte.toByte(), if (p.adminRootSeed == null) 0 else 1) + (p.adminRootSeed ?: ByteArray(0))
    }

    fun decodePlaintext(b: ByteArray): Plaintext {
        if (b.size != 34 && b.size != 66) throw Failure("bad-plaintext")
        val scheme = IrkScheme.entries.firstOrNull { it.byte == (b[32].toInt() and 0xff) } ?: throw Failure("bad-plaintext")
        val flags = b[33].toInt() and 0xff
        if (flags and 0x01.inv() != 0) throw Failure("bad-plaintext")
        if ((flags == 1) != (b.size == 66)) throw Failure("bad-plaintext")
        return Plaintext(b.copyOfRange(0, 32), scheme, if (b.size == 66) b.copyOfRange(34, 66) else null)
    }

    data class Delivery(
        val username: String,
        val toEpoch: Long,
        val deviceId: String,
        val devicePubHex: String,
        val rotationDigestHex: String,
        val sealedDigestHex: String,
        val issuedAt: Long,
    )

    fun canonical(d: Delivery): ByteArray = join(listOf(
        TAG_DELIVERY, username(d.username), uint(d.toEpoch, "toEpoch"), deviceId(d.deviceId), hex32(d.devicePubHex, "devicePubHex"),
        hex32(d.rotationDigestHex, "rotationDigestHex"), hex32(d.sealedDigestHex, "sealedDigestHex"), uint(d.issuedAt, "issuedAt"),
    ))

    enum class SealKind(val wire: String) { XWING("xwing"), ED25519("ed25519") }

    fun deliveryContext(username: String, toEpoch: Long, deviceId: String): List<ByteArray> =
        listOf(username(username).toByteArray(Charsets.UTF_8), uint(toEpoch, "toEpoch").toByteArray(Charsets.UTF_8), deviceId(deviceId).toByteArray(Charsets.UTF_8))

    fun senderKeyId(adminRootPubHex: String): ByteArray = sha256(bytes(hex32(adminRootPubHex, "adminRootPubHex")))

    /** X-Wing to the receive key. [randomness] (64 bytes) is for vectors only. */
    fun sealXWing(r: Rotation, deviceId: String, plaintext: ByteArray, receiveKey: ByteArray, issuedAt: Long, randomness: ByteArray? = null): ByteArray {
        val opts = PqHybrid.HybridSealOptions(TAG_DELIVERY, senderKeyId(r.adminRootPubHex), issuedAt)
        val ctx = deliveryContext(r.username, r.toEpoch, deviceId)
        return if (randomness != null) PqHybrid.hybridSealWithRandomness(receiveKey, opts, ctx, plaintext, randomness)
        else PqHybrid.hybridSeal(receiveKey, opts, ctx, plaintext)
    }

    /** The classical fallback to the device's Ed25519 identity key (`SecretSeal`'s layout); the
     *  ephemeral secret and nonce are for vectors only. */
    fun sealEd25519(plaintext: ByteArray, devicePub: ByteArray, ephPriv: ByteArray? = null, nonce: ByteArray? = null): ByteArray {
        if (ephPriv == null || nonce == null) return SecretSeal.sealForEd25519Recipient(plaintext, devicePub)
        val ephPub = X25519.publicFromPrivate(ephPriv)
        val shared = X25519.computeSharedSecret(ephPriv, Curve25519Map.edwardsPubToMontgomery(devicePub))
        val extract = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(ephPub, "HmacSHA256")) }
        val prk = extract.doFinal(shared)
        val key = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(prk, "HmacSHA256")) }.run {
            update(SEAL_TAG.toByteArray()); update(1); doFinal()
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return ephPub + nonce + cipher.doFinal(plaintext)
    }

    fun buildDelivery(r: Rotation, deviceId: String, devicePubHex: String, sealed: ByteArray, issuedAt: Long, adminRoot: (ByteArray) -> ByteArray): Pair<Delivery, String> {
        val d = Delivery(r.username, r.toEpoch, deviceId, devicePubHex, digestHex(r), sha256Hex(sealed), issuedAt)
        return d to PqHex.encode(adminRoot(canonical(d)))
    }

    /** A kept device opens its delivery (the caller verified the hop under its own pin). [secret] is
     *  the X-Wing receive-key seed or the Ed25519 identity seed. Throws [Failure]. */
    fun open(r: Rotation, d: Delivery, signatureHex: String, sealed: ByteArray, kind: SealKind, self: KeptDevice, secret: ByteArray): Plaintext {
        val msg = try { canonical(d) } catch (_: IllegalArgumentException) { throw Failure("malformed") }
        if (!verifyEd(signatureHex, msg, r.adminRootPubHex)) throw Failure("bad-signature")
        if (d.username != r.username || d.toEpoch != r.toEpoch) throw Failure("rotation-mismatch")
        if (d.rotationDigestHex != runCatching { digestHex(r) }.getOrNull()) throw Failure("rotation-mismatch")
        if (d.deviceId != self.deviceId || d.devicePubHex != self.devicePubHex) throw Failure("wrong-recipient")
        if (d.sealedDigestHex != sha256Hex(sealed)) throw Failure("sealed-mismatch")
        val plain = try {
            when (kind) {
                SealKind.XWING -> {
                    val opened = PqHybrid.hybridOpen(secret, TAG_DELIVERY, deliveryContext(r.username, r.toEpoch, d.deviceId), sealed)
                    check(opened.header.issuedAt == d.issuedAt && opened.header.senderKeyId.contentEquals(senderKeyId(r.adminRootPubHex)))
                    opened.plaintext
                }
                SealKind.ED25519 -> {
                    check(secret.size == 32 && pubHex(secret) == d.devicePubHex)
                    SecretSeal.openWithEd25519Seed(sealed, secret)
                }
            }
        } catch (_: Exception) {
            throw Failure("open-failed")
        }
        val p = decodePlaintext(plain)
        checkRotatedUmk(r, p)
        return p
    }

    // ── Device key rotate / receive key ─────────────────────────────────

    fun canonicalDeviceKeyRotate(username: String, deviceId: String, oldDevicePubHex: String, newDevicePubHex: String, issuedAt: Long): ByteArray =
        join(listOf(TAG_DEVICE_KEY_ROTATE, username(username), deviceId(deviceId), hex32(oldDevicePubHex, "oldDevicePubHex"),
            hex32(newDevicePubHex, "newDevicePubHex"), uint(issuedAt, "issuedAt")))

    /** Both signatures, the new key different from the old and from the admin root. */
    fun verifyDeviceKeyRotate(
        username: String, deviceId: String, oldDevicePubHex: String, newDevicePubHex: String, issuedAt: Long,
        newKeySignatureHex: String, adminRootSignatureHex: String, adminRootPubHex: String,
    ): Boolean {
        val msg = runCatching { canonicalDeviceKeyRotate(username, deviceId, oldDevicePubHex, newDevicePubHex, issuedAt) }.getOrNull() ?: return false
        if (newDevicePubHex == oldDevicePubHex || newDevicePubHex == adminRootPubHex) return false
        return verifyEd(newKeySignatureHex, msg, newDevicePubHex) && verifyEd(adminRootSignatureHex, msg, adminRootPubHex)
    }

    fun canonicalDeviceReceiveKey(username: String, deviceId: String, devicePubHex: String, xwingPubHex: String, issuedAt: Long): ByteArray {
        need(HEX.matches(xwingPubHex), "xwingPubHex")
        PqHybrid.parseHybridSealPublicKey(bytes(xwingPubHex))
        return join(listOf(TAG_DEVICE_RECEIVE_KEY, username(username), deviceId(deviceId), hex32(devicePubHex, "devicePubHex"), xwingPubHex, uint(issuedAt, "issuedAt")))
    }

    fun verifyDeviceReceiveKey(username: String, deviceId: String, devicePubHex: String, xwingPubHex: String, issuedAt: Long, signatureHex: String): Boolean {
        val msg = runCatching { canonicalDeviceReceiveKey(username, deviceId, devicePubHex, xwingPubHex, issuedAt) }.getOrNull() ?: return false
        return verifyEd(signatureHex, msg, devicePubHex)
    }

    // ── Per-server follow-ups ───────────────────────────────────────────

    fun canonicalCgkRekey(serverDomain: String, toEpoch: Long, sealedHex: String, issuedAt: Long): ByteArray =
        join(listOf(TAG_CGK_REKEY, domain(serverDomain), uint(toEpoch, "toEpoch"), sealedHex(sealedHex), uint(issuedAt, "issuedAt")))

    fun canonicalSwkRekey(serverDomain: String, toEpoch: Long, oldSwkCommitHex: String, sealedHex: String, issuedAt: Long): ByteArray =
        join(listOf(TAG_SWK_REKEY, domain(serverDomain), uint(toEpoch, "toEpoch"), hex32(oldSwkCommitHex, "oldSwkCommitHex"), sealedHex(sealedHex), uint(issuedAt, "issuedAt")))

    fun canonicalLuksRekeyConfirm(serverDomain: String, toEpoch: Long, sealedKeyDigestHex: String, issuedAt: Long): ByteArray =
        join(listOf(TAG_LUKS_REKEY_CONFIRM, domain(serverDomain), uint(toEpoch, "toEpoch"), hex32(sealedKeyDigestHex, "sealedKeyDigestHex"), uint(issuedAt, "issuedAt")))

    /** CGK and SWK re-keys are signed by the admin root, the LUKS confirmation by the new IRK. */
    fun verifyRekey(build: () -> ByteArray, signatureHex: String, signerPubHex: String): Boolean {
        val msg = runCatching(build).getOrNull() ?: return false
        return verifyEd(signatureHex, msg, signerPubHex)
    }
}
