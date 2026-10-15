// Renders the share-a-server screens to PNGs for review. Skipped unless
// SHARE_SCREENSHOTS_DIR (env) or share.screenshots.dir (system property)
// names an output directory.

package com.flagshipserver.app.ui.screens

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.flagshipserver.app.api.AccessRequest
import com.flagshipserver.app.api.RecentInstallEvent
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.api.ServerMetricsResponse
import com.flagshipserver.app.core.AcceptedShare
import com.flagshipserver.app.core.ActiveShare
import com.flagshipserver.app.core.ActivityActor
import com.flagshipserver.app.core.ActivityEntry
import com.flagshipserver.app.core.BootShareRequest
import com.flagshipserver.app.core.BootSharePending
import com.flagshipserver.app.core.OwnerShares
import com.flagshipserver.app.core.PendingShare
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.ServerShare
import com.flagshipserver.app.core.ShareOptions
import com.flagshipserver.app.core.ShareSession
import com.flagshipserver.app.core.ShareStartup
import com.flagshipserver.app.core.SharedEntry
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.OwnerShareUi
import com.flagshipserver.app.viewmodels.ServerAppsViewModel
import com.flagshipserver.app.viewmodels.ShareAcceptViewModel
import com.flagshipserver.app.viewmodels.SharedItem
import com.flagshipserver.app.viewmodels.SharedServerUi
import com.flagshipserver.app.viewmodels.SharedWithMeUi
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.io.FileOutputStream

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [33], qualifiers = "w400dp-h1600dp-xhdpi")
class ShareScreenshotsTest {
    @get:Rule val composeRule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private val outDir: String? = System.getenv("SHARE_SCREENSHOTS_DIR") ?: System.getProperty("share.screenshots.dir")
    private val now = System.currentTimeMillis()
    private val domain = "home.alice.flagship.services"

    @Before fun only() = assumeTrue(outDir != null)

    private fun shoot(name: String, content: @Composable () -> Unit) {
        composeRule.setContent {
            FlagshipTheme(darkTheme = false) {
                Column(Modifier.fillMaxSize().background(FS.colors.bg)) { content() }
            }
        }
        composeRule.waitForIdle()
        val view = composeRule.activity.window.decorView
        val bmp = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(android.graphics.Canvas(bmp))
        File(outDir!!).mkdirs()
        FileOutputStream(File(outDir, "share-android-$name.png")).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun a_ownerSharedWithCard() = shoot("a-owner-card") {
        Column(Modifier.fillMaxWidth().padding(FS.space.s6)) {
            ShareServerCardContent(
                ui = OwnerShareUi(
                    loading = false,
                    shares = OwnerShares(
                        active = listOf(ActiveShare("a".repeat(32), "Sam", ServerShare.LEVEL_MANAGE, true, false, "b".repeat(64), 1, now - 3 * 3600_000)),
                        pending = listOf(PendingShare("c".repeat(32), "Jo", ServerShare.LEVEL_VIEW, "https://flagshipserver.com/share#s=…", now + 6 * 86_400_000L)),
                        accepted = listOf(
                            AcceptedShare(
                                "d".repeat(32), "Robin", ShareOptions("Robin", ServerShare.LEVEL_VIEW, false, true),
                                ServerShare.Accept(domain, "d".repeat(32), "e".repeat(64), now), "f".repeat(128), "123456",
                            ),
                        ),
                    ),
                    activity = listOf(
                        ActivityEntry(now - 600_000, ActivityActor("share", "a".repeat(32), "Sam"), "ai.start", "notes"),
                        ActivityEntry(now - 3_600_000, ActivityActor("share", "a".repeat(32), "Sam"), "share.signed-in"),
                        ActivityEntry(now - 7_200_000, ActivityActor("owner"), "share.granted", "Sam"),
                    ),
                ),
                onShare = {}, onConfirm = {}, onNoMatch = {}, onLevel = { _, _ -> }, onUnlock = { _, _ -> },
                onData = { _, _ -> }, onRemove = {}, onCopy = {}, onCancelOffer = {},
            )
            androidx.compose.foundation.layout.Spacer(Modifier.padding(FS.space.s3))
            ShareActivityCard(
                listOf(
                    ActivityEntry(now - 600_000, ActivityActor("share", "a".repeat(32), "Sam"), "ai.start", "notes"),
                    ActivityEntry(now - 3_600_000, ActivityActor("share", "a".repeat(32), "Sam"), "share.signed-in"),
                    ActivityEntry(now - 7_200_000, ActivityActor("owner"), "share.granted", "Sam"),
                ),
            )
        }
    }

    @Test fun b_shareSheetLink() = shoot("b-share-sheet") {
        Column(Modifier.fillMaxWidth().padding(FS.space.s6)) {
            com.flagshipserver.app.ui.components.FSCard {
                ShareSheetContent(
                    serverName = "Home",
                    step = ShareSheetStep.Link,
                    label = "Sam",
                    level = ServerShare.LEVEL_MANAGE,
                    unlockAtBoot = false,
                    seeAppData = false,
                    link = "https://flagshipserver.com/share#s=0123456789abcdef0123456789abcdef&k=${"ab".repeat(32)}",
                    busy = false,
                    onLabel = {}, onLevel = {}, onUnlock = {}, onData = {}, onStep = {}, onCreate = {}, onClose = {},
                )
            }
        }
    }

    @Test fun b2_shareSheetLevel() = shoot("b2-share-sheet-level") {
        Column(Modifier.fillMaxWidth().padding(FS.space.s6)) {
            com.flagshipserver.app.ui.components.FSCard {
                ShareSheetContent(
                    serverName = "Home", step = ShareSheetStep.Options, label = "Sam", level = ServerShare.LEVEL_MANAGE,
                    unlockAtBoot = false, seeAppData = false, link = null, busy = false,
                    onLabel = {}, onLevel = {}, onUnlock = {}, onData = {}, onStep = {}, onCreate = {}, onClose = {},
                )
            }
        }
    }

    private val entry = SharedEntry("1".repeat(32), "2".repeat(32), "ab".repeat(32), domain, "Home", now)

    @Test fun c_memberAcceptCode() = shoot("c-member-accept") {
        ShareAcceptContent(
            phase = ShareAcceptViewModel.Phase.Code(entry, "123456", ServerShare.LEVEL_MANAGE),
            onOpen = {}, onAccept = {}, onRetry = {}, onOpenServer = {}, onDone = {},
        )
    }

    @Test fun d_homeSharedWithMe() = shoot("d-home") {
        HomeScreen(
            state = LoadingState.Loaded(
                ServerDetailResponse(
                    serverFqdn = "lab.sam.flagship.services", username = "sam", daemonVersion = "0.18.4",
                    startedAt = 0, uptimeMs = 1000, serviceCount = 2, pairedSessionCount = 1,
                    recentInstallEvents = emptyList<RecentInstallEvent>(),
                ),
            ),
            username = "sam",
            pods = listOf(PodInfo(podId = "p1", name = "Lab", fqdn = "lab.sam.flagship.services", status = PodInfo.Status.ONLINE)),
            onOpenPod = {}, onAddServer = {}, onMakeLeader = {}, onRefresh = {},
            sharedWithMe = {
                SharedWithMeContent(
                    ui = SharedWithMeUi(
                        loaded = true,
                        items = listOf(
                            SharedItem(entry, SharedItem.Status.Active(ServerShare.LEVEL_MANAGE)),
                            SharedItem(entry.copy(shareId = "3".repeat(32), serverName = "Cabin", serverDomain = "cabin.jo.flagship.services"), SharedItem.Status.Waiting),
                        ),
                    ),
                    onOpen = {},
                )
            },
        )
    }

    @Test fun e_memberServerManage() = shoot("e-member-server") {
        SharedServerContent(
            serverName = "Home",
            serverDomain = domain,
            ui = SharedServerUi(
                phase = SharedServerUi.Phase.Ready,
                session = ShareSession("fss_x", Long.MAX_VALUE, ServerShare.LEVEL_MANAGE, unlockAtBoot = true, seeAppData = false),
                detail = ServerDetailResponse(
                    serverFqdn = domain, username = "alice", daemonVersion = "0.18.4", startedAt = 0,
                    uptimeMs = 5 * 3600_000L + 12 * 60_000L, serviceCount = 2, pairedSessionCount = 3,
                    recentInstallEvents = emptyList(),
                ),
                metrics = ServerMetricsResponse(
                    collectedAt = now, cpuPercent = 23.0, loadAvg1 = 0.4, loadAvg5 = 0.3, loadAvg15 = 0.2,
                    memUsedBytes = 1_800_000_000, memTotalBytes = 4_000_000_000, diskUsedBytes = 21_000_000_000,
                    diskTotalBytes = 64_000_000_000, diskIOReadBytesPerSec = 0.0, diskIOWriteBytesPerSec = 0.0,
                    netRxBytesPerSec = 12_000.0, netTxBytesPerSec = 3_000.0,
                    cpuHistory = emptyList(), memHistory = emptyList(), ioHistory = emptyList(), netHistory = emptyList(),
                ),
                apps = listOf(
                    ServerAppsViewModel.Row("svc-1", "Notes", "notes.home.alice.flagship.services", "Running"),
                    ServerAppsViewModel.Row("svc-2", "Photos", "photos.home.alice.flagship.services", "Stopped"),
                ),
                accessRequests = listOf(AccessRequest(serviceId = "svc-1", appName = "Notes", host = "api.openweathermap.org")),
                startups = listOf(
                    ShareStartup(BootSharePending(BootShareRequest(domain, "aa".repeat(32), "unlock-key", "bb".repeat(32), now), "cc".repeat(64), postedAt = now - 60_000)),
                ),
                canUnlock = true,
            ),
            onBack = {}, onApprove = {}, onAnswer = { _, _ -> }, onLeave = {}, onRetry = {},
        )
    }
}
