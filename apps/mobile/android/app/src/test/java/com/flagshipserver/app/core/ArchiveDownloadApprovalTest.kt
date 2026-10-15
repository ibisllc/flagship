// The browser-download approval (`flagship/archive-download/v1`): the shared
// vectors, the download page's QR link, and the approval view model.

package com.flagshipserver.app.core

import android.net.Uri
import com.flagshipserver.app.api.ArchiveDownloadApproval
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ArchiveDownloadApprovalTest {
    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/archive-download/vectors.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        runCatching { javaClass.protectionDomain?.codeSource?.location?.toURI()?.let { candidates.add(File(it)) } }
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 14) {
                val f = File(dir, rel)
                if (f.isFile) return f
                dir = dir.parentFile
                hops += 1
            }
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private val root: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content

    @Test fun matchesTheSharedVectors() {
        val seed = ServerKeys.deriveProtocolIrkSeed(HexUtil.decode(root.s("umkSeedHex"))!!)
        val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        assertEquals(root.s("pub"), HexUtil.encode(kp.publicKey))
        val signer = Ed25519Sign(kp.privateKey)
        for (c in root["cases"]!!.jsonArray.map { it.jsonObject }) {
            val a = ArchiveDownloadApproval(c.s("serverDomain"), c.s("archiveId"), c.s("requestId"), c["issuedAt"]!!.jsonPrimitive.long)
            assertEquals(c.s("canonical"), String(a.canonicalBytes(), Charsets.UTF_8))
            assertEquals(c.s("code"), ArchiveDownloadApproval.code(a.requestId))
            assertEquals(c.s("signature"), HexUtil.encode(signer.sign(a.canonicalBytes())))
        }
    }

    @Test fun theDownloadPageQrOpensTheApproval() {
        val link = DeepLink.parse(Uri.parse("https://flagshipserver.com/app/backup-download#s=home.harry.flagship.services&a=00112233445566778899aabbccddeeff&r=0f1e2d3c4b5a69788796a5b4c3d2e1f0"))
        assertEquals(
            DeepLink.ApproveBackupDownload("home.harry.flagship.services", "00112233445566778899aabbccddeeff", "0f1e2d3c4b5a69788796a5b4c3d2e1f0"),
            link,
        )
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/app/backup-download#s=evil.example.com&a=00112233445566778899aabbccddeeff&r=0f1e2d3c4b5a69788796a5b4c3d2e1f0")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/app/backup-download#s=home.harry.flagship.services&a=zz&r=0f1e2d3c4b5a69788796a5b4c3d2e1f0")))
    }

    @Test fun theViewModelSignsTheApprovalAndPostsIt() = runBlocking {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val sent = mutableListOf<com.flagshipserver.app.api.ServerArchiveApproveRequest>()
        val client = object : com.flagshipserver.app.api.ScreensClient by com.flagshipserver.app.api.MockScreensClient() {
            override suspend fun serverArchiveApprove(req: com.flagshipserver.app.api.ServerArchiveApproveRequest) {
                sent += req
            }
        }
        val vm = com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel(
            serverFqdn = "Home.harry.flagship.services",
            archiveId = "00112233445566778899aabbccddeeff",
            requestId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
            client = client,
            sign = { bytes -> Ed25519Sign(kp.privateKey).sign(bytes) },
            now = { 1_700_000_000_000 },
        )
        vm.approve()
        assertEquals(com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Approved, vm.phase.value)
        val r = sent.single()
        assertEquals("home.harry.flagship.services", r.approval.serverDomain)
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(r.signature)!!, r.approval.canonicalBytes())
        assertTrue(true)
    }
}
