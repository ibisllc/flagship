package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class RescueHelloBodyTest {
    private val body = Json.parseToJsonElement(
        """{"clientNonce":"${"11".repeat(16)}","boxNonce":"${"22".repeat(16)}","certSha256":"${"ab".repeat(32)}","issuedAt":5}""",
    ).jsonObject

    @Test
    fun theHelloBodyNamesNoServerAndThePhonePutsItsOwnNameBack() {
        assertEquals(
            Rescue.Exchange("home.harry.flagship.services", "11".repeat(16), "22".repeat(16), "ab".repeat(32), 5),
            helloFromBody(body, "Home.Harry.flagship.services"),
        )
    }

    @Test
    fun aNameInTheBodyIsNotTrustedOverThePhonesOwn() {
        val withName = Json.parseToJsonElement(body.toString().replaceFirst("{", """{"serverDomain":"evil.example",""")).jsonObject
        assertEquals("home.harry.flagship.services", helloFromBody(withName, "home.harry.flagship.services").serverDomain)
    }
}
