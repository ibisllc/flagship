// Per-app disk limits on Android (docs/app-runtimes.md 5.3): the lines on the
// app page, the notes on the server's Backups section, how the box's JSON
// decodes, and the app-storage-full alert. Twin of the webapp's
// webappAppStorage.test.ts, word for word.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.AppStorage
import com.flagshipserver.app.api.PhoneAlert
import com.flagshipserver.app.api.PhoneAlertClient
import com.flagshipserver.app.api.PhoneAlertsResponse
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.api.ServerStorage
import com.flagshipserver.app.api.StoreUsage
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppStorageTextTest {
    private val gb = 1024L * 1024 * 1024
    private val json = Json { ignoreUnknownKeys = true }

    @Test fun showsFilesAndDatabaseUseAgainstTheirLimits() {
        val lines = AppStorageText.appLines(
            AppStorage(
                files = StoreUsage(usedBytes = 2 * gb, limitBytes = 5 * gb),
                postgres = StoreUsage(usedBytes = 300L * 1024 * 1024, limitBytes = gb),
            ),
        )
        assertEquals(listOf("Files", "Database"), lines.map { it.label })
        assertTrue(lines.all { !it.full && it.note.isEmpty() })
        assertEquals("2.0 GB of 5.0 GB", lines[0].text)
        assertTrue(lines[1].text, lines[1].text.startsWith("300 MB"))
    }

    @Test fun saysWhyNewDataIsRefusedWhenFullOrClosed() {
        val lines = AppStorageText.appLines(
            AppStorage(
                files = StoreUsage(usedBytes = 5 * gb, limitBytes = 5 * gb, full = true),
                postgres = StoreUsage(usedBytes = 2 * gb, limitBytes = gb, writesBlocked = true, stopped = true),
            ),
        )
        assertEquals(AppStorageText.FULL_SENTENCE, lines[0].note)
        assertTrue(lines[1].full)
        assertEquals(AppStorageText.STOPPED_SENTENCE, lines[1].note)
    }

    @Test fun showsNothingForABoxThatSendsNoStorage() {
        assertEquals(emptyList<AppStorageText.Line>(), AppStorageText.appLines(null))
        assertEquals(emptyList<String>(), AppStorageText.serverNotes(null))
    }

    @Test fun listsFullAppsByNameAndTheDiskBrake() {
        val notes = AppStorageText.serverNotes(
            ServerStorage(
                brake = "on",
                apps = listOf(
                    com.flagshipserver.app.api.AppStorageEntry("a", files = StoreUsage(full = true)),
                    com.flagshipserver.app.api.AppStorageEntry("b", postgres = StoreUsage(usedBytes = 1)),
                ),
            ),
        ) { "App $it" }
        assertEquals(2, notes.size)
        assertTrue(notes[0].contains("nearly full"))
        assertTrue(notes[1].contains("App a is full"))
    }

    @Test fun decodesTheBoxsStorageOnServerAndAppDetail() {
        val server = json.decodeFromString(
            ServerDetailResponse.serializer(),
            """{"serverFqdn":"h.u.flagship.services","username":"u","daemonVersion":"1","startedAt":1,"uptimeMs":1,"serviceCount":1,"pairedSessionCount":0,"recentInstallEvents":[],
               "storage":{"disk":{"totalBytes":10,"usedBytes":9},"brake":"hard","capped":true,
                 "apps":[{"serviceId":"u--wiki","files":{"usedBytes":5,"limitBytes":5,"full":true,"enforced":true}}]}}""",
        )
        assertEquals("hard", server.storage?.brake)
        assertTrue(server.storage!!.apps.single().files!!.full)
        val older = json.decodeFromString(
            ServerDetailResponse.serializer(),
            """{"serverFqdn":"h.u.flagship.services","username":"u","daemonVersion":"1","startedAt":1,"uptimeMs":1,"serviceCount":1,"pairedSessionCount":0,"recentInstallEvents":[]}""",
        )
        assertNull(older.storage)
        val app = json.decodeFromString(
            AppStorage.serializer(),
            """{"postgres":{"usedBytes":2,"limitBytes":1,"full":true,"writesBlocked":true,"stopped":true}}""",
        )
        assertTrue(app.postgres!!.stopped)
        assertNull(app.files)
    }

    private class Fake(var response: PhoneAlertsResponse) : PhoneAlertClient {
        val acked = mutableListOf<Int>()
        override suspend fun fetchAlerts(since: Int) = response
        override suspend fun ackAlerts(throughId: Int) { acked += throughId }
    }

    @Test fun theAlertParsesAndReachesTheNotifierOncePerApp() = runTest {
        val resp = PhoneAlertsResponse.parse(
            """{"events":[{"id":4,"emittedAt":1,"alert":{"kind":"app-storage-full","serviceId":"svc-1","store":"files"}}],"size":1}""",
        )
        assertEquals(PhoneAlert.AppStorageFull("svc-1", "files"), resp.events.single().alert)
        val client = Fake(resp)
        val got = mutableListOf<Pair<String, String?>>()
        val poller = AiChatAlertPoller(
            operations = ActiveOperationsCenter(),
            client = client,
            isActiveGate = { true },
            notify = { _, _, _ -> throw AssertionError("not an AI-chat alert") },
            currentServer = { "home.alice.flagship.services" },
            notifyStorageFull = { id, server -> got += id to server },
        )
        poller.drainOnce()
        poller.drainOnce()
        assertEquals(listOf("svc-1" to "home.alice.flagship.services"), got)
        assertEquals(listOf(4), client.acked)
    }

    @Test fun anAlertWithNoAppIsIgnored() {
        val resp = PhoneAlertsResponse.parse("""{"events":[{"id":1,"alert":{"kind":"app-storage-full"}}],"size":1}""")
        assertFalse(resp.events.single().alert is PhoneAlert.AppStorageFull)
    }
}
