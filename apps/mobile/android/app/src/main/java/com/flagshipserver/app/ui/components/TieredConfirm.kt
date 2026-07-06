// Reusable tiered confirmation (docs/device-admin-entitlements.md "Tiered
// confirmation", built in Slice C, reused everywhere). Two tiers, assembled from
// existing idioms:
//
//   BENIGN  — a colored callout ("here's what this grants you") + a single
//             confirm button (the biometric fires in the caller's onConfirm).
//   SEVERE  — danger color + TYPE-TO-CONFIRM (reusing the TransferGiver /
//             AccountDeletion "type the domain" pattern) + a danger button, then
//             the biometric.
//
// Load-bearing rule — WHAT YOU SEE IS WHAT YOU SIGN: the caller derives [title]/
// [body]/[confirmWord] from the SAME parsed bytes the key signs (e.g. the
// verified transfer offer's serverDomain), so there's no gap between the preview
// and the signed payload. Mirror of the iOS TieredConfirm sheet.

package com.flagshipserver.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.ui.theme.FS

enum class ConfirmTier { BENIGN, SEVERE }

/**
 * @param confirmWord for [ConfirmTier.SEVERE] the exact string the user must
 *   type (case-insensitive) to arm the confirm button — the load-bearing "what
 *   you see is what you sign" token (e.g. the server's FQDN). Ignored for BENIGN.
 * @param working disables the button + relabels while the signed action runs.
 * @param onConfirm fired on tap; the caller's biometric-gated signer runs here.
 */
@Composable
fun TieredConfirm(
    tier: ConfirmTier,
    title: String,
    body: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    modifier: Modifier = Modifier,
    confirmWord: String? = null,
    working: Boolean = false,
    fieldTag: String? = null,
    buttonTag: String? = null,
) {
    val accent = if (tier == ConfirmTier.SEVERE) FS.colors.danger else FS.colors.primary
    var typed by remember { mutableStateOf("") }
    val needsType = tier == ConfirmTier.SEVERE && !confirmWord.isNullOrEmpty()
    val typedOk = !needsType || typed.trim().equals(confirmWord!!.trim(), ignoreCase = true)
    val armed = typedOk && !working

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Text(
            title,
            color = FS.colors.text,
            style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium),
        )
        // Colored callout — benign teal / severe danger tint.
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(FS.radius.sm))
                .background(accent.copy(alpha = 0.12f))
                .padding(FS.space.s3),
        ) {
            Text(body, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
        }
        if (needsType) {
            FSField(
                value = typed,
                onValueChange = { typed = it },
                label = "Type “$confirmWord” to confirm",
                placeholder = confirmWord,
                fieldTag = fieldTag,
            )
        }
        val btnMod = if (buttonTag != null) Modifier.testTag(buttonTag) else Modifier
        val label = if (working) "Working…" else confirmLabel
        if (tier == ConfirmTier.SEVERE) {
            FSDangerButton(
                label = label,
                onClick = { if (armed) onConfirm() },
                enabled = armed,
                block = true,
                modifier = btnMod,
            )
        } else {
            FSPrimaryButton(
                label = label,
                onClick = { if (!working) onConfirm() },
                enabled = !working,
                block = true,
                modifier = btnMod,
            )
        }
    }
}
