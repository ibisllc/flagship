// Debug builds: the made-up world the store screenshots show (store/demo-world.json,
// docs/store-assets/capture-plan.md). The capture test passes the file's JSON as the
// `flagship.smokeStoreWorld` launch extra; each server gets its own mock box.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AppMember
import com.flagshipserver.app.api.AppMemberGrant
import com.flagshipserver.app.api.AppMemberInviteRole
import com.flagshipserver.app.api.AppMembersResponse
import com.flagshipserver.app.api.AppAccountMember
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.AppsListResponse
import com.flagshipserver.app.api.BackupLastRun
import com.flagshipserver.app.api.BackupPolicyState
import com.flagshipserver.app.api.BackupSchedule
import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.MockServiceAccessClient
import com.flagshipserver.app.api.PendingRequestSummaryWire
import com.flagshipserver.app.api.PendingSecretRequest
import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.api.SavedBackup
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ServerArchiveApp
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.api.ServiceInviteRow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class StoreWorld(
    val account: String,
    val servers: List<Server>,
    val unlockRequest: Waiting,
    val apps: List<App>,
    val membersApp: String,
    val members: List<Member>,
    val backups: Backups,
) {
    @Serializable data class Server(val name: String, val fqdn: String, val leader: Boolean, val uptimeHours: Long)
    @Serializable data class Waiting(val server: String, val askedMinutesAgo: Long)
    @Serializable data class App(val slug: String, val name: String, val summary: String, val server: String, val access: String)
    @Serializable data class Member(val name: String, val rank: String)
    @Serializable data class Backups(val server: String, val keep: Int, val policy: String, val lastHoursAgo: Long, val sizeGiB: Double)

    private val hour get() = 3_600_000L
    private fun serviceId(slug: String) = "$account--$slug"
    private fun asking(s: Server, waiting: Boolean) = waiting && s.name == unlockRequest.server

    /** Each server's signing key seed: fixed, so the phone's pin and the request agree. */
    private fun stkSeed(fqdn: String): ByteArray =
        java.security.MessageDigest.getInstance("SHA-256").digest("store-stk|$fqdn".toByteArray())
    private fun stkPub(fqdn: String): String = HexUtil.encode(com.flagshipserver.app.core.pq.PqHybrid.ed25519PublicKey(stkSeed(fqdn)))

    /** With no server order the oldest server leads: the leader is the older box. */
    private fun registeredAt(s: Server, now: Long) = now - (if (s.leader) 120 else 40) * 24 * hour

    /** The leader first, as the server order puts it. */
    fun pods(waiting: Boolean, now: Long): List<PodInfo> =
        (servers.filter { it.leader } + servers.filter { !it.leader }).map { s ->
            val ask = asking(s, waiting)
            PodInfo(
                podId = "store-${s.name}", name = s.name, fqdn = s.fqdn,
                status = if (ask) PodInfo.Status.OFFLINE else PodInfo.Status.ONLINE,
                registeredAt = registeredAt(s, now), awaitingUnlock = ask,
                liveness = if (ask) null else PodInfo.Liveness.LIVE, lastSeenMsAgo = if (ask) null else 20_000L,
                identityPubKeyHex = stkPub(s.fqdn),
            )
        }

    /** One mock box per server (by its first label), each answering only for itself. */
    fun boxes(waiting: Boolean, now: Long): Map<String, MockScreensClient> {
        val gib = 1024.0 * 1024 * 1024
        val ref = serviceId(membersApp)
        val aid = { i: Int -> (i + 6).toString().repeat(64) }
        val members = AppMembersResponse(
            serviceId = ref, mode = "restricted", defaultRole = "member",
            accountMembers = listOf(
                AppAccountMember(kind = "device", deviceId = MockScreensClient.SELF_DEVICE_ID, devicePub = MockScreensClient.SELF_DEVICE_PUB,
                    tier = "admin", rank = "master"),
            ),
            members = this.members.mapIndexed { i, m ->
                AppMember(aid(i), m.rank, listOf(AppMemberGrant("inv-${m.name.lowercase()}", m.rank)))
            },
            invites = this.members.map {
                AppMemberInviteRole("inv-${it.name.lowercase()}", it.rank, set = it.rank != "member", tier = "admin",
                    creatorDeviceId = MockScreensClient.SELF_DEVICE_ID)
            },
        )
        val details = servers.associate { s ->
            s.name to ServerDetailResponse(
                serverFqdn = s.fqdn, username = account, daemonVersion = "0.3.0", currentCommit = "7ac1b50a".repeat(5),
                startedAt = now - s.uptimeHours * hour, uptimeMs = s.uptimeHours * hour,
                certNotAfter = now + 60 * 24 * hour, certNotBefore = now - 30 * 24 * hour, certSans = listOf(s.fqdn, "*.${s.fqdn}"),
                serviceCount = apps.count { it.server == s.name }, pairedSessionCount = 2, recentInstallEvents = emptyList(),
            )
        }
        val lists = servers.associate { s ->
            s.name to AppsListResponse(apps.filter { it.server == s.name }.map { a ->
                AppSummary(
                    serviceId = serviceId(a.slug), creator = account, slug = a.slug, urlLabel = a.slug, summary = a.summary,
                    url = "https://${a.slug}.${s.fqdn}/", status = "running", version = "1.0.0", installedAt = now - 30 * 24 * hour,
                    accessMode = if (a.access == "members") "members-only" else "open", name = a.name,
                )
            })
        }
        return servers.associate { s ->
            val box = MockScreensClient(simulatedLatencyMs = 0)
            box.podContext = s.name
            box.storeApps += lists
            box.storeDetails += details
            box.accessFixture.clear()
            box.egressFixture.clear()
            box.appStorageFixture.clear()
            box.servingFixture = null
            box.membersFixture[ref] = members
            if (waiting) box.unreachablePodContexts += unlockRequest.server
            if (s.name == backups.server) {
                val b = backups
                val names = apps.filter { it.server == b.server }.map { ServerArchiveApp(serviceId(it.slug), it.name) }
                box.backupSchedule = BackupSchedule(frequency = "daily", minuteOfDayUtc = 180, keepDaily = b.keep, keepWeekly = 4)
                box.backupKeyPool.clear()
                box.backupKeyPool += List(300) { "%032x".format(it + 1) }
                box.savedBackupsList.clear()
                box.savedBackupsList += (0 until 3).map { i ->
                    val size = (b.sizeGiB * gib).toLong() - i * 40_000_000L
                    SavedBackup(
                        archiveId = (i + 5).toString().repeat(32), createdAt = now - (b.lastHoursAgo + 24L * i) * hour,
                        bytes = size, sha256 = "cd".repeat(32), backupBytes = 2048, backupFileName = "${b.server}.flagship-backup",
                        dataFileName = "${b.server}.flagship-data", bundleFileName = "${b.server}.flagship", bundleBytes = size + 2064,
                        bundleSha256 = "ab".repeat(32), apps = names,
                    )
                }
                box.backupLastRun = BackupLastRun(now - b.lastHoursAgo * hour, true, "schedule", box.savedBackupsList.first().archiveId)
                box.backupPolicyState = BackupPolicyState(b.policy, (32 * gib).toLong(), 1)
                box.backupUsedBytes = (b.sizeGiB * gib).toLong()
                box.backupDiskBytes = (480 * gib).toLong()
            }
            s.name to box
        }
    }

    /** `.com`'s directory, Chess Club's invites (sealed with this device's household key) and, when
     *  [waiting], the start-up request cabin posts, signed with its key, which this phone pinned before. */
    fun seed(waiting: Boolean, now: Long, mailbox: MockSecretMailboxClient, access: MockServiceAccessClient) {
        val asked = now - unlockRequest.askedMinutesAgo * 60_000L
        val nonce = "42".repeat(32)
        mailbox.directory = servers.map { s ->
            val ask = asking(s, waiting)
            PodDirectoryEntry(
                serverDomain = s.fqdn, identityPubKey = stkPub(s.fqdn),
                lastReported = if (ask) asked - 300_000L else now - 20_000L, registeredAt = registeredAt(s, now),
                pendingRequests = if (ask) listOf(PendingRequestSummaryWire(nonce, "unlock-key", asked, asked + 600_000L)) else emptyList(),
                liveness = if (ask) null else "live", lastSeenMsAgo = if (ask) null else 20_000L,
            )
        }
        for (s in servers) {
            ServerKeyPins.shared.forget(s.fqdn)
            ServerKeyPins.shared.recordFirstSeen(s.fqdn, stkPub(s.fqdn))
        }
        mailbox.pending = servers.filter { asking(it, waiting) }.map { s ->
            val pub = stkPub(s.fqdn)
            val sig = com.flagshipserver.app.core.pq.PqHybrid.ed25519Sign(
                stkSeed(s.fqdn), SecretRequest.canonicalBytes(s.fqdn, pub, SecretPurpose.UNLOCK_KEY, nonce, asked))
            PendingSecretRequest(
                serverDomain = s.fqdn, requestNonceHex = nonce, stkPub = pub, purpose = "unlock-key", issuedAt = asked,
                requestSignature = HexUtil.encode(sig), postedAt = asked, expiresAt = asked + 600_000L,
            )
        }
        val ref = serviceId(membersApp)
        val household = ServerKeys.deriveHouseholdKey(com.flagshipserver.app.keystore.Keystore.loadOrCreateUmkSeed())
        access.seed(ref, "restricted", members.mapIndexed { i, m ->
            val inviteId = "inv-${m.name.lowercase()}"
            ServiceInviteRow(
                inviteId = inviteId, serviceRef = ref,
                encryptedBundleHex = ServiceInvite.sealBundle(ServiceInvite.Bundle(m.name), household, inviteId),
                boundAidHex = (i + 6).toString().repeat(64), boundAt = now - (i + 2) * 24 * hour,
                createdAt = now - (i + 3) * 24 * hour, revokedAt = null, creatorTier = "admin",
                creatorDeviceId = MockScreensClient.SELF_DEVICE_ID,
            )
        })
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        fun parse(raw: String?): StoreWorld? = raw?.let { runCatching { json.decodeFromString(serializer(), it) }.getOrNull() }
    }
}

/** Each server's own mock box (the store world), so a list across servers never mixes them up. */
class StorePodClients(
    private val boxes: Map<String, MockScreensClient>,
    private val build: BuildClient,
) : PodClients {
    override fun screens(pod: PodInfo): ScreensClient? = boxes[pod.fqdn.substringBefore('.')]
    override fun build(pod: PodInfo): BuildClient = build
}
