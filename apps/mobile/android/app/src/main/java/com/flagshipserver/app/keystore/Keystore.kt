package com.flagshipserver.app.keystore

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.X25519
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Generates and holds the User Master Key inside Android Keystore (with
 * StrongBox when available), plus derived secrets that the rest of the
 * app needs:
 *   - IRK (Ed25519) — signs every IRK-bound canonical message.
 *   - PushX25519 — per-device ECDH keypair for encrypted push payloads.
 *
 * The IRK is derived deterministically from the UMK via HKDF-SHA256;
 * we cache the derived seed in EncryptedSharedPreferences so we don't
 * have to round-trip through the AndroidKeyStore + biometric prompt on
 * every send. The Push X25519 keypair lives there too.
 *
 * Why not store everything in AndroidKeyStore: Ed25519 isn't a first-
 * class KeyStore algorithm on every device; for parity with the iOS
 * CryptoKit code-path we keep raw seed bytes wrapped under an AES-GCM
 * KeyStore key (EncryptedSharedPreferences does this internally).
 */
object Keystore {
    private const val UMK_ALIAS = "com.flagship.umk"
    private const val ANDROID_KEY_STORE = "AndroidKeyStore"

    private const val FILE_NAME = "flagship-keystore"
    private const val KEY_UMK_SEED = "umk.seed"
    private const val KEY_IRK_SEED = "irk.seed"
    private const val KEY_PUSH_X25519_PRIV = "push.x25519.priv"
    private const val KEY_PUSH_TOKEN_ID = "push.tokenId"
    /** Active IRK HKDF version counter (B7/C7). Stored as a string of
     *  the integer; absent means v1 (the historical default). Bumped
     *  by Replace device + Wipe & restart ceremonies so old-IRK
     *  signatures stop verifying against the new registered IRK. */
    private const val KEY_IRK_VERSION = "irk.version"
    /** Pending IRK rotation target (C7). Stored during the 24-hour
     *  re-pair grace window; cleared on completion or abort. */
    private const val KEY_IRK_PENDING_VERSION = "irk.pendingVersion"

    // ---- Multi-profile keying (W3) -------------------------------------
    //
    // The phone can hold multiple cloud PROFILES (personal / family /
    // work). Each profile must own its OWN device key — a second
    // profile's UMK must not clobber the first. We achieve that by
    // namespacing every per-profile prefs slot by a *profileId* (the
    // profile's `cloudName`, lowercased).
    //
    // Backward-compat is load-bearing: the DEFAULT (sentinel) profileId
    // reuses the EXISTING un-suffixed key names verbatim, so with no
    // setActiveProfile() call the on-disk layout + every method's
    // behavior are byte-identical to the pre-multi-profile build. Only
    // non-default profileIds get a ".<profileId>" suffix.
    //
    // The active-profile pointer is metadata, NOT a per-profile secret
    // slot — it lives under its own key and is deliberately untouched by
    // wipe() (which clears only the active profile's secrets). A caller
    // that wants a full reset uses wipeAllProfiles().

    /** Pointer to the active profileId. Absent ⇒ the default/legacy
     *  profile. Stored as plain text (it's the lowercased cloudName, not
     *  a secret). */
    private const val KEY_ACTIVE_PROFILE = "active.profile"

    private val rng = SecureRandom()
    @Volatile private var prefs: SharedPreferences? = null
    @Volatile private var activeProfileId: String? = null

    /** Wire up the encrypted-prefs file. Idempotent. App init calls
     *  this from MainActivity.onCreate. */
    fun attach(context: Context) {
        if (prefs != null) return
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        prefs = EncryptedSharedPreferences.create(
            context, FILE_NAME, masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        // Resume the last-active profile across process death.
        activeProfileId = prefs?.getString(KEY_ACTIVE_PROFILE, null)
    }

    /** Test-only: attach to a plain SharedPreferences. */
    fun attachForTest(testPrefs: SharedPreferences) {
        prefs = testPrefs
        // Hydrate the in-memory active-profile pointer from the test
        // prefs so a re-attach within the same JVM resumes the same
        // profile (mirrors attach()).
        activeProfileId = testPrefs.getString(KEY_ACTIVE_PROFILE, null)
    }

    private fun requirePrefs(): SharedPreferences =
        prefs ?: error("Keystore not attached — call Keystore.attach(context) from app init.")

    // ---- Profile selection --------------------------------------------

    /**
     * Normalize a caller-supplied profile id (a cloudName) into the
     * canonical profileId. Null/blank ⇒ null (the default/legacy
     * profile); otherwise lowercased + trimmed.
     */
    private fun normalizeProfileId(id: String?): String? =
        id?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }

    /**
     * W3 — select which profile the per-profile methods operate on.
     * Pass the profile's `cloudName`; null or empty selects the
     * DEFAULT (legacy) profile, whose slots are the historical
     * un-suffixed keys. Persisted so the selection survives process
     * death; ALL subsequent installUmk / deriveIRK / wipe / etc. calls
     * key off the active profile until the next setActiveProfile().
     */
    fun setActiveProfile(id: String?) {
        val normalized = normalizeProfileId(id)
        activeProfileId = normalized
        val p = prefs ?: return
        val editor = p.edit()
        if (normalized == null) editor.remove(KEY_ACTIVE_PROFILE)
        else editor.putString(KEY_ACTIVE_PROFILE, normalized)
        editor.apply()
    }

    /** The active profileId, or null for the default/legacy profile. */
    fun activeProfile(): String? = activeProfileId

    /**
     * Suffix a base prefs key for the active profile. The default
     * profile (activeProfileId == null) returns the base key UNCHANGED
     * — this is what preserves byte-identical on-disk layout + behavior
     * for legacy single-profile installs. Non-default profiles get a
     * ".<profileId>" suffix so their slots never collide.
     */
    private fun pkey(base: String): String {
        val pid = activeProfileId ?: return base
        return "$base.$pid"
    }

    /** Generate the UMK in AndroidKeyStore (with StrongBox if available).
     *  This is the symmetric "anchor" key; in production it would wrap
     *  the cached seeds. Stub left over from the scaffolding step. */
    fun generateUMK(useStrongBox: Boolean = true): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        val spec = KeyGenParameterSpec.Builder(
            UMK_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setIsStrongBoxBacked(useStrongBox)
            .build()
        gen.init(spec)
        return gen.generateKey()
    }

    /** Return a 32-byte UMK seed for the active profile, creating it on
     *  first call. */
    fun loadOrCreateUmkSeed(): ByteArray {
        val p = requirePrefs()
        val umkKey = pkey(KEY_UMK_SEED)
        p.getString(umkKey, null)?.let { hex ->
            HexUtil.decode(hex)?.let { return it }
        }
        val seed = ByteArray(32).also(rng::nextBytes)
        p.edit().putString(umkKey, HexUtil.encode(seed)).apply()
        return seed
    }

    /**
     * E4 — atomically install a pre-existing UMK seed. Used by Wipe
     * & restart: the caller has just generated a fresh 32-byte UMK
     * (so the OLD IRK can sign the canonical bytes before we
     * overwrite). After this returns, deriveIRK() / deriveBAK() /
     * deriveSWK() all derive against the NEW UMK.
     *
     * Resets the IRK version slot to v1 and clears any pending
     * rotation, and sweeps stale per-version IRK seed caches so
     * subsequent deriveIRK calls re-mint from the new UMK.
     */
    fun installUmk(seed: ByteArray) {
        require(seed.size == 32) { "UMK seed must be 32 bytes" }
        val p = requirePrefs()
        val editor = p.edit()
        editor.putString(pkey(KEY_UMK_SEED), HexUtil.encode(seed))
        // Reset version slots — fresh UMK ⇒ fresh v1 derivation.
        editor.putString(pkey(KEY_IRK_VERSION), "1")
        editor.remove(pkey(KEY_IRK_PENDING_VERSION))
        // Sweep the ACTIVE profile's per-version IRK seed caches; they're
        // derived from the OLD UMK and would otherwise survive into the
        // new identity. Other profiles' caches are untouched.
        val seedCachePrefix = "${pkey(KEY_IRK_SEED)}.v"
        for (key in p.all.keys) {
            if (key.startsWith(seedCachePrefix)) editor.remove(key)
        }
        // Also drop the legacy single-slot IRK seed if a pre-versioned
        // install left it lying around — same correctness logic.
        editor.remove(pkey(KEY_IRK_SEED))
        editor.apply()
    }

    /** E4 — read the current UMK seed. Used by the Wipe ceremony to
     *  derive the OLD IRK + sign before installing a new UMK. */
    fun currentUmkSeed(): ByteArray =
        loadOrCreateUmkSeed()

    /** Derive (and cache) the IRK Ed25519 keypair at the currently
     *  active version. See `deriveIRK(reason, version)` for the
     *  versioned variant used by Replace device (C7) and Wipe &
     *  restart (E4-E5). */
    suspend fun deriveIRK(reason: String = "Sign Flagship request"): Ed25519Sign =
        deriveIRK(reason, currentIrkVersion())

    /** Explicit-version IRK derivation. Used by the rotation
     *  ceremonies to derive BOTH the OLD (currentIrkVersion()) and
     *  NEW (currentIrkVersion()+1) IRK from the shared UMK. Versions
     *  >= 1; v1 is the legacy default that pre-dates this primitive.
     *  Caches per-version so subsequent calls don't re-HKDF. */
    suspend fun deriveIRK(reason: String, version: Int): Ed25519Sign {
        require(version >= 1) { "IRK version must be >= 1" }
        BiometricAuthority.current()?.ensureFresh(
            title = "Authorize Flagship",
            subtitle = reason,
        )
        val p = requirePrefs()
        val cacheKey = "${pkey(KEY_IRK_SEED)}.v$version"
        val seedHex = p.getString(cacheKey, null)
        val seed = if (seedHex != null) {
            HexUtil.decode(seedHex) ?: error("corrupt IRK seed (v$version)")
        } else {
            val umk = loadOrCreateUmkSeed()
            val derived = hkdf(
                umk,
                salt = "flagship/irk/v$version".toByteArray(),
                info = "ed25519-seed".toByteArray(),
                length = 32,
            )
            p.edit().putString(cacheKey, HexUtil.encode(derived)).apply()
            derived
        }
        return Ed25519Sign(seed)
    }

    /** Current IRK HKDF version active for sign/verify against
     *  .com. Defaults to 1 if the slot is absent (covers legacy
     *  installs). */
    fun currentIrkVersion(): Int =
        requirePrefs().getString(pkey(KEY_IRK_VERSION), null)?.toIntOrNull()?.takeIf { it >= 1 } ?: 1

    /** Persist a new IRK version. Caller is expected to have just
     *  successfully completed a server-side IRK swap via either
     *  `/api/users/:u/re-pair/complete` or `/api/users/:u/wipe-restart`. */
    fun setCurrentIrkVersion(version: Int) {
        require(version >= 1)
        requirePrefs().edit().putString(pkey(KEY_IRK_VERSION), version.toString()).apply()
    }

    /** Optional pending-rotation marker. Presence = a re-pair was
     *  initiated; absent = no rotation in flight. */
    fun pendingIrkRotationVersion(): Int? =
        requirePrefs().getString(pkey(KEY_IRK_PENDING_VERSION), null)?.toIntOrNull()?.takeIf { it >= 1 }

    fun setPendingIrkRotationVersion(version: Int?) {
        val p = requirePrefs().edit()
        if (version == null) p.remove(pkey(KEY_IRK_PENDING_VERSION))
        else {
            require(version >= 1)
            p.putString(pkey(KEY_IRK_PENDING_VERSION), version.toString())
        }
        p.apply()
    }

    /** Public-key half of the IRK, hex-encoded. */
    suspend fun irkPubHex(): String {
        val p = requirePrefs()
        val irkKey = pkey(KEY_IRK_SEED)
        val seedHex = p.getString(irkKey, null) ?: run {
            deriveIRK("init"); p.getString(irkKey, null)!!
        }
        val seed = HexUtil.decode(seedHex)!!
        val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        return HexUtil.encode(pair.publicKey)
    }

    /** C7 — read the cached IRK seed for a specific version. Used by
     *  the ReplaceDeviceViewModel to compute pubkeys for OLD + NEW
     *  versions during a rotation ceremony. Caller is expected to
     *  have just called deriveIRK(version) so the cache slot is
     *  populated; throws if the slot is missing. */
    fun requireIrkSeedForVersion(version: Int): ByteArray {
        val cacheKey = "${pkey(KEY_IRK_SEED)}.v$version"
        val hex = requirePrefs().getString(cacheKey, null)
            ?: error("no IRK seed cached for v$version — call deriveIRK first")
        return HexUtil.decode(hex) ?: error("corrupt IRK seed (v$version)")
    }

    data class X25519KeyPair(val privateKey: ByteArray, val publicKey: ByteArray)

    /** Load (or create + persist) the per-device X25519 keypair used to
     *  receive encrypted push payloads. */
    fun loadOrCreatePushX25519(): X25519KeyPair {
        val p = requirePrefs()
        val pushKey = pkey(KEY_PUSH_X25519_PRIV)
        val privHex = p.getString(pushKey, null)
        val priv = if (privHex != null) HexUtil.decode(privHex)!! else {
            val k = X25519.generatePrivateKey()
            p.edit().putString(pushKey, HexUtil.encode(k)).apply()
            k
        }
        val pub = X25519.publicFromPrivate(priv)
        return X25519KeyPair(privateKey = priv, publicKey = pub)
    }

    /** Last-registered push tokenId; null if no current registration. */
    fun pushTokenId(): String? = requirePrefs().getString(pkey(KEY_PUSH_TOKEN_ID), null)

    fun setPushTokenId(id: String?) {
        val p = requirePrefs().edit()
        val key = pkey(KEY_PUSH_TOKEN_ID)
        if (id == null) p.remove(key) else p.putString(key, id)
        p.apply()
    }

    /**
     * B6a / E2-E5 — full local secret wipe. Drops every persisted
     * key the Keystore knows about. Idempotent + irreversible: after
     * this returns the app is in a fresh-install crypto state
     * (deriveUmk + deriveIRK will mint new seeds next call).
     *
     * Used by:
     *   - "Remove this device from account" (B6a) — followed by
     *     server-side push revoke + AppState.signOut.
     *   - Wipe & restart (E4/E5) — followed by re-init with the new
     *     UMK + new IRK + new recovery passkey.
     */
    fun wipe() {
        val p = requirePrefs()
        val editor = p.edit()
        editor.remove(pkey(KEY_UMK_SEED))
        editor.remove(pkey(KEY_IRK_SEED))
        editor.remove(pkey(KEY_PUSH_X25519_PRIV))
        editor.remove(pkey(KEY_PUSH_TOKEN_ID))
        editor.remove(pkey(KEY_IRK_VERSION))
        editor.remove(pkey(KEY_IRK_PENDING_VERSION))
        // Per-version IRK caches (C7) — sweep every "<irk.seed key>.vN"
        // entry the rotation primitive might have written FOR THE ACTIVE
        // PROFILE. Other profiles' caches survive.
        val seedCachePrefix = "${pkey(KEY_IRK_SEED)}.v"
        for (key in p.all.keys) {
            if (key.startsWith(seedCachePrefix)) editor.remove(key)
        }
        editor.apply()
    }

    /**
     * W3 / E2-E5 — full reset across EVERY profile. Drops every
     * per-profile secret slot (UMK / IRK / push / version) for every
     * profileId, plus the legacy un-suffixed slots and the active-
     * profile pointer. Resets the in-memory active profile to default.
     *
     * Used where the intent is "leave the app in a fresh-install crypto
     * state regardless of how many clouds were on this phone" — e.g.
     * a full account-removal / factory-reset path. The single-profile
     * "remove THIS device from THIS account" path uses wipe() instead,
     * which leaves other profiles intact.
     */
    fun wipeAllProfiles() {
        val p = requirePrefs()
        val editor = p.edit()
        // Every per-profile slot is one of these base names, either
        // un-suffixed (default profile) or ".<profileId>"-suffixed, plus
        // the ".vN" per-version IRK seed caches. Drop them all.
        val bases = listOf(
            KEY_UMK_SEED, KEY_IRK_SEED, KEY_PUSH_X25519_PRIV,
            KEY_PUSH_TOKEN_ID, KEY_IRK_VERSION, KEY_IRK_PENDING_VERSION,
        )
        for (key in p.all.keys) {
            if (key == KEY_ACTIVE_PROFILE) { editor.remove(key); continue }
            if (bases.any { key == it || key.startsWith("$it.") }) editor.remove(key)
        }
        editor.apply()
        activeProfileId = null
    }

    // ---- HKDF-SHA256 ----------------------------------------------------

    private fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(salt, "HmacSHA256"))
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
