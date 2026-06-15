// Kotlin/Compose mirror of FlagshipUI/Components/GlobalOperationsBar.swift.
//
// The global "operations" sliver — a teal strip the whole shell slides
// down to reveal, modelled on WhatsApp's active-call bar. It shows the
// most recently started running operation ("deploying server Home",
// "building blog on Home") with a spinner; tapping it deep-links to that
// operation's own screen.
//
// Mounted ABOVE the shell so it physically pushes every tab down rather
// than floating over content (iOS uses `.safeAreaInset(edge:.top)`; here
// the bar is the first child of a Column whose second child is the
// Scaffold). Renders nothing (zero height, no push) when there are no
// operations or the app is biometric-locked — the latter so operation
// names (the user's own data) never show through the lock screen.

package com.flagshipserver.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.ActiveOperation
import com.flagshipserver.app.core.ActiveOperationsCenter
import com.flagshipserver.app.core.DeepLinker
import com.flagshipserver.app.core.LocalActiveOperationsCenter
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.ui.theme.FS

/**
 * The teal sliver. Reads [LocalActiveOperationsCenter] for the primary
 * operation + the "+N" count, [LocalAppState] for the biometric-lock gate,
 * and [LocalDeepLinker] to navigate on tap. The whole bar animates in/out
 * vertically (a spring slide-down/up), which — because it sits above the
 * Scaffold in a Column — pushes the rest of the shell down.
 */
@Composable
fun GlobalOperationsBar() {
    val center = LocalActiveOperationsCenter.current
    val linker = LocalDeepLinker.current
    val app = LocalAppState.current

    // Re-render when either feeder changes or the lock latch flips.
    val operations by center.operations.collectAsState()
    val isUnlocked by app.isUnlocked.collectAsState()

    // Locked ⇒ show nothing (mirror iOS gating on isUnlocked). Reading
    // `operations` above also keys the recomposition; primary/additionalCount
    // derive from the same backing list.
    val primary: ActiveOperation? = if (isUnlocked) center.primary else null
    val extra = center.additionalCount

    AnimatedVisibility(
        visible = primary != null,
        enter = fadeIn() + expandVertically(
            animationSpec = spring(dampingRatio = 0.9f, stiffness = 420f),
        ),
        exit = fadeOut() + shrinkVertically(
            animationSpec = spring(dampingRatio = 0.9f, stiffness = 420f),
        ),
    ) {
        // `primary` can momentarily be null on the exit frame; hold the last
        // shown op so the collapse animates rather than blanking.
        primary?.let { op ->
            OperationsSliver(op = op, extra = extra) { linker.enqueue(op.target) }
        }
    }
}

@Composable
private fun OperationsSliver(op: ActiveOperation, extra: Int, onTap: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(FS.colors.primary)
            .clickable(onClick = onTap)
            .semantics {
                testTag = "global-operations-bar"
                contentDescription = op.label
            }
            .padding(horizontal = FS.space.s4, vertical = FS.space.s2),
    ) {
        CircularProgressIndicator(
            color = Color.White,
            strokeWidth = 2.dp,
            modifier = Modifier.size(16.dp),
        )
        Box(Modifier.size(FS.space.s2))
        Text(
            text = op.label,
            color = Color.White,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (extra > 0) {
            Box(Modifier.size(FS.space.s2))
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(FS.radius.pill))
                    .background(Color.White.copy(alpha = 0.22f))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Text(
                    text = "+$extra",
                    color = Color.White,
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                )
            }
        }
        Box(Modifier.size(FS.space.s2))
        // A literal chevron glyph — no Material arrow icon is otherwise used
        // in this module, so we avoid pulling that dependency in for one mark.
        Text(
            text = "›",
            color = Color.White.copy(alpha = 0.85f),
            style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
        )
    }
}
