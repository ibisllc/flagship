// Mirror of FlagshipUI.ViewModels.SettingsViewModel's trusted-devices
// slice on iOS — extracted into its own ViewModel on Android because
// the Material 3 idiom is a separate screen (NavHost destination)
// rather than an in-Settings section.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.TrustedDevice
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class TrustedDevicesViewModel(
    private val server: FlagshipServerClient,
    private val username: () -> String?,
) : ViewModel() {

    sealed interface State {
        data object Idle : State
        data object Loading : State
        data class Loaded(val devices: List<TrustedDevice>) : State
        data class Failed(val reason: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    /** Most recent ETag the Worker returned. Held so the host can
     *  attach it as If-Match on Disconnect / Replace, fencing the
     *  device-list-changed-mid-action race (Worker A3). */
    private val _etag = MutableStateFlow<String?>(null)
    val etag: StateFlow<String?> = _etag.asStateFlow()

    fun load() {
        viewModelScope.launch {
            val user = username()
            if (user.isNullOrEmpty()) {
                _state.value = State.Loaded(emptyList())
                _etag.value = null
                return@launch
            }
            _state.value = State.Loading
            try {
                val resp = server.listDevices(user)
                _state.value = State.Loaded(resp.devices)
                _etag.value = resp.etag
            } catch (t: Throwable) {
                _state.value = State.Failed(t.message ?: "Couldn't load trusted devices")
            }
        }
    }

    /**
     * **Disconnect** — soft revoke (push token only). Removes the row
     * at .com so the device stops getting alerts; the device's UMK in
     * its hardware-protected store is unchanged. Optimistic removal +
     * revert on failure for a responsive UI on flaky networks.
     *
     * Returns `true` on success so the screen can show a snackbar.
     */
    suspend fun disconnect(device: TrustedDevice): Boolean {
        val before = _state.value
        if (before !is State.Loaded) return false
        // Optimistic.
        _state.value = State.Loaded(before.devices.filter { it.tokenId != device.tokenId })
        return try {
            server.revokePushToken(device.tokenId)
            // Refresh to pick up the new ETag + reflect server truth.
            val user = username() ?: return true
            val refreshed = server.listDevices(user)
            _state.value = State.Loaded(refreshed.devices)
            _etag.value = refreshed.etag
            true
        } catch (_: Throwable) {
            _state.value = before
            false
        }
    }
}
