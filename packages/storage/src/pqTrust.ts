/**
 * Architecture v2 milestone 1 (migration 0111): hybrid key bindings per identity, the STK's
 * hybrid signature over a box's boot-key binding, and the assurance PolicyState per scope that
 * the critical-signature gate reads (packages/protocol/src/pqTrust.ts). `.com` verifies every
 * binding before storing it; readers check it again against the identity's current key.
 */
import type { D1Database } from "./d1.js";

export interface PqKeyBindingRecord {
  role: string;
  subjectId: string;
  ed25519PubHex: string;
  mldsaPubHex: string;
  issuedAt: number;
  signatureHex: string;
  storedAt: number;
}

export interface BootKeyHybridRecord {
  serverDomain: string;
  stkPubHex: string;
  bootKeyPubHex: string;
  issuedAt: number;
  hybridSignatureHex: string;
  storedAt: number;
}

export interface PolicyStateRecord {
  scopeKind: string;
  scopeId: string;
  profile: string;
  rollout: string;
  generation: number;
  headDigest: string;
  enforcedEver: boolean;
  updatedAt: number;
}

export type PqPutResult = { ok: true } | { ok: false; reason: "stale" | "pq-key-changed" };

export interface PqTrustStorage {
  getBinding(role: string, subjectId: string): Promise<PqKeyBindingRecord | null>;
  /**
   * Stores `rec` when there is none, when it is for another Ed25519 key (a new STK), or when it
   * is newer and names the SAME ML-DSA key. A different ML-DSA key for the same Ed25519 key is
   * refused: whoever could forge the classical half must not be able to rebind it.
   */
  putBinding(rec: PqKeyBindingRecord): Promise<PqPutResult>;
  getBootHybrid(serverDomain: string): Promise<BootKeyHybridRecord | null>;
  putBootHybrid(rec: BootKeyHybridRecord): Promise<void>;
  getPolicy(scopeKind: string, scopeId: string): Promise<PolicyStateRecord | null>;
  putPolicy(rec: PolicyStateRecord): Promise<void>;
  /** The installation policy and the box-stk binding for a server, in one round trip. */
  forServer(serverDomain: string): Promise<{ policy: PolicyStateRecord | null; stkBinding: PqKeyBindingRecord | null }>;
}

function decide(cur: PqKeyBindingRecord | null, next: PqKeyBindingRecord): PqPutResult {
  if (!cur || cur.ed25519PubHex !== next.ed25519PubHex) return { ok: true };
  if (cur.mldsaPubHex !== next.mldsaPubHex) return { ok: false, reason: "pq-key-changed" };
  return next.issuedAt > cur.issuedAt ? { ok: true } : { ok: false, reason: "stale" };
}

function lower(rec: PqKeyBindingRecord): PqKeyBindingRecord {
  return { ...rec, ed25519PubHex: rec.ed25519PubHex.toLowerCase(), mldsaPubHex: rec.mldsaPubHex.toLowerCase(), signatureHex: rec.signatureHex.toLowerCase() };
}

interface BindingRow {
  b_role: string | null;
  b_subject_id: string | null;
  b_ed25519_pub_hex: string | null;
  b_mldsa_pub_hex: string | null;
  b_issued_at: number | null;
  b_signature_hex: string | null;
  b_stored_at: number | null;
}

interface PolicyRow {
  p_scope_kind: string | null;
  p_scope_id: string | null;
  p_profile: string | null;
  p_rollout: string | null;
  p_generation: number | null;
  p_head_digest: string | null;
  p_enforced_ever: number | null;
  p_updated_at: number | null;
}

const BINDING_COLS =
  "role AS b_role, subject_id AS b_subject_id, ed25519_pub_hex AS b_ed25519_pub_hex, mldsa_pub_hex AS b_mldsa_pub_hex, issued_at AS b_issued_at, signature_hex AS b_signature_hex, stored_at AS b_stored_at";
const POLICY_COLS =
  "scope_kind AS p_scope_kind, scope_id AS p_scope_id, profile AS p_profile, rollout AS p_rollout, generation AS p_generation, head_digest AS p_head_digest, enforced_ever AS p_enforced_ever, updated_at AS p_updated_at";

function bindingOf(r: BindingRow | null): PqKeyBindingRecord | null {
  if (!r || r.b_role === null) return null;
  return {
    role: r.b_role,
    subjectId: r.b_subject_id!,
    ed25519PubHex: r.b_ed25519_pub_hex!,
    mldsaPubHex: r.b_mldsa_pub_hex!,
    issuedAt: r.b_issued_at!,
    signatureHex: r.b_signature_hex!,
    storedAt: r.b_stored_at!,
  };
}

function policyOf(r: PolicyRow | null): PolicyStateRecord | null {
  if (!r || r.p_scope_kind === null) return null;
  return {
    scopeKind: r.p_scope_kind,
    scopeId: r.p_scope_id!,
    profile: r.p_profile!,
    rollout: r.p_rollout!,
    generation: r.p_generation!,
    headDigest: r.p_head_digest!,
    enforcedEver: r.p_enforced_ever === 1,
    updatedAt: r.p_updated_at!,
  };
}

export class D1PqTrustStorage implements PqTrustStorage {
  constructor(private readonly db: D1Database) {}

  async getBinding(role: string, subjectId: string) {
    return bindingOf(
      await this.db.prepare(`SELECT ${BINDING_COLS} FROM pq_key_bindings WHERE role = ?1 AND subject_id = ?2`).bind(role, subjectId).first<BindingRow>(),
    );
  }

  async putBinding(rec: PqKeyBindingRecord) {
    const next = lower(rec);
    const d = decide(await this.getBinding(next.role, next.subjectId), next);
    if (!d.ok) return d;
    await this.db
      .prepare(
        `INSERT INTO pq_key_bindings (role, subject_id, ed25519_pub_hex, mldsa_pub_hex, issued_at, signature_hex, stored_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(role, subject_id) DO UPDATE SET
           ed25519_pub_hex = excluded.ed25519_pub_hex,
           mldsa_pub_hex = excluded.mldsa_pub_hex,
           issued_at = excluded.issued_at,
           signature_hex = excluded.signature_hex,
           stored_at = excluded.stored_at
         WHERE excluded.ed25519_pub_hex != pq_key_bindings.ed25519_pub_hex
            OR (excluded.mldsa_pub_hex = pq_key_bindings.mldsa_pub_hex AND excluded.issued_at > pq_key_bindings.issued_at)`,
      )
      .bind(next.role, next.subjectId, next.ed25519PubHex, next.mldsaPubHex, next.issuedAt, next.signatureHex, next.storedAt)
      .run();
    return d;
  }

  async getBootHybrid(serverDomain: string) {
    const r = await this.db
      .prepare("SELECT * FROM server_boot_key_hybrid WHERE server_domain = ?1")
      .bind(serverDomain.toLowerCase())
      .first<{ server_domain: string; stk_pub_hex: string; boot_key_pub_hex: string; issued_at: number; hybrid_signature_hex: string; stored_at: number }>();
    return r
      ? { serverDomain: r.server_domain, stkPubHex: r.stk_pub_hex, bootKeyPubHex: r.boot_key_pub_hex, issuedAt: r.issued_at, hybridSignatureHex: r.hybrid_signature_hex, storedAt: r.stored_at }
      : null;
  }

  async putBootHybrid(rec: BootKeyHybridRecord) {
    await this.db
      .prepare(
        `INSERT INTO server_boot_key_hybrid (server_domain, stk_pub_hex, boot_key_pub_hex, issued_at, hybrid_signature_hex, stored_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(server_domain) DO UPDATE SET
           stk_pub_hex = excluded.stk_pub_hex, boot_key_pub_hex = excluded.boot_key_pub_hex, issued_at = excluded.issued_at,
           hybrid_signature_hex = excluded.hybrid_signature_hex, stored_at = excluded.stored_at`,
      )
      .bind(rec.serverDomain.toLowerCase(), rec.stkPubHex.toLowerCase(), rec.bootKeyPubHex.toLowerCase(), rec.issuedAt, rec.hybridSignatureHex.toLowerCase(), rec.storedAt)
      .run();
  }

  async getPolicy(scopeKind: string, scopeId: string) {
    return policyOf(
      await this.db.prepare(`SELECT ${POLICY_COLS} FROM assurance_policy_states WHERE scope_kind = ?1 AND scope_id = ?2`).bind(scopeKind, scopeId).first<PolicyRow>(),
    );
  }

  async putPolicy(rec: PolicyStateRecord) {
    await this.db
      .prepare(
        `INSERT INTO assurance_policy_states (scope_kind, scope_id, profile, rollout, generation, head_digest, enforced_ever, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
           profile = excluded.profile, rollout = excluded.rollout, generation = excluded.generation,
           head_digest = excluded.head_digest, enforced_ever = excluded.enforced_ever, updated_at = excluded.updated_at
         WHERE excluded.generation >= assurance_policy_states.generation`,
      )
      .bind(rec.scopeKind, rec.scopeId, rec.profile, rec.rollout, rec.generation, rec.headDigest, rec.enforcedEver ? 1 : 0, rec.updatedAt)
      .run();
  }

  async forServer(serverDomain: string) {
    const d = serverDomain.toLowerCase();
    const r = await this.db
      .prepare(
        `SELECT p.*, b.* FROM (SELECT 1) AS one
           LEFT JOIN (SELECT ${POLICY_COLS} FROM assurance_policy_states WHERE scope_kind = 'installation' AND scope_id = ?1) AS p ON 1 = 1
           LEFT JOIN (SELECT ${BINDING_COLS} FROM pq_key_bindings WHERE role = 'box-stk' AND subject_id = ?1) AS b ON 1 = 1`,
      )
      .bind(d)
      .first<PolicyRow & BindingRow>();
    return { policy: policyOf(r), stkBinding: bindingOf(r) };
  }
}

export class InMemoryPqTrustStorage implements PqTrustStorage {
  private readonly bindings = new Map<string, PqKeyBindingRecord>();
  private readonly boot = new Map<string, BootKeyHybridRecord>();
  private readonly policies = new Map<string, PolicyStateRecord>();

  async getBinding(role: string, subjectId: string) {
    const r = this.bindings.get(`${role}|${subjectId}`);
    return r ? { ...r } : null;
  }

  async putBinding(rec: PqKeyBindingRecord) {
    const next = lower(rec);
    const key = `${next.role}|${next.subjectId}`;
    const d = decide(this.bindings.get(key) ?? null, next);
    if (d.ok) this.bindings.set(key, next);
    return d;
  }

  async getBootHybrid(serverDomain: string) {
    const r = this.boot.get(serverDomain.toLowerCase());
    return r ? { ...r } : null;
  }

  async putBootHybrid(rec: BootKeyHybridRecord) {
    this.boot.set(rec.serverDomain.toLowerCase(), {
      ...rec,
      serverDomain: rec.serverDomain.toLowerCase(),
      stkPubHex: rec.stkPubHex.toLowerCase(),
      bootKeyPubHex: rec.bootKeyPubHex.toLowerCase(),
      hybridSignatureHex: rec.hybridSignatureHex.toLowerCase(),
    });
  }

  async getPolicy(scopeKind: string, scopeId: string) {
    const r = this.policies.get(`${scopeKind}|${scopeId}`);
    return r ? { ...r } : null;
  }

  async putPolicy(rec: PolicyStateRecord) {
    const key = `${rec.scopeKind}|${rec.scopeId}`;
    const cur = this.policies.get(key);
    if (cur && cur.generation > rec.generation) return;
    this.policies.set(key, { ...rec });
  }

  async forServer(serverDomain: string) {
    const d = serverDomain.toLowerCase();
    return { policy: await this.getPolicy("installation", d), stkBinding: await this.getBinding("box-stk", d) };
  }
}
