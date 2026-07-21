// "Import backup file" — bring this device into an account using its
// `.flagshipkey` backup. Mirror of the iOS KeyfileImportViewModel; the
// flow swaps the WebAuthn-PRF unwrap of the credentialed takeover for a
// passphrase-decrypt of the keyfile:
//
//   1. The host hands us the picked file's text + the user's passphrase.
//   2. Keyfile.unwrap decrypts the UMK seed (argon2id + AES-256-GCM).
//   3. Point the Keystore at this account's per-profile slot + installUmk.
//   4. Initiate the takeover re-pair (new IRK derives from the installed
//      UMK), then complete it once the grace elapses. On Completed the
//      host flips AppState to paired (mirrors LoginViewModel).
//
// Errors map to the approved copy: wrong passphrase → "That passphrase
// didn't open the file."; not a keyfile → "This isn't a Flagship key
// file."

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.RePairInitiateRequest
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.RePairInitiateClaim
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
            _phase.value = KeyfileImportPhase.Failed("Enter the passphrase for this backup file.")
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
            _phase.value = KeyfileImportPhase.Failed("This isn't a Flagship key file.")
            return
        }

        try {
            // 2 — Point the Keystore at the recovered cloud's per-profile
            //     device-key slot BEFORE installing, so an imported second
            //     cloud lands in its own slot and never clobbers an
            //     already-present profile. installUmk resets the IRK
            //     lineage to v1 under the imported UMK.
            Keystore.setActiveProfile(username)
            Keystore.installUmk(seed)

            // 3 — Initiate the takeover re-pair. Derive OLD (v1) + NEW (v2)
            //     IRK from the just-installed UMK and sign with the NEW IRK,
            //     mirroring the LoginViewModel credentialed takeover. A
            //     keyfile import is single-device proof, so no totpProof.
            val oldVersion = Keystore.currentIrkVersion()
            val newVersion = oldVersion + 1
            val newSign = Keystore.deriveIRK("Bring this device into your Flagship account", newVersion)
            Keystore.deriveIRK("Confirm import", oldVersion)
            val oldPubHex = pubHexForVersion(oldVersion)
            val newPubHex = pubHexForVersion(newVersion)

            val issuedAt = now()
            val canonical = RePairInitiateClaim.canonicalBytes(
                username = username,
                newIrkPubHex = newPubHex,
                oldIrkPubHex = oldPubHex,
                issuedAt = issuedAt,
            )
            val signature = HexUtil.encode(newSign.sign(canonical))

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
                ),
                ifMatch = null,
            )
            Keystore.setPendingIrkRotationVersion(newVersion)
            _phase.value = KeyfileImportPhase.Grace(username = username, completesAt = resp.completesAt)
        } catch (t: Throwable) {
            _phase.value = KeyfileImportPhase.Failed(
                if (t is HttpException && t.status == 401 && t.body.contains("totpProof"))
                    // #52 — the account has a second factor enrolled, which
                    // the Worker now requires at initiate even for single-
                    // device accounts. The keyfile sheet has no second-
                    // factor field (yet); route via the sign-in flow.
                    "This account has a second factor enrolled. Use \"I already have an account\" to sign in — it will ask for your authenticator or recovery code."
                else
                    "Couldn't start bringing this device in: ${t.message}",
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
            server.completeRePair(grace.username)
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
                    "This expired before it was completed. Start again."
                else
                    "Couldn't finish bringing this device in: ${t.message}",
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
        Keyfile.KeyfileException.Code.BAD_PASSPHRASE -> "That passphrase didn't open the file."
        Keyfile.KeyfileException.Code.MALFORMED -> "This isn't a Flagship key file."
        Keyfile.KeyfileException.Code.VERSION ->
            "This backup was made by a newer version of Flagship. Update the app and try again."
    }
}
