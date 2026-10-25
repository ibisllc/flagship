/**
 * Architecture v2 milestone 2 (docs/architecture-v2/pq-suites.md §11.4): the box replays its
 * installation's owner-signed assurance policy chain itself and keeps the result.
 *
 * `.com` serves `GET /api/accounts/<u>/assurance-policy/installation/<this server>` (the box's
 * read token): the chain of AssurancePolicyChange entries with their signatures. The box trusts
 * none of `.com`'s state: it replays from legacy, verifying every change with the
 * critical-signature gate under keys it pins itself (the admin root from its config, admin
 * devices and their ML-DSA bindings from the device book), and adopts the result only if it is
 * not older than what it already holds (`adoptStoredState`), so a `.com` that serves a shorter
 * chain cannot roll a strict box back. A chain that fails part way is used up to the last change
 * that verified.
 *
 * The replay starts from the state the box already holds when the served chain contains its head
 * (that prefix was verified when it was adopted), so revoking the device that signed an early
 * change does not freeze the policy: the admin root, or an admin device still in the book, can
 * continue the chain. A second copy of the state (`<path>.floor`) is kept beside the first; when
 * both are unreadable the box reads as strict and leaves that only for a non-empty chain that
 * verifies, never for an empty one.
 */
import { readFile } from "node:fs/promises";
import {
  PolicyError,
  TAG_ASSURANCE_POLICY,
  adoptStoredState,
  advanceRollout,
  assurancePolicyDigest,
  applyPolicyChange,
  legacyPolicyState,
  verifyCriticalSignature,
  type AssurancePolicyChange,
  type PolicyScope,
  type PolicyState,
  type RolloutEvidence,
  type SignatureEnvelope,
  type VerifiedPqKeyBinding,
} from "@flagship/protocol";
import { writeFileDurable } from "./durableFile.js";

export interface AssurancePolicySyncOptions {
  path: string;
  account: string;
  serverDomain: string;
  /** `.com`'s answer for this installation, or null when unreachable. */
  fetchChain: () => Promise<unknown>;
  /** The pinned admin root, hex, or null when the box pins none. */
  adminRootHex: () => string | null;
  /** True when `pubHex` is an admin device in the box's verified device book. */
  isAdminDevice: (pubHex: string) => boolean;
  bindingFor: (pubHex: string) => VerifiedPqKeyBinding | null;
  /** What the box itself can vouch for: `.com` holds its STK binding, and its boot-key binding is hybrid. */
  ownEvidence: () => { stkBound: boolean; bootKeyHybrid: boolean };
  /** The scope replayed; the installation (this server) unless an app's scope is given. */
  scope?: PolicyScope;
  now?: () => number;
  log?: (m: string) => void;
}

type StoredRead = { kind: "missing" } | { kind: "unreadable" } | { kind: "ok"; state: PolicyState; headLoss: string[] };

const PROFILES = new Set(["strict", "compatibility"]);
const ROLLOUTS = new Set(["legacy", "capable", "prepared", "enforced", "retired"]);
const HEX64 = /^[0-9a-f]{64}$/;

function parseState(raw: unknown, scope: PolicyScope): PolicyState | null {
  const s = raw as Partial<PolicyState> | null;
  if (!s || typeof s !== "object") return null;
  if (!PROFILES.has(s.profile as string) || !ROLLOUTS.has(s.rollout as string)) return null;
  if (!Number.isSafeInteger(s.generation) || (s.generation as number) < 0 || typeof s.headDigest !== "string" || !HEX64.test(s.headDigest)) return null;
  if (typeof s.enforcedEver !== "boolean") return null;
  return { scope, profile: s.profile!, rollout: s.rollout!, generation: s.generation!, headDigest: s.headDigest, enforcedEver: s.enforcedEver };
}

/** The loss code that, signed into a change to strict, means "browsers may still reach it". */
export const BROWSER_LOSS = "browser-without-pq-authentication";

export class AssurancePolicySync {
  private state: PolicyState;
  /** What the owner acknowledged in the change in force (the browser answer, for a strict scope). */
  private headLoss: readonly string[] = [];
  private failClosed = false;
  /** The primary state file was unreadable and the floor copy stood in: rewrite it on the next refresh. */
  private repair = false;
  private readonly scope: PolicyScope;
  private readonly now: () => number;

  constructor(private readonly opts: AssurancePolicySyncOptions) {
    this.scope = opts.scope ?? { kind: "installation", id: opts.serverDomain.toLowerCase() };
    this.state = legacyPolicyState(this.scope);
    this.now = opts.now ?? Date.now;
  }

  /** The policy in force. While the stored state is unreadable: strict and enforced. */
  policy(): PolicyState {
    if (this.failClosed) return { ...this.state, profile: "strict", rollout: "enforced", enforcedEver: true };
    return this.state;
  }

  /**
   * Whether a browser (WebPKI TLS, no PQ channel) may still reach this scope: always outside
   * strict; under strict only when the owner's signed change to strict said so.
   */
  browsersAllowed(): boolean {
    if (this.failClosed) return false;
    const s = this.state;
    if (!(s.profile === "strict" && (s.rollout === "enforced" || s.rollout === "retired"))) return true;
    return this.headLoss.includes(BROWSER_LOSS);
  }

  async load(): Promise<void> {
    const primary = await this.readStored(this.opts.path);
    const floor = await this.readStored(this.floorPath());
    if (primary.kind === "missing" && floor.kind === "missing") return;
    const usable = [primary, floor].filter((r): r is Extract<StoredRead, { kind: "ok" }> => r.kind === "ok");
    if (usable.length === 0) {
      this.failClosed = true;
      this.opts.log?.("[assurance] the stored policy state is unreadable; treating this server as strict until the owner's chain is replayed");
      return;
    }
    const best = usable.reduce((a, b) => (b.state.generation > a.state.generation ? b : a));
    this.state = best.state;
    this.headLoss = best.headLoss;
    if (primary.kind !== "ok" || best !== primary) {
      this.repair = true;
      this.opts.log?.("[assurance] the stored policy state was damaged or behind; using its second copy");
    }
  }

  private floorPath(): string {
    return `${this.opts.path}.floor`;
  }

  private async readStored(path: string): Promise<StoredRead> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
    }
    try {
      const raw = JSON.parse(text) as { headLoss?: unknown };
      const state = parseState(raw, this.scope);
      if (!state) return { kind: "unreadable" };
      const loss = raw.headLoss;
      return { kind: "ok", state, headLoss: Array.isArray(loss) ? loss.filter((x): x is string => typeof x === "string") : [] };
    } catch {
      return { kind: "unreadable" };
    }
  }

  private async persist(): Promise<void> {
    const text = JSON.stringify({ ...this.state, headLoss: this.headLoss });
    await writeFileDurable(this.floorPath(), text);
    await writeFileDurable(this.opts.path, text);
    this.repair = false;
  }

  /** Replays `.com`'s chain and adopts it when it is not older. */
  async refresh(): Promise<PolicyState> {
    let body: unknown;
    try {
      body = await this.opts.fetchChain();
    } catch (e) {
      this.opts.log?.(`[assurance] chain fetch failed: ${(e as Error).message}`);
      return this.policy();
    }
    const b = body as { chain?: unknown; evidence?: { recoveryChecked?: unknown } } | null;
    if (!b || !Array.isArray(b.chain)) return this.policy();
    const { state: replayed, headLoss } = this.replayWithLoss(b.chain, b.evidence?.recoveryChecked === true);
    if (this.failClosed) {
      // Both copies are gone: only a chain that verifies at least one change can stand in for them.
      if (replayed.generation < 1) {
        this.opts.log?.("[assurance] the served chain verifies no change; staying strict");
        return this.policy();
      }
      this.state = replayed;
      this.headLoss = headLoss;
      this.failClosed = false;
      await this.persist();
      return this.policy();
    }
    try {
      const next = adoptStoredState(this.state, replayed);
      const changed = next.generation !== this.state.generation || next.rollout !== this.state.rollout || next.headDigest !== this.state.headDigest;
      this.state = next;
      if (changed) this.headLoss = headLoss;
      if (changed) await this.persist();
    } catch (e) {
      if (e instanceof PolicyError) this.opts.log?.(`[assurance] the served chain is older than the policy in force (${e.code}); kept ours`);
      else throw e;
    }
    if (this.repair) await this.persist();
    return this.policy();
  }

  /**
   * Replays a served chain; stops at the first change that does not verify. When the chain holds
   * the change at the head of the state in force, the replay starts there (its prefix was verified
   * when it was adopted) and checks only what follows against today's keys.
   */
  replay(chain: readonly unknown[], recoveryChecked: boolean): PolicyState {
    return this.replayWithLoss(chain, recoveryChecked).state;
  }

  private replayWithLoss(chain: readonly unknown[], recoveryChecked: boolean): { state: PolicyState; headLoss: readonly string[] } {
    let s = legacyPolicyState(this.scope);
    let headLoss: readonly string[] = [];
    let start = 0;
    if (!this.failClosed && this.state.generation > 0) {
      const at = chain.findIndex((entry) => {
        const c = (entry as { change?: AssurancePolicyChange } | null)?.change;
        if (!c || c.generation !== this.state.generation) return false;
        try {
          return assurancePolicyDigest(c) === this.state.headDigest;
        } catch {
          return false;
        }
      });
      if (at >= 0) {
        s = this.state;
        headLoss = this.headLoss;
        start = at + 1;
      }
    }
    for (const entry of chain.slice(start)) {
      const e = entry as { change?: AssurancePolicyChange; signature?: SignatureEnvelope } | null;
      const change = e?.change;
      const sig = e?.signature;
      if (!change || !sig || change.account !== this.opts.account.toLowerCase()) break;
      try {
        if (change.next === "strict") s = this.prepare(s, change, recoveryChecked);
        s = applyPolicyChange(s, change, (msg, c) => this.check(msg, c, sig, s));
        headLoss = [...change.acknowledgedLoss];
      } catch (err) {
        this.opts.log?.(`[assurance] change ${change.generation} refused: ${(err as { code?: string }).code ?? (err as Error).message}`);
        break;
      }
    }
    return { state: s, headLoss };
  }

  /** Moves the replay to `prepared` on the box's own evidence before a change to strict. */
  private prepare(s: PolicyState, change: AssurancePolicyChange, recoveryChecked: boolean): PolicyState {
    const own = this.opts.ownEvidence();
    const ev: RolloutEvidence = {
      capabilityAdvertised: own.stkBound,
      boundPublicKeys: own.stkBound && this.opts.bindingFor(change.signerKeyId) !== null,
      recipientsVerified: own.bootKeyHybrid,
      // `.com`'s word, which can only let the owner turn strict on, never weaken anything.
      recoveryChecked,
    };
    let out = s;
    if (out.rollout === "legacy") out = advanceRollout(out, "capable", ev);
    if (out.rollout === "capable") out = advanceRollout(out, "prepared", ev);
    return out;
  }

  private check(msg: Uint8Array, c: AssurancePolicyChange, sig: SignatureEnvelope, state: PolicyState) {
    const key = c.signerKeyId.toLowerCase();
    const root = this.opts.adminRootHex();
    const signerActive = !!root && (c.signerKind === "admin-root" ? key === root : c.signerKind === "admin-device" && this.opts.isAdminDevice(key));
    let suiteVerified = false;
    if (signerActive && sig.suite === c.suite) {
      try {
        const v = verifyCriticalSignature({
          message: msg,
          expectedPurpose: TAG_ASSURANCE_POLICY,
          envelope: { suite: sig.suite, signature: String(sig.signature).toLowerCase() },
          signerEd25519PubHex: key,
          binding: this.opts.bindingFor(key),
          policy: state,
        });
        suiteVerified = v.suite === c.suite;
      } catch {
        suiteVerified = false;
      }
    }
    return { suiteVerified, signerActive };
  }
}

/**
 * The owner's policies for this server's apps and connectors (`<serverDomain>:<name>` scopes),
 * each replayed by its own AssurancePolicySync and kept beside the installation's. A scope is
 * created the first time it is asked about, loads what it held and refreshes in the background;
 * until then it reads as the state it last held (legacy for a new one).
 */
export class ScopedPolicies {
  private readonly syncs = new Map<string, AssurancePolicySync>();

  constructor(
    private readonly opts: Omit<AssurancePolicySyncOptions, "scope" | "path" | "fetchChain"> & {
      dir: string;
      fetchScope: (scope: PolicyScope) => Promise<unknown>;
    },
  ) {}

  for(kind: "service" | "connector", name: string): AssurancePolicySync {
    const id = `${this.opts.serverDomain.toLowerCase()}:${name}`;
    const key = `${kind}|${id}`;
    let s = this.syncs.get(key);
    if (!s) {
      const scope: PolicyScope = { kind, id };
      const file = `${this.opts.dir}/assurance-${kind}-${name.replace(/[^a-z0-9.-]/gi, "_")}.json`;
      s = new AssurancePolicySync({ ...this.opts, scope, path: file, fetchChain: () => this.opts.fetchScope(scope) });
      this.syncs.set(key, s);
      const created = s;
      void created.load().then(() => created.refresh()).catch(() => {});
    }
    return s;
  }

  async refreshAll(): Promise<void> {
    for (const s of this.syncs.values()) await s.refresh().catch(() => {});
  }
}
