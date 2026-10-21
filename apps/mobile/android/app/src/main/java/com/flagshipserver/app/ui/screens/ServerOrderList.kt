// Home's server list in the owner's order (docs/server-order.md): drag a
// server by its handle and drop it. TalkBack users get "Move up" / "Move down"
// actions instead. Only registered servers with a known identity move;
// pending and revoked ones stay below them. Order is read from position
// alone: the only label is the leader's badge.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitVerticalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.verticalDrag
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DragHandle
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.ServerOrderProtocol
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.delay

/** The leader's row: the first server in the shown order that is online. */
data class LeaderLabel(
    val podId: String,
    /** The higher servers it stands in for while they are down. */
    val standingInFor: String? = null,
)

/** The leader of [shown] (the order on screen): the first registered,
 *  unrevoked server that is online. Null when none is. */
fun leaderLabel(shown: List<PodInfo>): LeaderLabel? {
    val ranked = shown.filter { it.status != PodInfo.Status.PENDING && !it.isRevoked }
    val i = ranked.indexOfFirst { it.status == PodInfo.Status.ONLINE }
    if (i < 0) return null
    val above = ranked.take(i).map { it.name }
    return LeaderLabel(ranked[i].podId, above.takeIf { it.isNotEmpty() }?.joinToString(", "))
}

/** True once the leader holds the order on screen: no drag draft is showing,
 *  and the owner never ordered ([orderIssuedAt] 0) or the leader's ack has
 *  caught up with it. Until then the badge is gray. */
fun leaderConfirmed(draftShowing: Boolean, orderIssuedAt: Long, acks: Map<String, Long>, leaderPodId: String?): Boolean =
    !draftShowing && (orderIssuedAt == 0L || (leaderPodId != null && (acks[leaderPodId] ?: 0L) >= orderIssuedAt))

/** Where a server that doesn't lead stands, by who is above it. */
fun successionLine(above: List<String>): String = when (above.size) {
    0 -> FSStrings.get(R.string.first_in_line_to_lead)
    1 -> FSStrings.get(R.string.takes_over_while_is_down, above[0])
    else -> FSStrings.get(R.string.takes_over_while_and_are_down, above.dropLast(1).joinToString(", "), above.last())
}

/** [committed] in [draft]'s order: drafted pods first, then any the draft
 *  doesn't know. [committed] as it is when there's no draft. */
fun applyDraft(committed: List<PodInfo>, draft: List<String>?): List<PodInfo> {
    if (draft == null) return committed
    val byId = committed.associateBy { it.podId }
    return draft.mapNotNull { byId[it] } + committed.filter { it.podId !in draft }
}

/** Move [id] one step in [order] toward [delta] (-1 up, +1 down), skipping
 *  nothing: a server only swaps with a neighbour that can be ordered too. */
internal fun moveInOrder(order: List<String>, id: String, delta: Int, canMove: (String) -> Boolean): List<String>? {
    val i = order.indexOf(id)
    val j = i + delta
    if (i < 0 || j !in order.indices || !canMove(order[j])) return null
    return order.toMutableList().also { it[i] = order[j]; it[j] = id }
}

/** The order on screen while a server is dragged, and from the drop until the
 *  committed order catches up, so the rows and the Leader badge always read
 *  the same order. */
@Stable
class ServerListDrag {
    var draft by mutableStateOf<List<String>?>(null)
    var draggingId by mutableStateOf<String?>(null)
    var offset by mutableFloatStateOf(0f)
}

@Composable
fun rememberServerListDrag(): ServerListDrag = remember { ServerListDrag() }

val DRAG_HANDLE_WIDTH = 40.dp

@Composable
fun ReorderableServerList(
    /** The servers in the committed order. */
    pods: List<PodInfo>,
    enabled: Boolean,
    drag: ServerListDrag,
    onReorder: (List<String>) -> Unit,
    row: @Composable (
        pod: PodInfo,
        rowModifier: Modifier,
        dragging: Boolean,
        /** The drag handle's slot: null when the list can't be reordered;
         *  an empty slot of the same width on a row that can't move. */
        handle: (@Composable () -> Unit)?,
        moveActions: List<CustomAccessibilityAction>,
    ) -> Unit,
) {
    val ids = pods.map { it.podId }
    val byId = pods.associateBy { it.podId }
    val latestById by rememberUpdatedState(byId)
    val latestIds by rememberUpdatedState(ids)
    val latestOnReorder by rememberUpdatedState(onReorder)
    val heights = remember { mutableStateMapOf<String, Int>() }
    val gap = with(LocalDensity.current) { FS.space.s3.toPx() }

    fun canMove(id: String) = latestById[id]?.let(ServerOrderProtocol::orderable) == true

    // The committed order moved (the save landed, or was put back), so it is
    // what shows now.
    LaunchedEffect(ids) { if (drag.draggingId == null) drag.draft = null }
    // A drop whose save never moves the committed order (refused before it
    // reached the screen) must not leave the draft up.
    LaunchedEffect(drag.draft, drag.draggingId) {
        if (drag.draft != null && drag.draggingId == null) {
            delay(3_000)
            drag.draft = null
        }
    }

    // Lifting the finger and the gesture being cancelled both land here:
    // whatever is on screen is the order the owner chose.
    fun finish(id: String) {
        if (drag.draggingId != id) return
        drag.draggingId = null
        drag.offset = 0f
        val dropped = drag.draft
        if (dropped == null || dropped == latestIds) drag.draft = null else latestOnReorder(dropped)
    }

    val shown = applyDraft(pods, drag.draft).map { it.podId }

    // The drag is read at the list, not on each row's handle: a row can be
    // recomposed from scratch when the drag starts (its handle was a fresh
    // pointer-input node, which Compose reset mid-gesture about one run in ten,
    // leaving the order untouched). The list itself never leaves the
    // composition, so the gesture survives whatever the rows do.
    val tops = remember { mutableStateMapOf<String, Float>() }
    var listTop by remember { mutableFloatStateOf(0f) }
    val handleWidthPx = with(LocalDensity.current) { DRAG_HANDLE_WIDTH.toPx() }

    fun handleAt(x: Float, y: Float): String? {
        if (x < 0f || x > handleWidthPx) return null
        val order = latestIds
        return order.firstOrNull { id ->
            val top = (tops[id] ?: return@firstOrNull false) - listTop
            val h = (heights[id] ?: return@firstOrNull false).toFloat()
            y >= top && y <= top + h
        }?.takeIf { canMove(it) }
    }

    fun dragBy(id: String, dy: Float) {
        drag.offset += dy
        val order = drag.draft ?: latestIds
        val i = order.indexOf(id)
        val offset = drag.offset
        if (offset > 0 && i in 0 until order.lastIndex && canMove(order[i + 1])) {
            val h = (heights[order[i + 1]] ?: 0) + gap
            if (h > gap && offset > h / 2) {
                drag.draft = moveInOrder(order, id, +1, ::canMove) ?: order
                drag.offset -= h
            }
        } else if (offset < 0 && i > 0 && canMove(order[i - 1])) {
            val h = (heights[order[i - 1]] ?: 0) + gap
            if (h > gap && -offset > h / 2) {
                drag.draft = moveInOrder(order, id, -1, ::canMove) ?: order
                drag.offset += h
            }
        }
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
        modifier = Modifier
            .animateContentSize()
            .onGloballyPositioned { listTop = it.positionInRoot().y }
            .then(
                if (!enabled) Modifier else Modifier.pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        val id = handleAt(down.position.x, down.position.y) ?: return@awaitEachGesture
                        try {
                            val slop = awaitVerticalTouchSlopOrCancellation(down.id) { change, over ->
                                change.consume()
                                drag.draft = drag.draft ?: latestIds
                                drag.draggingId = id
                                drag.offset = 0f
                                dragBy(id, over)
                            }
                            if (slop != null) {
                                verticalDrag(slop.id) { change ->
                                    // Read the move before consuming: consuming zeroes it.
                                    val dy = change.positionChange().y
                                    change.consume()
                                    dragBy(id, dy)
                                }
                            }
                        } finally {
                            finish(id)
                        }
                    }
                },
            ),
    ) {
        shown.forEach { id ->
            val pod = byId[id] ?: return@forEach
            key(id) {
                val isDragging = id == drag.draggingId
                val movable = enabled && canMove(id)
                var rowModifier = Modifier
                    .testTag("home-server-row-$id")
                    .onGloballyPositioned {
                        heights[id] = it.size.height
                        tops[id] = it.positionInRoot().y
                    }
                if (isDragging) {
                    rowModifier = rowModifier
                        .zIndex(1f)
                        .graphicsLayer { translationY = drag.offset; shadowElevation = 12f; scaleX = 1.02f; scaleY = 1.02f }
                }
                val moveActions = if (!movable) emptyList() else listOfNotNull(
                    moveInOrder(ids, id, -1, ::canMove)?.let { up ->
                        CustomAccessibilityAction(stringResource(R.string.move_up)) { onReorder(up); true }
                    },
                    moveInOrder(ids, id, +1, ::canMove)?.let { down ->
                        CustomAccessibilityAction(stringResource(R.string.move_down)) { onReorder(down); true }
                    },
                )
                val handle: (@Composable () -> Unit)? = if (!enabled) null else {
                    {
                        // Only the picture and the semantics: the list reads the gesture.
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier
                                .width(DRAG_HANDLE_WIDTH)
                                .fillMaxHeight()
                                .then(if (movable) Modifier.testTag("home-server-handle-$id") else Modifier),
                        ) {
                            if (movable) {
                                Icon(Icons.Outlined.DragHandle, contentDescription = null, tint = FS.colors.textMuted)
                            }
                        }
                    }
                }
                row(pod, rowModifier, isDragging, handle, moveActions)
            }
        }
    }
}
