package com.flagshipserver.app.core.pq

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters

/**
 * Org servers, the org key ring and the audit export (packages/protocol/src/orgServers.ts, orgKeyRing.ts,
 * orgAudit.ts; docs/enterprise-accounts.md "Org servers", §5.4, §8, §11). Byte for byte the TypeScript
 * canonical forms, pinned by test-vectors/org-servers.
 */
data class OrgServerCode(
    val orgId: String, val genesisHash: String, val serial: String, val serverName: String, val serverDomain: String,
    val delegatedPubKeyHex: String, val issuedAt: Long, val expiresAt: Long,
)

enum class OrgKeyKind(val wire: String) {
    CGK("cgk"), DIRECTORY_KEY("directory-key"), ARCHIVE_KEYS("archive-keys"), DISK_KEY("disk-key");
    companion object { fun of(s: String) = values().firstOrNull { it.wire == s } ?: throw OrgAuthorityException("malformed", "kind") }
}

data class OrgKeyRing(
    val orgId: String, val kind: OrgKeyKind, val scope: String, val version: Long, val prevSha256: String, val keyCommitment: String,
    val recipientsHash: String, val retired: List<String>, val oarVersion: Long, val issuedAt: Long,
)

data class OrgKeyRecipient(val recipient: String, val kemKeyId: String, val sealedHex: String)

/** A recipient's verified X-Wing key (`seat:<id>` or `box:<domain>`). */
class OrgKemKey(val recipient: String, val kemPub: ByteArray, val kemKeyId: String)

object OrgServers {
    const val TAG_SERVER_CODE = "flagship/org-server-code/v1"
    const val TAG_SERVER_REGISTER = "flagship/org-server-register/v1"
    const val TAG_INSTALL_BLOB = "flagship/org-install-blob/v1"
    const val TAG_SEAT_KEM = "flagship/org-seat-kem/v1"
    const val TAG_BOX_KEM = "flagship/org-box-kem/v1"
    const val TAG_KEY_RING = "flagship/org-key-ring/v1"
    const val TAG_KEY_RECIPIENTS = "flagship/org-key-recipients/v1"
    const val TAG_KEY_COMMIT = "flagship/org-key-commit/v1"
    const val TAG_KEY_SEAL = "flagship/org-key-seal/v1"
    const val TAG_SEAT_KEM_SEED = "flagship/org-seat-kem-seed/v1"
    const val TAG_LOG = "flagship/org-log/v1"
    const val TAG_AUDIT_EXPORT = "flagship/org-audit-export/v1"
    const val SERVER_CODE_MAX_MS = 24 * 3_600_000L

    private val LABEL = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    private val DOMAIN = Regex("^[a-z0-9][a-z0-9.-]{0,252}$")
    private val SERIAL = Regex("^[A-Za-z0-9_-]{8,64}$")
    private val NONCE = Regex("^[0-9a-f]{16,128}$")
    private val RECIPIENT = Regex("^(?:seat:[0-9a-f]{32}|box:[a-z0-9][a-z0-9.-]{0,252})$")
    private val REGISTER_URL = Regex("^https://[a-z0-9.-]+(?::[0-9]{1,5})?/api/orgs/[0-9a-f]{32}/servers/register$")

    private fun need(ok: Boolean, code: String, detail: String = "") { if (!ok) throw OrgAuthorityException(code, detail) }
    private fun hex(s: String, n: Int) = s.length == n && PqHex.isHex(s) && s == s.lowercase()
    private fun join(vararg p: Any): ByteArray = p.joinToString("|").toByteArray(Charsets.UTF_8)
    private fun sha(b: ByteArray) = OrgAuthority.sha256Hex(b)

    // ── server codes and registration ───────────────────────────────────

    fun canonicalServerCode(c: OrgServerCode): ByteArray {
        need(hex(c.orgId, 32) && hex(c.genesisHash, 64) && hex(c.delegatedPubKeyHex, 64), "malformed", "server code")
        need(SERIAL.matches(c.serial) && LABEL.matches(c.serverName) && DOMAIN.matches(c.serverDomain), "malformed", "server code")
        need(c.serverDomain.startsWith("${c.serverName}."), "malformed", "serverDomain")
        need(c.issuedAt >= 0 && c.expiresAt > c.issuedAt && c.expiresAt - c.issuedAt <= SERVER_CODE_MAX_MS, "malformed", "expiresAt")
        return join(TAG_SERVER_CODE, c.orgId, c.genesisHash, c.serial, c.serverName, c.serverDomain, c.delegatedPubKeyHex, c.issuedAt, c.expiresAt)
    }

    fun serverCodeSha256(c: OrgServerCode) = sha(canonicalServerCode(c))

    /** The org's AuthCode: names this org and genesis, still valid, approved for `add-server`. */
    fun verifyServerCode(state: OrgAuthorityState, book: OrgSeatBook, code: OrgServerCode, approvals: List<OrgApproval>, now: Long): Pair<List<String>, String?> {
        val order = canonicalServerCode(code)
        need(code.orgId == state.orgId && code.genesisHash == OrgAuthority.authorityHash(state.records[0]), "wrong-org")
        need(code.expiresAt > now, "expired")
        return OrgAuthority.authorize(state, book, OrgAction.AddServer, order, approvals, now)
    }

    fun canonicalServerRegister(orgId: String, serial: String, serverDomain: String, codeSha256: String, serverIdentityPubKeyHex: String, issuedAt: Long, nonceHex: String): ByteArray {
        need(hex(orgId, 32) && hex(codeSha256, 64) && hex(serverIdentityPubKeyHex, 64) && SERIAL.matches(serial), "malformed", "register")
        need(DOMAIN.matches(serverDomain) && NONCE.matches(nonceHex) && issuedAt >= 0, "malformed", "register")
        return join(TAG_SERVER_REGISTER, orgId, serial, serverDomain, codeSha256, serverIdentityPubKeyHex, issuedAt, nonceHex)
    }

    // ── the org recipe ───────────────────────────────────────────────────

    fun canonicalInstallBlob(
        orgId: String, genesisHash: String, orgName: String, serverName: String, serverDomain: String, registrationUrl: String,
        installerGitRef: String, phoneDelegatedPubKey: String, code: OrgServerCode, bootUnlockMode: String, diskEncryption: String,
    ): ByteArray {
        need(hex(orgId, 32) && hex(genesisHash, 64) && hex(phoneDelegatedPubKey, 64) && hex(installerGitRef, 40), "malformed", "install blob")
        need(LABEL.matches(orgName) && LABEL.matches(serverName) && DOMAIN.matches(serverDomain), "malformed", "install blob")
        need(REGISTER_URL.matches(registrationUrl) && registrationUrl.contains("/api/orgs/$orgId/"), "malformed", "registrationUrl")
        need(bootUnlockMode in setOf("auto", "approve") && diskEncryption in setOf("luks", "none"), "malformed", "install blob")
        need(code.orgId == orgId && code.genesisHash == genesisHash && code.serverName == serverName && code.serverDomain == serverDomain, "malformed", "code names another server")
        val apex = serverDomain.split(".").drop(2).joinToString(".")
        need(serverDomain == "$serverName.$orgName.$apex", "malformed", "serverDomain")
        return join(TAG_INSTALL_BLOB, orgId, genesisHash, orgName, serverName, serverDomain, registrationUrl, installerGitRef, phoneDelegatedPubKey,
            serverCodeSha256(code), bootUnlockMode, diskEncryption)
    }

    // ── KEM keys ─────────────────────────────────────────────────────────

    fun kemKeyIdHex(kemPub: ByteArray): String = PqHex.encode(PqHybrid.pqKeyId(PqHybrid.SUITE_HYBRID_SEAL_V1, kemPub))

    /** The seat's X-Wing seed from the person's UMK, for this org (every device of theirs opens its copies). */
    fun seatKemSeed(umk: ByteArray, orgId: String): ByteArray {
        need(umk.size == 32 && hex(orgId, 32), "malformed", "kem seed")
        val g = HKDFBytesGenerator(SHA256Digest())
        g.init(HKDFParameters(umk, ByteArray(0), "$TAG_SEAT_KEM_SEED|$orgId".toByteArray(Charsets.UTF_8)))
        return ByteArray(32).also { g.generateBytes(it, 0, 32) }
    }

    fun canonicalSeatKem(orgId: String, seatId: String, kemKeyId: String, issuedAt: Long): ByteArray {
        need(hex(orgId, 32) && hex(seatId, 32) && hex(kemKeyId, 64) && issuedAt >= 0, "malformed", "seat kem")
        return join(TAG_SEAT_KEM, orgId, seatId, kemKeyId, issuedAt)
    }

    fun canonicalBoxKem(orgId: String, serverDomain: String, kemKeyId: String, issuedAt: Long): ByteArray {
        need(hex(orgId, 32) && DOMAIN.matches(serverDomain) && hex(kemKeyId, 64) && issuedAt >= 0, "malformed", "box kem")
        return join(TAG_BOX_KEM, orgId, serverDomain, kemKeyId, issuedAt)
    }

    // ── the key ring ─────────────────────────────────────────────────────

    private fun orgWide(k: OrgKeyKind) = k == OrgKeyKind.CGK || k == OrgKeyKind.DIRECTORY_KEY

    fun canonicalKeyRing(r: OrgKeyRing): ByteArray {
        need(hex(r.orgId, 32), "malformed", "orgId")
        need(if (orgWide(r.kind)) r.scope == "*" else DOMAIN.matches(r.scope), "malformed", "scope")
        need(r.version >= 1 && hex(r.prevSha256, 64) && hex(r.keyCommitment, 64) && hex(r.recipientsHash, 64), "malformed", "ring")
        need(r.retired.all { hex(it, 32) } && r.retired == r.retired.sorted() && r.retired.toSet().size == r.retired.size, "malformed", "retired")
        need(r.oarVersion >= 0 && r.issuedAt >= 0, "malformed", "ring")
        return join(TAG_KEY_RING, r.orgId, r.kind.wire, r.scope, r.version, r.prevSha256, r.keyCommitment, r.recipientsHash, r.retired.joinToString(","), r.oarVersion, r.issuedAt)
    }

    fun keyRingSha256(r: OrgKeyRing) = sha(canonicalKeyRing(r))

    fun keyCommitment(orgId: String, kind: OrgKeyKind, scope: String, version: Long, key: ByteArray): String {
        need(key.size == 32, "malformed", "key")
        return sha(join(TAG_KEY_COMMIT, orgId, kind.wire, scope, version, PqHex.encode(key)))
    }

    fun recipientsHash(recipients: List<OrgKeyRecipient>): String {
        need(recipients.isNotEmpty() && recipients.size <= 256 && recipients.map { it.recipient }.toSet().size == recipients.size, "malformed", "recipients")
        val lines = recipients.map { x ->
            need(RECIPIENT.matches(x.recipient) && hex(x.kemKeyId, 64), "malformed", "recipient")
            val sealed = PqHex.decode(x.sealedHex)
            need(sealed != null && sealed.isNotEmpty() && x.sealedHex.length <= 8192, "malformed", "sealedHex")
            "${x.recipient}:${x.kemKeyId}:${sha(sealed!!)}"
        }
        return sha("$TAG_KEY_RECIPIENTS|${lines.sorted().joinToString(";")}".toByteArray(Charsets.UTF_8))
    }

    private fun sealContext(orgId: String, kind: OrgKeyKind, scope: String, version: Long, recipient: String) =
        listOf(orgId, kind.wire, scope, version.toString(), recipient).map { it.toByteArray(Charsets.UTF_8) }

    /** Opens this recipient's copy and checks it against the ring's key commitment. */
    fun openKeyRing(r: OrgKeyRing, recipients: List<OrgKeyRecipient>, recipient: String, kemSecret: ByteArray): ByteArray {
        val mine = recipients.firstOrNull { it.recipient == recipient } ?: throw OrgAuthorityException("seat-unknown", "not a recipient")
        val sealed = PqHex.decode(mine.sealedHex) ?: throw OrgAuthorityException("malformed", "sealedHex")
        val key = PqHybrid.hybridOpen(kemSecret, TAG_KEY_SEAL, sealContext(r.orgId, r.kind, r.scope, r.version, recipient), sealed).plaintext
        need(keyCommitment(r.orgId, r.kind, r.scope, r.version, key) == r.keyCommitment, "order-mismatch", "key commitment")
        return key
    }

    /** A new version sealed to `recipients` (a phone's rotation); the caller approves `canonicalKeyRing(ring)` and posts it. */
    fun buildKeyRing(
        orgId: String, kind: OrgKeyKind, scope: String, prev: OrgKeyRing?, key: ByteArray, recipients: List<OrgKemKey>,
        retired: List<String>, oarVersion: Long, issuedAt: Long,
    ): Pair<OrgKeyRing, List<OrgKeyRecipient>> {
        val version = (prev?.version ?: 0L) + 1
        val out = recipients.map { k ->
            val opts = PqHybrid.HybridSealOptions(purpose = TAG_KEY_SEAL, senderKeyId = ByteArray(32), issuedAt = issuedAt)
            OrgKeyRecipient(k.recipient, k.kemKeyId, PqHex.encode(PqHybrid.hybridSeal(k.kemPub, opts, sealContext(orgId, kind, scope, version, k.recipient), key)))
        }
        val ring = OrgKeyRing(orgId, kind, scope, version, prev?.let { keyRingSha256(it) } ?: "0".repeat(64),
            keyCommitment(orgId, kind, scope, version, key), recipientsHash(out), retired.sorted(), oarVersion, issuedAt)
        canonicalKeyRing(ring)
        return ring to out
    }

    // ── audit export ─────────────────────────────────────────────────────

    fun logEntryHash(orgId: String, seq: Long, prevHash: String, kind: String, refSha256: String, at: Long) = sha(join(TAG_LOG, orgId, seq, prevHash, kind, refSha256, at))

    fun canonicalAuditExport(orgId: String, oarVersion: Long, oarHash: String, logSeq: Long, logHeadHash: String, issuedAt: Long): ByteArray {
        need(hex(orgId, 32) && hex(oarHash, 64) && hex(logHeadHash, 64) && oarVersion >= 0 && logSeq >= 0 && issuedAt >= 0, "malformed", "audit export")
        return join(TAG_AUDIT_EXPORT, orgId, oarVersion, oarHash, logSeq, logHeadHash, issuedAt)
    }
}
