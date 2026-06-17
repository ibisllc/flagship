// Robolectric tests for CreateServerDraftStore — the device-local, draft-only
// backup-policy metadata for the create-server flow. Mirror of the iOS
// CreateServerDraftStore (UserDefaults) semantics: default "phone-only",
// round-trips, and reset()-to-default after a successful delivery.

package com.flagshipserver.app.core

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CreateServerDraftStoreTest {

    private fun freshStore(): CreateServerDraftStore {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val prefs = ctx.getSharedPreferences("draft.${System.nanoTime()}", android.content.Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
        return CreateServerDraftStore(prefs)
    }

    @Test fun defaultsToPhoneOnly() {
        assertEquals(CreateServerDraftStore.BackupPolicy.PHONE_ONLY, freshStore().backupPolicy())
    }

    @Test fun backupPolicyRoundTrips() {
        val store = freshStore()
        store.setBackupPolicy(CreateServerDraftStore.BackupPolicy.PEER)
        assertEquals(CreateServerDraftStore.BackupPolicy.PEER, store.backupPolicy())
        store.setBackupPolicy(CreateServerDraftStore.BackupPolicy.NONE)
        assertEquals(CreateServerDraftStore.BackupPolicy.NONE, store.backupPolicy())
    }

    @Test fun resetReturnsToTheDefault() {
        val store = freshStore()
        store.setBackupPolicy(CreateServerDraftStore.BackupPolicy.NONE)
        store.reset()
        // After a successful delivery a fresh "Add a server" starts at default.
        assertEquals(CreateServerDraftStore.BackupPolicy.PHONE_ONLY, store.backupPolicy())
    }

    // The wire tokens must match the webapp draft + iOS raw values exactly so
    // a future owner-signed set-backup-policy order means the same thing.
    @Test fun wireTokensMatchTheContract() {
        assertEquals("phone-only", CreateServerDraftStore.BackupPolicy.PHONE_ONLY.wire)
        assertEquals("peer", CreateServerDraftStore.BackupPolicy.PEER.wire)
        assertEquals("none", CreateServerDraftStore.BackupPolicy.NONE.wire)
        assertEquals(CreateServerDraftStore.BackupPolicy.PEER, CreateServerDraftStore.BackupPolicy.fromWire("peer"))
        assertEquals(null, CreateServerDraftStore.BackupPolicy.fromWire("bogus"))
    }
}
