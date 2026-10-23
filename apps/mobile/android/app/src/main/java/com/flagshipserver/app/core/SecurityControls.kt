// Three owner controls from the 0.3 security work, one wire each (mirror of
// FlagshipAPI/SecurityControls.swift and the webapp's lib/restoredAccess.js, lib/updateMode.js and
// lib/companionDelegation.js):
//  - permissions a restore held back (N09): approve the exact draft, or discard it;
//  - how an app takes updates (N11): manual (default), staged, automatic or frozen;
//  - letting one Remote browser session build or deploy one app (SEC-AUTH-002).

package com.flagshipserver.app.core

import com.flagshipserver.app.R
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
    val RESTORED_TITLE get() = FSStrings.get(R.string.restored_permissions)
    val RESTORED_INTRO get() = FSStrings.get(R.string.this_app_came_back_from_a)
    val RESTORED_APPROVE get() = FSStrings.get(R.string.approve_this_list)
    val RESTORED_DISCARD get() = FSStrings.get(R.string.discard_it)
    val RESTORED_ADMIN_ONLY get() = FSStrings.get(R.string.only_an_admin_device_can_approve)

    const val UPDATES_TITLE = "Updates"

    fun updateLabel(mode: String): String? = when (mode) {
        "manual" -> FSStrings.get(R.string.ask_me_each_time)
        "staged" -> FSStrings.get(R.string.wait_a_week_then_update)
        "auto" -> FSStrings.get(R.string.update_automatically)
        "frozen" -> FSStrings.get(R.string.never_update)
        else -> null
    }

    fun updateNote(mode: String): String? = when (mode) {
        "manual" -> FSStrings.get(R.string.you_approve_every_update)
        "staged" -> FSStrings.get(R.string.a_verified_update_from_the_same)
        "auto" -> FSStrings.get(R.string.a_verified_update_from_the_same_2)
        "frozen" -> FSStrings.get(R.string.this_app_stays_on_the_version)
        else -> null
    }

    val DELEGATE_OPEN get() = FSStrings.get(R.string.let_it_build)
    val DELEGATE_TITLE get() = FSStrings.get(R.string.let_this_browser_build_an_app)
    val DELEGATE_INTRO get() = FSStrings.get(R.string.a_browser_docked_through_remote_can)
    val DELEGATE_BUILD get() = FSStrings.get(R.string.change_the_app_build)
    val DELEGATE_DEPLOY get() = FSStrings.get(R.string.put_changes_live_deploy)
    const val DELEGATE_ALLOW = "Allow"
    val DELEGATE_END get() = FSStrings.get(R.string.end_it)
    val DELEGATE_ADMIN_ONLY get() = FSStrings.get(R.string.only_an_admin_device_can_let)
}
