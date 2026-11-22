// The Plan page's warning before Pro ends while apps keep a separate access list on each server
// (docs/service-access-gating.md "Separate lists per server (Pro)"). It asks the current server, so it stays
// quietly empty with no server paired or reachable.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.AppListScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class SeparateListsWarningViewModel(
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    /** A server's display name by its fqdn. */
    private val serverName: (String) -> String = AppListScope::firstLabel,
) {
    /** Null when there's nothing to warn about or no server can say. */
    private val _warning = MutableStateFlow<String?>(null)
    val warning: StateFlow<String?> = _warning.asStateFlow()

    fun load() = scope.launch {
        val summary = try {
            client.accessListsSummary()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        _warning.value = summary?.let {
            AppListScope.separateListsWarning(it.plan, it.separateApps, it.leaders, serverName)
        }
    }
}
