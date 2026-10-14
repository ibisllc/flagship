// Home's server list in the owner's order (docs/server-order.md): touch and
// hold a server, drag it, drop it. TalkBack users get "Move up" / "Move down"
// actions instead. Only registered servers with a known identity move;
// pending and revoked ones stay below them.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.zIndex
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.ServerOrderProtocol
import com.flagshipserver.app.ui.theme.FS
import kotlin.math.abs

/** Where a server stands in the order, for its row's labels. */
data class ServerRole(
    /** 1-based place among the servers that can be ordered; null when there's only one. */
    val position: Int?,
    /** The leader's row: the name of the higher server it's standing in for. */
    val standingInFor: String? = null,
)

/** Roles for [ranked] (already in the owner's order) with [leaderPodId] leading. */
fun serverRoles(ranked: List<PodInfo>, leaderPodId: String?): Map<String, ServerRole> {
    val orderable = ranked.filter(ServerOrderProtocol::orderable)
    val numbered = orderable.size >= 2
    val leaderIndex = orderable.indexOfFirst { it.podId == leaderPodId }
    return orderable.withIndex().associate { (i, pod) ->
        val standingInFor = if (i == leaderIndex && i > 0) {
            orderable.take(i).firstOrNull { !ServerOrderProtocol.isUp(it) }?.name
        } else null
        pod.podId to ServerRole(position = if (numbered) i + 1 else null, standingInFor = standingInFor)
    }
}

/** Move [id] one step in [order] toward [delta] (-1 up, +1 down), skipping
 *  nothing: a server only swaps with a neighbour that can be ordered too. */
internal fun moveInOrder(order: List<String>, id: String, delta: Int, canMove: (String) -> Boolean): List<String>? {
    val i = order.indexOf(id)
    val j = i + delta
    if (i < 0 || j !in order.indices || !canMove(order[j])) return null
    return order.toMutableList().also { it[i] = order[j]; it[j] = id }
}

@Composable
fun ReorderableServerList(
    pods: List<PodInfo>,
    enabled: Boolean,
    onReorder: (List<String>) -> Unit,
    row: @Composable (
        pod: PodInfo,
        rowModifier: Modifier,
        dragging: Boolean,
        menuOpen: Boolean,
        onMenuOpenChange: (Boolean) -> Unit,
        /** False while (or just after) a hold-and-drag: the release isn't a tap. */
        clickAllowed: () -> Boolean,
    ) -> Unit,
) {
    val ids = pods.map { it.podId }
    val byId = pods.associateBy { it.podId }
    val latestById by rememberUpdatedState(byId)
    val latestIds by rememberUpdatedState(ids)
    var order by remember { mutableStateOf(ids) }
    var draggingId by remember { mutableStateOf<String?>(null) }
    var offset by remember { mutableFloatStateOf(0f) }
    var moved by remember { mutableStateOf(false) }
    var menuFor by remember { mutableStateOf<String?>(null) }
    var heldUntil by remember { mutableStateOf(0L) }
    val heights = remember { mutableStateMapOf<String, Int>() }
    val gap = with(LocalDensity.current) { FS.space.s3.toPx() }
    val slop = with(LocalDensity.current) { FS.space.s2.toPx() }

    fun canMove(id: String) = latestById[id]?.let(ServerOrderProtocol::orderable) == true

    // While a drag runs the list shows the dragged order; otherwise the
    // owner's order from AppState.
    val shown = if (draggingId == null) ids else order.filter { it in byId } + ids.filter { it !in order }

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        shown.forEach { id ->
            val pod = byId[id] ?: return@forEach
            key(id) {
                val isDragging = id == draggingId
                val movable = enabled && canMove(id)
                var rowModifier = Modifier
                    .testTag("home-server-row-$id")
                    .onGloballyPositioned { heights[id] = it.size.height }
                if (isDragging) {
                    rowModifier = rowModifier
                        .zIndex(1f)
                        .graphicsLayer { translationY = offset; shadowElevation = 12f; scaleX = 1.02f; scaleY = 1.02f }
                }
                if (movable) {
                    rowModifier = rowModifier
                        .semantics {
                            customActions = listOfNotNull(
                                moveInOrder(latestIds, id, -1, ::canMove)?.let { up ->
                                    CustomAccessibilityAction("Move up") { onReorder(up); true }
                                },
                                moveInOrder(latestIds, id, +1, ::canMove)?.let { down ->
                                    CustomAccessibilityAction("Move down") { onReorder(down); true }
                                },
                            )
                        }
                        .pointerInput(id) {
                            detectDragGesturesAfterLongPress(
                                onDragStart = {
                                    heldUntil = Long.MAX_VALUE
                                    order = latestIds
                                    draggingId = id
                                    offset = 0f
                                    moved = false
                                },
                                onDrag = { change, amount ->
                                    change.consume()
                                    offset += amount.y
                                    if (abs(offset) > slop) moved = true
                                    val i = order.indexOf(id)
                                    if (offset > 0 && i < order.lastIndex && canMove(order[i + 1])) {
                                        val h = (heights[order[i + 1]] ?: 0) + gap
                                        if (h > gap && offset > h / 2) {
                                            order = moveInOrder(order, id, +1, ::canMove) ?: order
                                            offset -= h
                                        }
                                    } else if (offset < 0 && i > 0 && canMove(order[i - 1])) {
                                        val h = (heights[order[i - 1]] ?: 0) + gap
                                        if (h > gap && -offset > h / 2) {
                                            order = moveInOrder(order, id, -1, ::canMove) ?: order
                                            offset += h
                                        }
                                    }
                                },
                                onDragEnd = {
                                    heldUntil = System.currentTimeMillis() + 400
                                    val dropped = order
                                    val changed = dropped != latestIds
                                    draggingId = null
                                    offset = 0f
                                    if (changed) onReorder(dropped) else if (!moved) menuFor = id
                                },
                                onDragCancel = {
                                    heldUntil = System.currentTimeMillis() + 400
                                    draggingId = null
                                    offset = 0f
                                },
                            )
                        }
                }
                row(
                    pod, rowModifier, isDragging, menuFor == id,
                    { open -> menuFor = if (open) id else null },
                    { System.currentTimeMillis() >= heldUntil },
                )
            }
        }
    }
}
