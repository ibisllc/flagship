// Pair to an existing pod. Mirrors FlagshipUI/Screens/PodPairScreen.swift.
//
// User scans the QR shown on the existing pod's webapp at
// /webapp/?view=pod-pair, or types the 6-char fallback code. We accept
// the code + name + description, then hand back to the caller which
// owns the add-pod + token-store mutations.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS

@Composable
fun PodPairScreen(
    onSubmit: (code: String, name: String, description: String) -> Unit,
    onCancel: () -> Unit,
) {
    var pairCode by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    val scroll = rememberScrollState()

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s12))
        Text(
            "Pair to your server",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Open the Flagship webapp on a device that's already signed in. Scan the QR it shows, or paste the 6-character pair code below.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s4))
        QRScanner(onScanned = { pairCode = it })

        Spacer(Modifier.height(FS.space.s4))
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column {
                Text(
                    "OR ENTER A CODE",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s2))
                FSField(value = pairCode, onValueChange = { pairCode = it }, label = "Pair code", placeholder = "ABC123")
            }
        }

        Spacer(Modifier.height(FS.space.s3))
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column {
                Text(
                    "NAME THIS SERVER",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s2))
                FSField(value = name, onValueChange = { name = it }, label = "Short name", placeholder = "Office, Garage")
                Spacer(Modifier.height(FS.space.s2))
                FSField(value = description, onValueChange = { description = it }, label = "One-line description", placeholder = "Failover for work")
            }
        }

        Spacer(Modifier.height(FS.space.s4))
        FSPrimaryButton(
            label = "Connect",
            onClick = { onSubmit(pairCode, name, description) },
            enabled = pairCode.length >= 6 && name.isNotBlank(),
            block = true,
        )
        FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
        Spacer(Modifier.height(FS.space.s12))
    }
}
