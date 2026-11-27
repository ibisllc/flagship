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
    val messages: Messages? = null,
    val calls: Calls? = null,
    /** This phone's name per language (Access control's account members, "Invited by"). */
    val deviceName: Map<String, String> = emptyMap(),
    val build: Build? = null,
) {
    @Serializable data class Server(val name: String, val fqdn: String, val leader: Boolean, val uptimeHours: Long)
    @Serializable data class Waiting(val server: String, val askedMinutesAgo: Long)
    @Serializable data class App(
        val slug: String, val name: String, val summary: String, val server: String, val access: String,
        /** The summary in each capture language (`en` is [summary]). */
        val summaryByLang: Map<String, String> = emptyMap(),
        /** The app's voi.ci link: a random code or a custom name, its own for every app. */
        val link: String? = null,
    ) {
        fun summary(lang: String) = summaryByLang[lang] ?: summaryByLang[lang.substringBefore('-')] ?: summary
    }
    @Serializable data class Member(val name: String, val rank: String)
    @Serializable data class Backups(val server: String, val keep: Int, val policy: String, val lastHoursAgo: Long, val sizeGiB: Double)
    /** Slide 03: the conversations from the account's voi.ci page (Sam's, then [others]), texts per language. */
    @Serializable data class Messages(
        val displayName: String, val nickname: Map<String, String>, val thread: List<Line>, val others: List<Other> = emptyList(),
    ) {
        @Serializable data class Line(val from: String, val minutesAgo: Long, val text: Map<String, String>)
        /** Another person who wrote: a fixed visitor key ([seed], one byte repeated) and the owner's nickname for them. */
        @Serializable data class Other(val id: String, val seed: Int, val nickname: Map<String, String>, val thread: List<Line>)
    }
    /** Slide 08: a build chat on [server], ready to deploy. */
    @Serializable data class Build(
        val sessionId: String, val name: String, val server: String, val credits: Double? = null, val messages: List<Message>,
    ) {
        @Serializable data class Message(val role: String, val minutesAgo: Long, val text: Map<String, String>)
    }
    /** Slides 01 and 02 (0.4): Sam calling (ringing), and the calls on the Social page (history). */
    @Serializable data class Calls(val ringing: Ringing? = null, val history: List<Call> = emptyList()) {
        @Serializable data class Ringing(val from: String? = null, val video: Boolean = false)
        @Serializable data class Call(
            val from: String? = null, val direction: String, val outcome: String, val video: Boolean = false,
            val minutesAgo: Long, val durationSec: Long = 0,
        )
    }

    private fun pickLang(t: Map<String, String>, lang: String) = t[lang] ?: t[lang.substringBefore('-')] ?: t["en"].orEmpty()

    /** This phone's name in [lang]. */
    fun deviceName(lang: String): String? = deviceName.takeIf { it.isNotEmpty() }?.let { pickLang(it, lang) }

    /** Each app's voi.ci link, by service id. */
    fun shortCodes(): Map<String, String> = apps.mapNotNull { a -> a.link?.let { serviceId(a.slug) to it } }.toMap()

    /** Slide 08's chat in [lang], as the box serves it. */
    fun chat(lang: String, now: Long): com.flagshipserver.app.api.VibeCodeSessionPublicState? {
        val b = build ?: return null
        return com.flagshipserver.app.api.VibeCodeSessionPublicState(
            id = b.sessionId, status = "ready-to-deploy",
            messages = b.messages.mapIndexed { i, m ->
                com.flagshipserver.app.api.VibeCodeSessionMessage(
                    role = m.role, text = pickLang(m.text, lang), timestamp = now - m.minutesAgo * 60_000,
                    credits = if (m.role == "assistant" && i == b.messages.lastIndex) b.credits else null,
                )
            },
            model = "medium", canContinue = true, provider = "flagship", conversationTokens = 24_000,
        )
    }

    /** The caller's name on slide 01: the owner's nickname for Sam in [lang]. */
    fun ringingName(lang: String): String? {
        val r = calls?.ringing ?: return null
        return if (r.from == "nickname") messages?.nickname?.let { pickLang(it, lang) } else null
    }

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
    fun boxes(waiting: Boolean, now: Long, lang: String = "en"): Map<String, MockScreensClient> {
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
                    serviceId = serviceId(a.slug), creator = account, slug = a.slug, urlLabel = a.slug, summary = a.summary(lang),
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
            // A fresh account's Activity, as iOS's store world shows it: no re-attach report and no
            // gym log lines (the mock's defaults), so neither "Post-recovery" nor a server count appears.
            box.postRecoveryReported = false
            box.boxActivityFixture = emptyList()
            box.membersFixture[ref] = members
            if (build?.server == s.name) box.storeChat = chat(lang, now)
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

    /**
     * Slide 03: [account]'s published voi.ci page and its conversations on it (in [lang], a BCP 47 tag), answered by the
     * owner and renamed with the owner's nickname, so the thread opens accepted and titled by the nickname.
     */
    fun seedMessages(c: com.flagshipserver.app.api.MockVoiciClient, lang: String, now: Long) {
        val m = messages ?: return
        val pick = { t: Map<String, String> -> pickLang(t, lang) }
        val umk = com.flagshipserver.app.keystore.Keystore.loadOrCreateUmkSeed()
        val pageId = "5a".repeat(16)
        val profile = com.flagshipserver.app.core.voici.VoiciOwner.defaultProfile(m.displayName)
        val bytes = com.flagshipserver.app.core.voici.VoiciOwner.profileBytes(profile)
        val sha = com.flagshipserver.app.core.voici.WebEnvelopes.sha256Hex(bytes)
        c.pieces["$pageId/$sha"] = bytes
        val keys = com.flagshipserver.app.core.voici.VoiciOwnerKeys.derive(umk, pageId, 1)
        val body = com.flagshipserver.app.core.voici.VoiciPageIndexBody(
            account, pageId, 1, now - 86_400_000, 1, 1, keys.inboxPub, keys.signPub,
            listOf(com.flagshipserver.app.core.voici.VoiciPieceRef("profile", sha, bytes.size.toLong())), "admin-root",
        )
        val clock = c.now
        try {
            kotlinx.coroutines.runBlocking {
                c.now = { now - 86_400_000 }
                c.publish(account, com.flagshipserver.app.core.voici.VoiciPage.signVoiciPageIndex(body, GymSeams.GYM_ADMIN_ROOT_SEED).toJson())
                val visitorUmk = ByteArray(32) { 0x5E }
                val v = com.flagshipserver.app.core.voici.VoiciVisitorKeys.derive(visitorUmk, pageId)
                val convId = com.flagshipserver.app.core.voici.VoiciMessages.voiciConv(pageId, v.pseudonymPub)
                var conv = com.flagshipserver.app.core.voici.StoredVoiciConversation(convId, pageId, v.pseudonymPub, v.threadPub)
                var visitorSeq = 0L
                for (line in m.thread) {
                    val at = now - line.minutesAgo * 60_000
                    c.now = { at }
                    if (line.from == "owner") {
                        val env = com.flagshipserver.app.core.voici.VoiciOwner.reply(keys, conv, pick(line.text), null, 1, at)
                        c.send(env.toJson())
                        conv = conv.copy(messages = conv.messages + com.flagshipserver.app.core.voici.StoredVoiciMessage(env.msgId, env.from, env.seq, at, pick(line.text), mine = true))
                    } else {
                        visitorSeq += 1
                        c.send(c.visitorMessage(account, visitorUmk, pick(line.text), seq = visitorSeq))
                    }
                }
                val nicknames = sortedMapOf(v.pseudonymPub to com.flagshipserver.app.core.voici.MessagesNickname(pick(m.nickname), now - 3_000_000))
                val accepted = mutableListOf(convId)
                for (o in m.others) {
                    val ou = ByteArray(32) { o.seed.toByte() }
                    val ov = com.flagshipserver.app.core.voici.VoiciVisitorKeys.derive(ou, pageId)
                    val oc = com.flagshipserver.app.core.voici.VoiciMessages.voiciConv(pageId, ov.pseudonymPub)
                    var oconv = com.flagshipserver.app.core.voici.StoredVoiciConversation(oc, pageId, ov.pseudonymPub, ov.threadPub)
                    var oSeq = 0L
                    for (line in o.thread) {
                        val at = now - line.minutesAgo * 60_000
                        c.now = { at }
                        if (line.from == "owner") {
                            val env = com.flagshipserver.app.core.voici.VoiciOwner.reply(keys, oconv, pick(line.text), null, 1, at)
                            c.send(env.toJson())
                            oconv = oconv.copy(messages = oconv.messages + com.flagshipserver.app.core.voici.StoredVoiciMessage(env.msgId, env.from, env.seq, at, pick(line.text), mine = true))
                        } else {
                            oSeq += 1
                            c.send(c.visitorMessage(account, ou, pick(line.text), seq = oSeq))
                        }
                    }
                    nicknames[ov.pseudonymPub] = com.flagshipserver.app.core.voici.MessagesNickname(pick(o.nickname), now - 3_000_000)
                    accepted += oc
                }
                val state = com.flagshipserver.app.core.voici.MessagesState(nicknames = nicknames, accepted = accepted)
                val key = com.flagshipserver.app.core.voici.VoiciMessages.deriveMessagesStateKey(umk)
                c.states[account] = com.flagshipserver.app.core.voici.VoiciMessages.sealMessagesState(key, account, 1, state).toJson()
            }
        } finally {
            c.now = clock
        }
    }

    /**
     * Slide 03: the calls in the world's history, recorded on this device as answered or missed calls are. Sam's are
     * on the conversations [seedMessages] made (so the nicknames name them); a `null` caller is an unnamed visitor.
     */
    suspend fun seedCalls(center: com.flagshipserver.app.core.voici.VoiciCenter, now: Long) {
        val history = calls?.history ?: return
        val pageId = "5a".repeat(16)
        val seeds = mapOf("nickname" to 0x5E) + messages?.others.orEmpty().associate { it.id to it.seed }
        val people = seeds.mapValues { (_, seed) ->
            val v = com.flagshipserver.app.core.voici.VoiciVisitorKeys.derive(ByteArray(32) { seed.toByte() }, pageId)
            com.flagshipserver.app.core.voici.VoiciMessages.voiciConv(pageId, v.pseudonymPub) to v.pseudonymPub
        }
        history.forEachIndexed { i, c ->
            val who = c.from?.let { people[it] }
            center.recordCall(
                com.flagshipserver.app.calls.VoiciCallRecord(
                    id = "store-call-$i", callId = "%064x".format(i + 1), direction = if (c.direction == "outgoing") "out" else "in",
                    outcome = c.outcome, conv = who?.first, pseudonymPub = who?.second,
                    media = if (c.video) "audio,video" else "audio", at = now - c.minutesAgo * 60_000, durationMs = c.durationSec * 1000,
                ),
            )
        }
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
