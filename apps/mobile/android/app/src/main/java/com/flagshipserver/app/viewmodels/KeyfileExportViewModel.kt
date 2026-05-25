// "Back up your account key" — reads the UMK out of the Keystore and
// wraps it into a passphrase-encrypted `.flagshipkey` file, byte-
// compatible with packages/protocol/src/keyfile.ts. Mirror of the iOS
// KeyfileExportViewModel.
//
// The view holds the three required acknowledgments + the passphrase;
// this VM only validates strength and runs the wrap. The produced file
// text is handed back so the host can save it via the Storage Access
// Framework / a share intent — we never write it anywhere on our own.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.keystore.Keyfile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface KeyfileExportPhase {
    data object Idle : KeyfileExportPhase
    data object Working : KeyfileExportPhase
    /** The keyfile text is ready; the host saves it (SAF / share). */
    data class Ready(val text: String) : KeyfileExportPhase
    data class Failed(val message: String) : KeyfileExportPhase
}

class KeyfileExportViewModel(
    val username: String,
    val accountId: String? = null,
    /** Seam so tests can supply the UMK without piercing the Keystore.
     *  Defaults to the real (active-profile) UMK seed read. */
    private val readUmkSeed: () -> ByteArray = { com.flagshipserver.app.keystore.Keystore.currentUmkSeed() },
    /** Injectable clock for deterministic createdAt in tests. */
    private val nowIso: () -> String = { Keyfile.nowIso() },
) : ViewModel() {

    private val _phase = MutableStateFlow<KeyfileExportPhase>(KeyfileExportPhase.Idle)
    val phase: StateFlow<KeyfileExportPhase> = _phase.asStateFlow()

    private val _passphrase = MutableStateFlow("")
    val passphrase: StateFlow<String> = _passphrase.asStateFlow()
    fun setPassphrase(v: String) { _passphrase.value = v }

    private val _confirm = MutableStateFlow("")
    val confirmPassphrase: StateFlow<String> = _confirm.asStateFlow()
    fun setConfirmPassphrase(v: String) { _confirm.value = v }

    // The three required acknowledgments. All must be true before
    // "Create backup file" enables.
    private val _ackControl = MutableStateFlow(false)
    val ackControl: StateFlow<Boolean> = _ackControl.asStateFlow()
    fun setAckControl(v: Boolean) { _ackControl.value = v }

    private val _ackOffline = MutableStateFlow(false)
    val ackOffline: StateFlow<Boolean> = _ackOffline.asStateFlow()
    fun setAckOffline(v: Boolean) { _ackOffline.value = v }

    private val _ackNoRecovery = MutableStateFlow(false)
    val ackNoRecovery: StateFlow<Boolean> = _ackNoRecovery.asStateFlow()
    fun setAckNoRecovery(v: Boolean) { _ackNoRecovery.value = v }

    val acknowledged: Boolean
        get() = _ackControl.value && _ackOffline.value && _ackNoRecovery.value

    val passphraseStrong: Boolean
        get() = isStrong(_passphrase.value)

    val passphrasesMatch: Boolean
        get() = _confirm.value.isNotEmpty() && _passphrase.value == _confirm.value

    /** The "Create backup file" CTA enables only when everything lines
     *  up: strong passphrase, confirmation matches, all three acks. */
    val canCreate: Boolean
        get() = passphraseStrong && passphrasesMatch && acknowledged

    /** Suggested filename for the save dialog: `<username>.flagshipkey`. */
    val suggestedFilename: String
        get() = (username.ifEmpty { "account" }) + ".flagshipkey"

    /** Read the UMK + wrap it. On success → Ready(text). */
    fun createBackup() {
        if (!canCreate) return
        _phase.value = KeyfileExportPhase.Working
        try {
            val seed = readUmkSeed()
            val meta = Keyfile.Meta(
                username = username,
                accountId = accountId,
                createdAt = nowIso(),
            )
            val text = Keyfile.wrap(umkSeed = seed, passphrase = _passphrase.value, meta = meta)
            _phase.value = KeyfileExportPhase.Ready(text)
        } catch (t: Throwable) {
            _phase.value = KeyfileExportPhase.Failed("Couldn't create the backup file: ${t.message}")
        }
    }

    fun reset() {
        _phase.value = KeyfileExportPhase.Idle
    }

    companion object {
        /** A simple, defensible strength rule. The keyfile floor is 8;
         *  we ask for more in the UI since this file is the keys to the
         *  whole account: >= 12 chars and at least 3 of 4 character
         *  classes (lower / upper / digit / symbol). Mirror of the iOS
         *  KeyfileExportViewModel.isStrong. */
        fun isStrong(s: String): Boolean {
            if (s.length < 12) return false
            val lower = s.any { it.isLowerCase() }
            val upper = s.any { it.isUpperCase() }
            val digit = s.any { it.isDigit() }
            val symbol = s.any { !it.isLetterOrDigit() && !it.isWhitespace() }
            val classes = listOf(lower, upper, digit, symbol).count { it }
            return classes >= 3
        }
    }
}
