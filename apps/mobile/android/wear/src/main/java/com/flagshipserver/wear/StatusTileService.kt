// The Flagship tile: an install's phase, else how many boxes wait for a boot
// approval, else how many servers are up, with the leader underneath; with
// nothing from the phone, what to do ("Open Flagship on your phone"). A tap
// opens the app. Drawn from the snapshot the phone last sent, in the watch's
// language. The tile picker's preview (drawable-nodpi/tile_preview.png) and the
// store's tile screenshot are this same layout, rendered by StoreTileCaptureTest.

package com.flagshipserver.wear

import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.flagshipserver.companion.WatchContext
import com.flagshipserver.companion.WatchProjection
import com.flagshipserver.companion.WatchText
import com.google.common.util.concurrent.ListenableFuture

class StatusTileService : TileService() {

    override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> {
        val tile = TileBuilders.Tile.Builder()
            .setResourcesVersion(RESOURCES_VERSION)
            .setFreshnessIntervalMillis(30 * 60 * 1000L)
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(statusTileLayout(this, WatchStore.read(this))))
            .build()
        return done(tile)
    }

    override fun onTileResourcesRequest(requestParams: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
        done(ResourceBuilders.Resources.Builder().setVersion(RESOURCES_VERSION).build())

    private fun <T : Any> done(value: T): ListenableFuture<T> =
        CallbackToFutureAdapter.getFuture { completer ->
            completer.set(value)
            "flagship-tile"
        }

    internal companion object {
        const val RESOURCES_VERSION = "1"
    }
}

private const val WHITE = com.flagshipserver.companion.StatusPalette.DARK_INK.toInt()
private const val GRAY = com.flagshipserver.companion.StatusPalette.DARK_MUTED.toInt()
private const val AMBER = com.flagshipserver.companion.StatusPalette.DARK_WARN.toInt()

/** The tile's layout for [data], in [context]'s language. */
internal fun statusTileLayout(context: android.content.Context, data: WatchContext): LayoutElementBuilders.LayoutElement {
    val lines = WatchProjection.tileLines(data)
    val open = ModifiersBuilders.Clickable.Builder()
        .setId("open")
        .setOnClick(
            ActionBuilders.LaunchAction.Builder()
                .setAndroidActivity(
                    ActionBuilders.AndroidActivity.Builder()
                        .setPackageName(context.packageName)
                        .setClassName(WearMainActivity::class.java.name)
                        .build(),
                )
                .build(),
        )
        .build()
    // The "open Flagship on your phone" prompt is a sentence, not a count: smaller, over more lines.
    val prompt = lines.headline == WatchText.OpenPhone
    val column = LayoutElementBuilders.Column.Builder()
        .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
        .addContent(tileText("Flagship", 13f, GRAY, bold = false, maxLines = 1))
        .addContent(
            tileText(
                WatchStrings.text(context, lines.headline),
                if (prompt) 17f else 22f,
                if (lines.attention) AMBER else WHITE,
                bold = true,
                maxLines = if (prompt) 3 else 2,
            ),
        )
    lines.detail?.let { column.addContent(tileText(WatchStrings.text(context, it), 13f, GRAY, bold = false, maxLines = 2)) }
    return LayoutElementBuilders.Box.Builder()
        .setWidth(expand())
        .setHeight(expand())
        .setModifiers(ModifiersBuilders.Modifiers.Builder().setClickable(open).build())
        .addContent(column.build())
        .build()
}

private fun tileText(value: String, size: Float, color: Int, bold: Boolean, maxLines: Int) =
    LayoutElementBuilders.Text.Builder()
        .setText(value)
        .setMaxLines(maxLines)
        .setMultilineAlignment(LayoutElementBuilders.TEXT_ALIGN_CENTER)
        .setFontStyle(
            LayoutElementBuilders.FontStyle.Builder()
                .setSize(sp(size))
                .setColor(argb(color))
                .setWeight(if (bold) LayoutElementBuilders.FONT_WEIGHT_BOLD else LayoutElementBuilders.FONT_WEIGHT_NORMAL)
                .build(),
        )
        .build()
