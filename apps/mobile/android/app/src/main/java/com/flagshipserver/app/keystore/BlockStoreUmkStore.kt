// Google Block Store wrapper for the wrapped-UMK envelope.
//
// Block Store gives us a 16KB end-to-end encrypted key-value store
// that backs up + restores across Google accounts when the user
// signs in to a new device. Perfect for stashing a wrapped UMK seed
// alongside the credentialId so a fresh phone can re-derive the same
// IRK after a passkey-PRF assertion.

package com.flagshipserver.app.keystore

import android.content.Context
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.BlockstoreClient
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

class BlockStoreUmkStore(context: Context) {
    private val client: BlockstoreClient = Blockstore.getClient(context)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /**
     * Persist [envelope] to Block Store under the well-known key. The
     * client opts into end-to-end encryption when the device supports
     * it (newer Android + Play Services with screen lock + Google
     * Account); on older configurations the bytes are still encrypted
     * at rest but not e2e.
     */
    suspend fun save(envelope: WrappedUmk) {
        val bytes = json.encodeToString(WrappedUmk.serializer(), envelope).toByteArray()
        val req = StoreBytesData.Builder()
            .setBytes(bytes)
            .setKey(BLOCK_KEY)
            .setShouldBackupToCloud(true)
            .build()
        client.storeBytes(req).await()
    }

    /** Returns null if no envelope is stored (fresh device). */
    suspend fun fetch(): WrappedUmk? {
        val req = RetrieveBytesRequest.Builder()
            .setKeys(listOf(BLOCK_KEY))
            .build()
        val resp = client.retrieveBytes(req).await()
        val entry = resp.blockstoreDataMap[BLOCK_KEY] ?: return null
        val raw = String(entry.bytes)
        return runCatching { json.decodeFromString(WrappedUmk.serializer(), raw) }.getOrNull()
    }

    suspend fun delete() {
        // BlockstoreClient doesn't expose a single-key delete, but
        // re-storing an empty envelope effectively neutralizes the
        // entry. The fetch path returns null when decode fails.
        val req = StoreBytesData.Builder()
            .setBytes(ByteArray(0))
            .setKey(BLOCK_KEY)
            .build()
        client.storeBytes(req).await()
    }

    companion object {
        private const val BLOCK_KEY = "flagship.wrappedUmk"
    }
}

@Serializable
data class WrappedUmk(
    val credentialId: String,
    val ciphertextBase64: String,
    val nonceBase64: String,
)
