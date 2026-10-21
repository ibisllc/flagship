// "Secure your account" — the SKIPPABLE backup nudge shown once, right
// after a brand-new account is opened (create path only; the recovery /
// "Connect to an existing account" path never sees this). It pre-selects the
// cloud (passkey) option when the device can do it, falls back to a
// file-only / skip state when it can't, and never blocks the user from
// reaching the app.
//
// This VM holds ONLY selection + skip-confirm state. The actual cloud
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

    // Cloud is PRE-SELECTED by default when it's available; when it
    // isn't, nothing is pre-selected (the step still works via file or
    // skip). The cloud option is rendered disabled in that case.
    private val _selected = MutableStateFlow(
        if (passkeyAvailable) SecureAccountOption.Cloud else null,
    )
    val selected: StateFlow<SecureAccountOption?> = _selected.asStateFlow()

    fun select(option: SecureAccountOption) {
        // The cloud option can't be selected when passkeys are
        // unavailable on this device.
        if (option == SecureAccountOption.Cloud && !passkeyAvailable) return
        _selected.value = option
    }

    // Drives the "Skip for now" confirmation dialog.
    private val _showSkipConfirm = MutableStateFlow(false)
    val showSkipConfirm: StateFlow<Boolean> = _showSkipConfirm.asStateFlow()

    fun requestSkip() { _showSkipConfirm.value = true }
    fun cancelSkip() { _showSkipConfirm.value = false }

    /** Continue is meaningful only with a selection. */
    val canContinue: Boolean
        get() = _selected.value != null

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

        const val CONTINUE = "Continue"
        val SKIP get() = FSStrings.get(R.string.skip_for_now)

        val SKIP_WARNING get() =
            FSStrings.get(R.string.without_a_backup_losing_this_device)
        val SKIP_CONFIRM get() = FSStrings.get(R.string.skip_anyway)
        const val SKIP_BACK = "Back"
    }
}
