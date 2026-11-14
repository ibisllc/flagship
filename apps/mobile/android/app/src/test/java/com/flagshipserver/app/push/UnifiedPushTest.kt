package com.flagshipserver.app.push

import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PushTokenRegister
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class UnifiedPushTest {
    private val p256dh = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM"
    private val auth = "tBHItJI5svbpez7KI4CCXg"

    @Test fun aDistributorWinsOverPlayServices() {
        assertEquals(PushTransport.UNIFIEDPUSH, PushTransport.choose(hasDistributor = true, hasPlayServices = true))
        assertEquals(PushTransport.UNIFIEDPUSH, PushTransport.choose(hasDistributor = true, hasPlayServices = false))
        assertEquals(PushTransport.FCM, PushTransport.choose(hasDistributor = false, hasPlayServices = true))
        assertEquals(PushTransport.NONE, PushTransport.choose(hasDistributor = false, hasPlayServices = false))
        assertEquals("unifiedpush", PushTransport.UNIFIEDPUSH.platform)
    }

    @Test fun theEndpointBecomesTheWebPushSubscriptionDotComExpects() {
        val token = UnifiedPushSubscription.providerToken("https://ntfy.sh/upAbC123?up=1", p256dh, auth)!!
        assertEquals(
            """{"endpoint":"https://ntfy.sh/upAbC123?up=1","keys":{"p256dh":"$p256dh","auth":"$auth"}}""",
            token,
        )
        val o = org.json.JSONObject(token)
        assertEquals("https://ntfy.sh/upAbC123?up=1", o.getString("endpoint"))
        PushTokenRegister.canonicalBytes(
            username = "alice",
            deviceId = "01".repeat(16),
            platform = "unifiedpush",
            providerToken = token,
            pushX25519PubHex = HexUtil.encode(ByteArray(32) { 7 }),
            issuedAt = 1L,
        )
    }

    @Test fun anEndpointDotComWouldRefuseIsNotOffered() {
        assertNull(UnifiedPushSubscription.providerToken("http://ntfy.sh/up", p256dh, auth))
        assertNull(UnifiedPushSubscription.providerToken("https://ntfy.sh/a|b", p256dh, auth))
        assertNull(UnifiedPushSubscription.providerToken("https://ntfy.sh/a\"b", p256dh, auth))
        assertNull(UnifiedPushSubscription.providerToken("https://ntfy.sh/up", null, auth))
        assertNull(UnifiedPushSubscription.providerToken("https://ntfy.sh/up", "not base64!", auth))
        assertNull(UnifiedPushSubscription.providerToken("https://" + "a".repeat(1100), p256dh, auth))
    }

    @Test fun aDecryptedPushIsTheFcmDataMap() {
        val data = FlagshipUnifiedPushService.decode(
            """{"kind":"secret-request","deepLink":"https://flagshipserver.com/app/secret-requests","category":"secret-request"}""".toByteArray(),
        )!!
        assertEquals("secret-request", data["category"])
        assertEquals("secret-request", data["kind"])
        assertNull(FlagshipUnifiedPushService.decode("""{"kind":"x"}""".toByteArray()))
        assertNull(FlagshipUnifiedPushService.decode("not json".toByteArray()))
    }
}
