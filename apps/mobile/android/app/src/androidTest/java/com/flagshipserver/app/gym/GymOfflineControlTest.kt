// GYM Android: Offline control (docs/data-sovereignty.md). With the rescue extra the screen runs its
// real view model against an in-process box (GymRescue, debug builds only): the server is found by
// its opaque id, checked by its pinned key, and every action is an owner-signed order the box checks.
// Scenarios: found, not found, wrong key, expired certificate, an interrupted download that resumes,
// each offline control, a stranger refused. NO BACKEND.

package com.flagshipserver.app.gym

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymOfflineControlTest : GymBase() {
    private val user = "bright-maple"
    private val notes = "$user--notes"

    private fun open(scenario: String) {
        launch(tab = "settings", username = user, rescue = scenario)
        waitUntilExists("settings-open-offline-control", 30_000)
        tap("settings-open-offline-control")
        waitUntilExists("offline-control")
    }

    private fun connectHome() {
        tap("offline-connect-home")
    }

    @Test
    fun aFoundServerConnectsAndEachControlIsSigned() {
        open("found")
        waitUntilExists("offline-found-home", 15_000)
        gymShot("offline-found")
        connectHome()
        waitUntilExists("offline-connected-title", 15_000)
        assertEquals(1, tagCount("offline-status"))
        gymShot("offline-connected")
        tap("offline-app-stop-$notes")
        tap("offline-confirm")
        eventually(10_000, "stopped") { textOfTag("offline-app-state-$notes") == "Stopped" }
        tap("offline-app-start-$notes")
        eventually(10_000, "running") { textOfTag("offline-app-state-$notes") == "Running" }
        tap("offline-app-restart-$notes")
        tap("offline-confirm")
        eventually(10_000, "restarted") { textOfTag("offline-notice").endsWith("was restarted.") }
        tap("offline-server-restart")
        tap("offline-confirm")
        eventually(10_000, "server restart") { textOfTag("offline-notice").startsWith("The server is restarting.") }
        gymShot("offline-server-restarting")
    }

    @Test
    fun notFoundSaysSoAndATypedAddressConnects() {
        open("not-found")
        connectHome()
        waitUntilExists("offline-error", 10_000)
        assertTrue(textOfTag("offline-error"), textOfTag("offline-error").contains("wasn't found on this Wi-Fi"))
        gymShot("offline-not-found")
        type("offline-manual-name", "home.$user.flagship.services")
        type("offline-manual-address", "192.168.1.20")
        tap("offline-manual-connect")
        waitUntilExists("offline-connected-title", 15_000)
    }

    @Test
    fun anotherKeyIsNotYourServer() {
        open("wrong-key")
        waitUntilExists("offline-found-home", 15_000)
        connectHome()
        waitUntilExists("offline-error", 10_000)
        assertTrue(textOfTag("offline-error"), textOfTag("offline-error").contains("This isn't your server"))
        assertEquals(0, tagCount("offline-connected-title"))
        gymShot("offline-wrong-key")
    }

    @Test
    fun aStrangerIsRefusedInTheBoxsOwnWords() {
        open("stranger")
        waitUntilExists("offline-found-home", 15_000)
        connectHome()
        waitUntilExists("offline-error", 10_000)
        assertTrue(textOfTag("offline-error"), textOfTag("offline-error").startsWith("The rescue session was refused: not signed by this server's owner key"))
    }

    @Test
    fun anExpiredCertificateStillWorksByKey() {
        open("expired-cert")
        waitUntilExists("offline-found-home", 15_000)
        connectHome()
        waitUntilExists("offline-connected-title", 15_000)
        waitUntilExists("offline-cert-note")
        gymShot("offline-expired-cert")
    }

    @Test
    fun anInterruptedDownloadResumesAndFinishes() {
        open("interrupt")
        waitUntilExists("offline-found-home", 15_000)
        connectHome()
        waitUntilExists("offline-connected-title", 15_000)
        tap("offline-rescue")
        waitUntilExists("offline-backup-passcode-saved")
        tap("offline-backup-passcode-saved")
        tap("offline-backup-start")
        waitUntilExists("offline-backup-interrupted", 30_000)
        gymShot("offline-interrupted")
        tap("offline-backup-resume")
        waitUntilExists("offline-backup-saved", 30_000)
        gymShot("offline-saved")
    }
}
