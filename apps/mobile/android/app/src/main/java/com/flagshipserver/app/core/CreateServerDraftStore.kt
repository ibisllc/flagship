// Local, draft-only metadata the user fills in before delivering an
// InstallBlob. Kotlin mirror of FlagshipCore/CreateServerDraftStore.swift.
//
// Deliberately NOT signed into the InstallBlob (the audit confirmed
// `backupPolicy` does not appear in the canonical bytes), so it lives only on
// this device and only as user intent. The box reads it later via an
// owner-signed `set-backup-policy` order.
//
// Mirrors the webapp's draft schema (apps/web/public/webapp/lib/buildDraft.js):
//   - backupPolicy ∈ {"none", "phone-only", "peer"}, default "phone-only".
//
// Persistence is plain SharedPreferences (non-secret, device-local). There is
// one in-flight draft at a time (create-server is single-instance), so we
// don't key by an id; resuming the screen after dismissal restores the last
// value the user picked, and reset() wipes it after a successful delivery.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

class CreateServerDraftStore(private val prefs: SharedPreferences) {
    enum class BackupPolicy(val wire: String) {
        /** Phone-side scheduled pull; the default. Mirrors the webapp default. */
        PHONE_ONLY("phone-only"),

        /** Peer-backup distribution to other Flagship users. */
        PEER("peer"),

        /** No automatic backup. Power-user opt-out. */
        NONE("none");

        companion object {
            fun fromWire(s: String?): BackupPolicy? = entries.firstOrNull { it.wire == s }
        }
    }

    /** The user's chosen backup policy — absent ⇒ the default ("phone-only"). */
    fun backupPolicy(): BackupPolicy =
        BackupPolicy.fromWire(prefs.getString(BACKUP_POLICY_KEY, null)) ?: BackupPolicy.PHONE_ONLY

    fun setBackupPolicy(policy: BackupPolicy) {
        prefs.edit().putString(BACKUP_POLICY_KEY, policy.wire).apply()
    }

    /** Wipe the draft back to defaults. Called after a successful delivery so
     *  the next "Add a server" doesn't ghost-restore yesterday's pick onto a
     *  fresh build. */
    fun reset() {
        prefs.edit().remove(BACKUP_POLICY_KEY).apply()
    }

    companion object {
        private const val PREFS = "flagship.createServerDraft"
        private const val BACKUP_POLICY_KEY = "backupPolicy"

        fun from(context: Context): CreateServerDraftStore =
            CreateServerDraftStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
