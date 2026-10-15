// The Flagship complication, the twin of the Apple Watch's provision-phase
// complication: a ranged value while a server installs, otherwise short text
// (how many boxes wait for approval, else how many servers are up). A tap
// opens the app.

package com.flagshipserver.wear

import android.app.PendingIntent
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import com.flagshipserver.companion.PendingApproval
import com.flagshipserver.companion.PodStatusSnapshot
import com.flagshipserver.companion.WatchContext
import com.flagshipserver.companion.WatchProjection

class StatusComplicationService : SuspendingComplicationDataSourceService() {

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? =
        build(request.complicationType, WatchStore.read(this))

    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        build(
            type,
            WatchContext(
                status = PodStatusSnapshot(
                    pods = listOf(PodStatusSnapshot.Pod("home", "Home", "home.example.flagship.services", "online", true)),
                ),
                pendingApprovals = listOf(PendingApproval(null, "home.example.flagship.services")),
            ),
        )

    private fun build(type: ComplicationType, ctx: WatchContext): ComplicationData? {
        val text = WatchProjection.shortText(ctx)
        val description = PlainComplicationText.Builder("Flagship: $text").build()
        val tap = PendingIntent.getActivity(
            this, 0, Intent(this, WearMainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return when (type) {
            ComplicationType.SHORT_TEXT ->
                ShortTextComplicationData.Builder(PlainComplicationText.Builder(text).build(), description)
                    .setTapAction(tap)
                    .build()
            ComplicationType.RANGED_VALUE ->
                RangedValueComplicationData.Builder(
                    value = WatchProjection.provisionFraction(ctx) ?: 0f,
                    min = 0f,
                    max = 1f,
                    contentDescription = description,
                )
                    .setText(PlainComplicationText.Builder(text).build())
                    .setTapAction(tap)
                    .build()
            else -> null
        }
    }
}
