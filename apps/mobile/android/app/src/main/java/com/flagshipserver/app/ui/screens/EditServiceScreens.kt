// "Edit this service": change an installed service's code, either by
// describing the change to the AI chat or from the owner's own IDE. Either
// way the new version replaces the running one in place (same address, same
// data).
//
// MIRRORS: iOS EditServiceScreens.swift, webapp views/edit-service.js.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
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
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.OutlinedTextField
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
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
    val ROW_TITLE get() = FSStrings.get(R.string.edit_this_service)
    val ROW_CAPTION get() = FSStrings.get(R.string.change_it_with_ai_or_in)
    val AI_TITLE get() = FSStrings.get(R.string.describe_the_change)
    val AI_SUBTITLE get() = FSStrings.get(R.string.tell_the_ai_what_to_change)
    val IDE_TITLE get() = FSStrings.get(R.string.use_your_ide)
    val IDE_SUBTITLE get() = FSStrings.get(R.string.connect_cursor_cline_or_another_editor)
    val REPLACE_NOTE get() =
        FSStrings.get(R.string.the_new_version_replaces_the_one)
    val PROMPT_LABEL get() = FSStrings.get(R.string.what_should_change)
    val PROMPT_HINT get() = FSStrings.get(R.string.for_example_add_a_due_date)

    /** The slug half of a `<creator>--<slug>` service id. */
    fun slug(serviceId: String): String = serviceId.substringAfter("--")

    fun title(name: String) = FSStrings.get(R.string.edit, name)

    fun canStart(prompt: String, starting: Boolean) = !starting && prompt.isNotBlank()

    /** The "Connect your IDE" intro when the IDE changes an installed service. */
    fun ideIntro(name: String) =
        FSStrings.get(R.string.your_editors_agent_changes_on_your, name)

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
            SessionOpen -> FSStrings.get(R.string.already_being_changed)
            is TooBig -> FSStrings.get(R.string.too_big_for_the_ai_chat)
            is Other -> FSStrings.get(R.string.couldnt_start)
        }

    fun message(name: String): String = when (this) {
        SessionOpen ->
            FSStrings.get(R.string.a_build_session_is_already_changing, name)
        is TooBig -> message
        is Other -> message
    }

    companion object {
        /** Read the box's refusal of `vibeCodeStart`. */
        fun from(error: Throwable): EditStartRefusal {
            if (VibeCodeNameCheck.conflict(error)?.kind == "session") return SessionOpen
            val msg = error.boxError()
            if (error is ScreensError.Http && error.status == 413) {
                return TooBig(msg ?: FSStrings.get(R.string.this_service_is_too_big_to))
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
                iconTint = FS.colors.accent,
                onClick = { nav.navigate(EditService.keyRoute(serviceId)) },
                modifier = Modifier.testTag("edit-service-ai"),
            )
            FSDivider()
            FSRow(
                title = EditService.IDE_TITLE,
                subtitle = EditService.IDE_SUBTITLE,
                icon = Icons.Outlined.Laptop,
                iconTint = FS.colors.accent,
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
            label = if (starting) stringResource(R.string.starting) else stringResource(R.string.start),
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
                    ) { Text(stringResource(R.string.open_build_sessions)) }
                    is EditStartRefusal.TooBig -> TextButton(
                        onClick = {
                            refusal = null
                            nav.navigate(EditService.mcpRoute(serviceId))
                        },
                        modifier = Modifier.testTag("edit-describe-use-ide"),
                    ) { Text(stringResource(R.string.use_your_ide)) }
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
