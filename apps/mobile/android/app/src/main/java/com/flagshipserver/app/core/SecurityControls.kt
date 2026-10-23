// Three owner controls from the 0.3 security work, one wire each (mirror of
// FlagshipAPI/SecurityControls.swift and the webapp's lib/restoredAccess.js, lib/updateMode.js and
// lib/companionDelegation.js):
//  - permissions a restore held back (N09): approve the exact draft, or discard it;
//  - how an app takes updates (N11): manual (default), staged, automatic or frozen;
//  - letting one Remote browser session build or deploy one app (SEC-AUTH-002).

package com.flagshipserver.app.core

import kotlinx.serialization.Serializable

@Serializable
data class RestoredAccessDraft(val serviceRef: String, val sha256: String, val people: Int = 0, val mode: String = "restricted", val restoredAt: Long = 0)

@Serializable
data class RestoredAccessList(val drafts: List<RestoredAccessDraft> = emptyList())

@Serializable
data class RestoredAccessApproveBody(val request: RestoredApproveRequest, val signature: String)

@Serializable
data class RestoredApproveRequest(val serviceRef: String, val draftSha256: String, val issuedAt: Long)

@Serializable
data class RestoredDiscardBody(val serviceRef: String)

@Serializable
data class UpdateModeState(val mode: String, val modes: List<String> = emptyList(), val stagedHoldDays: Int = 7)

@Serializable
data class UpdateModeBody(val mode: String)

@Serializable
data class CompanionDelegationRow(val serviceRef: String, val ops: List<String>, val expiresAt: Long? = null)

@Serializable
data class CompanionDelegationList(val delegations: List<CompanionDelegationRow> = emptyList())

@Serializable
data class CompanionDelegationRequest(val sessionId: String, val serviceRef: String, val ops: List<String>, val issuedAt: Long, val expiresAt: Long)

@Serializable
data class CompanionDelegationBody(val delegation: CompanionDelegationRequest, val signature: String)

@Serializable
data class CompanionDelegationEnd(val sessionId: String, val serviceRef: String)

object SecurityControlWords {
    const val RESTORED_TITLE = "Restored permissions"
    const val RESTORED_INTRO = "This app came back from a backup. Until an admin approves, nobody from the old list can open it."
    const val RESTORED_APPROVE = "Approve this list"
    const val RESTORED_DISCARD = "Discard it"
    const val RESTORED_ADMIN_ONLY = "Only an admin device can approve restored permissions."

    const val UPDATES_TITLE = "Updates"

    fun updateLabel(mode: String): String? = when (mode) {
        "manual" -> "Ask me each time"
        "staged" -> "Wait a week, then update"
        "auto" -> "Update automatically"
        "frozen" -> "Never update"
        else -> null
    }

    fun updateNote(mode: String): String? = when (mode) {
        "manual" -> "You approve every update."
        "staged" -> "A verified update from the same publisher is held for a week, then goes in. Anything that asks for more access still waits for you."
        "auto" -> "A verified update from the same publisher goes in at once. Anything that asks for more access still waits for you."
        "frozen" -> "This app stays on the version it is on."
        else -> null
    }

    const val DELEGATE_OPEN = "Let it build…"
    const val DELEGATE_TITLE = "Let this browser build an app"
    const val DELEGATE_INTRO = "A browser docked through Remote can only look. This lets it change one app you pick, for a short time. It ends on its own, or when you end it, or when the session ends."
    const val DELEGATE_BUILD = "Change the app (build)"
    const val DELEGATE_DEPLOY = "Put changes live (deploy)"
    const val DELEGATE_ALLOW = "Allow"
    const val DELEGATE_END = "End it"
    const val DELEGATE_ADMIN_ONLY = "Only an admin device can let a browser build."
}
