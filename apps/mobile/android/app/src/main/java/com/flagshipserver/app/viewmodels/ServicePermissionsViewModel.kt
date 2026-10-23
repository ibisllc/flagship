// The data behind an app's "Access & permissions" section. A box without the page shows nothing.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.PermissionRevokeResult
import com.flagshipserver.app.core.PermissionWords
import com.flagshipserver.app.core.ServicePermissions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class ServicePermissionsViewModel(
    private val serviceId: String,
    private val client: ScreensClient,
) {
    private val _permissions = MutableStateFlow<ServicePermissions?>(null)
    val permissions: StateFlow<ServicePermissions?> = _permissions.asStateFlow()
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    suspend fun load() {
        _permissions.value = try {
            client.servicePermissions(serviceId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            null
        }
    }

    /** Ends one grant, or all of this app's grants when [grantId] is null. */
    suspend fun revoke(grantId: String?) {
        _busy.value = true
        try {
            val r: PermissionRevokeResult = client.revokeServicePermission(serviceId, grantId)
            _notice.value = PermissionWords.outcome(r)
            _error.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _error.value = e.userFacing()
        } finally {
            _busy.value = false
        }
        load()
    }
}
