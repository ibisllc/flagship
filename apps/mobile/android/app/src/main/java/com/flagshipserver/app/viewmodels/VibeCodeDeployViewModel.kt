// The chat ("vibe") Deploy: the box stages the session's files as a private
// test copy (the session's AI may fix one that won't start), seals the
// session, then installs the tested image. A current box answers the deploy
// at once and is followed on GET /api/screens/vibe-code/:id; an older box
// answers only once the app is live.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

class VibeCodeDeployViewModel(
    private val sessionId: String,
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val pollIntervalMs: Long = 1_500,
    private val pollLimitMs: Long = 45 * 60 * 1_000L,
) {
    sealed interface Phase {
        data object Idle : Phase
        /** `stage`: the box's `deployPhase` ("staging" | "fixing" | "going-live"), if any. */
        data class Deploying(val stage: String? = null) : Phase
        data class Deployed(val url: String, val leftOpen: Boolean = false) : Phase
        data class Failed(val reason: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    val isDeploying: Boolean get() = _phase.value is Phase.Deploying

    fun deploy(): Job = scope.launch {
        if (_phase.value is Phase.Deploying) return@launch
        _phase.value = Phase.Deploying()
        try {
            val r = client.vibeCodeDeployStart(sessionId)
            when {
                r.started == true -> follow()
                r.ok && r.url != null -> _phase.value = Phase.Deployed(r.url, leftOpen = r.inviteOnly == false)
                else -> _phase.value = Phase.Failed("Deploy was rejected by the box.")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            if (t is ScreensError.Http && t.status == 409 && alreadyDeploying(t)) {
                // A deploy is already running (another device, or a retap): follow it.
                try {
                    follow()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    _phase.value = Phase.Failed(e.userFacing())
                }
            } else {
                _phase.value = Phase.Failed(t.boxError() ?: t.userFacing())
            }
        }
    }

    /** Follow a deploy the box is already running, e.g. on reopening the chat. */
    fun resume(stage: String?): Job? {
        if (_phase.value is Phase.Deploying) return null
        _phase.value = Phase.Deploying(stage)
        return scope.launch {
            try {
                follow()
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                _phase.value = Phase.Failed(t.userFacing())
            }
        }
    }

    private suspend fun follow() {
        val done = withTimeoutOrNull(pollLimitMs) { poll() }
        if (done == null) {
            _phase.value = Phase.Failed("The deploy is taking unusually long. Check Build sessions later to see how it went.")
        }
    }

    /** Polls the session until the deploy ends. A dropped poll isn't the end;
     *  five in a row are. */
    private suspend fun poll() {
        var misses = 0
        while (true) {
            delay(pollIntervalMs)
            val s = try {
                client.vibeCodeStatus(sessionId).also { misses = 0 }
            } catch (t: Throwable) {
                if (t is CancellationException || ++misses >= 5) throw t
                continue
            }
            when (s.status) {
                "deployed" -> {
                    _phase.value = Phase.Deployed(s.deployedUrl ?: "")
                    return
                }
                "failed" -> {
                    _phase.value = Phase.Failed(s.errorReason ?: "The deploy failed.")
                    return
                }
                "deploying" -> _phase.value = Phase.Deploying(s.deployPhase)
                else -> {}
            }
        }
    }

    companion object {
        const val STAGING = "Testing the app on a private copy…"
        const val FIXING = "The AI is fixing a problem it found…"
        const val GOING_LIVE = "Installing…"
        const val DEPLOYING = "Deploying…"

        fun stageText(stage: String?): String = when (stage) {
            "staging" -> STAGING
            "fixing" -> FIXING
            "going-live" -> GOING_LIVE
            else -> DEPLOYING
        }

        fun alreadyDeploying(t: ScreensError.Http): Boolean =
            (t.boxError() ?: t.body).contains("already deploying", ignoreCase = true)
    }
}
