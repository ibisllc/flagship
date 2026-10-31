/**
 * The box's copy of its serving authority (docs/architecture-v2/serving-wiring.md §3,
 * issuance-and-lease-records.md §5): the owner's signed `serving-policy/v1` (how long the box keeps serving with no
 * admin opening Flagship, and what a lapse does), the leases admin devices sign when they open the app, and the
 * renewal-key delegations those leases lean on. Records arrive on the heartbeat reply (`serving`) and from the apps
 * (`POST /api/screens/serving`); every one is checked with the protocol's own rules (`servingDecision`,
 * `verifyServingRecord`) under the box's pinned sensitive-order key before it is kept. `.com` cannot add or remove
 * authority here: it only carries records the admin signed.
 *
 * `<dataDir>/serving.json` holds everything; `<dataDir>/serving-floor.json` holds a second copy of the strongest
 * policy and the best lease. A lost or damaged `serving.json` alone must not disarm a `lock-server` policy (the
 * default with no policy is "indefinitely"), so on load the strongest verified policy of the two files wins.
 */
import {
  servingDecision,
  verifyServingRecord,
  emptyRevocationState,
  boxNameList,
  nameListSha256,
  GRACE_MS,
  type RenewalKeyDelegation,
  type ServingGrace,
  type ServingInput,
  type ServingLease,
  type ServingOnLapse,
  type ServingPolicy,
  type SignedServingRecord,
} from "@flagship/protocol";
import { keepCorruptAside, readStateFile, writeFileDurable } from "./durableFile.js";

export type SignedPolicy = SignedServingRecord<ServingPolicy>;
export type SignedDelegation = SignedServingRecord<RenewalKeyDelegation>;
export type StoredLease = SignedServingRecord<ServingLease> & { delegation?: SignedDelegation };

/** What server-detail shows: the apps' server-page line and what a policy edit must sign. */
export interface ServingView {
  grace: ServingGrace;
  onLapse: ServingOnLapse;
  /** When app routes stop (and, under `lock-server`, the box locks) without a newer lease; null = no time limit. */
  until: number | null;
  /** 0 when no policy was ever set. */
  policyGen: number;
  regGen: number;
  scopeSha256: string;
  /** The box identity key a policy for this box names. */
  boxPub: string;
}

export interface ServingOfferResult {
  policyAdopted: boolean;
  leasesAccepted: number;
  refused: Array<{ kind: "policy" | "lease" | "delegation"; leaseId?: string; code: string }>;
}

interface Persisted {
  /** `.com`'s word for the box's registration generation (display only: never used to choose a policy). */
  comRegGen: number | null;
  policy: SignedPolicy | null;
  leases: StoredLease[];
}

const MAX_LEASES = 64;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export interface ServingStoreOptions {
  path: string;
  /** Default: `serving-floor.json` beside `path`. */
  floorPath?: string;
  account: string;
  /** The box's identity public key, lowercase hex. */
  boxPub: () => string;
  /** The pinned sensitive-order key (admin root, else IRK), lowercase hex; null pins nothing and keeps nothing. */
  adminKey: string | null;
  /** The box's own name, `<server>.<account>.<apex>`, for the scope hash. */
  serverFqdn: string;
  now?: () => number;
  onChange?: () => void;
  log?: (m: string) => void;
}

export class ServingStore {
  private state: Persisted = { comRegGen: null, policy: null, leases: [] };
  private readonly floorPath: string;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ServingStoreOptions) {
    this.floorPath = opts.floorPath ?? opts.path.replace(/[^/]*$/, "serving-floor.json");
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
  }

  async load(): Promise<void> {
    const main = await this.readFile(this.opts.path, "The serving time limit is read again from the floor copy and from flagshipserver.com.");
    const floor = await this.readFile(this.floorPath, "The serving time limit is read again from serving.json and from flagshipserver.com.");
    const next: Persisted = { comRegGen: null, policy: null, leases: [] };
    if (main && typeof main.comRegGen === "number" && Number.isSafeInteger(main.comRegGen)) next.comRegGen = main.comRegGen;
    for (const src of [main, floor]) {
      if (!src) continue;
      const p = this.verifiedPolicy(src.policy);
      if (p && (!next.policy || stronger(p.record, next.policy.record))) next.policy = p;
    }
    this.state = next;
    if (next.policy) {
      const leases = [...(Array.isArray(main?.leases) ? main.leases : []), ...(Array.isArray(floor?.leases) ? floor.leases : [])];
      for (const l of leases) this.keepLease(l);
    }
    if (!main && !floor) return;
    if (main && floor && JSON.stringify(this.floorOf()) === JSON.stringify(floorShape(floor))) return;
    await this.persist();
  }

  /** The policy that counts, or null (the default: indefinitely, stop-apps). */
  policy(): SignedPolicy | null {
    return this.state.policy;
  }

  leases(): readonly StoredLease[] {
    return this.state.leases;
  }

  adminKey(): string | null {
    return this.opts.adminKey;
  }

  /**
   * The input to `servingDecision` as the box sees itself: its pinned key as both keys (the box trusts no other
   * source), the held policy's own regGen (so `.com` cannot disarm a lock by reporting a newer generation), no
   * revocations (those are the relay's to enforce). Null when there is nothing to decide (no pinned key, no policy).
   */
  decisionInput(now = this.now()): ServingInput | null {
    const admin = this.opts.adminKey;
    const p = this.state.policy;
    if (!admin || !p) return null;
    return {
      account: this.opts.account,
      box: this.opts.boxPub(),
      regGen: p.record.regGen,
      adminKeyFromCom: admin,
      adminKeyFromBox: admin,
      policies: [p],
      leases: this.state.leases,
      revocations: emptyRevocationState(),
      now,
    };
  }

  /** The latest end among the held leases that still count (0 when none). */
  bestLeaseEnd(now = this.now()): number {
    let best = 0;
    for (const l of this.state.leases) {
      if (this.leaseCounts(l, now)) best = Math.max(best, l.record.notAfter);
    }
    return best;
  }

  view(now = this.now()): ServingView {
    const p = this.state.policy?.record ?? null;
    const regGen = Math.max(this.state.comRegGen ?? 0, p?.regGen ?? 0, 1);
    const scopeSha256 = scopeSha256Of(this.opts.serverFqdn, this.opts.account);
    const boxPub = this.opts.boxPub();
    if (!p) return { grace: "indefinite", onLapse: "stop-apps", until: null, policyGen: 0, regGen, scopeSha256, boxPub };
    let until: number | null = null;
    if (p.grace !== "indefinite") {
      const input = this.decisionInput(now);
      const d = input ? servingDecision(input) : null;
      until = d && d.apps ? d.until : Math.max(this.bestLeaseEnd(now), policyGraceEnd(p, now));
    }
    return { grace: p.grace, onLapse: p.onLapse, until, policyGen: p.policyGen, regGen, scopeSha256, boxPub };
  }

  helloFields(): { servingAdminKey: string | null; servingPolicy: SignedPolicy | null } {
    return { servingAdminKey: this.opts.adminKey, servingPolicy: this.state.policy };
  }

  /**
   * Offer records from `.com` (the heartbeat reply's `serving`) or an admin's app (`POST /api/screens/serving`):
   * `{regGen?, policy?, leases?, delegations?}`. Keeps the strongest policy, the best lease per signer for that
   * policy, and drops leases of an older policy. Never throws.
   */
  offer(raw: unknown, source: string): Promise<ServingOfferResult> {
    const run = this.chain.then(() => this.offerNow(raw, source));
    this.chain = run.catch(() => {});
    return run;
  }

  private async offerNow(raw: unknown, source: string): Promise<ServingOfferResult> {
    const out: ServingOfferResult = { policyAdopted: false, leasesAccepted: 0, refused: [] };
    if (!isObj(raw) || !this.opts.adminKey) return out;
    const before = JSON.stringify(this.state);
    if (typeof raw.regGen === "number" && Number.isSafeInteger(raw.regGen) && raw.regGen >= 1) this.state.comRegGen = raw.regGen;

    if (raw.policy !== undefined && raw.policy !== null) {
      const p = this.verifiedPolicy(raw.policy);
      if (!p) out.refused.push({ kind: "policy", code: "serving-policy-signature" });
      else if (!this.state.policy || stronger(p.record, this.state.policy.record)) {
        this.state.policy = p;
        this.state.leases = this.state.leases.filter((l) => samePolicy(l.record, p.record));
        out.policyAdopted = true;
        this.log(`[serving] adopted policy ${p.record.policyGen} (${p.record.grace}, ${p.record.onLapse}) from ${source}`);
      } else if (stronger(this.state.policy.record, p.record)) {
        out.refused.push({ kind: "policy", code: "serving-policy-stale" });
      }
    }

    const delegations: SignedDelegation[] = [];
    for (const d of Array.isArray(raw.delegations) ? raw.delegations : []) {
      const v = this.verifiedDelegation(d);
      if (v) delegations.push(v);
      else out.refused.push({ kind: "delegation", code: "renewal-delegation-signature" });
    }

    for (const l of Array.isArray(raw.leases) ? raw.leases : []) {
      const parsed = parseLease(l, delegations, this.state.leases);
      const rec = isObj(l) ? (l.record ?? l.lease) : null;
      const leaseId = isObj(rec) && typeof rec.leaseId === "string" ? rec.leaseId : "";
      if (!parsed) {
        out.refused.push({ kind: "lease", leaseId, code: "serving-lease-malformed" });
        continue;
      }
      const code = this.keepLease(parsed);
      if (code === "kept") out.leasesAccepted++;
      else if (code !== "not-better") out.refused.push({ kind: "lease", leaseId, code });
    }

    if (JSON.stringify(this.state) !== before) {
      await this.persist();
      this.opts.onChange?.();
    }
    return out;
  }

  /** A lease counts when `servingDecision`, given only it and the held policy, serves apps at its own issue time. */
  private leaseCounts(l: StoredLease, now: number): boolean {
    const admin = this.opts.adminKey;
    const p = this.state.policy;
    if (!admin || !p) return false;
    const at = Math.min(l.record.issuedAt, now);
    const d = servingDecision({
      account: this.opts.account,
      box: this.opts.boxPub(),
      regGen: p.record.regGen,
      adminKeyFromCom: admin,
      adminKeyFromBox: admin,
      policies: [p],
      leases: [l],
      revocations: emptyRevocationState(),
      now: at,
    });
    return d.apps && l.record.notAfter > at;
  }

  private keepLease(raw: unknown): "kept" | "not-better" | "serving-no-policy" | "serving-lease-stale" | "serving-lease-signature" {
    const p = this.state.policy;
    if (!p) return "serving-no-policy";
    const l = asStoredLease(raw);
    if (!l) return "serving-lease-signature";
    if (!samePolicy(l.record, p.record)) return "serving-lease-stale";
    if (!this.leaseCounts(l, this.now())) return "serving-lease-signature";
    const signer = l.delegation ? l.delegation.record.renewalPub : "admin";
    const i = this.state.leases.findIndex((x) => (x.delegation ? x.delegation.record.renewalPub : "admin") === signer);
    if (i >= 0) {
      if (this.state.leases[i]!.record.notAfter >= l.record.notAfter) return "not-better";
      this.state.leases[i] = l;
    } else {
      this.state.leases.push(l);
      if (this.state.leases.length > MAX_LEASES) {
        this.state.leases.sort((a, b) => b.record.notAfter - a.record.notAfter);
        this.state.leases.length = MAX_LEASES;
      }
    }
    return "kept";
  }

  /** A policy for this account and box that verifies under the pinned key (the rule `servingDecision` applies). */
  private verifiedPolicy(raw: unknown): SignedPolicy | null {
    const admin = this.opts.adminKey;
    if (!admin || !isObj(raw)) return null;
    const record = raw.record ?? raw.policy;
    if (!isObj(record) || typeof raw.signature !== "string") return null;
    const r = record as unknown as ServingPolicy;
    if (r.account !== this.opts.account || r.box !== this.opts.boxPub() || typeof r.regGen !== "number") return null;
    const signed: SignedPolicy = { record: pickPolicy(r), signature: raw.signature };
    const d = servingDecision({
      account: this.opts.account,
      box: this.opts.boxPub(),
      regGen: r.regGen,
      adminKeyFromCom: admin,
      adminKeyFromBox: admin,
      policies: [signed],
      leases: [],
      revocations: emptyRevocationState(),
      now: this.now(),
    });
    return d.apps || d.reason !== "policy-signature" ? signed : null;
  }

  private verifiedDelegation(raw: unknown): SignedDelegation | null {
    const admin = this.opts.adminKey;
    if (!admin || !isObj(raw)) return null;
    const record = raw.record ?? raw.delegation;
    if (!isObj(record) || typeof raw.signature !== "string") return null;
    const r = pickDelegation(record as unknown as RenewalKeyDelegation);
    if (r.account !== this.opts.account) return null;
    return verifyServingRecord("renewal-key-delegation", r, raw.signature, admin) ? { record: r, signature: raw.signature } : null;
  }

  private floorOf(): { policy: SignedPolicy | null; leases: StoredLease[] } {
    const best = [...this.state.leases].sort((a, b) => b.record.notAfter - a.record.notAfter)[0];
    return { policy: this.state.policy, leases: best ? [best] : [] };
  }

  private async persist(): Promise<void> {
    try {
      await writeFileDurable(this.opts.path, JSON.stringify(this.state));
      await writeFileDurable(this.floorPath, JSON.stringify(this.floorOf()));
    } catch (e) {
      this.log(`[serving] couldn't save the serving records: ${(e as Error).message}`);
    }
  }

  private async readFile(path: string, effect: string): Promise<Record<string, unknown> | null> {
    const read = await readStateFile(path);
    if (read.kind === "missing") return null;
    try {
      if (read.kind === "unreadable") throw read.error;
      const obj = JSON.parse(read.text) as unknown;
      if (!isObj(obj)) throw new Error("not a serving state object");
      return obj;
    } catch (e) {
      await keepCorruptAside(path, e, effect);
      return null;
    }
  }
}

/** The scope hash a policy edit signs: the box's canonical name list. */
export function scopeSha256Of(serverFqdn: string, account: string): string {
  const fqdn = serverFqdn.toLowerCase();
  const server = fqdn.split(".")[0] ?? "";
  const apex = fqdn.slice(`${server}.${account}.`.length);
  return nameListSha256(boxNameList(server, account, apex));
}

/** The box never locks sooner than one grace after the owner signed the policy (the signing is admin presence). */
export function policyGraceEnd(p: ServingPolicy, now: number): number {
  if (p.grace === "indefinite") return Number.POSITIVE_INFINITY;
  return Math.min(p.issuedAt, now) + GRACE_MS[p.grace];
}

function stronger(a: ServingPolicy, b: ServingPolicy): boolean {
  return a.regGen !== b.regGen ? a.regGen > b.regGen : a.policyGen > b.policyGen;
}

function samePolicy(l: ServingLease, p: ServingPolicy): boolean {
  return l.account === p.account && l.box === p.box && l.regGen === p.regGen && l.policyGen === p.policyGen;
}

function floorShape(o: Record<string, unknown>): unknown {
  return { policy: o.policy ?? null, leases: Array.isArray(o.leases) ? o.leases : [] };
}

function pickPolicy(r: ServingPolicy): ServingPolicy {
  return {
    account: r.account,
    box: r.box,
    regGen: r.regGen,
    policyGen: r.policyGen,
    grace: r.grace,
    onLapse: r.onLapse,
    scopeSha256: r.scopeSha256,
    issuedAt: r.issuedAt,
  };
}

function pickDelegation(r: RenewalKeyDelegation): RenewalKeyDelegation {
  return { account: r.account, alg: r.alg, renewalPub: r.renewalPub, deviceId: r.deviceId, issuedAt: r.issuedAt };
}

function pickLease(r: ServingLease): ServingLease {
  return {
    account: r.account,
    box: r.box,
    regGen: r.regGen,
    policyGen: r.policyGen,
    leaseId: r.leaseId,
    issuedAt: r.issuedAt,
    notAfter: r.notAfter,
  };
}

/** A stored lease's own shape (as `serving.json` keeps it), without checking any signature. */
function asStoredLease(raw: unknown): StoredLease | null {
  if (!isObj(raw) || !isObj(raw.record) || typeof raw.signature !== "string") return null;
  const out: StoredLease = { record: pickLease(raw.record as unknown as ServingLease), signature: raw.signature };
  if (isObj(raw.delegation) && isObj(raw.delegation.record) && typeof raw.delegation.signature === "string") {
    out.delegation = { record: pickDelegation(raw.delegation.record as unknown as RenewalKeyDelegation), signature: raw.delegation.signature };
  }
  return out;
}

/**
 * A lease as offered: `{record|lease, signature, delegationPub?, delegation?}`. A lease naming a renewal key
 * gets that key's delegation from the same offer (or one already held); the signature check comes after.
 */
function parseLease(raw: unknown, offered: readonly SignedDelegation[], held: readonly StoredLease[]): StoredLease | null {
  if (!isObj(raw)) return null;
  const record = raw.record ?? raw.lease;
  if (!isObj(record) || typeof raw.signature !== "string") return null;
  const out: StoredLease = { record: pickLease(record as unknown as ServingLease), signature: raw.signature };
  if (isObj(raw.delegation) && isObj(raw.delegation.record ?? raw.delegation.delegation) && typeof raw.delegation.signature === "string") {
    out.delegation = {
      record: pickDelegation((raw.delegation.record ?? raw.delegation.delegation) as unknown as RenewalKeyDelegation),
      signature: raw.delegation.signature,
    };
  } else if (typeof raw.delegationPub === "string") {
    const pub = raw.delegationPub;
    const d = offered.find((x) => x.record.renewalPub === pub) ?? held.find((x) => x.delegation?.record.renewalPub === pub)?.delegation;
    if (!d) return null;
    out.delegation = d;
  }
  return out;
}
