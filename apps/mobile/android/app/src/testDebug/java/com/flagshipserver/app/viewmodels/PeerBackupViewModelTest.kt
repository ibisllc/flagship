// Peer-backup status view model: loads the v2 screen and humanises failures.
// Mirrors the webapp's views/peer-backup.js (the participation toggle is gone:
// peer backup is a backup policy now).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.PeerBackupHolder
import com.flagshipserver.app.api.PeerBackupStatusResponse
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.PeerBackup
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PeerBackupViewModelTest {

    @Test fun mockDefault_isTheV2Screen() = runTest {
        val r = MockScreensClient(simulatedLatencyMs = 0).peerBackupStatus()
        assertEquals(2, r.v)
        assertEquals("protected", r.state)
        assertEquals(listOf("Server 1", "Server 2", "Server 3"), r.holderList!!.map { it.label })
    }

    @Test fun load_landsLoadedWithTheV2Fields() = runTest {
        val vm = PeerBackupViewModel(MockScreensClient(simulatedLatencyMs = 0), scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertEquals(8, s.value.healthyBricks)
        assertEquals(9, s.value.totalBricks)
        val rows = PeerBackup.holderRows(s.value, formatTime = { "T" })
        assertEquals(3, rows.size)
        assertEquals("Server 1", rows[0].label)
        assertTrue(rows[2].line, rows[2].line.startsWith("Not answering"))
    }

    @Test fun load_pinnedFixture_isReturnedVerbatim() = runTest {
        val base = MockScreensClient(simulatedLatencyMs = 0).peerBackupStatus()
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            peerBackupStatusFixture = base.copy(state = "at-risk", holderList = listOf(PeerBackupHolder("Server 1", "offline", null, 0)))
        }
        val vm = PeerBackupViewModel(client, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertEquals("at-risk", s.value.state)
        assertEquals("Offline · no proof yet · 0 pieces", PeerBackup.holderRows(s.value)[0].line)
    }

    private fun failing(status: Int): ScreensClient = object : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
        override suspend fun peerBackupStatus(): PeerBackupStatusResponse = throw ScreensError.Http(status, "transport down")
    }

    @Test fun load_aBoxWithoutTheEndpointSaysToUpdate() = runTest {
        val vm = PeerBackupViewModel(failing(404), scope = backgroundScope)
        vm.load().join()
        assertEquals(PeerBackup.OLDER_ENGINE, (vm.state.first() as LoadingState.Failed).message)
    }

    @Test fun load_notSetUpSaysSo() = runTest {
        val vm = PeerBackupViewModel(failing(503), scope = backgroundScope)
        vm.load().join()
        assertEquals(PeerBackupViewModel.NOT_SET_UP, (vm.state.first() as LoadingState.Failed).message)
    }

    @Test fun load_transportError_landsInFailedHumanised() = runTest {
        val vm = PeerBackupViewModel(failing(500), scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first()
        assertTrue("expected Failed, was $s", s is LoadingState.Failed)
        val msg = (s as LoadingState.Failed).message
        assertFalse(msg, msg.contains("500") || msg.contains("transport down"))
        assertTrue(msg, msg.contains("try again", ignoreCase = true))
    }
}
