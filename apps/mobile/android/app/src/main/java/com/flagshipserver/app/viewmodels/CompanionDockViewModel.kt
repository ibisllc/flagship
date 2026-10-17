// The phone side of the remote ceremony. A browser at remote.<apex> shows
// `https://flagshipserver.com/remote?s=<sid>&k=<pk>` (older pages:
// `flagship://remote?…`); this phone joins that QR-relay session, both
// screens show the same 6-digit code, and on a biometric approval the
// phone mints a single-use companion ticket on the server the owner picked and
// seals it to the browser, which redeems it there. Also lists and revokes the
// browsers connected to the picked server.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.CompanionListResponse
import com.flagshipserver.app.api.CompanionMintTicketRequest
import com.flagshipserver.app.api.CompanionRevokeRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.Base64URL
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.QrRelayClient
import com.flagshipserver.app.core.QrSession
import com.flagshipserver.app.core.RemoteApprovalLink
import com.flagshipserver.app.core.RemoteTicketPayload
import com.flagshipserver.app.keystore.BiometricAuthority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/** A server this phone can attach a browser to, with a client bound to it. */
data class RemoteServer(val pod: PodInfo, val client: ScreensClient)

class CompanionDockViewModel(
    /** Ordered as the picker shows them; the first is the default. Read on
     *  each use, so a refreshed server list doesn't restart the ceremony. */
    private val serversProvider: () -> List<RemoteServer>,
    private val username: () -> String?,
    private val relayFactory: () -> QrRelayClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val confirmGateMs: Long = 600,
    private val authenticate: suspend (String) -> Unit = { reason ->
        BiometricAuthority.current()?.let { authority ->
            // A fresh, explicit ceremony even when the rest of the unlocked
            // app session has a warm biometric latch.
            authority.invalidate()
            authority.ensureFresh("Let this browser in", reason)
        }
    },
) {
    sealed interface Phase {
        data object Idle : Phase
        data object Connecting : Phase
        data class Matching(val matchCode: String, val gateOpen: Boolean) : Phase
        data object Approving : Phase
        data class Connected(val serverName: String) : Phase
    }

    private val _state = MutableStateFlow<LoadingState<CompanionListResponse>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<CompanionListResponse>> = _state.asStateFlow()

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    val servers: List<RemoteServer> get() = serversProvider()

    private val _selectedPodId = MutableStateFlow(servers.firstOrNull()?.pod?.podId)
    val selectedPodId: StateFlow<String?> = _selectedPodId.asStateFlow()

    private val _approvalError = MutableStateFlow<String?>(null)
    val approvalError: StateFlow<String?> = _approvalError.asStateFlow()

    private val _revokePending = MutableStateFlow<Set<String>>(emptySet())
    val revokePending: StateFlow<Set<String>> = _revokePending.asStateFlow()

    private var session: QrSession? = null
    private var relay: QrRelayClient? = null

    private val selected: RemoteServer?
        get() {
            val all = servers
            return all.firstOrNull { it.pod.podId == _selectedPodId.value }
                ?: all.firstOrNull()?.also { _selectedPodId.value = it.pod.podId }
        }

    fun selectServer(podId: String) {
        if (servers.none { it.pod.podId == podId }) return
        _selectedPodId.value = podId
        load()
    }

    fun load(): Job = scope.launch {
        val server = selected ?: run {
            _state.value = LoadingState.Failed("No server on this phone can take a browser yet.")
            return@launch
        }
        _state.value = LoadingState.Loading
        runCatching { server.client.companionList() }
            .fold(
                onSuccess = { _state.value = LoadingState.Loaded(it) },
                onFailure = { t -> _state.value = LoadingState.Failed(failureMessage(t)) },
            )
    }

    /** A scanned or pasted code. Joins the browser's relay session and shows
     *  the code to compare; false when it isn't a remote page's code. */
    fun stageApproval(raw: String): Boolean {
        _approvalError.value = null
        val qr = RemoteApprovalLink.parse(raw)
        if (qr == null) {
            _approvalError.value = "That isn't the code from ${com.flagshipserver.app.core.Endpoints.remoteHost}."
            return false
        }
        if (_phase.value is Phase.Connecting || _phase.value is Phase.Approving) return false
        closeRelay()
        _phase.value = Phase.Connecting
        scope.launch {
            try {
                val s = QrSession.fresh()
                val code = s.pair(qr.browserPublicKey)
                val r = relayFactory()
                session = s
                relay = r
                r.openAndHello(qr.sid, Base64URL.encode(s.phonePubKey))
                _phase.value = Phase.Matching(code, gateOpen = false)
                delay(confirmGateMs)
                val now = _phase.value
                if (now is Phase.Matching && now.matchCode == code) _phase.value = now.copy(gateOpen = true)
            } catch (t: Throwable) {
                fail(t)
            }
        }
        return true
    }

    fun cancel() {
        closeRelay()
        _phase.value = Phase.Idle
        _approvalError.value = null
    }

    fun approve(): Job = scope.launch {
        val matching = _phase.value as? Phase.Matching ?: return@launch
        if (!matching.gateOpen) return@launch
        val server = selected ?: return@launch fail(IllegalStateException("Pick a server first."))
        val s = session ?: return@launch
        val r = relay ?: return@launch
        val user = username() ?: return@launch fail(IllegalStateException("Sign in to your account first."))
        _phase.value = Phase.Approving
        _approvalError.value = null
        try {
            authenticate("Let this browser use ${server.pod.name} for four hours, without a key")
            val ticket = server.client.companionMintTicket(CompanionMintTicketRequest())
            val payload = RemoteTicketPayload(
                ticketId = ticket.ticketId,
                ticketSecret = ticket.ticketSecret,
                podBaseUrl = "https://${server.pod.fqdn.lowercase()}",
                username = user,
            )
            val sealed = s.seal(json.encodeToString(RemoteTicketPayload.serializer(), payload).toByteArray())
            r.deliver(sealed.ciphertextB64u, sealed.nonceB64u)
            closeRelay()
            _phase.value = Phase.Connected(server.pod.name)
            delay(1_500)
            load()
        } catch (t: Throwable) {
            fail(t)
        }
    }

    fun revoke(tokenPrefix: String): Job = scope.launch {
        val server = selected ?: return@launch
        _revokePending.value = _revokePending.value + tokenPrefix
        try {
            runCatching { server.client.companionRevoke(CompanionRevokeRequest(tokenPrefix = tokenPrefix)) }
                .fold(
                    onSuccess = {
                        val current = _state.value
                        if (current is LoadingState.Loaded) {
                            val remaining = current.value.companions.filterNot { it.tokenPrefix == tokenPrefix }
                            _state.value = LoadingState.Loaded(CompanionListResponse(companions = remaining))
                        }
                    },
                    onFailure = { t -> _state.value = LoadingState.Failed(failureMessage(t)) },
                )
        } finally {
            _revokePending.value = _revokePending.value - tokenPrefix
        }
    }

    private fun fail(t: Throwable) {
        closeRelay()
        _phase.value = Phase.Idle
        _approvalError.value = failureMessage(t)
    }

    private fun closeRelay() {
        relay?.close()
        relay = null
        session = null
    }

    private fun failureMessage(t: Throwable): String = when (t) {
        is ScreensError.Http -> NetworkErrorHumanizer.humanize(t, "remote")
        else -> {
            com.flagshipserver.app.core.ErrorLog.caught("remote", t, NetworkErrorHumanizer.errorCode(t))
            t.message ?: "Something went wrong. Try again."
        }
    }

    private companion object {
        val json = Json { encodeDefaults = true }
    }
}
