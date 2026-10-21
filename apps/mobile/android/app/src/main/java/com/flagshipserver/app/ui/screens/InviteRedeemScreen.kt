// Friend-side redeem screen (docs/service-access-gating.md §v2 hardening). Mirror
// of iOS InviteRedeemScreen + the webapp views/invite-redeem.js. Reached from a
// `https://<server>.<user>.flagship.services/invite#<secret>&a=<authorAID>[&i=<inviteId>]`
// universal link (or older box pages' flagship://invite). "Accept" signs the redeem
// with the friend's PER-AUTHOR contact AID against the box; an AUTO invite
// confirms immediately, an APPROVE (manual) invite produces a confirmation reply
// the friend sends back to the author to finalize.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.QrImage
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.InviteRedeemPhase
import com.flagshipserver.app.viewmodels.InviteRedeemViewModel
import kotlinx.coroutines.launch

/**
 * @param authorAidHex the author AID parsed from the invite link (or null for a
 *   legacy link — the friend then redeems with the global AID).
 * @param onOpenService invoked with the box host when the friend taps "Open it".
 * @param onDone invoked when the friend taps "Go to Flagship".
 */
@Composable
fun InviteRedeemScreen(
    serverDomain: String,
    secretHex: String,
    authorAidHex: String? = null,
    inviteIdHex: String? = null,
    serviceRef: String? = null,
    onOpenService: (String) -> Unit,
    onDone: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    val ctx = LocalContext.current
    val vm = remember(serverDomain, secretHex, authorAidHex, inviteIdHex, serviceRef) {
        InviteRedeemViewModel(
            serverDomain = serverDomain, secretHex = secretHex, authorAidHex = authorAidHex,
            inviteIdHex = inviteIdHex, serviceRef = serviceRef,
        )
    }
    val phase by vm.phase.collectAsState()

    FSScreen(title = "Accept invite", onBack = onDone) {
        when (val p = phase) {
            is InviteRedeemPhase.Done -> FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text(stringResource(R.string.youre_in), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleLarge)
                    Text(
                        fsString(R.string.your_account_now_has_access_to, p.serviceRef.ifEmpty { stringResource(R.string.the_service) }) +
                            if (!p.firstBind) " (You already had access — this link is linked to your account.)" else "",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    FSPrimaryButton(label = stringResource(R.string.open_it), block = true, large = true, onClick = { onOpenService(serverDomain) }, modifier = Modifier.semantics { testTag = "invite-redeem-open" })
                    FSSecondaryButton(label = stringResource(R.string.go_to_flagship), block = true, onClick = onDone)
                }
            }
            is InviteRedeemPhase.AwaitingApproval -> FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text(stringResource(R.string.one_more_step), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleLarge)
                    Text(
                        stringResource(R.string.this_invite_needs_the_owners_approval),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    QrImage(
                        payload = p.replyLink,
                        size = 180.dp,
                        contentDescription = stringResource(R.string.confirmation_reply_qr),
                        modifier = Modifier.semantics { testTag = "invite-redeem-reply-qr" },
                    )
                    Text(
                        p.replyBody,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { testTag = "invite-redeem-reply-body" },
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                        FSPrimaryButton(
                            label = stringResource(R.string.send_back),
                            onClick = { shareReply(ctx, p.replyLink) },
                            modifier = Modifier.weight(1f).semantics { testTag = "invite-redeem-reply-share" },
                        )
                        FSSecondaryButton(
                            label = stringResource(R.string.copy),
                            onClick = { copyReply(ctx, p.replyLink); toasts.success(FSStrings.get(R.string.confirmation_copied)) },
                            modifier = Modifier.weight(1f).semantics { testTag = "invite-redeem-reply-copy" },
                        )
                    }
                    FSSecondaryButton(label = stringResource(R.string.go_to_flagship), block = true, onClick = onDone)
                }
            }
            else -> FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text(stringResource(R.string.youve_been_invited), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleLarge)
                    Text(
                        fsString(R.string.this_grants_your_account_access_to, serverDomain),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    val redeeming = p is InviteRedeemPhase.Redeeming
                    FSPrimaryButton(
                        label = if (redeeming) stringResource(R.string.accepting) else "Accept & get access",
                        enabled = !redeeming,
                        block = true,
                        large = true,
                        onClick = { scope.launch { vm.redeem() } },
                        modifier = Modifier.semantics { testTag = "invite-redeem-accept" },
                    )
                    (p as? InviteRedeemPhase.Failed)?.let {
                        Text(it.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.semantics { testTag = "invite-redeem-error" })
                    }
                }
            }
        }
    }
}

private fun shareReply(ctx: Context, link: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, link)
    }
    val chooser = Intent.createChooser(send, FSStrings.get(R.string.send_confirmation))
    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(chooser)
}

private fun copyReply(ctx: Context, link: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText(FSStrings.get(R.string.flagship_invite_confirmation), link))
}
