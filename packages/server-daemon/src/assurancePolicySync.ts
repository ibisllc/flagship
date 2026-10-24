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
 * that verified. An unreadable state file reads as strict until a verified chain arrives.
 */
import { readFile } from "node:fs/promises";
import {
  PolicyError,
  TAG_ASSURANCE_POLICY,
  adoptStoredState,
  advanceRollout,
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
    let text: string;
    try {
      text = await readFile(this.opts.path, "utf8");
    } catch {
      return;
    }
    let parsed: PolicyState | null = null;
    try {
      parsed = parseState(JSON.parse(text), this.scope);
    } catch {
      parsed = null;
    }
    if (parsed) {
      this.state = parsed;
      const loss = (JSON.parse(text) as { headLoss?: unknown }).headLoss;
      this.headLoss = Array.isArray(loss) ? loss.filter((x): x is string => typeof x === "string") : [];
    } else {
      this.failClosed = true;
      this.opts.log?.("[assurance] the stored policy state is unreadable; treating this server as strict until the owner's chain is replayed");
    }
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
    try {
      const next = this.failClosed ? replayed : adoptStoredState(this.state, replayed);
      const changed = this.failClosed || next.generation !== this.state.generation || next.rollout !== this.state.rollout || next.headDigest !== this.state.headDigest;
      this.state = next;
      if (changed || this.failClosed) this.headLoss = headLoss;
      this.failClosed = false;
      if (changed) await writeFileDurable(this.opts.path, JSON.stringify({ ...next, headLoss: this.headLoss }));
    } catch (e) {
      if (e instanceof PolicyError) this.opts.log?.(`[assurance] the served chain is older than the policy in force (${e.code}); kept ours`);
      else throw e;
    }
    return this.policy();
  }

  /** Replays a served chain from legacy; stops at the first change that does not verify. */
  replay(chain: readonly unknown[], recoveryChecked: boolean): PolicyState {
    return this.replayWithLoss(chain, recoveryChecked).state;
  }

  private replayWithLoss(chain: readonly unknown[], recoveryChecked: boolean): { state: PolicyState; headLoss: readonly string[] } {
    let s = legacyPolicyState(this.scope);
    let headLoss: readonly string[] = [];
    for (const entry of chain) {
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
