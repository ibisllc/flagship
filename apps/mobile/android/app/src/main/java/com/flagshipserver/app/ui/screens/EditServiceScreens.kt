// "Edit this service": change an installed service's code, either by
// describing the change to the AI chat or from the owner's own IDE. Either
// way the new version replaces the running one in place (same address, same
// data).
//
// MIRRORS: iOS EditServiceScreens.swift, webapp views/edit-service.js.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.BuildCredential
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.VibeCodeNameCheck
import com.flagshipserver.app.api.VibeCodeStartRequest
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.shell.tabs.openBuildSessions
import com.flagshipserver.app.ui.shell.tabs.openEditSession
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.PendingBuildCredential
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

object EditService {
    const val ROW_TITLE = "Edit this service"
    const val ROW_CAPTION = "Change it with AI, or in your own editor"
    const val AI_TITLE = "Describe the change"
    const val AI_SUBTITLE = "Tell the AI what to change. It starts from the current code."
    const val IDE_TITLE = "Use your IDE"
    const val IDE_SUBTITLE = "Connect Cursor, Cline or another editor and change it with your own AI."
    const val REPLACE_NOTE =
        "The new version replaces the one running now. Its address, data and the people who can open it stay the same."
    const val PROMPT_LABEL = "What should change?"
    const val PROMPT_HINT = "For example: \"Add a due date to each item and sort by it.\""

    /** The slug half of a `<creator>--<slug>` service id. */
    fun slug(serviceId: String): String = serviceId.substringAfter("--")

    fun title(name: String) = "Edit $name"

    fun canStart(prompt: String, starting: Boolean) = !starting && prompt.isNotBlank()

    /** The "Connect your IDE" intro when the IDE changes an installed service. */
    fun ideIntro(name: String) =
        "Your editor's agent changes $name on your server, starting from its current code, using your own AI subscription. Deploying from the IDE replaces the running version; its address and data stay the same."

    fun keyRoute(serviceId: String) = "edit/key/$serviceId"
    fun describeRoute(serviceId: String) = "edit/describe/$serviceId"
    fun mcpRoute(serviceId: String) = "edit/mcp/$serviceId"
}

/** Why the box wouldn't start an edit session. */
sealed interface EditStartRefusal {
    /** Another session is already changing this service. */
    data object SessionOpen : EditStartRefusal

    /** Too much code for the AI chat; the IDE route can take it. */
    data class TooBig(val message: String) : EditStartRefusal

    data class Other(val message: String) : EditStartRefusal

    val title: String
        get() = when (this) {
            SessionOpen -> "Already being changed"
            is TooBig -> "Too big for the AI chat"
            is Other -> "Couldn't start"
        }

    fun message(name: String): String = when (this) {
        SessionOpen ->
            "A build session is already changing $name. Open it from Build sessions, or discard it there to start over."
        is TooBig -> message
        is Other -> message
    }

    companion object {
        /** Read the box's refusal of `vibeCodeStart`. */
        fun from(error: Throwable): EditStartRefusal {
            if (VibeCodeNameCheck.conflict(error)?.kind == "session") return SessionOpen
            val msg = error.boxError()
            if (error is ScreensError.Http && error.status == 413) {
                return TooBig(msg ?: "This service is too big to change in the AI chat. Use your IDE instead.")
            }
            return Other(msg ?: NetworkErrorHumanizer.humanize(error))
        }
    }
}

@Composable
private fun EditScaffold(title: String, onBack: () -> Unit, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s12))
        Text(
            text = title,
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s6))
        content()
        Spacer(Modifier.height(FS.space.s6))
        FSGhostButton("Back", onClick = onBack, block = true)
        Spacer(Modifier.height(FS.space.s12))
    }
}

/** The chooser: the AI chat or the owner's IDE. */
@Composable
fun EditServiceScreen(nav: NavController, serviceId: String) {
    EditScaffold(title = EditService.title(EditService.slug(serviceId)), onBack = { nav.popBackStack() }) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            EditOption(
                icon = Icons.Outlined.AutoAwesome,
                title = EditService.AI_TITLE,
                subtitle = EditService.AI_SUBTITLE,
                testTag = "edit-service-ai",
                onClick = { nav.navigate(EditService.keyRoute(serviceId)) },
            )
            EditOption(
                icon = Icons.Outlined.Laptop,
                title = EditService.IDE_TITLE,
                subtitle = EditService.IDE_SUBTITLE,
                testTag = "edit-service-ide",
                onClick = { nav.navigate(EditService.mcpRoute(serviceId)) },
            )
        }
        Spacer(Modifier.height(FS.space.s4))
        Text(
            EditService.REPLACE_NOTE,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
    }
}

@Composable
private fun EditOption(
    icon: ImageVector,
    title: String,
    subtitle: String,
    testTag: String,
    onClick: () -> Unit,
) {
    FSCard(
        padding = PaddingValues(FS.space.s4),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .testTag(testTag),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = FS.colors.primary, modifier = Modifier.width(28.dp))
            Spacer(Modifier.width(FS.space.s3))
            Column(Modifier.weight(1f)) {
                Text(title, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                Text(subtitle, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
            }
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = FS.colors.textMuted)
        }
    }
}

/**
 * What should change, for the AI chat. Starting runs the same build session
 * screen as a new service, directly above the service's page; deploying from
 * it replaces this one.
 */
@Composable
fun EditDescribeScreen(nav: NavController, serviceId: String) {
    val screens = LocalScreensClient.current
    val scope = rememberCoroutineScope()
    val name = EditService.slug(serviceId)
    var prompt by remember { mutableStateOf("") }
    var starting by remember { mutableStateOf(false) }
    var refusal by remember { mutableStateOf<EditStartRefusal?>(null) }

    EditScaffold(title = EditService.title(name), onBack = { nav.popBackStack() }) {
        Text(
            EditService.PROMPT_LABEL,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(180.dp)
                .clip(RoundedCornerShape(FS.radius.sm))
                .background(FS.colors.surfaceSunken)
                .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.sm))
                .padding(14.dp),
        ) {
            BasicTextField(
                value = prompt,
                onValueChange = { prompt = it },
                cursorBrush = SolidColor(FS.colors.primary),
                textStyle = TextStyle(color = FS.colors.text, fontSize = 16.sp, lineHeight = 22.sp),
                modifier = Modifier.fillMaxSize().testTag("edit-describe-prompt"),
            )
        }
        Spacer(Modifier.height(FS.space.s2))
        Text(EditService.PROMPT_HINT, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
        Spacer(Modifier.height(FS.space.s6))
        FSPrimaryButton(
            label = if (starting) "Starting…" else "Start",
            modifier = Modifier.testTag("edit-describe-start"),
            enabled = EditService.canStart(prompt, starting),
            block = true,
            large = true,
            onClick = {
                if (starting) return@FSPrimaryButton
                starting = true
                // Main, as on the new-build describe screen: the navigation
                // after the call must run on the main thread.
                scope.launch(Dispatchers.Main) {
                    try {
                        val cred = PendingBuildCredential.peek()?.let {
                            BuildCredential(it.provider, it.apiKey, it.baseUrl)
                        }
                        val resp = screens.vibeCodeStart(
                            VibeCodeStartRequest(prompt = prompt, credential = cred, editServiceId = serviceId),
                        )
                        if (resp.needsCredential) {
                            nav.navigate(EditService.keyRoute(serviceId))
                        } else {
                            PendingBuildCredential.take()
                            nav.openEditSession(resp.sessionId, serviceId)
                        }
                    } catch (t: Throwable) {
                        refusal = EditStartRefusal.from(t)
                    } finally {
                        starting = false
                    }
                }
            },
        )
    }

    refusal?.let { r ->
        AlertDialog(
            onDismissRequest = { refusal = null },
            title = { Text(r.title) },
            text = { Text(r.message(name)) },
            confirmButton = {
                when (r) {
                    EditStartRefusal.SessionOpen -> TextButton(
                        onClick = {
                            refusal = null
                            nav.openBuildSessions()
                        },
                        modifier = Modifier.testTag("edit-describe-open-sessions"),
                    ) { Text("Open build sessions") }
                    is EditStartRefusal.TooBig -> TextButton(
                        onClick = {
                            refusal = null
                            nav.navigate(EditService.mcpRoute(serviceId))
                        },
                        modifier = Modifier.testTag("edit-describe-use-ide"),
                    ) { Text("Use your IDE") }
                    is EditStartRefusal.Other -> TextButton(onClick = { refusal = null }) { Text("OK") }
                }
            },
            dismissButton = {
                if (r !is EditStartRefusal.Other) {
                    TextButton(onClick = { refusal = null }) { Text("OK") }
                }
            },
        )
    }
}
