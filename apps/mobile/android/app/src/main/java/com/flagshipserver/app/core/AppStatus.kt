// An app's status pill (docs/app-placement.md §6): one server's state from its
// apps-list row, and the services list's pill combining every server the app
// is on. Older boxes send only `status: "unknown"` and no `activity`.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AppSummary

object AppStatus {
    /** How a pill is drawn: online (green), accent, idle (grey), warning. */
    enum class Tone { Online, Accent, Idle, Warning }

    data class Pill(val label: String, val tone: Tone)

    /** What one server says about one app it lists. */
    enum class ServerState { Running, Starting, Stopped, Deploying, Copying, Editing, Unknown }

    fun of(app: AppSummary): ServerState {
        when (app.activity?.kind) {
            "deploying" -> return ServerState.Deploying
            "copying" -> return ServerState.Copying
            "editing" -> return ServerState.Editing
        }
        if (app.copying != null) return ServerState.Copying
        return when (app.status) {
            "running" -> ServerState.Running
            "starting" -> ServerState.Starting
            "stopped" -> ServerState.Stopped
            else -> ServerState.Unknown
        }
    }

    /** The app page's and a Runs-on row's pill; none for an unknown state. */
    fun pill(state: ServerState): Pill? = when (state) {
        ServerState.Running -> Pill("Running", Tone.Online)
        ServerState.Starting -> Pill("Starting", Tone.Accent)
        ServerState.Stopped -> Pill("Stopped", Tone.Idle)
        ServerState.Deploying -> Pill("Deploying", Tone.Accent)
        ServerState.Copying -> Pill("Copying", Tone.Accent)
        ServerState.Editing -> Pill("Editing", Tone.Accent)
        ServerState.Unknown -> null
    }

    fun pill(app: AppSummary): Pill? = pill(of(app))

    /** The services list's pill, over every server the app is on: each entry
     *  is that server's state, or null when it didn't answer this time.
     *  An "unknown" server (an older box) has the app but isn't counted as
     *  running; with none running, the unknown ones are counted instead, so
     *  Stopped means every server that answered said stopped. */
    fun combined(servers: List<ServerState?>): Pill {
        val answered = servers.filterNotNull()
        if (answered.any { it == ServerState.Deploying || it == ServerState.Copying }) return DEPLOYING
        if (answered.any { it == ServerState.Editing }) return EDITING
        val running = answered.count { it == ServerState.Running || it == ServerState.Starting }
        if (running > 0) return onServers(running)
        if (answered.isEmpty()) return CANT_REACH
        val unknown = answered.count { it == ServerState.Unknown }
        if (unknown > 0) return onServers(unknown)
        return STOPPED
    }

    fun onServers(n: Int): Pill = Pill(if (n == 1) "On 1 server" else "On $n servers", Tone.Online)

    val DEPLOYING = Pill("Deploying", Tone.Accent)
    val EDITING = Pill("Editing", Tone.Accent)
    val STOPPED = Pill("Stopped", Tone.Idle)
    val CANT_REACH = Pill("Can't reach", Tone.Warning)
}
