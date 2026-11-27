/**
 * Account master-key rotation storage (migration 0164, docs/account-key-rotation.md).
 *
 * `apply` is one D1 batch (one transaction). Its first statement is the compare-and-set on the account
 * row (IRK, key epoch, admin root). The lane row comes next and computes `cas_ok` from the state that
 * swap left behind: the new keys in place, the recovery record still the one the hop was signed against,
 * every kept device still active with the key the hop names. `cas_ok` is CHECKed to be 1, so a lost race
 * or a changed precondition fails the batch and nothing in it is applied. Every later statement is also
 * conditioned on the lane row this batch wrote (its `apply_id`).
 */
import type { D1Database, D1PreparedStatement } from "./d1.js";
import type {
  AccountKeyRotationApply,
  AccountKeyRotationRecord,
  AccountKeyRotationStorage,
  DeviceCapabilityGrantRecord,
  DeviceReceiveKeyRecord,
  UmkRotationDeliveryRecord,
  Storage,
} from "./types.js";

interface RotationRow {
  username: string;
  from_epoch: number;
  to_epoch: number;
  rotation_digest_hex: string;
  admin_root_pub_hex: string;
  old_irk_pub_hex: string;
  new_irk_pub_hex: string;
  hop_json: string;
  kept_json: string;
  applied_at: number;
}

interface DeliveryRow {
  username: string;
  to_epoch: number;
  device_id: string;
  device_pub_hex: string;
  seal_kind: string;
  sealed_hex: string;
  delivery_json: string;
  signature_hex: string;
  created_at: number;
  expires_at: number;
  acked_at: number | null;
}

interface ReceiveKeyRow {
  account_id: string;
  device_id: string;
  device_pub_hex: string;
  xwing_pub_hex: string;
  issued_at: number;
  signature_hex: string;
  updated_at: number;
}

function rotationOf(r: RotationRow): AccountKeyRotationRecord {
  return {
    username: r.username,
    fromEpoch: r.from_epoch,
    toEpoch: r.to_epoch,
    rotationDigestHex: r.rotation_digest_hex,
    adminRootPubHex: r.admin_root_pub_hex,
    oldIrkPubHex: r.old_irk_pub_hex,
    newIrkPubHex: r.new_irk_pub_hex,
    hopJson: r.hop_json,
    keptJson: r.kept_json,
    appliedAt: r.applied_at,
  };
}

function deliveryOf(r: DeliveryRow): UmkRotationDeliveryRecord {
  return {
    username: r.username,
    toEpoch: r.to_epoch,
    deviceId: r.device_id,
    devicePubHex: r.device_pub_hex,
    sealKind: r.seal_kind === "xwing" ? "xwing" : "ed25519",
    sealedHex: r.sealed_hex,
    deliveryJson: r.delivery_json,
    signatureHex: r.signature_hex,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ackedAt: r.acked_at,
  };
}

function receiveKeyOf(r: ReceiveKeyRow): DeviceReceiveKeyRecord {
  return {
    accountId: r.account_id,
    deviceId: r.device_id,
    devicePubHex: r.device_pub_hex,
    xwingPubHex: r.xwing_pub_hex,
    issuedAt: r.issued_at,
    signatureHex: r.signature_hex,
    updatedAt: r.updated_at,
  };
}

/** The SQL predicate (and its binds) that the recovery row is in the state the plan expects. */
function recoveryGuard(u: string, digest: string): { sql: string; binds: unknown[] } {
  if (digest === "genesis") return { sql: "NOT EXISTS (SELECT 1 FROM webauthn_recovery_records WHERE username = ?)", binds: [u] };
  if (digest === "legacy") {
    return { sql: "EXISTS (SELECT 1 FROM webauthn_recovery_records WHERE username = ? AND record_digest_hex IS NULL)", binds: [u] };
  }
  return { sql: "EXISTS (SELECT 1 FROM webauthn_recovery_records WHERE username = ? AND record_digest_hex = ?)", binds: [u, digest] };
}

const GRANT_COLUMNS =
  "grant_id, username, device_id, device_pub_hex, scopes_json, issued_at, expires_at, signature_hex, revoked_at, signer_root, pq_signature_json";

function grantBinds(g: DeviceCapabilityGrantRecord, u: string): unknown[] {
  return [
    g.grantId, u, g.deviceId.toLowerCase(), g.devicePubHex.toLowerCase(), g.scopesJson, g.issuedAt, g.expiresAt,
    g.signatureHex, null, g.signerRoot ?? "membership", g.pqSignatureJson ?? null,
  ];
}

export class D1AccountKeyRotationStorage implements AccountKeyRotationStorage {
  constructor(private readonly db: D1Database) {}

  async apply(plan: AccountKeyRotationApply): Promise<{ ok: true } | { ok: false; reason: "conflict" }> {
    const r = plan.rotation;
    const u = r.username.toLowerCase();
    const at = plan.at;
    const applyId = `${r.rotationDigestHex}:${at}:${Math.random().toString(16).slice(2)}`;
    const keptIds = JSON.stringify(plan.kept.map((k) => k.deviceId.toLowerCase()));
    const keptPairs = JSON.stringify(plan.kept.map((k) => `${k.deviceId.toLowerCase()}:${k.devicePubHex.toLowerCase()}`));
    const replacedDevices = JSON.stringify([...new Set(plan.newGrants.map((g) => g.deviceId.toLowerCase()))]);
    // Every statement after the lane row runs only if this batch wrote it.
    const G = "EXISTS (SELECT 1 FROM account_key_rotations WHERE username = ? AND to_epoch = ? AND apply_id = ?)";
    const g = [u, r.toEpoch, applyId];
    const recoveryExpect =
      plan.recovery.kind === "replace" ? plan.recovery.expectedPriorDigest
      : plan.recovery.kind === "delete" ? plan.recovery.expectedDigest
      : "genesis";
    const rec = recoveryGuard(u, recoveryExpect);
    const stmts: D1PreparedStatement[] = [
      this.db.prepare(
        `UPDATE usernames SET irk_pub_hex = ?, aid_pub_hex = ?, key_epoch = ?
         WHERE username = ? AND lower(irk_pub_hex) = ? AND key_epoch = ? AND lower(admin_root_pub_hex) = ?`,
      ).bind(r.newIrkPubHex, plan.newAidPubHex, r.toEpoch, u, r.oldIrkPubHex.toLowerCase(), r.fromEpoch, plan.expectedAdminRootPubHex.toLowerCase()),
      this.db.prepare(
        `INSERT INTO account_key_rotations
           (username, to_epoch, from_epoch, rotation_digest_hex, admin_root_pub_hex, old_irk_pub_hex, new_irk_pub_hex,
            hop_json, kept_json, apply_id, applied_at, cas_ok)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (EXISTS (SELECT 1 FROM usernames WHERE username = ? AND irk_pub_hex = ? AND key_epoch = ?)
            AND ${rec.sql}
            AND (SELECT COUNT(*) FROM device_identities
                 WHERE account_id = ? AND revoked_at IS NULL
                   AND (device_id || ':' || device_pub_hex) IN (SELECT value FROM json_each(?))) = ?)`,
      ).bind(
        u, r.toEpoch, r.fromEpoch, r.rotationDigestHex, r.adminRootPubHex, r.oldIrkPubHex, r.newIrkPubHex,
        r.hopJson, r.keptJson, applyId, at,
        u, r.newIrkPubHex, r.toEpoch,
        ...rec.binds,
        u, keptPairs, plan.kept.length,
      ),
      this.db.prepare(
        `UPDATE device_identities SET revoked_at = ?
         WHERE account_id = ? AND revoked_at IS NULL AND device_id NOT IN (SELECT value FROM json_each(?)) AND ${G}`,
      ).bind(at, u, keptIds, ...g),
      this.db.prepare(
        `UPDATE device_capability_grants SET revoked_at = ?
         WHERE username = ? AND revoked_at IS NULL
           AND (device_id NOT IN (SELECT value FROM json_each(?))
                OR signer_root <> 'admin-root'
                OR device_id IN (SELECT value FROM json_each(?)))
           AND ${G}`,
      ).bind(at, u, keptIds, replacedDevices, ...g),
      ...plan.newGrants.map((grant) =>
        this.db.prepare(`INSERT INTO device_capability_grants (${GRANT_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${G}`)
          .bind(...grantBinds(grant, u), ...g)),
      this.db.prepare(
        `DELETE FROM push_tokens WHERE username = ? AND device_id NOT IN (SELECT value FROM json_each(?)) AND ${G}`,
      ).bind(u, keptIds, ...g),
      this.db.prepare(`UPDATE pending_re_pairs SET objected_at = ? WHERE username = ? AND objected_at IS NULL AND ${G}`).bind(at, u, ...g),
      this.db.prepare(`DELETE FROM device_self_profiles WHERE account_id = ? AND ${G}`).bind(u, ...g),
      this.db.prepare(`DELETE FROM account_directory_key_grants WHERE account_id = ? AND ${G}`).bind(u, ...g),
      this.db.prepare(`DELETE FROM device_managed_profiles WHERE account_id = ? AND ${G}`).bind(u, ...g),
      this.db.prepare(`DELETE FROM account_profiles WHERE account_id = ? AND ${G}`).bind(u, ...g),
      this.db.prepare(`DELETE FROM device_receive_keys WHERE account_id = ? AND device_id NOT IN (SELECT value FROM json_each(?)) AND ${G}`)
        .bind(u, keptIds, ...g),
    ];
    if (plan.accountProfile) {
      const p = plan.accountProfile;
      stmts.push(this.db.prepare(
        `INSERT INTO account_profiles
           (account_id, revision, key_version, nonce_hex, ciphertext_hex, signer_pub_hex, signature_hex, issued_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${G}`,
      ).bind(u, p.revision, p.keyVersion, p.nonceHex, p.ciphertextHex, p.signerPubHex, p.signatureHex, p.issuedAt, p.updatedAt, ...g));
    }
    for (const p of plan.managedProfiles) {
      stmts.push(this.db.prepare(
        `INSERT INTO device_managed_profiles
           (account_id, device_id, revision, key_version, nonce_hex, ciphertext_hex, locked, signer_pub_hex, signature_hex, issued_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${G}`,
      ).bind(u, p.deviceId.toLowerCase(), p.revision, p.keyVersion, p.nonceHex, p.ciphertextHex, p.locked ? 1 : 0, p.signerPubHex, p.signatureHex, p.issuedAt, p.updatedAt, ...g));
    }
    if (plan.recovery.kind === "replace") {
      const rr = plan.recovery.record;
      const vals = [
        u, rr.credentialIdHex, rr.wrappedUmkB64, rr.irkPubHex, rr.fetchTokenHashHex ?? null, rr.prfSaltHashHex ?? null,
        rr.wrappedAcmeAccountKeyB64 ?? null, rr.wrappedAdminRootB64 ?? null, rr.signed?.digestHex ?? null,
        rr.signed?.generation ?? null, rr.signed?.signedClaimJson ?? null, rr.signed?.signatureHex ?? null,
        rr.passkey?.coseHex ?? null, rr.passkey?.alg ?? null, rr.createdAt, rr.updatedAt,
      ];
      stmts.push(this.db.prepare(`DELETE FROM webauthn_recovery_records WHERE username = ? AND ${G}`).bind(u, ...g));
      stmts.push(this.db.prepare(
        `INSERT INTO webauthn_recovery_records
           (username, credential_id_hex, wrapped_umk_b64, irk_pub_hex, fetch_token_hash, prf_salt_hash,
            wrapped_acme_account_key_b64, wrapped_admin_root_b64, record_digest_hex, generation, signed_claim_json,
            signature_hex, passkey_cose_hex, passkey_alg, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${G}`,
      ).bind(...vals, ...g));
    } else if (plan.recovery.kind === "delete") {
      stmts.push(this.db.prepare(`DELETE FROM webauthn_recovery_records WHERE username = ? AND ${G}`).bind(u, ...g));
    }
    for (const d of plan.deliveries) {
      stmts.push(this.db.prepare(
        `INSERT INTO umk_rotation_deliveries
           (username, to_epoch, device_id, device_pub_hex, seal_kind, sealed_hex, delivery_json, signature_hex, created_at, expires_at, acked_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL WHERE ${G}`,
      ).bind(u, d.toEpoch, d.deviceId.toLowerCase(), d.devicePubHex.toLowerCase(), d.sealKind, d.sealedHex, d.deliveryJson, d.signatureHex, d.createdAt, d.expiresAt, ...g));
    }
    const a = plan.audit;
    stmts.push(this.db.prepare(
      `INSERT INTO audit_events (username, event_kind, detail, device_prefix, posted_at, account_type_at_event, quarantine_until, recovery_method)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${G}`,
    ).bind(u, a.eventKind, a.detail, a.devicePrefix, a.postedAt, a.accountTypeAtEvent ?? null, a.quarantineUntil ?? null, a.recoveryMethod ?? null, ...g));
    try {
      await this.db.batch(stmts);
    } catch (e) {
      // The CHECK on cas_ok (lost race, changed precondition) or the lane's keys (same epoch or digest twice).
      if (/CHECK|UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) return { ok: false, reason: "conflict" };
      throw e;
    }
    return { ok: true };
  }

  async list(username: string): Promise<AccountKeyRotationRecord[]> {
    const rows = await this.db.prepare("SELECT * FROM account_key_rotations WHERE username = ? ORDER BY to_epoch")
      .bind(username.toLowerCase()).all<RotationRow>();
    return (rows.results ?? []).map(rotationOf);
  }

  async getByDigest(rotationDigestHex: string): Promise<AccountKeyRotationRecord | undefined> {
    const row = await this.db.prepare("SELECT * FROM account_key_rotations WHERE rotation_digest_hex = ?")
      .bind(rotationDigestHex.toLowerCase()).first<RotationRow>();
    return row ? rotationOf(row) : undefined;
  }

  async listPendingDeliveries(username: string, deviceId: string, now: number): Promise<UmkRotationDeliveryRecord[]> {
    const rows = await this.db.prepare(
      "SELECT * FROM umk_rotation_deliveries WHERE username = ? AND device_id = ? AND acked_at IS NULL AND expires_at > ? ORDER BY to_epoch",
    ).bind(username.toLowerCase(), deviceId.toLowerCase(), now).all<DeliveryRow>();
    return (rows.results ?? []).map(deliveryOf);
  }

  async ackDeliveries(username: string, deviceId: string, toEpoch: number, at: number): Promise<number> {
    const r = await this.db.prepare(
      "UPDATE umk_rotation_deliveries SET acked_at = ? WHERE username = ? AND device_id = ? AND to_epoch <= ? AND acked_at IS NULL",
    ).bind(at, username.toLowerCase(), deviceId.toLowerCase(), toEpoch).run();
    return r.meta.changes ?? 0;
  }

  async putReceiveKey(rec: DeviceReceiveKeyRecord): Promise<void> {
    await this.db.prepare(
      `INSERT INTO device_receive_keys (account_id, device_id, device_pub_hex, xwing_pub_hex, issued_at, signature_hex, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, device_id) DO UPDATE SET
         device_pub_hex = excluded.device_pub_hex, xwing_pub_hex = excluded.xwing_pub_hex,
         issued_at = excluded.issued_at, signature_hex = excluded.signature_hex, updated_at = excluded.updated_at
       WHERE excluded.issued_at >= device_receive_keys.issued_at`,
    ).bind(rec.accountId.toLowerCase(), rec.deviceId.toLowerCase(), rec.devicePubHex.toLowerCase(), rec.xwingPubHex.toLowerCase(), rec.issuedAt, rec.signatureHex, rec.updatedAt).run();
  }

  async getReceiveKey(accountId: string, deviceId: string): Promise<DeviceReceiveKeyRecord | undefined> {
    const row = await this.db.prepare("SELECT * FROM device_receive_keys WHERE account_id = ? AND device_id = ?")
      .bind(accountId.toLowerCase(), deviceId.toLowerCase()).first<ReceiveKeyRow>();
    return row ? receiveKeyOf(row) : undefined;
  }

  async listReceiveKeys(accountId: string): Promise<DeviceReceiveKeyRecord[]> {
    const rows = await this.db.prepare("SELECT * FROM device_receive_keys WHERE account_id = ? ORDER BY device_id")
      .bind(accountId.toLowerCase()).all<ReceiveKeyRow>();
    return (rows.results ?? []).map(receiveKeyOf);
  }

  async rotateDeviceKey(args: {
    accountId: string;
    deviceId: string;
    oldDevicePubHex: string;
    newDevicePubHex: string;
    revokeGrantIds: string[];
    newGrant: DeviceCapabilityGrantRecord | null;
    at: number;
  }): Promise<boolean> {
    const u = args.accountId.toLowerCase();
    const id = args.deviceId.toLowerCase();
    const G = "EXISTS (SELECT 1 FROM device_identities WHERE account_id = ? AND device_id = ? AND device_pub_hex = ? AND key_origin = 'random' AND revoked_at IS NULL)";
    const g = [u, id, args.newDevicePubHex.toLowerCase()];
    const stmts: D1PreparedStatement[] = [
      this.db.prepare(
        `UPDATE device_identities SET device_pub_hex = ?, key_origin = 'random'
         WHERE account_id = ? AND device_id = ? AND device_pub_hex = ? AND revoked_at IS NULL`,
      ).bind(args.newDevicePubHex.toLowerCase(), u, id, args.oldDevicePubHex.toLowerCase()),
      this.db.prepare(`DELETE FROM device_receive_keys WHERE account_id = ? AND device_id = ? AND ${G}`).bind(u, id, ...g),
      ...args.revokeGrantIds.map((grantId) =>
        this.db.prepare(`UPDATE device_capability_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL AND ${G}`)
          .bind(args.at, grantId, ...g)),
      ...(args.newGrant
        ? [this.db.prepare(`INSERT INTO device_capability_grants (${GRANT_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${G}`)
            .bind(...grantBinds(args.newGrant, u), ...g)]
        : []),
    ];
    let results;
    try {
      results = await this.db.batch(stmts);
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) return false;
      throw e;
    }
    return (results[0]?.meta?.changes ?? 0) > 0;
  }
}

/** The in-memory stores the in-memory rotation writes through (InMemoryStorage wires its own). */
export interface InMemoryAccountKeyRotationDeps {
  usernames: Storage["usernames"] & { setAccountKeys(u: string, irk: string, aid: string, epoch: number): void };
  identities: Storage["deviceIdentities"] & { rekey(a: string, d: string, oldPub: string, newPub: string): boolean };
  grants: Storage["deviceCapabilityGrants"];
  pushTokens: Storage["pushTokens"];
  pendingRePairs: Storage["pendingRePairs"];
  webauthnRecovery: Storage["webauthnRecovery"];
  accountProfiles: Storage["accountProfiles"];
  selfProfiles: Storage["deviceSelfProfiles"];
  managedProfiles: Storage["deviceManagedProfiles"];
  directoryKeyGrants: Storage["accountDirectoryKeyGrants"];
  auditEvents: Storage["auditEvents"];
}

/**
 * In memory: every precondition is checked first, then everything is written, under one lock, so two
 * applies never interleave (the D1 adapter gets the same from its single transaction).
 */
export class InMemoryAccountKeyRotationStorage implements AccountKeyRotationStorage {
  private rotations: AccountKeyRotationRecord[] = [];
  private deliveries: UmkRotationDeliveryRecord[] = [];
  private receiveKeys = new Map<string, DeviceReceiveKeyRecord>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly s: InMemoryAccountKeyRotationDeps) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  apply(plan: AccountKeyRotationApply): Promise<{ ok: true } | { ok: false; reason: "conflict" }> {
    return this.serial(async () => {
      const r = plan.rotation;
      const u = r.username.toLowerCase();
      const conflict = { ok: false as const, reason: "conflict" as const };
      const user = await this.s.usernames.get(u);
      if (
        !user || user.irkPubHex.toLowerCase() !== r.oldIrkPubHex.toLowerCase() || (user.keyEpoch ?? 0) !== r.fromEpoch ||
        (user.adminRootPubHex ?? "").toLowerCase() !== plan.expectedAdminRootPubHex.toLowerCase()
      ) return conflict;
      if (this.rotations.some((x) => x.rotationDigestHex === r.rotationDigestHex || (x.username === u && x.toEpoch === r.toEpoch))) return conflict;
      const recovery = await this.s.webauthnRecovery.get(u);
      const expect = plan.recovery.kind === "replace" ? plan.recovery.expectedPriorDigest
        : plan.recovery.kind === "delete" ? plan.recovery.expectedDigest : "genesis";
      const have = !recovery ? "genesis" : (recovery.signed?.digestHex ?? "legacy");
      if (have !== expect) return conflict;
      const identities = await this.s.identities.listForAccount(u);
      const keptIds = new Set(plan.kept.map((k) => k.deviceId.toLowerCase()));
      for (const k of plan.kept) {
        const id = identities.find((d) => d.deviceId === k.deviceId.toLowerCase());
        if (!id || id.revokedAt !== null || id.devicePubHex !== k.devicePubHex.toLowerCase()) return conflict;
      }

      const at = plan.at;
      this.s.usernames.setAccountKeys(u, r.newIrkPubHex, plan.newAidPubHex, r.toEpoch);
      this.rotations.push({ ...r, username: u });
      for (const d of identities) {
        if (d.revokedAt === null && !keptIds.has(d.deviceId)) await this.s.identities.revoke(u, d.deviceId, at);
      }
      const replaced = new Set(plan.newGrants.map((g) => g.deviceId.toLowerCase()));
      for (const g of await this.s.grants.listForUser(u)) {
        if (g.revokedAt !== null) continue;
        const dev = g.deviceId.toLowerCase();
        if (!keptIds.has(dev) || (g.signerRoot ?? "membership") !== "admin-root" || replaced.has(dev)) await this.s.grants.revoke(g.grantId, at);
      }
      for (const g of plan.newGrants) await this.s.grants.put({ ...g, username: u, revokedAt: null });
      for (const t of await this.s.pushTokens.listByUser(u)) {
        if (!keptIds.has(t.deviceId.toLowerCase())) await this.s.pushTokens.remove(t.tokenId);
      }
      await this.s.pendingRePairs.object(u, at);
      await this.s.selfProfiles.purgeForAccount(u);
      await this.s.directoryKeyGrants.purgeForAccount(u);
      for (const [key, k] of this.receiveKeys) if (k.accountId === u && !keptIds.has(k.deviceId)) this.receiveKeys.delete(key);
      // The handler checked each replacement is the stored revision + 1 (or 1 when none).
      if (plan.accountProfile) await this.s.accountProfiles.put({ ...plan.accountProfile, accountId: u }, plan.accountProfile.revision - 1);
      else await this.s.accountProfiles.purgeForAccount(u);
      const keptManaged = new Set(plan.managedProfiles.map((p) => p.deviceId.toLowerCase()));
      for (const p of await this.s.managedProfiles.listForAccount(u)) {
        if (!keptManaged.has(p.deviceId)) await this.s.managedProfiles.delete(u, p.deviceId, p.revision);
      }
      for (const p of plan.managedProfiles) await this.s.managedProfiles.put({ ...p, accountId: u }, p.revision - 1);
      if (plan.recovery.kind === "replace") {
        await this.s.webauthnRecovery.delete(u);
        await this.s.webauthnRecovery.upsert({ ...plan.recovery.record, username: u });
      } else if (plan.recovery.kind === "delete") {
        await this.s.webauthnRecovery.delete(u);
      }
      for (const d of plan.deliveries) this.deliveries.push({ ...d, username: u, deviceId: d.deviceId.toLowerCase(), ackedAt: null });
      await this.s.auditEvents.append({ ...plan.audit, username: u });
      return { ok: true as const };
    });
  }

  async list(username: string): Promise<AccountKeyRotationRecord[]> {
    const u = username.toLowerCase();
    return this.rotations.filter((r) => r.username === u).sort((a, b) => a.toEpoch - b.toEpoch).map((r) => ({ ...r }));
  }

  async getByDigest(rotationDigestHex: string): Promise<AccountKeyRotationRecord | undefined> {
    const r = this.rotations.find((x) => x.rotationDigestHex === rotationDigestHex.toLowerCase());
    return r ? { ...r } : undefined;
  }

  async listPendingDeliveries(username: string, deviceId: string, now: number): Promise<UmkRotationDeliveryRecord[]> {
    const u = username.toLowerCase();
    const id = deviceId.toLowerCase();
    return this.deliveries
      .filter((d) => d.username === u && d.deviceId === id && d.ackedAt === null && d.expiresAt > now)
      .sort((a, b) => a.toEpoch - b.toEpoch)
      .map((d) => ({ ...d }));
  }

  async ackDeliveries(username: string, deviceId: string, toEpoch: number, at: number): Promise<number> {
    let n = 0;
    for (const d of this.deliveries) {
      if (d.username === username.toLowerCase() && d.deviceId === deviceId.toLowerCase() && d.toEpoch <= toEpoch && d.ackedAt === null) {
        d.ackedAt = at;
        n++;
      }
    }
    return n;
  }

  async putReceiveKey(rec: DeviceReceiveKeyRecord): Promise<void> {
    const key = `${rec.accountId.toLowerCase()}|${rec.deviceId.toLowerCase()}`;
    const prior = this.receiveKeys.get(key);
    if (prior && prior.issuedAt > rec.issuedAt) return;
    this.receiveKeys.set(key, {
      ...rec,
      accountId: rec.accountId.toLowerCase(),
      deviceId: rec.deviceId.toLowerCase(),
      devicePubHex: rec.devicePubHex.toLowerCase(),
      xwingPubHex: rec.xwingPubHex.toLowerCase(),
    });
  }

  async getReceiveKey(accountId: string, deviceId: string): Promise<DeviceReceiveKeyRecord | undefined> {
    const r = this.receiveKeys.get(`${accountId.toLowerCase()}|${deviceId.toLowerCase()}`);
    return r ? { ...r } : undefined;
  }

  async listReceiveKeys(accountId: string): Promise<DeviceReceiveKeyRecord[]> {
    const a = accountId.toLowerCase();
    return [...this.receiveKeys.values()].filter((k) => k.accountId === a).sort((x, y) => x.deviceId.localeCompare(y.deviceId)).map((k) => ({ ...k }));
  }

  rotateDeviceKey(args: {
    accountId: string;
    deviceId: string;
    oldDevicePubHex: string;
    newDevicePubHex: string;
    revokeGrantIds: string[];
    newGrant: DeviceCapabilityGrantRecord | null;
    at: number;
  }): Promise<boolean> {
    return this.serial(async () => {
      const u = args.accountId.toLowerCase();
      const id = args.deviceId.toLowerCase();
      if (await this.s.identities.getByPub(u, args.newDevicePubHex)) return false;
      if (!this.s.identities.rekey(u, id, args.oldDevicePubHex, args.newDevicePubHex)) return false;
      this.receiveKeys.delete(`${u}|${id}`);
      for (const g of args.revokeGrantIds) {
        const rec = await this.s.grants.get(g);
        if (rec && rec.revokedAt === null) await this.s.grants.revoke(g, args.at);
      }
      if (args.newGrant) await this.s.grants.put({ ...args.newGrant, username: u, revokedAt: null });
      return true;
    });
  }
}
