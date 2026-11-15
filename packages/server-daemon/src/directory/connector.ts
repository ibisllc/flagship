/**
 * The connector runtime on an org box (docs/org-directory.md §1.5, §3, §4). It:
 *   1. reads the org's connector records from `.com` and keeps those naming this box that verify
 *      under the org chain this box pinned (one org admin approved, the box is the org's);
 *   2. opens each connector's setup (sealed to this box's org KEM key) and checks it against the
 *      approved record: the connector's hybrid seeds match its key id, the mapping its digest;
 *   3. runs the directory engine over each source's people and posts the resulting proposals,
 *      sealed to every org admin's seat KEM key it verified and signed with the connector key;
 *   4. links a pending person to their seat once an admin carried out their invite (the decision
 *      names the invite's digest, and the invite names the seat).
 * The box never holds an org key here and a connector never moves authority.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  buildOrgProposal,
  canonicalOrgSeatInvite,
  canonicalOrgDirectoryEntryBody,
  hybridSigKeygen,
  orgKemKeyPair,
  openOrgConnectorSetup,
  orgSha256Hex,
  verifyOrgConnector,
  verifyOrgSeatKem,
  type OrgConnectorBundle,
  type OrgConnectorSetup,
  type OrgKemKey,
  type OrgProposalBundle,
  type OrgSeatInvite,
  type OrgSeatKemBundle,
} from "@flagship/protocol";
import { readStateFile, writeFileDurable } from "../durableFile.js";
import type { OrgPinned } from "../orgAuthorityPin.js";
import { diffDirectory, emptyDirectoryState, type DirectoryState, type ProposalIntent } from "./engine.js";
import type { DirectoryUser } from "./source.js";

export interface ConnectorDeps {
  dataDir: string;
  orgId: string;
  serverDomain: string;
  controlPlaneBaseUrl: string;
  pin: () => OrgPinned | null;
  /** This box's org X-Wing seed (orgBoxKemSeed). */
  boxKemSeed: () => Promise<Uint8Array>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ActiveConnector {
  bundle: OrgConnectorBundle;
  setup: OrgConnectorSetup;
  connectorSecret: Uint8Array;
}

/** SCIM tokens older than this get a warning in the console (owner decision, 2026-11-15). */
export const SCIM_TOKEN_WARN_AFTER_MS = 365 * 24 * 3_600_000;

export class ConnectorRuntime {
  private active = new Map<string, ActiveConnector>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: ConnectorDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  private url(path: string): string {
    return `${this.deps.controlPlaneBaseUrl.replace(/\/$/, "")}/api/orgs/${this.deps.orgId}${path}`;
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.fetchImpl(this.url(path), { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    return this.fetchImpl(this.url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  }

  connectors(): ActiveConnector[] {
    return [...this.active.values()];
  }

  connector(id: string): ActiveConnector | undefined {
    return this.active.get(id);
  }

  /** Reads and verifies this box's connectors; a paused or retired one stops proposing. */
  async refresh(): Promise<ActiveConnector[]> {
    const pin = this.deps.pin();
    if (!pin) return [];
    const [{ connectors }, { servers }] = await Promise.all([
      this.get<{ connectors: OrgConnectorBundle[] }>("/connectors"),
      this.get<{ servers: Array<{ serverDomain: string; revoked?: unknown }> }>("/servers"),
    ]);
    const live = new Set(servers.filter((s) => !s.revoked).map((s) => s.serverDomain));
    const kem = orgKemKeyPair(await this.deps.boxKemSeed());
    const next = new Map<string, ActiveConnector>();
    for (const b of connectors) {
      if (b.connector?.serverDomain !== this.deps.serverDomain || b.connector.status !== "active" || !b.setup) continue;
      try {
        // Checked as of the record its approval names; an approver who is no longer an org admin ends it.
        verifyOrgConnector({ state: pin.state, book: pin.book, servers: live, now: this.now() }, b, null, { stored: true });
        const setup = openOrgConnectorSetup(b.connector, b.setup, kem.kemSecret, hybridSigKeygen);
        const seeds = Buffer.from(setup.connectorSeedsHex, "hex");
        next.set(b.connector.connectorId, { bundle: b, setup, connectorSecret: hybridSigKeygen(seeds.subarray(0, 32), seeds.subarray(32)).secretKey });
      } catch (e) {
        this.deps.log?.(`[directory] connector ${b.connector.connectorId.slice(0, 8)} refused: ${(e as Error).message}`);
      }
    }
    this.active = next;
    return this.connectors();
  }

  /** The org admins' seat KEM keys, each verified under the pinned chain (a departed admin's no longer verifies). */
  async adminKems(): Promise<OrgKemKey[]> {
    const pin = this.deps.pin();
    if (!pin) return [];
    const { seatKems } = await this.get<{ seatKems: OrgSeatKemBundle[] }>("/keys");
    const admins = new Set(pin.state.current.admins.filter((a) => a.kind === "admin").map((a) => a.seatId));
    const out = new Map<string, OrgKemKey>();
    for (const k of seatKems) {
      if (!admins.has(k.statement?.seatId)) continue;
      try {
        const v = verifyOrgSeatKem(pin.state, pin.book, k, this.now());
        const prev = out.get(v.recipient);
        if (!prev || prev.issuedAt < v.issuedAt) out.set(v.recipient, v);
      } catch {
        /* not verifiable under this box's chain */
      }
    }
    return [...out.values()].sort((a, b) => (a.recipient < b.recipient ? -1 : 1));
  }

  private statePath(connectorId: string): string {
    return join(this.deps.dataDir, "org-directory", `${connectorId}.state.json`);
  }

  async loadState(connectorId: string): Promise<DirectoryState> {
    const r = await readStateFile(this.statePath(connectorId));
    if (r.kind !== "ok") return emptyDirectoryState();
    try {
      return JSON.parse(r.text) as DirectoryState;
    } catch {
      return emptyDirectoryState();
    }
  }

  private async saveState(connectorId: string, s: DirectoryState): Promise<void> {
    await writeFileDurable(this.statePath(connectorId), JSON.stringify(s));
  }

  /**
   * One sync: links seats from decided invites, diffs `people` against the last snapshot and posts
   * every new proposal. Returns the intents it proposed.
   */
  async sync(connectorId: string, people: readonly DirectoryUser[]): Promise<ProposalIntent[]> {
    const c = this.active.get(connectorId);
    if (!c) throw new Error("connector not active on this box");
    let state = await this.linkSeats(connectorId, await this.loadState(connectorId));
    const { state: next, intents } = diffDirectory(state, people, c.setup.mapping, c.bundle.connector.kind, this.now());
    state = next;
    const admins = intents.length > 0 ? await this.adminKems() : [];
    const posted: ProposalIntent[] = [];
    for (const i of intents) {
      if (admins.length === 0) {
        state.proposed = state.proposed.filter((d) => d !== i.digest);
        continue;
      }
      const bundle = this.proposal(c, i, admins);
      const r = await this.post("/proposals", bundle);
      if (r.ok || r.status === 409) posted.push(i);
      else {
        state.proposed = state.proposed.filter((d) => d !== i.digest);
        this.deps.log?.(`[directory] proposal not posted: HTTP ${r.status}`);
      }
    }
    await this.saveState(connectorId, state);
    return posted;
  }

  private proposal(c: ActiveConnector, i: ProposalIntent, admins: OrgKemKey[]): OrgProposalBundle {
    return buildOrgProposal({
      orgId: this.deps.orgId,
      proposalId: createHash("sha256").update(`${c.bundle.connector.connectorId}|${i.digest}`).digest("hex").slice(0, 32),
      connectorId: c.bundle.connector.connectorId,
      kind: i.kind,
      subject: i.subject,
      roles: i.roles,
      rolesHash: i.rolesHash,
      payload: canonicalOrgDirectoryEntryBody(i.entry),
      admins,
      issuedAt: this.now(),
      connectorSecret: c.connectorSecret,
    });
  }

  /** A pending person becomes linked to a seat once an admin carried out their invite proposal. */
  async linkSeats(connectorId: string, state: DirectoryState): Promise<DirectoryState> {
    const pending = Object.entries(state.links).filter(([, l]) => !l.seatId);
    if (pending.length === 0) return state;
    const [{ proposals }, { invites }] = await Promise.all([
      this.get<{ proposals: Array<{ bundle: OrgProposalBundle; decision: { statement: { decision: string; refSha256: string } } | null }> }>("/proposals"),
      this.get<{ invites: Array<{ invite: OrgSeatInvite }> }>("/seats"),
    ]);
    const bySha = new Map<string, string>();
    for (const i of invites ?? []) {
      try {
        bySha.set(orgSha256Hex(canonicalOrgSeatInvite(i.invite)), i.invite.seatId);
      } catch {
        /* malformed */
      }
    }
    const pin = this.deps.pin();
    const links = { ...state.links };
    for (const p of proposals ?? []) {
      const d = p.decision?.statement;
      if (p.bundle?.proposal?.connectorId !== connectorId || p.bundle.proposal.kind !== "invite" || d?.decision !== "done") continue;
      const seatId = bySha.get(d.refSha256);
      // Only a seat the pinned seat book holds counts (`.com` alone cannot link a person to a seat).
      if (!seatId || !pin?.book.seats.has(seatId)) continue;
      for (const [ext, l] of pending) if (l.pendingId === p.bundle.proposal.subject) links[ext] = { ...l, seatId };
    }
    return { ...state, links };
  }
}
