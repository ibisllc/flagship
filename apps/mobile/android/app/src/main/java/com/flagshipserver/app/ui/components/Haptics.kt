package com.flagshipserver.app.ui.components

import android.view.HapticFeedbackConstants
import android.view.View

/** Short, quiet feedback for choices; stronger for outcomes. Android 13 and up. */

/** A selection step: a chip, a segment, an accordion row. */
fun View.fsTick() {
    performHapticFeedback(
        if (android.os.Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.CLOCK_TICK,
    )
}

/** Something worked (a success toast, a confirmed action). */
fun View.fsConfirm() { performHapticFeedback(HapticFeedbackConstants.CONFIRM) }

/** Something was refused or failed (an error toast). */
fun View.fsReject() { performHapticFeedback(HapticFeedbackConstants.REJECT) }
