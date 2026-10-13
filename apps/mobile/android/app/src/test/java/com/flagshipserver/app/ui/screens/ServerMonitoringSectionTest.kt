// The server page's Monitoring pane: same rows, order and short values as iOS
// and the webapp; each row expands in place and says so to screen readers.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.flagshipserver.app.api.BoxHealthDaemonWire
import com.flagshipserver.app.api.BoxHealthWire
import com.flagshipserver.app.api.ServerMetricsResponse
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.LoadingState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val DAY = 86_400_000L
private const val GB = 1024L * 1024 * 1024

internal fun sampleMetrics(now: Long) = ServerMetricsResponse(
    collectedAt = now,
    cpuPercent = 12.4,
    loadAvg1 = 0.12, loadAvg5 = 0.3, loadAvg15 = 0.25,
    memUsedBytes = 3 * GB / 2, memTotalBytes = 4 * GB,
    diskUsedBytes = 41 * GB, diskTotalBytes = 100 * GB,
    diskIOReadBytesPerSec = 2048.0, diskIOWriteBytesPerSec = 0.0,
    netRxBytesPerSec = 12.0 * 1024, netTxBytesPerSec = 3.0 * 1024,
    cpuHistory = List(20) { ServerMetricsResponse.TimedSample(now - (20 - it) * 15_000L, 10.0 + it % 5) },
    memHistory = List(20) { ServerMetricsResponse.TimedSample(now - (20 - it) * 15_000L, 1.4 * GB + it * 1e7) },
    ioHistory = List(20) { ServerMetricsResponse.IOSample(now - (20 - it) * 15_000L, 2000.0 + it * 100, 500.0 + it * 50) },
    netHistory = List(20) { ServerMetricsResponse.IOSample(now - (20 - it) * 15_000L, 12000.0 - it * 200, 3000.0 + it * 80) },
)

internal fun sampleCert(now: Long) = MonitoringCert(
    notAfter = now + 42 * DAY,
    notBefore = now - 48 * DAY,
    sans = listOf("home2.plucky-avocet.flagship.services", "*.home2.plucky-avocet.flagship.services"),
)

internal fun sampleHealth(now: Long, tunnel: Boolean = true) = BoxHealthWire(
    v = 1, at = now - 30_000, uptimeS = 3 * 86_400L, memTotalMB = 3900, memAvailMB = 2100,
    swapUsedMB = 0, oomKills = 0, daemon = BoxHealthDaemonWire(state = "active", restarts = 0, lastExit = 0),
    tunnel = tunnel, diskUsedPct = 41, receivedAt = now - 30_000,
)

class MonitoringRowsTest {
    private val now = 1_760_000_000_000L
    private val gb = GB

    private fun metrics(diskUsed: Long = 50) = sampleMetrics(now).copy(
        cpuPercent = 23.4,
        memUsedBytes = 4 * gb, memTotalBytes = 16 * gb,
        diskUsedBytes = diskUsed * gb, diskTotalBytes = 100 * gb,
        netRxBytesPerSec = 2048.0, netTxBytesPerSec = 3.0 * 1024 * 1024,
    )

    private fun rows(
        health: BoxHealthWire? = null,
        metrics: LoadingState<ServerMetricsResponse>? = null,
        cert: MonitoringCert? = null,
    ) = MonitoringRows.build(health, metrics, cert, now)

    @Test fun orderAndLabelsMatchIos() {
        val r = rows(sampleHealth(now), LoadingState.Loaded(metrics()), MonitoringCert(now + 40 * DAY))
        assertEquals(listOf("Health", "CPU", "Memory", "Disk", "Network", "Certificate"), r.map { it.key.title })
    }

    @Test fun collapsedValuesMatchIos() {
        val v = rows(sampleHealth(now), LoadingState.Loaded(metrics()), MonitoringCert(now + 40 * DAY))
            .associate { it.key to it.value }
        assertEquals("Healthy", v[MonitoringKey.HEALTH])
        assertEquals("23%", v[MonitoringKey.CPU])
        assertEquals("4.0 GB of 16.0 GB", v[MonitoringKey.MEMORY])
        assertEquals("50% used", v[MonitoringKey.DISK])
        assertEquals("↓ 2 KB/s  ↑ 3.0 MB/s", v[MonitoringKey.NETWORK])
        assertTrue(v[MonitoringKey.CERTIFICATE]!!.startsWith("Valid until "))
    }

    @Test fun healthProblemsAndStaleReports() {
        val bad = rows(health = sampleHealth(now, tunnel = false))
        assertEquals(listOf(MonitoringKey.HEALTH), bad.map { it.key })
        assertEquals("Needs attention", bad.single().value)
        assertEquals(MonitoringTone.WARNING, bad.single().tone)
        val stale = rows(health = sampleHealth(now).copy(receivedAt = now - 10 * 60_000))
        assertEquals("No report", stale.single().value)
        assertTrue(rows(health = BoxHealthWire()).isEmpty())
    }

    @Test fun loadingAndFailedMetrics() {
        val loading = rows(metrics = LoadingState.Loading)
        assertEquals(listOf("CPU", "Memory", "Disk", "Network"), loading.map { it.key.title })
        assertTrue(loading.all { it.value == null })
        assertTrue(rows(metrics = LoadingState.Failed("down")).all { it.value == "Unavailable" })
    }

    @Test fun diskTone() {
        fun tone(used: Long) = rows(metrics = LoadingState.Loaded(metrics(used))).first { it.key == MonitoringKey.DISK }.tone
        assertEquals(MonitoringTone.NORMAL, tone(50))
        assertEquals(MonitoringTone.WARNING, tone(80))
        assertEquals(MonitoringTone.DANGER, tone(95))
    }

    @Test fun certificateStates() {
        assertEquals("Provisioning", rows(cert = MonitoringCert(null)).single().value)
        val expired = rows(cert = MonitoringCert(now - 1)).single()
        assertEquals("Expired", expired.value)
        assertEquals(MonitoringTone.DANGER, expired.tone)
    }

    @Test fun percentGuardsAnEmptyTotal() {
        assertEquals(0.0, MonitoringRows.percent(5, 0), 0.0)
        assertEquals(1.0, MonitoringRows.percent(150, 100), 0.0)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ServerMonitoringSectionComposeTest {
    @get:Rule val composeRule = createComposeRule()

    private fun stateIs(s: String) = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, s)

    @Test fun everyRowShowsItsValueAndExpandsInPlace() {
        val now = System.currentTimeMillis()
        composeRule.setContent {
            FlagshipTheme {
                Column {
                    MonitoringSection(
                        health = sampleHealth(now),
                        metrics = LoadingState.Loaded(sampleMetrics(now)),
                        cert = sampleCert(now),
                    )
                }
            }
        }
        composeRule.onNodeWithText("Monitoring").assertIsDisplayed()
        listOf("health", "cpu", "memory", "disk", "network", "certificate").forEach {
            composeRule.onNodeWithTag("monitor-$it").assertExists()
        }
        composeRule.onNodeWithText("12%").assertIsDisplayed()
        composeRule.onNodeWithText("Healthy").assertIsDisplayed()

        composeRule.onNodeWithTag("monitor-health").assert(stateIs("Collapsed"))
        composeRule.onNodeWithTag("monitor-cpu").assert(stateIs("Collapsed"))
        composeRule.onNodeWithText("Load 0.12 · 0.30 · 0.25").assertDoesNotExist()
        composeRule.onNodeWithTag("monitor-cpu").performClick()
        composeRule.onNodeWithTag("monitor-cpu").assert(stateIs("Expanded"))
        composeRule.onNodeWithText("Load 0.12 · 0.30 · 0.25").assertIsDisplayed()
        composeRule.onNodeWithTag("monitor-cpu").performClick()
        composeRule.onNodeWithText("Load 0.12 · 0.30 · 0.25").assertDoesNotExist()

        composeRule.onNodeWithTag("monitor-certificate").performClick()
        composeRule.onNodeWithText("Renews").assertExists()
        composeRule.onNodeWithText("*.home2.plucky-avocet.flagship.services").assertExists()
    }

    @Test fun aHealthProblemStartsExpandedAndShowsAloneWithoutTheBox() {
        val now = System.currentTimeMillis()
        composeRule.setContent {
            FlagshipTheme {
                Column { MonitoringSection(health = sampleHealth(now, tunnel = false), metrics = null, cert = null) }
            }
        }
        composeRule.onNodeWithTag("monitor-health").assert(stateIs("Expanded"))
        composeRule.onNodeWithText("Needs attention").assertIsDisplayed()
        composeRule.onNodeWithText("Can't reach the Flagship relay.").assertIsDisplayed()
        composeRule.onNodeWithTag("monitor-cpu").assertDoesNotExist()
        composeRule.onNodeWithTag("monitor-certificate").assertDoesNotExist()
    }

    @Test fun failedMetricsSayUnavailableAndOfferRetry() {
        composeRule.setContent {
            FlagshipTheme {
                Column {
                    MonitoringSection(
                        health = null,
                        metrics = LoadingState.Failed("This device isn't paired with this server yet."),
                        cert = MonitoringCert(null),
                        onRetryMetrics = {},
                    )
                }
            }
        }
        composeRule.onNodeWithTag("monitor-health").assertDoesNotExist()
        composeRule.onNodeWithTag("monitor-disk").performClick()
        composeRule.onNodeWithText("This device isn't paired with this server yet.").assertIsDisplayed()
        composeRule.onNodeWithText("Retry").assertIsDisplayed()
        composeRule.onNodeWithText("Provisioning").assertIsDisplayed()
    }
}
