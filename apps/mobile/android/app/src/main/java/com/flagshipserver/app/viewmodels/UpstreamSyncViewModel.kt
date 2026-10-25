// "Check for updates from <repo>" on an imported app's page (N12, buildmodes/syncProposal.ts). The
// box clones one upstream version, compares it three ways with the version the app was imported at
// and what runs now, and opens a build holding the merge. The phone shows what the merge does, with
// capability changes apart from code, then hands the build to the existing deploy step: nothing
// goes live until the owner deploys it.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.R
import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.BuildSyncResponse
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.SyncCapabilityChange
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.NetworkErrorHumanizer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

object UpstreamSyncText {
    fun section(name: String): String = when (name) {
        "network.egress" -> FSStrings.get(R.string.sync_cap_egress)
        "network.subdomain" -> FSStrings.get(R.string.sync_cap_subdomain)
        "data.stores" -> FSStrings.get(R.string.sync_cap_stores)
        "browser.domains" -> FSStrings.get(R.string.sync_cap_browser)
        "access" -> FSStrings.get(R.string.sync_cap_access)
        "runtime" -> FSStrings.get(R.string.sync_cap_runtime)
        "distribution" -> FSStrings.get(R.string.sync_cap_distribution)
        else -> name
    }

    /** "Adds: …" and "Removes: …" for one manifest section, whichever apply. */
    fun changeLines(c: SyncCapabilityChange): List<String> = buildList {
        if (c.added.isNotEmpty()) add(FSStrings.get(R.string.sync_adds, c.added.joinToString(", ")))
        if (c.removed.isNotEmpty()) add(FSStrings.get(R.string.sync_removes, c.removed.joinToString(", ")))
    }

    fun version(commit: String?): String? = commit?.takeIf { it.isNotBlank() }?.let { FSStrings.get(R.string.sync_version, it.take(12)) }

    /** The diff summary lines, each only when it has something to say. */
    fun counts(r: BuildSyncResponse): List<String> = buildList {
        val p = r.proposal
        if (p.takeUpstream.isNotEmpty()) add(FSStrings.plural(R.plurals.sync_files_upstream, p.takeUpstream.size, p.takeUpstream.size))
        if (p.localChanged.isNotEmpty()) {
            val kept = p.localChanged.count { it !in p.conflicts }
            if (kept > 0) add(FSStrings.plural(R.plurals.sync_local_kept, kept, kept))
        }
        if (p.alreadyApplied.isNotEmpty()) add(FSStrings.plural(R.plurals.sync_already_match, p.alreadyApplied.size, p.alreadyApplied.size))
    }

    fun conflictsHeading(n: Int): String = FSStrings.plural(R.plurals.sync_conflicts, n, n)

    fun error(t: Throwable): String {
        if (t is ScreensError.Http && t.status == 404) return FSStrings.get(R.string.sync_not_imported)
        return t.boxError() ?: NetworkErrorHumanizer.humanize(t, "app-sync")
    }
}

class UpstreamSyncViewModel(
    private val serviceId: String,
    private val client: BuildClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
) {
    sealed interface Phase {
        data object Idle : Phase
        data object Checking : Phase
        /** Nothing to take: the box opened no build, so there is nothing to discard. */
        data object UpToDate : Phase
        data class Proposal(val result: BuildSyncResponse, val buildId: String) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    fun check(ref: String): Job = scope.launch {
        _phase.value = Phase.Checking
        _phase.value = try {
            val r = client.syncFromUpstream(serviceId, ref.trim().ifEmpty { null })
            val id = r.buildId
            when {
                r.upToDate -> Phase.UpToDate
                id.isNullOrEmpty() -> Phase.Failed(FSStrings.get(R.string.couldnt_reach_the_server_check_your))
                else -> Phase.Proposal(r, id)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            Phase.Failed(UpstreamSyncText.error(t))
        }
    }

    /** The build a proposal opened, which the owner leaves without deploying. Best effort. */
    fun discard(): Job? {
        val id = (_phase.value as? Phase.Proposal)?.buildId ?: return null
        _phase.value = Phase.Idle
        return scope.launch { runCatching { client.discard(id) } }
    }
}
