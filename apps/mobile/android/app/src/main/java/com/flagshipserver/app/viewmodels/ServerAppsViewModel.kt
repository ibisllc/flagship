// A server's own apps on its page (docs/app-placement.md §3): name, address
// and status, each opening the app's page. An app being copied onto the
// server is listed greyed out with "Copying…" and its progress until it is
// installed; the page polls while any copy is underway.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppCopyRecord
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.AppStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class ServerAppsViewModel(private val client: ScreensClient) {
    data class Row(
        val serviceId: String,
        val name: String,
        val address: String,
        /** That server's state ("Running", "Deploying", … §6), "Copying… 40%"
         *  or a failed copy's reason. */
        val status: String,
        val copying: Boolean = false,
        val failed: Boolean = false,
        /** Only invited members may open it (a co-manager included). */
        val membersOnly: Boolean = false,
    ) {
        /** Only an installed app has a page to open. */
        val opens: Boolean get() = !copying && !failed
    }

    sealed interface Phase {
        data object Loading : Phase
        data class Loaded(val rows: List<Row>) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Loading)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    /** Copies seen underway on this visit, so one that then fails is shown. */
    private val seenUnderway = HashSet<String>()

    val underway: Boolean
        get() = (_phase.value as? Phase.Loaded)?.rows?.any { it.copying } == true

    suspend fun load() {
        val apps = try {
            client.appsList().apps
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            if (_phase.value !is Phase.Loaded) _phase.value = Phase.Failed(t.userFacing())
            return
        }
        // Best-effort: a box from before copies has no list (404).
        val copies = try {
            client.serviceCopies().copies
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            emptyList()
        }
        _phase.value = Phase.Loaded(rows(apps, copies, seenUnderway))
        copies.filter { it.underway }.forEach { seenUnderway.add(it.copyId) }
    }

    companion object {
        const val TITLE = "Apps"
        const val CREATE_HERE = "Create app here"
        const val EMPTY = "No apps on this server yet."

        fun displayName(slug: String): String = slug.replaceFirstChar { it.uppercase() }

        fun rows(apps: List<AppSummary>, copies: List<AppCopyRecord>, seenUnderway: Set<String> = emptySet()): List<Row> {
            val out = apps.map { app ->
                val copying = app.copying
                Row(
                    serviceId = app.serviceId,
                    name = displayName(app.slug),
                    address = app.url.removePrefix("https://").removePrefix("http://").trimEnd('/'),
                    status = when {
                        copying != null -> AppPlacementViewModel.progressText(copying.progress)
                        else -> AppStatus.pill(app)?.label ?: "Status unknown"
                    },
                    copying = copying != null,
                    membersOnly = app.accessMode == "members-only",
                )
            }.toMutableList()
            val listed = apps.map { it.serviceId }.toSet()
            // A copy the box doesn't list yet, or one that failed while we watched.
            copies.filter { it.serviceId !in listed }
                .groupBy { it.serviceId }
                .mapNotNull { (_, list) -> list.maxByOrNull { it.startedAt } }
                .forEach { c ->
                    val name = c.appName.ifEmpty { displayName(c.serviceId.substringAfter("--")) }
                    when {
                        c.underway -> out.add(
                            Row(c.serviceId, name, "", AppPlacementViewModel.progressText(c.progress), copying = true),
                        )
                        c.state == "failed" && c.copyId in seenUnderway -> out.add(
                            Row(
                                c.serviceId, name, "",
                                "Couldn't copy" + (c.reason?.takeIf { it.isNotEmpty() }?.let { ": $it" } ?: ""),
                                failed = true,
                            ),
                        )
                    }
                }
            return out
        }
    }
}
