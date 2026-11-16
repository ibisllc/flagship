// "Secure your account" — the SKIPPABLE backup nudge shown once, right
// after a brand-new account is opened (create path only; the recovery /
// "Connect to an existing account" path never sees this). Cloud (passkey)
// backup and a backup file are two INDEPENDENT ticks, both off at first:
// the person ticks either, both, or skips behind a warning. Cloud can't be
// ticked when the device can't make a passkey; file + skip still work.
//
// This VM holds ONLY the two ticks + skip-confirm state. The actual cloud
// ceremony reuses PasskeyRecoveryManager + Recovery + BlockStoreUmkStore
// (exactly as RecoveryScreen does) and the file option reuses the
// existing KeyfileExportScreen — neither is rebuilt here.
//
// Copy is approved + verbatim; mirror it on the other surfaces.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The two backup methods offered on the step. */
enum class SecureAccountOption { Cloud, File }

class SecureAccountViewModel(
    /** Whether this device can register a PRF passkey for cloud backup.
     *  Injected so tests can pin both branches; the screen computes the
     *  real value from the platform (see [PasskeyAvailability]). */
    val passkeyAvailable: Boolean,
) : ViewModel() {

    // Both start unticked: Continue waits for a choice, Skip is the way out.
    private val _cloudSelected = MutableStateFlow(false)
    val cloudSelected: StateFlow<Boolean> = _cloudSelected.asStateFlow()

    private val _fileSelected = MutableStateFlow(false)
    val fileSelected: StateFlow<Boolean> = _fileSelected.asStateFlow()

    /** Tick or untick one option; cloud can't be ticked without passkeys. */
    fun toggle(option: SecureAccountOption) {
        when (option) {
            SecureAccountOption.Cloud -> if (passkeyAvailable) _cloudSelected.value = !_cloudSelected.value
            SecureAccountOption.File -> _fileSelected.value = !_fileSelected.value
        }
    }

    // Drives the "Skip for now" confirmation dialog.
    private val _showSkipConfirm = MutableStateFlow(false)
    val showSkipConfirm: StateFlow<Boolean> = _showSkipConfirm.asStateFlow()

    fun requestSkip() { _showSkipConfirm.value = true }
    fun cancelSkip() { _showSkipConfirm.value = false }

    /** Continue runs every ticked backup, so it needs at least one. */
    val canContinue: Boolean
        get() = _cloudSelected.value || _fileSelected.value

    companion object {
        /** Copy — kept here so tests can assert it and the other
         *  surfaces can mirror it verbatim. */
        val TITLE get() = FSStrings.get(R.string.secure_your_account)
        val BODY get() =
            FSStrings.get(R.string.back_up_your_account_now_so)

        val CLOUD_LABEL get() = FSStrings.get(R.string.back_up_with_your_passkey)
        val CLOUD_SUBLABEL get() =
            FSStrings.get(R.string.recover_with_your_google_passkey_or)
        val CLOUD_UNAVAILABLE_HINT get() =
            FSStrings.get(R.string.passkeys_arent_available_on_this_device)

        val FILE_LABEL get() = FSStrings.get(R.string.save_a_backup_file)
        val FILE_SUBLABEL get() = FSStrings.get(R.string.an_encrypted_flagshipkey_you_keep_yourself)

        val CONTINUE get() = FSStrings.get(R.string.continue_label)
        val SKIP get() = FSStrings.get(R.string.skip_for_now)

        val SKIP_WARNING get() =
            FSStrings.get(R.string.without_a_backup_losing_this_device)
        val SKIP_CONFIRM get() = FSStrings.get(R.string.skip_anyway)
        val SKIP_BACK get() = FSStrings.get(R.string.back)
    }
}
