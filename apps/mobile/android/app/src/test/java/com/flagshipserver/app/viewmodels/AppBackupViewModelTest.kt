package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppBackupStartRequest
import com.flagshipserver.app.api.AppBackupStartResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// "Back up now": the box packs the app, then hands the archive to this phone.
class AppBackupViewModelTest {
    @Test fun backUpBringsTheArchiveTheBoxPacked() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AppBackupViewModel("harry--notes", client, now = { 1_760_000_000_000L })
        vm.backUp(includeData = true, password = "pw")
        val p = vm.phase.value as AppBackupViewModel.Phase.Ready
        assertEquals("mock app backup", String(p.bytes))
        assertTrue(p.encrypted)
        assertEquals("notes-backup-2025-10-09-0853.tar.gz.enc", p.fileName)
        assertEquals(1, client.appBackupFetches.size)
        assertTrue(client.appBackupFetches[0].startsWith("/api/backups/"))
    }

    @Test fun aRefusalSaysWhy() = runTest {
        val refusing = object : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
            override suspend fun appBackupStart(req: AppBackupStartRequest): AppBackupStartResponse =
                throw ScreensError.Http(503, "app-backup not configured")
        }
        val vm = AppBackupViewModel("harry--notes", refusing)
        vm.backUp(includeData = false, password = "")
        assertTrue(vm.phase.value is AppBackupViewModel.Phase.Failed)
        assertTrue(!vm.busy)
    }
}
