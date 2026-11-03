package com.flagshipserver.app.ui.components

import android.view.HapticFeedbackConstants
import android.view.View

/** Short, quiet feedback for choices; stronger for outcomes. Android 10: the nearest older effects. */

/** A selection step: a chip, a segment, an accordion row. */
fun View.fsTick() {
    performHapticFeedback(
        if (android.os.Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.CLOCK_TICK,
    )
}

/** Something worked (a success toast, a confirmed action). */
fun View.fsConfirm() {
    performHapticFeedback(if (android.os.Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
}

/** Something was refused or failed (an error toast). */
fun View.fsReject() {
    performHapticFeedback(if (android.os.Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)
}
