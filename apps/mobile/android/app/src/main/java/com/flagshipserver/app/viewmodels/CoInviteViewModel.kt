// Co-manager invites on a shared server's app (docs/service-access-gating.md
// "Co-manager invites"): "Invite people" opens the panel; B invites at Member
// and withdraws only B's own invites while the box says B may. Mirror of iOS
// CoInviteController.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.ServerShareClient
import com.flagshipserver.app.core.ShareCoInviteCreated
import com.flagshipserver.app.core.ShareCoInviteGroup
import com.flagshipserver.app.core.ShareCoInviteState
import com.flagshipserver.app.core.ShareException
import com.flagshipserver.app.core.ShareInviteRefusal
import com.flagshipserver.app.core.SharedEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class CoInviteUi(
    val open: Boolean = false,
    val loading: Boolean = false,
    val state: ShareCoInviteState? = null,
    val failed: String? = null,
    val adding: Kind? = null,
    val lastLink: String? = null,
    val busy: Boolean = false,
    val withdrawing: String? = null,
    val error: String? = null,
) {
    enum class Kind { Person, Group }
}

class CoInviteViewModel(
    val serviceRef: String,
    val appName: String,
    private val fetch: suspend () -> ShareCoInviteState,
    private val make: suspend (ownerAid: String?, name: String, group: ShareCoInviteGroup?) -> ShareCoInviteCreated,
    private val drop: suspend (inviteId: String) -> Unit,
) {
    constructor(client: ServerShareClient, entry: SharedEntry, serviceRef: String, appName: String) : this(
        serviceRef,
        appName,
        fetch = { client.coInvites(entry, serviceRef) },
        make = { aid, name, group -> client.createCoInvite(entry, serviceRef, aid, name, group) },
        drop = { client.withdrawCoInvite(entry, it) },
    )

    private val _ui = MutableStateFlow(CoInviteUi())
    val ui: StateFlow<CoInviteUi> = _ui.asStateFlow()

    /** "Invite people": open (and load) the panel, or close it. */
    suspend fun toggle() {
        if (_ui.value.open) {
            _ui.value = CoInviteUi()
            return
        }
        _ui.update { it.copy(open = true) }
        reload()
    }

    suspend fun reload() {
        _ui.update { it.copy(loading = it.state == null, failed = null) }
        try {
            val s = fetch()
            _ui.update { it.copy(loading = false, state = s) }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _ui.update { it.copy(loading = false, failed = t.inviteMessage()) }
        }
    }

    fun startAdding(kind: CoInviteUi.Kind) {
        _ui.update { it.copy(adding = kind, lastLink = null, error = null) }
    }

    /** Create the invite; true when it was made (the link is in `lastLink`). */
    suspend fun create(name: String, maxUses: String = "10", days: String = ""): Boolean {
        val kind = _ui.value.adding ?: return false
        if (_ui.value.busy) return false
        _ui.update { it.copy(busy = true, error = null) }
        return try {
            val group = if (kind == CoInviteUi.Kind.Group) ShareCoInviteGroup.fromForm(maxUses, days) else null
            val made = make(_ui.value.state?.ownerAid, name, group)
            reload()
            _ui.update { it.copy(busy = false, adding = null, lastLink = made.link) }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _ui.update { it.copy(busy = false, error = t.inviteMessage()) }
            false
        }
    }

    /** Withdraw one of B's own invites; true when the box took it. */
    suspend fun withdraw(inviteId: String): Boolean {
        if (_ui.value.withdrawing != null) return false
        _ui.update { it.copy(withdrawing = inviteId, error = null) }
        return try {
            drop(inviteId)
            reload()
            _ui.update { it.copy(withdrawing = null) }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _ui.update { it.copy(withdrawing = null, error = t.inviteMessage()) }
            false
        }
    }
}

private fun Throwable.inviteMessage(): String = when (this) {
    is ShareInviteRefusal -> message ?: FSStrings.get(R.string.something_went_wrong_try_again)
    is ShareException -> message ?: FSStrings.get(R.string.something_went_wrong_try_again)
    else -> userFacing()
}
