// Receives the phone's WatchContext data item while the watch app is closed,
// so the tile and complication stay current.

package com.flagshipserver.wear

import com.flagshipserver.companion.WatchPaths
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService

class WatchDataService : WearableListenerService() {
    override fun onDataChanged(events: DataEventBuffer) {
        for (event in events) {
            if (event.dataItem.uri.path != WatchPaths.CONTEXT) continue
            when (event.type) {
                DataEvent.TYPE_CHANGED ->
                    WatchStore.write(this, DataMapItem.fromDataItem(event.dataItem).dataMap.getString(WatchPaths.CONTEXT_KEY))
                DataEvent.TYPE_DELETED -> WatchStore.write(this, null)
            }
        }
    }
}
