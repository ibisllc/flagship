// The watch's copy of the phone's latest WatchContext: kept in preferences so
// the tile, the complication and a cold app launch read the same snapshot,
// and as a flow the open app redraws from. Only the phone writes it (through
// the Data Layer); the watch never fetches anything else.

package com.flagshipserver.wear

import android.content.ComponentName
import android.content.Context
import androidx.wear.tiles.TileService
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import com.flagshipserver.companion.WatchContext
import com.flagshipserver.companion.WatchPaths
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.tasks.await

object WatchStore {
    private const val PREFS = "flagship.watch"
    private const val KEY = "watch-context.v1"

    private val _context = MutableStateFlow<WatchContext?>(null)
    val context: StateFlow<WatchContext?> = _context.asStateFlow()

    fun read(ctx: Context): WatchContext =
        _context.value ?: WatchContext.decode(prefs(ctx).getString(KEY, null)).also { _context.value = it }

    /** Store the phone's JSON and redraw the tile and complication. */
    fun write(ctx: Context, json: String?) {
        val next = WatchContext.decode(json)
        prefs(ctx).edit().putString(KEY, next.encode()).apply()
        _context.value = next
        refreshSurfaces(ctx)
    }

    /** Pull the current data item, for a launch that may have missed a change. */
    suspend fun sync(ctx: Context) {
        runCatching {
            val items = Wearable.getDataClient(ctx).dataItems.await()
            try {
                items.firstOrNull { it.uri.path == WatchPaths.CONTEXT }?.let { item ->
                    write(ctx, DataMapItem.fromDataItem(item).dataMap.getString(WatchPaths.CONTEXT_KEY))
                }
            } finally {
                items.release()
            }
        }
    }

    fun refreshSurfaces(ctx: Context) {
        runCatching { TileService.getUpdater(ctx).requestUpdate(StatusTileService::class.java) }
        runCatching {
            ComplicationDataSourceUpdateRequester
                .create(ctx, ComponentName(ctx, StatusComplicationService::class.java))
                .requestUpdateAll()
        }
    }

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
