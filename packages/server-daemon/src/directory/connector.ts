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
  canonicalOrgProposalDecision,
  canonicalOrgSeatInvite,
  canonicalOrgDirectoryEntryBody,
  hybridSigKeygen,
  orgKemKeyPair,
  openOrgConnectorSetup,
  orgApprovalFromWire,
  orgSeatRolesHash,
  orgSha256Hex,
  verifyOrgConnector,
  verifyOrgProposal,
  verifyOrgRecordedApprovals,
  verifyOrgSeatKem,
  type OrgConnectorBundle,
  type OrgConnectorStanding,
  type OrgConnectorSetup,
  type OrgConnectorMapping,
  type OrgKemKey,
  type OrgProposalBundle,
  type OrgProposalDecisionStatement,
  type OrgSeatRole,
  type OrgSeatInvite,
  type OrgSeatKemBundle,
} from "@flagship/protocol";
import { readStateFile, writeFileDurable } from "../durableFile.js";
import type { OrgPinned } from "../orgAuthorityPin.js";
import { diffDirectory, directoryStateFrom, emptyDirectoryState, type DirectoryLink, type DirectoryState, type ProposalIntent } from "./engine.js";
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
  /** An Activity line (connector id prefixes and dates only, never a name). */
  note?: (kind: string, text: string, ok: boolean) => void;
  /** False while the org's Business plan has lapsed (orgPlanCheck.ts): new people wait, nothing else does. */
  newPeopleAllowed?: () => boolean;
}

export interface ActiveConnector {
  bundle: OrgConnectorBundle;
  /** `needs-reapproval` while its last approver has left less than 7 days ago. */
  standing: OrgConnectorStanding;
  setup: OrgConnectorSetup & { connectorSeedsHex: string; mapping: OrgConnectorMapping };
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
      const id = b.connector.connectorId;
      try {
        // Checked as of the record its approval names; once its last approver has left it needs re-approval
        // (7 days of grace), then it is suspended until any org admin approves it again.
        const standing = verifyOrgConnector({ state: pin.state, book: pin.book, servers: live, now: this.now() }, b, null, { stored: true })!;
        const known = await this.loadSetup(id);
        const setup = openOrgConnectorSetup(b.connector, b.setup, kem.kemSecret, hybridSigKeygen, known?.connectorSeedsHex, known ?? undefined);
        await this.saveSetup(id, setup);
        const seeds = Buffer.from(setup.connectorSeedsHex, "hex");
        next.set(id, { bundle: b, standing, setup, connectorSecret: hybridSigKeygen(seeds.subarray(0, 32), seeds.subarray(32)).secretKey });
        const key = `${id}|${standing.state}|${b.connector.issuedAt}`;
        if (standing.state === "needs-reapproval" && !this.noted.has(key)) {
          this.noted.add(key);
          this.deps.note?.("org.directory.reapprove", `Directory connector ${id.slice(0, 8)} needs re-approval: the admin who approved it left. It stops on ${new Date(standing.suspendAt!).toISOString().slice(0, 10)} unless an org admin approves it again`, false);
        }
      } catch (e) {
        const msg = (e as Error).message;
        const key = `${id}|refused|${b.connector.issuedAt}|${msg}`;
        if (!this.noted.has(key)) {
          this.noted.add(key);
          this.deps.note?.("org.directory.suspended", `Directory connector ${id.slice(0, 8)} is not running: ${/suspended/.test(msg) ? "it needs an org admin's re-approval" : msg}`, false);
        }
        this.deps.log?.(`[directory] connector ${id.slice(0, 8)} refused: ${msg}`);
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

  private readonly noted = new Set<string>();

  private setupPath(id: string): string {
    return join(this.deps.dataDir, "org-directory", `${id}.setup.json`);
  }

  /** The setup this box opened last (seeds, token hash, LDAP settings), kept 0600 on the encrypted disk. */
  private async loadSetup(id: string): Promise<(OrgConnectorSetup & { connectorSeedsHex: string }) | null> {
    const r = await readStateFile(this.setupPath(id));
    if (r.kind !== "ok") return null;
    try {
      return JSON.parse(r.text) as OrgConnectorSetup & { connectorSeedsHex: string };
    } catch {
      return null;
    }
  }

  private async saveSetup(id: string, setup: OrgConnectorSetup): Promise<void> {
    await writeFileDurable(this.setupPath(id), JSON.stringify(setup), 0o600);
  }

  private statePath(connectorId: string): string {
    return join(this.deps.dataDir, "org-directory", `${connectorId}.state.json`);
  }

  async loadState(connectorId: string): Promise<DirectoryState> {
    const r = await readStateFile(this.statePath(connectorId));
    if (r.kind !== "ok") return emptyDirectoryState();
    try {
      return directoryStateFrom(JSON.parse(r.text));
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
    const lapsed = this.deps.newPeopleAllowed ? !this.deps.newPeopleAllowed() : false;
    let waiting = 0;
    for (const i of intents) {
      if (lapsed && i.kind === "invite") {
        state.proposed = state.proposed.filter((d) => d !== i.digest);
        waiting++;
        continue;
      }
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
    if (waiting > 0) this.deps.note?.("org.directory.waiting", `${waiting} new people wait until the org's plan is paid`, false);
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

  /**
   * A pending person becomes linked to a seat once an admin carried out their invite proposal. Every link rests on
   * evidence the box checks itself under its pinned chain (05c review F3): the proposal is this connector's own
   * (its signature), an org admin approved the decision naming that proposal and the invite's digest, an org admin
   * approved the invite, and the invite's seat is in the pinned seat book. `.com` alone cannot link anyone.
   */
  async linkSeats(connectorId: string, state: DirectoryState): Promise<DirectoryState> {
    const pending = Object.entries(state.links).filter(([, l]) => !l.seatId);
    if (pending.length === 0) return state;
    const c = this.active.get(connectorId);
    const pin = this.deps.pin();
    if (!c || !pin) return state;
    const [{ proposals }, { invites }] = await Promise.all([
      this.get<{ proposals: Array<{ bundle: OrgProposalBundle; decision: { statement: OrgProposalDecisionStatement; approvals?: unknown[] } | null }> }>("/proposals"),
      this.get<{ invites: Array<{ invite: OrgSeatInvite; approvals?: unknown[] }> }>("/seats"),
    ]);
    const now = this.now();
    const approved = (order: Uint8Array, wire: unknown): boolean => {
      try {
        if (!Array.isArray(wire) || wire.length === 0) return false;
        const approvals = wire.map(orgApprovalFromWire);
        const v = approvals[0]!.oarVersion;
        if (approvals.some((a) => a.oarVersion !== v)) return false;
        // No scope: every signer must be an org admin of the record the approvals name.
        verifyOrgRecordedApprovals(pin.state, pin.book, order, approvals, v, now);
        return true;
      } catch {
        return false;
      }
    };
    const bySha = new Map<string, string>();
    for (const i of Array.isArray(invites) ? invites : []) {
      try {
        if (i?.invite?.orgId !== this.deps.orgId) continue;
        const order = canonicalOrgSeatInvite(i.invite);
        if (!approved(order, i.approvals)) continue;
        bySha.set(orgSha256Hex(order), i.invite.seatId);
      } catch {
        /* malformed */
      }
    }
    const links: Record<string, DirectoryLink> = Object.assign(Object.create(null) as Record<string, DirectoryLink>, state.links);
    for (const p of Array.isArray(proposals) ? proposals : []) {
      const d = p?.decision?.statement;
      const prop = p?.bundle?.proposal;
      if (prop?.connectorId !== connectorId || prop.kind !== "invite" || d?.decision !== "done") continue;
      if (d.orgId !== this.deps.orgId || d.proposalId !== prop.proposalId) continue;
      try {
        const roles = Array.isArray(p.bundle.roles) ? (p.bundle.roles as OrgSeatRole[]) : [];
        verifyOrgProposal(c.bundle, p.bundle, { rolesHash: roles.length > 0 ? orgSeatRolesHash(roles) : "", now });
        if (!approved(canonicalOrgProposalDecision(d), p.decision!.approvals)) continue;
      } catch {
        continue;
      }
      const seatId = bySha.get(d.refSha256);
      // Only a seat the pinned seat book holds counts.
      if (!seatId || !pin.book.seats.has(seatId)) continue;
      for (const [ext, l] of pending) if (l.pendingId === prop.subject) links[ext] = { ...l, seatId };
    }
    return { ...state, links };
  }
}
