// Local, draft-only metadata the user fills in before delivering an
// InstallBlob. Kotlin mirror of FlagshipCore/CreateServerDraftStore.swift.
//
// Not part of the InstallBlob's signed bytes: the chosen policy is signed as
// its own `flagship/backup-policy/v1` order and rides beside the pairing order
// (docs/server-backup-and-clone.md, "Backup policy"); this store only keeps
// the draft while the user fills the form.
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
        /** Phone-side backups. */
        PHONE_ONLY("phone-only"),

        /** Peer-backup distribution to other Flagship users. */
        PEER("peer"),

        /** No automatic backup. Power-user opt-out. */
        NONE("none");

        /** The policy's name in `flagship/backup-policy/v1`. */
        val order: String get() = if (this == PHONE_ONLY) "phone" else wire

        companion object {
            fun fromWire(s: String?): BackupPolicy? = entries.firstOrNull { it.wire == s }
            fun fromOrder(s: String): BackupPolicy? = entries.firstOrNull { it.order == s }
        }
    }

    /** The phone's reserve for a phone-side backup, in GB; null ⇒ the default for this phone. */
    fun reserveGb(): Int? = prefs.getInt(RESERVE_KEY, 0).takeIf { it > 0 }

    fun setReserveGb(gb: Int) {
        prefs.edit().putInt(RESERVE_KEY, gb).apply()
    }

    /** The user's chosen backup policy; absent until they pick one (there is no default). */
    fun backupPolicy(): BackupPolicy? =
        // A saved "peer" pick is dropped while backups on other servers are off, so an old draft
        // can't create a Peer server (the box refuses it too).
        BackupPolicy.fromWire(prefs.getString(BACKUP_POLICY_KEY, null))
            ?.takeUnless { it == BackupPolicy.PEER && !BackupFeatures.PEER_BACKUP }

    fun setBackupPolicy(policy: BackupPolicy) {
        prefs.edit().putString(BACKUP_POLICY_KEY, policy.wire).apply()
    }

    /** Wipe the draft back to defaults. Called after a successful delivery so
     *  the next "Add a server" doesn't ghost-restore yesterday's pick onto a
     *  fresh build. */
    fun reset() {
        prefs.edit().remove(BACKUP_POLICY_KEY).remove(RESERVE_KEY).apply()
    }

    companion object {
        private const val PREFS = "flagship.createServerDraft"
        private const val BACKUP_POLICY_KEY = "backupPolicy"
        private const val RESERVE_KEY = "phoneReserveGb"

        fun from(context: Context): CreateServerDraftStore =
            CreateServerDraftStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
