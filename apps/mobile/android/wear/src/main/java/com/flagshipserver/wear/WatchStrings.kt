// The words for what WatchProjection decides (companion's WatchText), from the watch's own string
// resources: the projection runs on the watch over the raw context the phone sent, so the tile,
// complication and app read in the watch's language, whatever the phone's is.

package com.flagshipserver.wear

import android.content.Context
import com.flagshipserver.companion.WatchProjection
import com.flagshipserver.companion.WatchText

internal object WatchStrings {

    fun text(ctx: Context, t: WatchText): String = when (t) {
        is WatchText.Phase -> ctx.getString(phaseShortRes(t.phase))
        is WatchText.Waiting -> ctx.resources.getQuantityString(R.plurals.watch_waiting, t.count, t.count)
        is WatchText.Up -> ctx.getString(R.string.watch_servers_up, t.online, t.total)
        WatchText.OpenPhone -> ctx.getString(R.string.watch_open_flagship_on_your_phone)
        WatchText.NoServers -> ctx.getString(R.string.watch_no_servers)
        WatchText.AddOnPhone -> ctx.getString(R.string.watch_add_one_on_your_phone)
        WatchText.NewServer -> ctx.getString(R.string.new_server)
        WatchText.TapToApprove -> ctx.getString(R.string.watch_tap_to_approve)
        is WatchText.Leader -> ctx.getString(R.string.watch_leader_name, t.name)
        is WatchText.Name -> t.name
    }

    /** The complication's few characters: [WatchText.OpenPhone] has a shorter form there. */
    fun short(ctx: Context, t: WatchText): String =
        if (t == WatchText.OpenPhone) ctx.getString(R.string.watch_open_phone_short) else text(ctx, t)

    /** The complication's spoken description: the whole sentence, never the clipped form. */
    fun description(ctx: Context, t: WatchText): String =
        if (t == WatchText.OpenPhone) ctx.getString(R.string.open_flagship_on_your_phone_to)
        else ctx.getString(R.string.watch_complication_description, text(ctx, t))

    private fun phaseShortRes(phase: String): Int = when (phase) {
        "booting" -> R.string.watch_phase_short_booting
        "partitioning" -> R.string.watch_phase_short_partitioning
        "installing" -> R.string.watch_phase_short_installing
        "downloading" -> R.string.watch_phase_short_downloading
        "registering" -> R.string.watch_phase_short_registering
        "sealing" -> R.string.watch_phase_short_sealing
        "installed" -> R.string.watch_phase_short_installed
        "pairing" -> R.string.watch_phase_short_pairing
        "live" -> R.string.watch_phase_short_live
        "error" -> R.string.watch_phase_short_error
        else -> R.string.watch_phase_short_other
    }

    /** The install phase's title (provisionStatus.ts PHASE_TITLES). */
    fun phaseTitle(ctx: Context, phase: String): String = ctx.getString(
        when (phase) {
            "booting" -> R.string.watch_phase_booting
            "downloading" -> R.string.watch_phase_downloading
            "partitioning" -> R.string.watch_phase_partitioning
            "installing" -> R.string.watch_phase_installing
            "installed" -> R.string.watch_phase_installed
            "registering" -> R.string.watch_phase_registering
            "sealing" -> R.string.watch_phase_sealing
            "pairing" -> R.string.watch_phase_pairing
            "live" -> R.string.watch_phase_live
            "error" -> R.string.watch_phase_error
            else -> R.string.watch_phase_other
        },
    )

    /** An audit event's label (iOS SecurityAlertsProjection.label); an unknown kind shows itself. */
    fun eventLabel(ctx: Context, kind: String): String {
        val id = when (kind) {
            "device-disconnected" -> R.string.watch_event_device_disconnected
            "device-replaced" -> R.string.watch_event_device_replaced
            "device-added" -> R.string.watch_event_device_added
            "wipe-restart" -> R.string.watch_event_wipe_restart
            "recovery-set-up" -> R.string.watch_event_recovery_set_up
            "recovery-rotated" -> R.string.watch_event_recovery_rotated
            "app-renamed" -> R.string.watch_event_app_renamed
            "server-created" -> R.string.watch_event_server_created
            "server-online" -> R.string.watch_event_server_online
            "server-revoked" -> R.string.watch_event_server_revoked
            "server-unrevoked" -> R.string.watch_event_server_unrevoked
            "demo-vps-provisioned" -> R.string.watch_event_demo_vps_provisioned
            "totp-enrolled" -> R.string.watch_event_totp_enrolled
            "totp-disabled" -> R.string.watch_event_totp_disabled
            "re-pair-initiated" -> R.string.watch_event_re_pair_initiated
            else -> return WatchProjection.unknownEventLabel(kind)
        }
        return ctx.getString(id)
    }
}
