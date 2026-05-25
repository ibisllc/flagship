// "Secure your account" — the SKIPPABLE backup nudge shown once, right
// after a brand-new account is opened (create path only; the recovery /
// "I already have an account" path never sees this). It pre-selects the
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
        const val TITLE = "Secure your account"
        const val BODY =
            "Back up your account now so you can get back in if you lose " +
                "this device. No one — not even us — can recover it for you."

        const val CLOUD_LABEL = "Back up with your passkey"
        const val CLOUD_SUBLABEL =
            "Recover with your Google passkey or password manager."
        const val CLOUD_UNAVAILABLE_HINT =
            "Passkeys aren't available on this device — use a backup file."

        const val FILE_LABEL = "Save a backup file"
        const val FILE_SUBLABEL = "An encrypted .flagshipkey you keep yourself."

        const val CONTINUE = "Continue"
        const val SKIP = "Skip for now"

        const val SKIP_WARNING =
            "Without a backup, losing this device means losing your " +
                "account for good. You can set this up anytime in Settings."
        const val SKIP_CONFIRM = "Skip anyway"
        const val SKIP_BACK = "Back"
    }
}
