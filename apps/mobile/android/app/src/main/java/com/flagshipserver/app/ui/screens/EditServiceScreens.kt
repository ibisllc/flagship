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
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import com.flagshipserver.app.api.LlmProviderCredential
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.VibeCodeNameCheck
import com.flagshipserver.app.api.VibeCodeStartRequest
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.shell.tabs.openBuildSessions
import com.flagshipserver.app.ui.shell.tabs.openEditSession
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.PendingBuildCredential
import com.flagshipserver.app.core.FreeAiSessions
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
private fun EditScaffold(title: String, onBack: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    FSScreen(title = title, onBack = onBack, content = content)
}

/** The chooser: the AI chat or the owner's IDE. */
@Composable
fun EditServiceScreen(nav: NavController, serviceId: String) {
    EditScaffold(title = EditService.title(EditService.slug(serviceId)), onBack = { nav.popBackStack() }) {
        FSGroup {
            FSRow(
                title = EditService.AI_TITLE,
                subtitle = EditService.AI_SUBTITLE,
                icon = Icons.Outlined.AutoAwesome,
                iconTint = MaterialTheme.colorScheme.primary,
                onClick = { nav.navigate(EditService.keyRoute(serviceId)) },
                modifier = Modifier.testTag("edit-service-ai"),
            )
            FSDivider()
            FSRow(
                title = EditService.IDE_TITLE,
                subtitle = EditService.IDE_SUBTITLE,
                icon = Icons.Outlined.Laptop,
                iconTint = MaterialTheme.colorScheme.primary,
                onClick = { nav.navigate(EditService.mcpRoute(serviceId)) },
                modifier = Modifier.testTag("edit-service-ide"),
            )
        }
        Text(
            EditService.REPLACE_NOTE,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = FS.space.s1),
        )
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
    val freeAiServer = currentBuildServerFqdn()

    EditScaffold(title = EditService.title(name), onBack = { nav.popBackStack() }) {
        OutlinedTextField(
            value = prompt,
            onValueChange = { prompt = it },
            label = { Text(EditService.PROMPT_LABEL) },
            supportingText = { Text(EditService.PROMPT_HINT) },
            textStyle = MaterialTheme.typography.bodyLarge,
            shape = MaterialTheme.shapes.small,
            minLines = 6,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 180.dp)
                .testTag("edit-describe-prompt"),
        )
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
                        val pending = PendingBuildCredential.peek()
                        val cred = pending?.let(LlmProviderCredential::from)
                        val startModel = com.flagshipserver.app.core.ModelMenus.startWire(
                            runCatching { com.flagshipserver.app.core.AiKeyStore.defaultModelFor(pending) }.getOrNull(),
                        )
                        val resp = screens.vibeCodeStart(
                            VibeCodeStartRequest(
                                prompt = prompt, credential = cred, editServiceId = serviceId,
                                // The default model chosen in Settings for this key; none ⇒ the box's.
                                model = startModel.first, effort = startModel.second,
                            ),
                        )
                        if (resp.needsCredential) {
                            nav.navigate(EditService.keyRoute(serviceId))
                        } else {
                            PendingBuildCredential.take()
                            com.flagshipserver.app.core.BuildSessionAi.remember(resp.sessionId, pending)
                            if (pending?.isFreeAi == true) {
                                FreeAiSessions.remember(resp.sessionId, freeAiServer)
                            }
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
