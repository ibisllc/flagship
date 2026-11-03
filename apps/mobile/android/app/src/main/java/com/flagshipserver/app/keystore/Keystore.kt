package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerKeys
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.X25519
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Holds this phone's account keys, per profile:
 *   - the account seed (UMK) and the admin master root: seed-class, sealed under the session KEK
 *     that only the unlock prompt opens ([SeedVault], the Android twin of iOS's `.userPresence`
 *     Keychain custody). Read only while the app session is unlocked; locked, a read throws
 *     [SessionLockedException] and background work waits for the next unlock.
 *   - keys derived from the UMK (IRK, AID, per-app ids, SWK, CGK, the account device key): computed
 *     when needed; the IRK seed is cached in memory for the session only, its public half on disk.
 *   - device-local keys that must work without a prompt, as on iOS (AfterFirstUnlockThisDeviceOnly):
 *     the push X25519 key, the watch-delegate key, a joined device's stored account device key, the
 *     ACME account scalar, read tokens, pins. These stay in EncryptedSharedPreferences.
 * Ed25519 isn't a first-class Keystore algorithm on every device, so the seeds are raw bytes kept
 * under Keystore-held keys rather than Keystore keys themselves.
 */
object Keystore {

    private const val FILE_NAME = "flagship-keystore"
    private const val KEY_UMK_SEED = "umk.seed"
    private const val KEY_IRK_SEED = "irk.seed"
    /** The IRK's public half per version (not secret), so showing it never needs the unlock. */
    private const val KEY_IRK_PUB = "irk.pub"
    private const val KEY_PUSH_X25519_PRIV = "push.x25519.priv"
    private const val KEY_PUSH_TOKEN_ID = "push.tokenId"
    /** #28 — exportable ECDSA P-256 ACME account-key scalar (32 bytes,
     *  hex). Admin-held; escrowed into the recovery envelope. */
    private const val KEY_ACME_ACCOUNT_SCALAR = "acme.account.scalar"
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
    @Volatile private var appContext: Context? = null
    @Volatile private var activeProfileId: String? = null
    /** The PQ identity keys' entries (PqKeyPrefs) and the held assurance policy (QuantumSafetyStore). */
    @Volatile private var pqPrefs: List<SharedPreferences> = emptyList()

    /** Wire up the encrypted-prefs file. Idempotent. App init calls
     *  this from MainActivity.onCreate. */
    fun attach(context: Context) {
        if (prefs != null) return
        appContext = context.applicationContext
        pqPrefs = listOf(
            context.getSharedPreferences("flagship.pqkeys.v1", Context.MODE_PRIVATE),
            context.getSharedPreferences("flagship.assurance.v1", Context.MODE_PRIVATE),
        )
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

    /** Switch the profile for this process only, leaving the persisted choice
     *  alone (a debug gym run uses its own key slot without making the device
     *  look paired at the next launch). */
    fun setActiveProfileInMemory(id: String?) {
        activeProfileId = normalizeProfileId(id)
    }

    /** Back to the profile the device persisted (what a normal launch uses). */
    fun restorePersistedActiveProfile() {
        activeProfileId = prefs?.getString(KEY_ACTIVE_PROFILE, null)?.let { normalizeProfileId(it) }
    }

    /** The active profileId, or null for the default/legacy profile. */
    fun activeProfile(): String? = activeProfileId

    /** The active profile as a Keystore alias suffix ("default" for the legacy profile). */
    fun activeProfileTag(): String = activeProfileId?.replace(Regex("[^a-z0-9-]"), "_") ?: "default"

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

    // ---- Seed custody (SeedVault) -----------------------------------------

    /** The IRK seeds derived this session, per profile and version. Memory only: dropped with the
     *  session ([sessionClosed]); old builds kept them on disk, which [SeedVault.migrate] removes. */
    private val irkSeeds = ConcurrentHashMap<String, ByteArray>()

    private fun irkCacheKey(version: Int) = "${activeProfileTag()}|$version"

    /** Read a seed-class [slot] of the active profile, or null when absent. Throws
     *  [SessionLockedException] while the session is locked and [AccountKeyUnreadableException]
     *  when the sealed record no longer opens (the Keystore key behind it is gone). */
    private fun readSeed(slot: String): ByteArray? {
        val kek = PqSessionKek.current()
        try {
            return when (val r = SeedVault.read(requirePrefs(), slot, kek)) {
                SeedVault.Read.Absent -> null
                is SeedVault.Read.Legacy -> r.bytes
                is SeedVault.Read.Opened -> r.bytes
                SeedVault.Read.Locked -> throw lockedException()
                SeedVault.Read.Unreadable -> {
                    SeedVault.markLost(true)
                    throw AccountKeyUnreadableException()
                }
            }
        } finally {
            kek?.fill(0)
        }
    }

    private fun writeSeed(slot: String, value: ByteArray) {
        val kek = PqSessionKek.current()
        try {
            val sealed = SeedVault.write(requirePrefs(), slot, value, kek)
            if (!sealed) com.flagshipserver.app.core.ErrorLog.step("seed-vault", "kept in the old storage until the next unlock (${slot.substringBefore('.')})")
        } finally {
            kek?.fill(0)
        }
    }

    private fun lockedException(): SessionLockedException {
        val ctx = appContext
        val needsFingerprint = ctx != null && PqSessionKek.needsStrongBiometric(KeyAuthSpec.strongBiometricEnrolled(ctx))
        return if (needsFingerprint) SessionLockedException(FSStrings.get(R.string.add_your_fingerprint_again_to_open_account_key))
        else SessionLockedException()
    }

    /**
     * Open the session before a seed is read: the unlock prompt (once per session), and, when the
     * seeds are sealed but this session's prompt did not open the KEK (a prompt that could not carry
     * the key, a transient Keystore error), one more prompt that carries it. Without a bound activity
     * (background) nothing is asked; the read then throws [SessionLockedException] and the work waits.
     */
    private suspend fun openSession(title: String, reason: String) {
        val authority = BiometricAuthority.current() ?: return
        authority.ensureFresh(title = title, subtitle = reason)
        if (PqSessionKek.isOpen() || !anySealedSeed()) return
        val ctx = appContext
        if (ctx != null && PqSessionKek.needsStrongBiometric(KeyAuthSpec.strongBiometricEnrolled(ctx))) return
        authority.reopenKeys(title = title, subtitle = reason)
    }

    /** Open the session (one prompt at most) so a following [currentUmkSeed] / [adminRootSeed]
     *  read succeeds, for flows that read the seed directly instead of through a derive. */
    suspend fun ensureUnlocked(reason: String = FSStrings.get(R.string.authorize_flagship)) =
        openSession(FSStrings.get(R.string.authorize_flagship), reason)

    private fun anySealedSeed(): Boolean {
        val p = prefs ?: return false
        return SeedVault.isSealed(p, pkey(KEY_UMK_SEED)) || SeedVault.isSealed(p, adminRootSeedKey())
    }

    /** The session KEK just opened (an unlock): move seeds still in the old storage under it, then
     *  check every sealed seed opens. Called by [PqSessionKek.finish]; never prompts. */
    internal fun sessionKekOpened(kek: ByteArray) {
        val p = prefs ?: return
        runCatching {
            val steps = SeedVault.migrate(p, kek)
            for ((slot, step) in steps) {
                com.flagshipserver.app.core.ErrorLog.step("seed-vault", "migrate ${slot.substringBefore('.')}: $step")
                if (slot.startsWith(SeedVault.ADMIN_ROOT)) rememberAdminRootPub(slot.removePrefix(SeedVault.ADMIN_ROOT))
            }
            val unreadable = SeedVault.unreadableSlots(p, kek)
            if (unreadable.isNotEmpty()) com.flagshipserver.app.core.ErrorLog.step("seed-vault", "unreadable: ${unreadable.size}")
            SeedVault.markLost(unreadable.isNotEmpty())
        }.onFailure { com.flagshipserver.app.core.ErrorLog.step("seed-vault", "migrate failed: ${it.javaClass.simpleName}") }
    }

    /** The session ended (lock, background, sign-out): forget the derived seeds held in memory. */
    internal fun sessionClosed() {
        irkSeeds.values.forEach { it.fill(0) }
        irkSeeds.clear()
    }

    /** True when this phone's account seeds are sealed under the session key (the custody iOS's
     *  `.userPresence` gives), false while they are still in the old storage. */
    fun seedsAreSealed(): Boolean = prefs?.let { SeedVault.isSealed(it, pkey(KEY_UMK_SEED)) } == true

    /**
     * The person chose to restore their account after [SeedVault.lost]: the sealed records that no
     * longer open are deleted (no key exists that could open them), and the active profile's other
     * secrets with them when its account seed was among them. Returns true when the active profile
     * lost its account seed, so the caller signs out to the welcome screen's recovery.
     */
    fun forgetUnreadableSeeds(): Boolean {
        val p = requirePrefs()
        val kek = PqSessionKek.current() ?: return false
        try {
            val unreadable = SeedVault.unreadableSlots(p, kek)
            val activeLost = pkey(KEY_UMK_SEED) in unreadable
            val e = p.edit()
            for (slot in unreadable) {
                e.remove(SeedVault.sealedKey(slot))
                if (slot.startsWith(SeedVault.ADMIN_ROOT)) e.remove("admin.root.pub" + slot.removePrefix(SeedVault.ADMIN_ROOT))
            }
            e.commit()
            if (activeLost) wipe()
            SeedVault.markLost(false)
            return activeLost
        } finally {
            kek.fill(0)
        }
    }

    /** Return a 32-byte UMK seed for the active profile, creating it on
     *  first call. Never mints while one exists, even a locked or unreadable
     *  one: it throws instead (see [readSeed]). */
    fun loadOrCreateUmkSeed(): ByteArray {
        readSeed(pkey(KEY_UMK_SEED))?.takeIf { it.size == 32 }?.let { return it }
        if (SeedVault.has(requirePrefs(), pkey(KEY_UMK_SEED))) error("corrupt account seed")
        val seed = ByteArray(32).also(rng::nextBytes)
        writeSeed(pkey(KEY_UMK_SEED), seed)
        return seed
    }

    /** The UMK when it can be read without a prompt (the session is open, or the seed is still in
     *  the old storage), else null. Never mints. */
    fun umkSeedIfOpen(): ByteArray? = runCatching { readSeed(pkey(KEY_UMK_SEED)) }.getOrNull()

    /** True when this device already holds a UMK seed for the active
     *  profile — a real identity that survives process death. The launch
     *  path reads this to restore the session instead of forcing a fresh
     *  sign-in. Unlike [loadOrCreateUmkSeed] it never mints one, and it
     *  needs no unlock (sealed or not, the seed is there). */
    fun hasUmkSeed(): Boolean = SeedVault.has(requirePrefs(), pkey(KEY_UMK_SEED))

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
        writeSeed(pkey(KEY_UMK_SEED), seed)
        val editor = p.edit()
        // Reset version slots — fresh UMK ⇒ fresh v1 derivation.
        editor.putString(pkey(KEY_IRK_VERSION), "1")
        editor.remove(pkey(KEY_IRK_PENDING_VERSION))
        // Sweep the ACTIVE profile's IRK caches (old builds' on-disk seeds, the public halves);
        // they're derived from the OLD UMK. Other profiles' caches are untouched.
        sweepIrkCaches(p, editor)
        editor.commit()
        dropActiveIrkSeeds()
    }

    private fun sweepIrkCaches(p: SharedPreferences, editor: SharedPreferences.Editor) {
        val seedCachePrefix = "${pkey(KEY_IRK_SEED)}.v"
        val pubCachePrefix = "${pkey(KEY_IRK_PUB)}.v"
        for (key in p.all.keys) {
            if (key.startsWith(seedCachePrefix) || key.startsWith(pubCachePrefix)) editor.remove(key)
        }
        editor.remove(pkey(KEY_IRK_SEED))
    }

    private fun dropActiveIrkSeeds() {
        val prefix = "${activeProfileTag()}|"
        irkSeeds.keys.filter { it.startsWith(prefix) }.forEach { irkSeeds.remove(it)?.fill(0) }
    }

    /** E4 — read the current UMK seed. Used by the Wipe ceremony to
     *  derive the OLD IRK + sign before installing a new UMK. */
    fun currentUmkSeed(): ByteArray =
        loadOrCreateUmkSeed()

    fun storeAccountDeviceSeed(deviceId: String, seed: ByteArray) {
        require(deviceId.matches(Regex("^[0-9a-f]{32}$")))
        require(seed.size == 32)
        requirePrefs().edit()
            .putString(pkey("account.device.seed.$deviceId"), HexUtil.encode(seed))
            .apply()
    }

    fun accountDeviceSigner(umk: ByteArray, accountId: String, deviceId: String): Ed25519Sign {
        val stored = requirePrefs().getString(pkey("account.device.seed.$deviceId"), null)
            ?.let(HexUtil::decode)
        return if (stored != null && stored.size == 32) Ed25519Sign(stored)
        else com.flagshipserver.app.core.AccountMetadata.deriveAccountDeviceKey(umk, accountId, deviceId)
    }

    /**
     * This device's account device key without a prompt: the stored one (joined devices, or kept
     * at an earlier unlock), else derived from the UMK while the session is open and then kept on
     * the device for silent read tokens (docs/account-read-token.md; iOS keeps it the same way,
     * device-local, readable after first unlock). Null while locked with nothing kept.
     */
    fun sessionAccountDeviceKey(accountId: String, deviceId: String): AccountDeviceKey? {
        if (!Regex("^[0-9a-f]{32}$").matches(deviceId)) return null
        val stored = requirePrefs().getString(pkey("account.device.seed.$deviceId"), null)?.let(HexUtil::decode)
            ?.takeIf { it.size == 32 }
        val seed = stored ?: run {
            val umk = umkSeedIfOpen() ?: return null
            com.flagshipserver.app.core.AccountMetadata.deriveAccountDeviceSeed(umk, accountId, deviceId).also {
                umk.fill(0)
                storeAccountDeviceSeed(deviceId, it)
            }
        }
        return AccountDeviceKey(Ed25519Sign(seed), HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey))
    }

    class AccountDeviceKey(val signer: Ed25519Sign, val pubHex: String)

    fun accountDevicePublicKey(umk: ByteArray, accountId: String, deviceId: String): ByteArray {
        val stored = requirePrefs().getString(pkey("account.device.seed.$deviceId"), null)
            ?.let(HexUtil::decode)
        return if (stored != null && stored.size == 32) Ed25519Sign.KeyPair.newKeyPairFromSeed(stored).publicKey
        else com.flagshipserver.app.core.AccountMetadata.deriveAccountDevicePub(umk, accountId, deviceId)
    }

    /** Derive (and cache) the IRK Ed25519 keypair at the currently
     *  active version. See `deriveIRK(reason, version)` for the
     *  versioned variant used by Replace device (C7) and Wipe &
     *  restart (E4-E5). */
    suspend fun deriveIRK(reason: String = FSStrings.get(R.string.sign_flagship_request)): Ed25519Sign =
        deriveIRK(reason, currentIrkVersion())

    /** Explicit-version IRK derivation. Used by the rotation
     *  ceremonies to derive BOTH the OLD (currentIrkVersion()) and
     *  NEW (currentIrkVersion()+1) IRK from the shared UMK. Versions
     *  >= 1; v1 is the legacy default that pre-dates this primitive.
     *  Caches per-version so subsequent calls don't re-HKDF. */
    suspend fun deriveIRK(reason: String, version: Int): Ed25519Sign {
        require(version >= 1) { "IRK version must be >= 1" }
        openSession(FSStrings.get(R.string.authorize_flagship), reason)
        return Ed25519Sign(irkSeed(version))
    }

    /** The IRK seed at [version]: this session's memory copy, else HKDF(UMK) (which needs the
     *  session open when the UMK is sealed), remembered for the session with its public half. */
    private fun irkSeed(version: Int): ByteArray {
        irkSeeds[irkCacheKey(version)]?.let { return it.copyOf() }
        val umk = loadOrCreateUmkSeed()
        val derived = hkdf(
            umk,
            salt = "flagship/irk/v$version".toByteArray(),
            info = "ed25519-seed".toByteArray(),
            length = 32,
        )
        umk.fill(0)
        irkSeeds[irkCacheKey(version)] = derived.copyOf()
        val pub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(derived).publicKey)
        val pubKey = "${pkey(KEY_IRK_PUB)}.v$version"
        if (requirePrefs().getString(pubKey, null) != pub) requirePrefs().edit().putString(pubKey, pub).apply()
        return derived
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

    /** Public-key half of the IRK at the current version, hex-encoded: the key
     *  [deriveIRK] signs with. Read from its on-disk public cache (no unlock needed);
     *  derived (behind the session) the first time. */
    suspend fun irkPubHex(): String {
        val version = currentIrkVersion()
        requirePrefs().getString("${pkey(KEY_IRK_PUB)}.v$version", null)?.let { return it }
        deriveIRK("init", version)
        val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(requireIrkSeedForVersion(version))
        return HexUtil.encode(pair.publicKey)
    }

    /** C7 — the IRK seed for a specific version, for callers that need the
     *  raw seed (rotation ceremonies, the boot relay). Derived from the UMK
     *  when this session hasn't yet; throws [SessionLockedException] while the
     *  session is locked (call [deriveIRK] first to open it). */
    fun requireIrkSeedForVersion(version: Int): ByteArray {
        require(version >= 1) { "IRK version must be >= 1" }
        return irkSeed(version)
    }

    /** Stable Account Identity Key (AID) signer for service-access gating
     *  (docs/service-access-gating.md) — the NON-rotating account identity
     *  `HKDF(umk, "flagship/account-id/v1")` (via ServerKeys), used by the
     *  friend to sign the redeem/visit. Biometric-gated. Distinct from the
     *  versioned IRK. */
    suspend fun deriveAccountId(reason: String = FSStrings.get(R.string.authorize_flagship)): Ed25519Sign {
        openSession(FSStrings.get(R.string.authorize_flagship), reason)
        return ServerKeys.deriveAccountId(loadOrCreateUmkSeed())
    }

    /** The stable AID Ed25519 PUBLIC key (hex). Biometric-gated. */
    suspend fun accountIdPubHex(reason: String = FSStrings.get(R.string.authorize_flagship)): String {
        openSession(FSStrings.get(R.string.authorize_flagship), reason)
        return HexUtil.encode(ServerKeys.deriveAccountIdPub(loadOrCreateUmkSeed()))
    }

    /** The visitor's id for ONE app (`deriveAppAccountId(UMK, serviceRef)`,
     *  docs/service-access-gating.md "Per-app identity"): the redeem / visit /
     *  knock / acceptance signer they present to that app, never the global
     *  AID. Biometric-gated. */
    suspend fun deriveAppAccountId(appRef: String, reason: String = FSStrings.get(R.string.authorize_flagship)): Ed25519Sign {
        openSession(FSStrings.get(R.string.authorize_flagship), reason)
        return ServerKeys.deriveAppAccountId(loadOrCreateUmkSeed(), appRef)
    }

    /** The per-app id's PUBLIC key (hex). Biometric-gated. */
    suspend fun appAccountIdPubHex(appRef: String, reason: String = FSStrings.get(R.string.authorize_flagship)): String {
        openSession(FSStrings.get(R.string.authorize_flagship), reason)
        return HexUtil.encode(ServerKeys.deriveAppAccountIdPub(loadOrCreateUmkSeed(), appRef))
    }

    /** The household AEAD key (32 bytes) that seals the {name, photo?} invite
     *  bundle — `HKDF(umk, "flagship/household-key/v1")` (via ServerKeys).
     *  Biometric-gated. */
    suspend fun deriveHouseholdKey(reason: String = FSStrings.get(R.string.authorize_flagship)): ByteArray {
        openSession(FSStrings.get(R.string.authorize_flagship), reason)
        return ServerKeys.deriveHouseholdKey(loadOrCreateUmkSeed())
    }

    /** The key that seals one server archive (`ServerArchive.deriveKey`):
     *  server-id independent, so any device of the account can back up a server
     *  or import a backup onto a server with a different name. Biometric-gated. */
    suspend fun deriveServerArchiveKey(archiveId: String, reason: String = FSStrings.get(R.string.authorize_flagship)): ByteArray {
        openSession(FSStrings.get(R.string.authorize_flagship), reason)
        return com.flagshipserver.app.core.ServerArchive.deriveKey(loadOrCreateUmkSeed(), archiveId)
            ?: throw IllegalStateException("server archive key")
    }

    /** [count] fresh archive ids with their account-slot keys, for a box's
     *  scheduled backups (docs/server-backup-and-clone.md, "Scheduled backups").
     *  Biometric-gated (the same session as the deposit's signature). */
    suspend fun mintServerArchiveKeys(count: Int, reason: String = FSStrings.get(R.string.authorize_flagship)): List<com.flagshipserver.app.core.ArchiveKey> {
        openSession(FSStrings.get(R.string.authorize_flagship), reason)
        return com.flagshipserver.app.core.ArchiveKeys.mint(loadOrCreateUmkSeed(), count)
    }

    /** True when signing a sensitive order now would show the biometric prompt
     *  (the session hasn't been opened yet); background work then waits for a tap. */
    fun sensitiveSigningNeedsPrompt(): Boolean {
        val authority = BiometricAuthority.current() ?: return false
        return !authority.isFresh() || (!PqSessionKek.isOpen() && anySealedSeed())
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

    // ---- Watch delegate key (opt-in quick-approve) ---------------------
    //
    // A per-device Ed25519 key for "approve a boot from the watch". Unlike
    // deriveIRK, this NEVER calls BiometricAuthority.ensureFresh() — so
    // signing a boot approval with it raises no biometric prompt, which is
    // the whole point. The IRK attests its pubkey at enrollment; the cloud +
    // boot worker honor its signature for boot approval ONLY. Stored in the
    // active profile's prefs like the push key (device-local, never synced).

    private fun watchDelegateSeedKey() = pkey("watch.delegate.seed")
    private fun watchDelegateGrantIdKey() = pkey("watch.delegate.grantId")

    /** Load (or mint + persist) the watch-delegate signing key. No biometric
     *  prompt — the seed lives in EncryptedSharedPreferences and is read
     *  whenever the app runs. */
    fun loadOrCreateWatchDelegateKey(): Ed25519Sign {
        val p = requirePrefs()
        val key = watchDelegateSeedKey()
        val seedHex = p.getString(key, null)
        val seed = if (seedHex != null) {
            HexUtil.decode(seedHex) ?: error("corrupt watch-delegate seed")
        } else {
            val s = ByteArray(32).also { SecureRandom().nextBytes(it) }
            p.edit().putString(key, HexUtil.encode(s)).apply()
            s
        }
        return Ed25519Sign(seed)
    }

    /** The watch-delegate pubkey hex if a key is enrolled on this device,
     *  else null (no key is minted by this read). */
    fun watchDelegatePubHex(): String? {
        val seedHex = requirePrefs().getString(watchDelegateSeedKey(), null) ?: return null
        val seed = HexUtil.decode(seedHex) ?: return null
        return HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
    }

    /** True when a delegate key is enrolled — the boot-approval signer reads
     *  this to choose the delegate (no prompt) vs the IRK path. */
    fun hasWatchDelegateKey(): Boolean =
        requirePrefs().getString(watchDelegateSeedKey(), null) != null

    fun watchDelegateGrantId(): String? =
        requirePrefs().getString(watchDelegateGrantIdKey(), null)

    fun setWatchDelegateGrantId(id: String?) {
        val e = requirePrefs().edit()
        val k = watchDelegateGrantIdKey()
        if (id == null) e.remove(k) else e.putString(k, id)
        e.apply()
    }

    /** Drop the delegate key + grantId from this device. Called on toggle-off,
     *  Replace device, and Wipe & restart. The server-side revoke (IRK-signed)
     *  + the cloud's IRK re-verify are the authority; this clears the local
     *  key so a stale device can't keep signing. */
    fun clearWatchDelegate() {
        requirePrefs().edit()
            .remove(watchDelegateSeedKey())
            .remove(watchDelegateGrantIdKey())
            .apply()
        // The boot-only key goes with the delegate it serves.
        KeystoreWatchBootKeys().clear()
    }

    private fun watchBootCopiesKey() = pkey("watch.boot.copies")

    /** Servers holding a copy of their disk key for this device's boot-only key, with each copy's end. */
    fun watchBootCopies(): Map<String, com.flagshipserver.app.core.WatchBootCopy> {
        val raw = requirePrefs().getString(watchBootCopiesKey(), null) ?: return emptyMap()
        return raw.split('\n').mapNotNull { line ->
            val parts = line.split(' ')
            if (parts.size < 2) return@mapNotNull null
            val ends = parts[1].toLongOrNull() ?: return@mapNotNull null
            parts[0] to com.flagshipserver.app.core.WatchBootCopy(ends)
        }.toMap()
    }

    fun setWatchBootCopy(serverDomain: String, copy: com.flagshipserver.app.core.WatchBootCopy?) {
        val next = watchBootCopies().toMutableMap()
        if (copy == null) next.remove(serverDomain) else next[serverDomain] = copy
        val e = requirePrefs().edit()
        if (next.isEmpty()) e.remove(watchBootCopiesKey())
        else e.putString(watchBootCopiesKey(), next.entries.joinToString("\n") { "${it.key} ${it.value.expiresAt}" })
        e.apply()
    }

    fun clearWatchBootCopies() {
        requirePrefs().edit().remove(watchBootCopiesKey()).apply()
    }

    private fun watchBootSoftKeyKey() = pkey("watch.boot.x25519")

    /** Android 10 and 11 only: the watch's X25519 start-up key, kept in these encrypted prefs
     *  (the same custody as the account seed) because Keystore holds X25519 only from Android 12. */
    fun watchBootSoftKey(): ByteArray? =
        requirePrefs().getString(watchBootSoftKeyKey(), null)?.let { HexUtil.decode(it) }?.takeIf { it.size == 32 }

    fun setWatchBootSoftKey(privateKey: ByteArray?) {
        val e = requirePrefs().edit()
        if (privateKey == null) e.remove(watchBootSoftKeyKey()) else e.putString(watchBootSoftKeyKey(), HexUtil.encode(privateKey))
        e.apply()
    }

    private fun serverKeyPinsKey() = pkey("server.key.pins")

    private fun serverKeyPins(): Map<String, String> =
        requirePrefs().getString(serverKeyPinsKey(), null)?.split('\n')?.mapNotNull { line ->
            val parts = line.split(' ')
            if (parts.size == 2) parts[0] to parts[1] else null
        }?.toMap().orEmpty()

    /** The server key this device pinned for [serverDomain] at its first blessing (ServerKeyPins). */
    fun serverKeyPin(serverDomain: String): String? = serverKeyPins()[serverDomain]

    fun setServerKeyPin(serverDomain: String, stkPubHex: String?) {
        val next = serverKeyPins().toMutableMap()
        if (stkPubHex == null) next.remove(serverDomain) else next[serverDomain] = stkPubHex
        val e = requirePrefs().edit()
        if (next.isEmpty()) e.remove(serverKeyPinsKey()) else e.putString(serverKeyPinsKey(), next.entries.joinToString("\n") { "${it.key} ${it.value}" })
        e.apply()
    }

    // ---- First contact (docs/first-contact.md) --------------------------
    //
    // Per-server records kept in these encrypted preferences (a Keystore-wrapped key; the app
    // opts out of backup): the enrollment secret and Studio confirm key of a server this device
    // created, and signed app-name grants waiting for their box. One line per server,
    // "<domain> <value>", where a value never holds a space or a newline.

    private fun deviceLocalLines(name: String): Map<String, String> =
        requirePrefs().getString(pkey(name), null)?.split('\n')?.mapNotNull { line ->
            val i = line.indexOf(' ')
            if (i > 0) line.substring(0, i) to line.substring(i + 1) else null
        }?.toMap().orEmpty()

    fun deviceLocalValue(name: String, serverDomain: String): String? = deviceLocalLines(name)[serverDomain.lowercase()]

    /** Every per-server record kept under [name]. */
    fun deviceLocalAll(name: String): Map<String, String> = deviceLocalLines(name)

    /** The servers this device pinned a key for (ServerKeyPins). */
    fun serverKeyPinDomains(): List<String> = serverKeyPins().keys.sorted()

    fun setDeviceLocalValue(name: String, serverDomain: String, value: String?) {
        require(value == null || (' ' !in value && '\n' !in value)) { "value" }
        val next = deviceLocalLines(name).toMutableMap()
        if (value == null) next.remove(serverDomain.lowercase()) else next[serverDomain.lowercase()] = value
        val e = requirePrefs().edit()
        if (next.isEmpty()) e.remove(pkey(name)) else e.putString(pkey(name), next.entries.joinToString("\n") { "${it.key} ${it.value}" })
        e.apply()
    }

    // ---- Admin master root (Slice D device-admin tier) -----------------
    //
    // The AUTHORITY root (docs/device-admin-tier-spec.md §1). A FRESH RANDOM
    // Ed25519 keypair minted at ACCOUNT CREATION on the first device — NOT
    // UMK-derived, so a UMK backup / any membership device can't recompute it
    // (that is the whole membership-vs-authority split). Held ONLY by admin
    // devices, sealed device-local in EncryptedSharedPreferences and NEVER
    // synced — the same device-local custody as the watch-delegate + ACME keys
    // (contrast the iCloud-synced membership account key on iOS; on Android
    // EncryptedSharedPreferences is inherently device-local). The first device
    // holds the root ⇒ it is a bare-master-root admin by default.
    //
    // Signs SENSITIVE/destructive orders (§2) via [adminSigningKey]. Escrowed
    // under the recovery credential (D-3, CloudRecoveryEnrollment) so credential
    // recovery can later re-establish it. Read of the SIGNING key is biometric-
    // gated (like deriveIRK) — signing a destructive order is never silent; the
    // pub read + raw-seed read (for the escrow upload) are NOT gated, mirroring
    // acmeAccountKeyScalar / the push key.

    private fun adminRootSeedKey() = pkey(SeedVault.ADMIN_ROOT)
    /** The admin root's public half (not secret), so showing it or checking this device is an
     *  admin needs no unlock (iOS keeps `adminRootPub` the same way). */
    private fun adminRootPubKey() = pkey("admin.root.pub")

    private fun storeAdminRoot(seed: ByteArray): String {
        val pub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        requirePrefs().edit().putString(adminRootPubKey(), pub).commit()
        writeSeed(adminRootSeedKey(), seed)
        return pub
    }

    /** After a migration sealed the admin root of the profile with [profileSuffix] ("" or
     *  ".<profile>"), record its public half if an older build never did. */
    private fun rememberAdminRootPub(profileSuffix: String) {
        val p = prefs ?: return
        val pubKey = "admin.root.pub$profileSuffix"
        if (p.getString(pubKey, null) != null) return
        val kek = PqSessionKek.current() ?: return
        try {
            val r = SeedVault.read(p, SeedVault.ADMIN_ROOT + profileSuffix, kek)
            val seed = (r as? SeedVault.Read.Opened)?.bytes ?: (r as? SeedVault.Read.Legacy)?.bytes ?: return
            if (seed.size == 32) p.edit().putString(pubKey, HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)).commit()
        } finally {
            kek.fill(0)
        }
    }

    /** Mint + persist a fresh random admin master root for the active profile
     *  (first-device-at-account-creation). Idempotent: an existing root is
     *  never clobbered. Returns the admin-root PUBLIC key hex. */
    fun generateAdminRoot(): String {
        if (hasAdminRoot()) {
            adminRootPubHex()?.let { return it }
            readSeed(adminRootSeedKey())?.let { return storeAdminRoot(it) }
        }
        val seed = ByteArray(32).also(rng::nextBytes)
        return storeAdminRoot(seed)
    }

    /** True when this device holds the admin master root (⇒ this device is a
     *  bare-root master admin). The signing gate [adminSigningKey] reads this
     *  to choose admin-root vs the legacy owner-IRK fallback. Needs no unlock. */
    fun hasAdminRoot(): Boolean = SeedVault.has(requirePrefs(), adminRootSeedKey())

    /** The admin-root PUBLIC key hex if held on this device, else null (no
     *  mint, no unlock). Published to `.com` at account creation + pinned into the recipe
     *  AuthCode so fresh boxes anchor it. */
    fun adminRootPubHex(): String? {
        if (!hasAdminRoot()) return null
        requirePrefs().getString(adminRootPubKey(), null)?.let { return it }
        // An older build kept no public half: derive it when the seed can be read now.
        val seed = runCatching { readSeed(adminRootSeedKey()) }.getOrNull() ?: return null
        val pub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        requirePrefs().edit().putString(adminRootPubKey(), pub).apply()
        return pub
    }

    /** Biometric-gated admin-root SIGNER (like deriveIRK). Errors when absent —
     *  callers gate on [hasAdminRoot] first (or use [adminSigningKey]). */
    suspend fun adminRootKey(reason: String = FSStrings.get(R.string.authorize_a_sensitive_change)): Ed25519Sign {
        openSession(FSStrings.get(R.string.authorize_flagship), reason)
        val seed = readSeed(adminRootSeedKey()) ?: error("no admin root on this device")
        return Ed25519Sign(seed)
    }

    /** The admin-root signer behind a biometric prompt that runs every time,
     *  even in an unlocked session: for consent given per act (each debug
     *  access grant). Errors when this device holds no admin root. */
    suspend fun adminRootKeyConfirmed(reason: String): Ed25519Sign {
        BiometricAuthority.confirmNow(reason)
        val seed = adminRootSeed() ?: error("no admin root on this device")
        return Ed25519Sign(seed)
    }

    /** Raw read of the 32-byte admin-root seed (no mint, no prompt) — for
     *  the recovery-credential escrow upload (D-3) and work riding an unlocked
     *  session. Null when absent, so a missing root never forces one into
     *  existence; throws [SessionLockedException] while the session is locked. */
    fun adminRootSeed(): ByteArray? = readSeed(adminRootSeedKey())

    /** Install a recovered admin-root seed into the active profile — credential
     *  recovery re-establishing admin from the escrowed root. */
    fun importAdminRoot(seed: ByteArray) {
        require(seed.size == 32) { "admin root seed must be 32 bytes" }
        storeAdminRoot(seed)
    }

    /** Drop the active profile's admin root (the gym plays a non-admin device). */
    fun forgetAdminRoot() {
        val e = requirePrefs().edit()
        SeedVault.remove(e, adminRootSeedKey())
        e.remove(adminRootPubKey())
        e.commit()
    }

    /**
     * The Slice D signing GATE (§8.3, task step 4): resolve the key to sign a
     * SENSITIVE order with. If THIS account holds an admin master root on THIS
     * device, sign with it; ELSE fall back to the owner IRK (legacy, pre-wipe
     * accounts that never minted a root). Only the signing KEY changes — the
     * order's canonical bytes are byte-identical, and the box/.com resolve the
     * signer by trial (`adminAuthorityLocal` / `adminAuthorityGate`), so a
     * bare-root admin's order verifies against the pinned admin root while a
     * legacy account's still verifies against the IRK. Biometric-gated either
     * way (one prompt, within the freshness window).
     */
    suspend fun adminSigningKey(reason: String = FSStrings.get(R.string.authorize_a_sensitive_change)): Ed25519Sign =
        if (hasAdminRoot()) adminRootKey(reason) else deriveIRK(reason)

    // ---- ACME account key (#28, per-user-cert) -------------------------
    //
    // The ECDSA P-256 (ES256) account key that authorizes minting this
    // user's TLS certs. Admin-held + independent of the UMK, so it is
    // stored as a raw EXPORTABLE 32-byte scalar (hex) in EncryptedShared-
    // Preferences — NOT an AndroidKeyStore key, which couldn't be escrowed.
    // No biometric gate on read (mirrors the push + watch-delegate keys):
    // the escrow path needs the raw bytes whenever the app runs. The
    // recovery envelope carries the wrapped form (see AcmeAccountKey).

    private fun acmeAccountKeyScalarKey() = pkey(KEY_ACME_ACCOUNT_SCALAR)

    /** Load (or mint + persist) the ACME account-key scalar for the active
     *  profile. First call generates a fresh P-256 scalar via
     *  AcmeAccountKey.generateScalar(). */
    fun loadOrCreateAcmeAccountKeyScalar(): ByteArray {
        val p = requirePrefs()
        val key = acmeAccountKeyScalarKey()
        p.getString(key, null)?.let { hex ->
            HexUtil.decode(hex)?.let { return it }
        }
        val scalar = com.flagshipserver.app.core.AcmeAccountKey.generateScalar()
        p.edit().putString(key, HexUtil.encode(scalar)).apply()
        return scalar
    }

    /** Raw read of the ACME account-key scalar (no mint). Returns null when
     *  absent. Used by the escrow-upload path so a missing key never forces
     *  one into existence. */
    fun acmeAccountKeyScalar(): ByteArray? {
        val hex = requirePrefs().getString(acmeAccountKeyScalarKey(), null) ?: return null
        return HexUtil.decode(hex)
    }

    /** Install a recovered ACME account-key scalar into the active profile.
     *  Used by the recovery-restore path after unwrapping the escrowed key
     *  from the fetched envelope. */
    fun importAcmeAccountKeyScalar(scalar: ByteArray) {
        require(scalar.size == 32) { "ACME account key scalar must be 32 bytes" }
        requirePrefs().edit().putString(acmeAccountKeyScalarKey(), HexUtil.encode(scalar)).apply()
    }

    /** True when an ACME account key is held on this device (active profile). */
    fun hasAcmeAccountKey(): Boolean =
        requirePrefs().getString(acmeAccountKeyScalarKey(), null) != null

    /** Drop the ACME account-key scalar from the active profile. */
    fun clearAcmeAccountKey() {
        requirePrefs().edit().remove(acmeAccountKeyScalarKey()).apply()
    }

    /** Last-registered push tokenId; null if no current registration. */
    // ---- Account read tokens (docs/account-read-token.md) ---------------
    //
    // Per profile and account, device-local, never biometric-gated: a token
    // only reads the account's server list, so a poll can use it silently.

    private const val KEY_READ_TOKEN = "account.read.token"

    private fun readTokenKey(username: String) = "${pkey(KEY_READ_TOKEN)}.u.${username.lowercase()}"

    fun accountReadToken(username: String): String? =
        requirePrefs().getString(readTokenKey(username), null)

    fun setAccountReadToken(username: String, value: String?) {
        val editor = requirePrefs().edit()
        if (value == null) editor.remove(readTokenKey(username)) else editor.putString(readTokenKey(username), value)
        editor.apply()
    }

    /** Drop every read token of the active profile. */
    fun clearAccountReadTokens() {
        val p = requirePrefs()
        val prefix = "${pkey(KEY_READ_TOKEN)}.u."
        val editor = p.edit()
        for (key in p.all.keys) if (key.startsWith(prefix)) editor.remove(key)
        editor.apply()
    }

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
        SeedVault.remove(editor, pkey(KEY_UMK_SEED))
        editor.remove(pkey(KEY_IRK_SEED))
        editor.remove(pkey(KEY_PUSH_X25519_PRIV))
        editor.remove(pkey(KEY_PUSH_TOKEN_ID))
        editor.remove(pkey(KEY_IRK_VERSION))
        editor.remove(pkey(KEY_IRK_PENDING_VERSION))
        editor.remove(watchDelegateSeedKey())
        editor.remove(watchDelegateGrantIdKey())
        editor.remove(watchBootCopiesKey())
        editor.remove(serverKeyPinsKey())
        runCatching { KeystoreWatchBootKeys().clear() }
        editor.remove(acmeAccountKeyScalarKey())
        // Slice D — drop the admin master root so a removed device retains NO
        // administrative authority (the security invariant: authority is
        // device-local + revoked with the device).
        SeedVault.remove(editor, adminRootSeedKey())
        editor.remove(adminRootPubKey())
        val readTokenPrefix = "${pkey(KEY_READ_TOKEN)}.u."
        // This profile's kept account device key ("account.device.seed.<id>[.<profile>]").
        val deviceSeed = Regex("^account\\.device\\.seed\\.[0-9a-f]{32}" + (activeProfileId?.let { Regex.escape(".$it") } ?: "") + "$")
        for (key in p.all.keys) {
            if (key.startsWith(readTokenPrefix) || deviceSeed.matches(key)) editor.remove(key)
        }
        // Per-version IRK caches (C7) — sweep every "<irk.seed key>.vN"
        // entry the rotation primitive might have written FOR THE ACTIVE
        // PROFILE. Other profiles' caches survive.
        sweepIrkCaches(p, editor)
        editor.commit()
        dropActiveIrkSeeds()
        SeedVault.markLost(false)
        wipePq(activeProfileId ?: "-")
    }

    /**
     * Architecture v2: the PQ halves of a profile's identities (wrapped ML-DSA seeds) and the
     * assurance policy this phone held for it go with its account keys. `null` = every profile.
     */
    fun wipePq(profile: String?) {
        for (pp in pqPrefs) {
            val e = pp.edit()
            for (key in pp.all.keys) {
                val mine = profile == null || key.startsWith("pq.mldsa.v1.$profile.") || key.startsWith("assurance.v1.$profile|")
                if (mine) e.remove(key)
            }
            e.apply()
        }
        // The session KEK only opens seeds; with every profile gone it goes too.
        if (profile == null) {
            for (pp in pqPrefs) pp.edit().remove("pq.kek.v2").apply()
            PqSessionKek.clear()
        }
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
            KEY_ACME_ACCOUNT_SCALAR, SeedVault.ADMIN_ROOT, KEY_READ_TOKEN, KEY_IRK_PUB, "admin.root.pub", "account.device.seed",
            SeedVault.sealedKey(KEY_UMK_SEED), SeedVault.sealedKey(SeedVault.ADMIN_ROOT),
        )
        for (key in p.all.keys) {
            if (key == KEY_ACTIVE_PROFILE) { editor.remove(key); continue }
            if (bases.any { key == it || key.startsWith("$it.") }) editor.remove(key)
        }
        editor.commit()
        activeProfileId = null
        sessionClosed()
        SeedVault.markLost(false)
        wipePq(null)
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
