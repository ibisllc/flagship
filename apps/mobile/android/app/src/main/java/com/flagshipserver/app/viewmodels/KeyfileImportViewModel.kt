// "Import backup file" — bring this device into an account using its
// `.flagshipkey` backup. Mirror of the iOS KeyfileImportViewModel; the
// flow swaps the WebAuthn-PRF unwrap of the credentialed takeover for a
// passphrase-decrypt of the keyfile:
//
//   1. The host hands us the picked file's text + the user's passphrase.
//   2. Keyfile.unwrap decrypts the UMK seed (argon2id + AES-256-GCM).
//   3. Find the key the account holds now (IrkLineage: any client's
//      derivation, any version) and initiate the takeover re-pair on the
//      seed in memory.
//   4. Once `.com` accepted, point the Keystore at this account's slot +
//      installUmk; complete the re-pair once the grace elapses. On
//      Completed the host flips AppState to paired (mirrors LoginViewModel).
//
// Errors map to the approved copy: wrong passphrase → "That passphrase
// didn't open the file."; not a keyfile → "This isn't a Flagship key
// file."

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.UserErrorText
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.RePairCompleteRequest
import com.flagshipserver.app.api.RePairInitiateRequest
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.RateLimitedException
import com.flagshipserver.app.core.RePairCompleteClaim
import com.flagshipserver.app.core.RePairInitiateClaim
import com.flagshipserver.app.keystore.IrkLineage
import com.flagshipserver.app.keystore.Keyfile
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface KeyfileImportPhase {
    data object Idle : KeyfileImportPhase
    data object Working : KeyfileImportPhase
    /** Re-pair initiated — the takeover grace is running server-side. */
    data class Grace(val username: String, val completesAt: Long) : KeyfileImportPhase
    /** Re-pair complete — the account is open as a fresh `admin` device. */
    data class Opened(val username: String) : KeyfileImportPhase
    data class Failed(val message: String) : KeyfileImportPhase
}

class KeyfileImportViewModel(
    private val server: FlagshipServerClient,
    private val app: AppState,
    /** Wall-clock injectable for deterministic canonical-bytes tests. */
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    private val _phase = MutableStateFlow<KeyfileImportPhase>(KeyfileImportPhase.Idle)
    val phase: StateFlow<KeyfileImportPhase> = _phase.asStateFlow()

    private val _passphrase = MutableStateFlow("")
    val passphrase: StateFlow<String> = _passphrase.asStateFlow()
    fun setPassphrase(v: String) { _passphrase.value = v }

    val canImport: Boolean
        get() = _passphrase.value.isNotEmpty()

    /**
     * Unwrap the keyfile, install the UMK, and initiate the takeover
     * re-pair. [fileText] is the raw `.flagshipkey` contents the host
     * read from the picked file.
     */
    suspend fun importBackup(fileText: String) {
        if (!canImport) {
            _phase.value = KeyfileImportPhase.Failed(FSStrings.get(R.string.enter_the_passphrase_for_this_backup))
            return
        }
        _phase.value = KeyfileImportPhase.Working

        // 1 — Decrypt the keyfile.
        val seed: ByteArray
        val username: String
        try {
            val (s, meta) = Keyfile.unwrap(fileText, _passphrase.value)
            seed = s
            username = meta.username
        } catch (e: Keyfile.KeyfileException) {
            _phase.value = KeyfileImportPhase.Failed(humanizedKeyfileError(e))
            return
        } catch (_: Throwable) {
            _phase.value = KeyfileImportPhase.Failed(FSStrings.get(R.string.this_isnt_a_flagship_key_file))
            return
        }

        // 2 — Which key does the account hold now? An account made on the
        //     webapp or iOS (or re-paired anywhere) does not hold this app's
        //     v1, so `.com` would refuse "oldIrkPub does not match the
        //     current registered IRK". Only keys derived from the file's own
        //     seed are tried; no match means the file isn't this account's
        //     current key, and nothing is sent or installed.
        // The unlock prompt first, as before: the key is sealed under the
        // session it opens when it is installed below.
        try {
            Keystore.ensureUnlocked(FSStrings.get(R.string.bring_this_device_into_your_flagship))
        } catch (t: Throwable) {
            _phase.value = KeyfileImportPhase.Failed(FSStrings.get(R.string.couldnt_start_bringing_this_device_in, UserErrorText.of(t)))
            return
        }
        val registered: IrkLineage.Key
        try {
            val pub = server.getUsernameRecord(username).irkPub
            registered = IrkLineage.findRegistered(seed, pub) ?: run {
                _phase.value = KeyfileImportPhase.Failed(FSStrings.get(R.string.keyfile_import_key_mismatch, username))
                return
            }
        } catch (t: Throwable) {
            _phase.value = KeyfileImportPhase.Failed(
                if (t is HttpException && t.status == 404) FSStrings.get(R.string.keyfile_import_no_such_account, username)
                else RateLimitedException.messageOf(t) ?: FSStrings.get(R.string.keyfile_import_unreachable),
            )
            return
        }

        try {
            // 3 — Initiate the takeover re-pair on the seed in memory: the
            //     NEW key is this app's scheme one version past the
            //     registered one, the OLD (registered) key signs the same
            //     bytes as the credential. The key is installed only once
            //     `.com` accepted, so a refusal leaves this device as it was.
            //     A keyfile import is single-device proof, so no totpProof.
            val newVersion = IrkLineage.nextVersion(registered)
            val newKey = IrkLineage.key(seed, IrkLineage.OWN, newVersion)
            val newSign = newKey.signer()
            val oldSign = registered.signer()
            val oldPubHex = registered.pubHex
            val newPubHex = newKey.pubHex

            val issuedAt = now()
            val canonical = RePairInitiateClaim.canonicalBytes(
                username = username,
                newIrkPubHex = newPubHex,
                oldIrkPubHex = oldPubHex,
                issuedAt = issuedAt,
            )
            val signature = HexUtil.encode(newSign.sign(canonical))
            // The CREDENTIAL: a second signature over the SAME bytes by
            // the OLD (currently registered) IRK. The key file gave us
            // the seed, so we can derive that key and prove account
            // ownership — which is what .com requires, since `signature`
            // above is made by the key we're asking it to install and
            // `oldIrkPub` is public.
            val oldSignature = HexUtil.encode(oldSign.sign(canonical))

            val resp = server.initiateRePair(
                username = username,
                body = RePairInitiateRequest(
                    request = RePairInitiateRequest.Inner(
                        username = username,
                        newIrkPub = newPubHex,
                        oldIrkPub = oldPubHex,
                        issuedAt = issuedAt,
                    ),
                    signature = signature,
                    totpProof = null,
                    oldIrkSignature = oldSignature,
                ),
                ifMatch = null,
            )
            // 4 — Accepted: install into the recovered cloud's per-profile
            //     slot (an imported second cloud never clobbers another
            //     profile) and stage the rotation the completion finalizes.
            Keystore.setActiveProfile(username)
            Keystore.installUmk(seed)
            Keystore.setPendingIrkRotationVersion(newVersion)
            _phase.value = KeyfileImportPhase.Grace(username = username, completesAt = resp.completesAt)
        } catch (t: Throwable) {
            _phase.value = KeyfileImportPhase.Failed(
                RateLimitedException.messageOf(t) ?: if (t is HttpException && t.status == 401 && t.body.contains("totpProof"))
                    // #52 — the account has a second factor enrolled, which
                    // the Worker now requires at initiate even for single-
                    // device accounts. The keyfile sheet has no second-
                    // factor field (yet); route via the sign-in flow.
                    FSStrings.get(R.string.this_account_has_a_second_factor)
                else if (t is HttpException)
                    FSStrings.get(R.string.keyfile_import_refused, username)
                else
                    FSStrings.get(R.string.couldnt_start_bringing_this_device_in, UserErrorText.of(t)),
            )
        }
    }

    /**
     * Finalize the takeover once its grace has elapsed. The complete
     * endpoint is a public, idempotent CAS-swap. On success we activate
     * the staged IRK rotation locally, open the account as the imported
     * user, leaving the device unnamed.
     */
    suspend fun completeImport() {
        val grace = _phase.value as? KeyfileImportPhase.Grace ?: return
        _phase.value = KeyfileImportPhase.Working
        try {
            // Signed by the PENDING version — the key the swap installs.
            // `.com` refuses an unsigned finalization.
            val version = Keystore.pendingIrkRotationVersion() ?: Keystore.currentIrkVersion()
            val newSign = Keystore.deriveIRK(FSStrings.get(R.string.finish_bringing_this_device_in), version)
            val newPubHex = pubHexForVersion(version)
            val issuedAt = now()
            val completeSig = newSign.sign(
                RePairCompleteClaim.canonicalBytes(
                    username = grace.username,
                    newIrkPubHex = newPubHex,
                    issuedAt = issuedAt,
                ),
            )
            server.completeRePair(
                grace.username,
                RePairCompleteRequest(
                    request = RePairCompleteRequest.Inner(
                        username = grace.username,
                        newIrkPub = newPubHex,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(completeSig),
                ),
            )
            Keystore.pendingIrkRotationVersion()?.let { pending ->
                Keystore.setCurrentIrkVersion(pending)
                Keystore.setPendingIrkRotationVersion(null)
            }
            // Left unnamed: administrator status is a capability in the
            // device's signed grant, never a locally invented display name.
            app.completeOnboarding(username = grace.username, pods = emptyList())
            _phase.value = KeyfileImportPhase.Opened(grace.username)
        } catch (t: Throwable) {
            _phase.value = KeyfileImportPhase.Failed(
                if (t is HttpException && t.status == 410)
                    // #52 — completion window elapsed; the cloud swept the row.
                    FSStrings.get(R.string.this_expired_before_it_was_completed)
                else
                    FSStrings.get(R.string.couldnt_finish_bringing_this_device_in, UserErrorText.of(t)),
            )
        }
    }

    fun reset() {
        _phase.value = KeyfileImportPhase.Idle
    }

    private fun pubHexForVersion(version: Int): String {
        val seed = Keystore.requireIrkSeedForVersion(version)
        val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        return HexUtil.encode(pair.publicKey)
    }

    private fun humanizedKeyfileError(e: Keyfile.KeyfileException): String = when (e.code) {
        Keyfile.KeyfileException.Code.BAD_PASSPHRASE -> FSStrings.get(R.string.that_passphrase_didnt_open_the_file)
        Keyfile.KeyfileException.Code.MALFORMED -> FSStrings.get(R.string.this_isnt_a_flagship_key_file)
        Keyfile.KeyfileException.Code.VERSION ->
            FSStrings.get(R.string.this_backup_was_made_by_a)
    }
}
