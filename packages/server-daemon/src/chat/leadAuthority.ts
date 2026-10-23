/**
 * The exclusive lead term behind cross-owner chat admission (SECURITY-HARDENING-PLAN.md 18.7).
 *
 * `authority/leaderLease.ts` supplies the lease arithmetic; this wires it to the account's boxes. The
 * membership is the account's registered servers, a majority of ALL of them must grant a lease (an
 * offline server counts against quorum, which is the point: two partitioned halves cannot both lead),
 * and the box acts only until the earliest granted expiry less a drift margin, measured on the
 * authenticated clock. Without that clock, or without quorum, `mayAdmit()` is false and a start for
 * this app is dropped like any other without a listener. Only the first live server in the owner's
 * server order campaigns, so the box `.com` names as the lead is the box that holds the lease.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { LeaderCandidate, LeaseVoter, type GrantResult } from "../authority/leaderLease.js";
import { keepCorruptAside, readStateFile, withFileLock } from "../durableFile.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { LeadAuthority } from "./admission.js";
import type { ChatPeerDirectory } from "./peerDirectory.js";
import { authenticatePeer, type ChatWireTransport } from "./wire.js";

const J = { "content-type": "application/json" } as const;

export interface ChatLeadOptions {
  self: string;
  dir: string;
  /** Every server of the account, this one included. */
  members: () => string[];
  /** True when this box is the first live server in the owner's order. */
  shouldCampaign: () => boolean;
  /** Authenticated time in ms, or null when unsynced. */
  now: () => number | null;
  transport: ChatWireTransport;
  leaseMs?: number;
  driftMs?: number;
  everyMs?: number;
  log?: (m: string) => void;
}

export class ChatLeadAuthority implements LeadAuthority {
  readonly voter: LeaseVoter;
  private candidate: LeaderCandidate | null = null;
  private memberKey = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private term = 0;
  private readonly leaseMs: number;
  private readonly driftMs: number;

  constructor(private readonly o: ChatLeadOptions) {
    this.leaseMs = o.leaseMs ?? 30_000;
    this.driftMs = o.driftMs ?? 5_000;
    this.voter = new LeaseVoter(o.self.toLowerCase(), `${o.dir}/chat-lease-voter.json`, o.now, this.leaseMs);
  }

  generation(): number {
    return this.candidate?.state.term ?? this.term;
  }

  mayAdmit(): boolean {
    return this.candidate?.mayAct() ?? false;
  }

  async start(): Promise<void> {
    await this.voter.load();
    this.term = await this.loadTerm();
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch((e) => this.o.log?.(`[chat-lead] ${String((e as Error)?.message ?? e)}`)), this.o.everyMs ?? 10_000);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const c = this.candidate;
    if (c) await c.stepDown((member, holder) => this.release(member, holder));
  }

  private async tick(): Promise<void> {
    const members = [...new Set(this.o.members().map((m) => m.toLowerCase()))].sort();
    const self = this.o.self.toLowerCase();
    if (!members.includes(self)) members.push(self);
    const key = members.join(",");
    if (key !== this.memberKey || !this.candidate) {
      this.memberKey = key;
      this.candidate = new LeaderCandidate(
        self,
        members,
        (m, term, ms) => this.ask(m, term, ms),
        this.o.now,
        { leaseMs: this.leaseMs, driftMs: this.driftMs },
        { load: async () => this.term, save: async (t) => { this.term = t; await this.saveTerm(t); } },
      );
      await this.candidate.init();
    }
    if (!this.o.shouldCampaign()) {
      // Not the box to lead: give back anything granted to this box so the one that should lead is not held off.
      if (this.candidate.state.actUntil !== null) await this.candidate.stepDown((m, h) => this.release(m, h));
      return;
    }
    const led = await this.candidate.campaign();
    // A campaign that fell short must not keep the leases it did win: two boxes each holding their own
    // vote would refuse each other for good.
    if (!led) await this.candidate.stepDown((m, h) => this.release(m, h));
  }

  private async ask(member: string, term: number, leaseMs: number): Promise<GrantResult> {
    if (member === this.o.self.toLowerCase()) return this.voter.grant(member, term, leaseMs);
    const r = await this.o.transport.post(member, "lease", JSON.stringify({ op: "grant", term, leaseMs }), "/api/chat/lease");
    return (await r.json()) as GrantResult;
  }

  private async release(member: string, holder: string): Promise<void> {
    if (member === holder) {
      await this.voter.release(holder);
      return;
    }
    await this.o.transport.post(member, "lease", JSON.stringify({ op: "release" }), "/api/chat/lease");
  }

  private get termPath(): string {
    return `${this.o.dir}/chat-lead-term.json`;
  }

  private async loadTerm(): Promise<number> {
    const r = await readStateFile(this.termPath);
    if (r.kind === "ok") {
      try {
        const t = (JSON.parse(r.text) as { term?: unknown }).term;
        if (Number.isSafeInteger(t) && (t as number) >= 0) return t as number;
      } catch (e) {
        await keepCorruptAside(this.termPath, e, "The chat lead term was reset; this server waits out one lease before leading.");
      }
    } else if (r.kind === "unreadable") {
      await keepCorruptAside(this.termPath, r.error, "The chat lead term was reset; this server waits out one lease before leading.");
    }
    // A term that cannot be read restarts from the voters' highest term the next campaign meets: a lower
    // term is refused ("old-term"), and the candidate then moves up by one each round.
    return 0;
  }

  private async saveTerm(t: number): Promise<void> {
    await mkdir(dirname(this.termPath), { recursive: true });
    await withFileLock(this.termPath, (write) => write(JSON.stringify({ term: t })));
  }
}

/** `POST /api/chat/lease` — a vote request from another box of the same account. */
export function buildLeaseVoterHandler(o: {
  self: string;
  directory: ChatPeerDirectory;
  voter: LeaseVoter;
  members: () => string[];
  now?: () => number;
}) {
  const now = o.now ?? (() => Date.now());
  const seen = new Map<string, number>();
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path.split("?")[0] !== "/api/chat/lease") return null;
    if (req.method !== "POST") return { status: 405, headers: J, body: JSON.stringify({ error: "method not allowed" }) };
    const a = await authenticatePeer(req, "lease", o.self, o.directory, now, seen);
    if (!a.ok) return { status: a.status, headers: J, body: JSON.stringify({ error: "refused" }) };
    const from = a.statement.fromServer.toLowerCase();
    if (!o.members().map((m) => m.toLowerCase()).includes(from)) return { status: 403, headers: J, body: JSON.stringify({ error: "not a member" }) };
    let b: { op?: unknown; term?: unknown; leaseMs?: unknown };
    try {
      b = JSON.parse(a.body) as typeof b;
    } catch {
      return { status: 400, headers: J, body: JSON.stringify({ error: "bad request" }) };
    }
    if (b.op === "release") return { status: 200, headers: J, body: JSON.stringify({ released: await o.voter.release(from) }) };
    if (b.op === "grant" && Number.isSafeInteger(b.term) && Number.isSafeInteger(b.leaseMs) && (b.leaseMs as number) > 0) {
      return { status: 200, headers: J, body: JSON.stringify(await o.voter.grant(from, b.term as number, b.leaseMs as number)) };
    }
    return { status: 400, headers: J, body: JSON.stringify({ error: "bad request" }) };
  };
}

