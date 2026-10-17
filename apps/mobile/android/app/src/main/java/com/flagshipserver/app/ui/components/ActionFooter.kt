package com.flagshipserver.app.ui.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.ui.theme.FS

/**
 * The bottom of the two front-door screens, Welcome (no account) and the app
 * lock: a big primary button, the secondary option right below it, a gap,
 * then "Patent Pending". One component so both screens stay identical (iOS
 * FSActionFooter, webapp .action-footer). The host keeps it clear of the
 * navigation bar (safeDrawing bottom inset).
 */
@Composable
fun FSActionFooter(
    primary: String,
    primaryTag: String,
    onPrimary: () -> Unit,
    secondary: String,
    secondaryTag: String,
    onSecondary: () -> Unit,
    modifier: Modifier = Modifier,
    primaryEnabled: Boolean = true,
    secondaryDescription: String? = null,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        FSPrimaryButton(
            label = primary,
            onClick = onPrimary,
            enabled = primaryEnabled,
            block = true,
            large = true,
            modifier = Modifier.testTag(primaryTag),
        )
        Spacer(Modifier.height(FS.space.s3))
        FSSecondaryButton(
            label = secondary,
            onClick = onSecondary,
            block = true,
            large = true,
            modifier = Modifier
                .testTag(secondaryTag)
                .then(
                    if (secondaryDescription != null) {
                        Modifier.semantics { contentDescription = secondaryDescription }
                    } else {
                        Modifier
                    },
                ),
        )
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Patent Pending",
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier
                .align(Alignment.CenterHorizontally)
                .padding(bottom = FS.space.s4)
                .testTag("patent-pending"),
        )
    }
}
