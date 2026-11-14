/**
 * The box's side of the relay mesh (docs/architecture-v2/relay-mesh.md §9): which relay holds its tunnel, the
 * attachment it signs for that relay, the move hints it accepts, and the hourly check that its relay is still blessed
 * and listed. Every rule is the protocol's (`@flagship/protocol` relayMesh.ts); this module only holds the box's state
 * and the verified relay directory.
 *
 * `<dataDir>/relay-mesh.json` keeps the hint rate-limit state (`MoveHintRateState`) and the newest directory the box
 * verified, so a restart neither resets the limits nor forgets the directory. A damaged file is set aside and the
 * limits load closed (as if a `locality` and a `co-locate` move had just happened: only `retire` hints pass for a while).
 */
import {
  ATTACH_RENEW_MS,
  ATTACH_TTL_MS,
  BOX_DIRECTORY_MAX_AGE_MS,
  BOX_RELAY_CHECK_MS,
  MOVE_DIAL_TIMEOUT_MS,
  MOVE_OLD_TUNNEL_GRACE_MS,
  canonicalBoxAttachment,
  checkMoveHint,
  directoryRelay,
  ed,
  emptyMoveHintRateState,
  newerRelayDirectory,
  recordMoveHint,
  recordMoveTargetFailed,
  relayTunnelHost,
  verifyRelayBlessing,
  verifyRelayDirectory,
  type BoxAttachment,
  type Bytes,
  type MoveHint,
  type MoveHintRateState,
  type MoveHintReason,
  type MoveHintRefusal,
  type RelayBlessing,
  type RelayDirectory,
} from "@flagship/protocol";
import type { AttachmentFramePayload, MoveHintFramePayload } from "@flagship/tunnel-protocol";
import { keepCorruptAside, readStateFile, writeFileDurable } from "../durableFile.js";

export { ATTACH_RENEW_MS, BOX_RELAY_CHECK_MS, MOVE_DIAL_TIMEOUT_MS, MOVE_OLD_TUNNEL_GRACE_MS };

/** Activity kinds the box writes for relay moves (the apps' copy for them is chunk F). */
export const RELAY_MOVED_KIND = "server.relay.moved";
export const RELAY_MOVE_REFUSED_KIND = "server.relay.move-refused";

/** The relay this tunnel is on, as its verified blessing names it. */
export interface MeshRelay {
  relayId: string;
  relayKey: string;
  tunnelHost: string;
  blessing: RelayBlessing;
}

/** A hint the box will act on: where to dial, and what the new relay must prove (its blessed key). */
export interface MoveTarget {
  relayId: string;
  relayKey: string;
  url: string;
  reason: MoveHintReason;
}

export type MeshAckRefusal = "no-relay-id" | "bad-blessing" | "relay-mismatch" | "hubsig";

/** Why a relay check asks the box to leave its relay (§9.4). */
export type RelayCheckFailure = "blessing-expired" | "not-in-directory" | "key-changed";

export type HintRefusal = MoveHintRefusal;

interface Persisted {
  rate: MoveHintRateState;
  directory: RelayDirectory | null;
  directoryFetchedAt: number | null;
}

export interface RelayMeshBoxOptions {
  /** The box's pod name, `<server>.<user>.<apex>`, lowercase. */
  serverFqdn: string;
  servicesApex: string;
  /** The box identity key, 64 lowercase hex. */
  boxPub: string;
  /** The box's registration generation (the serving store's view). */
  regGen: () => number;
  /** Signs with the box identity key (custodian / keyd: purpose `flagship/relay-attachment/v1`). */
  sign: (msg: Bytes) => Bytes | Promise<Bytes>;
  /** The CA keys authorized now (`relayMeshCaKeys` over the maintainer chain); [] fails every check closed. */
  caKeys: () => Promise<readonly string[]>;
  /** `directory.json` from the public feed: `{directory, blessings}` (or a bare directory). Throws on failure. */
  fetchDirectory: () => Promise<unknown>;
  /** `<dataDir>/relay-mesh.json`. */
  statePath: string;
  now?: () => number;
  log?: (m: string) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The tunnel URL of a relay's direct name (§9.3). */
export function relayTunnelUrl(tunnelHost: string): string {
  return `wss://${tunnelHost}:8443/tunnel`;
}

/**
 * The public feed's base URL (§4.5): `FLAGSHIP_RELAY_FEED_URL`, else `https://feed.<controlApex>/v1`, where the
 * control apex is the host of `.com`'s base URL.
 */
export function relayFeedBaseUrl(controlPlaneBaseUrl: string, env: Record<string, string | undefined> = process.env): string {
  const set = env.FLAGSHIP_RELAY_FEED_URL?.trim();
  if (set) return set.replace(/\/+$/, "");
  const host = new URL(controlPlaneBaseUrl).hostname.toLowerCase();
  return `https://feed.${host}/v1`;
}

export class RelayMeshBox {
  private state: Persisted = { rate: emptyMoveHintRateState(), directory: null, directoryFetchedAt: null };
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private chain: Promise<unknown> = Promise.resolve();
  private fetching: Promise<boolean> | null = null;

  constructor(private readonly opts: RelayMeshBoxOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.log(m));
  }

  async load(): Promise<void> {
    const read = await readStateFile(this.opts.statePath);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const o = JSON.parse(read.text) as unknown;
      if (!isObj(o)) throw new Error("not a relay-mesh state object");
      this.state = {
        rate: parseRate(o.rate),
        directory: isObj(o.directory) ? (o.directory as unknown as RelayDirectory) : null,
        directoryFetchedAt: typeof o.directoryFetchedAt === "number" && Number.isSafeInteger(o.directoryFetchedAt) ? o.directoryFetchedAt : null,
      };
      // The directory is checked again before use, so a hand-edited file cannot add a relay.
      if (this.state.directory && !(await this.directoryVerifies(this.state.directory))) {
        this.state.directory = null;
        this.state.directoryFetchedAt = null;
      }
    } catch (e) {
      await keepCorruptAside(this.opts.statePath, e, "Relay move limits start closed: only a relay that is shutting down can move this server for a while.");
      const t = this.now();
      this.state = { rate: { lastLocalityAt: t, coLocateAt: [t], failedTargets: {} }, directory: null, directoryFetchedAt: null };
      await this.persist();
    }
  }

  rate(): MoveHintRateState {
    return this.state.rate;
  }

  directory(): RelayDirectory | null {
    return this.state.directory;
  }

  directoryFetchedAt(): number | null {
    return this.state.directoryFetchedAt;
  }

  /**
   * An accepting HELLO_ACK from a mesh relay (§9.2): its `relayBlessing` verifies under the CA, names `relayId` and
   * this apex, and `hubSig` (over the box's HELLO nonce) verifies under the blessing's `relayKey`.
   */
  async verifyAck(e: { relayId?: string; relayBlessing?: unknown; hubSig?: string; nonce: Uint8Array }): Promise<{ ok: true; relay: MeshRelay } | { ok: false; reason: MeshAckRefusal }> {
    if (typeof e.relayId !== "string" || !isObj(e.relayBlessing)) return { ok: false, reason: "no-relay-id" };
    const b = e.relayBlessing as unknown as RelayBlessing;
    const caKeys = await this.caKeysSafe();
    if (!verifyRelayBlessing(b, caKeys, this.now(), this.opts.servicesApex).ok) return { ok: false, reason: "bad-blessing" };
    if (b.relayId !== e.relayId) return { ok: false, reason: "relay-mismatch" };
    let sigOk = false;
    try {
      sigOk = typeof e.hubSig === "string" && /^[0-9a-f]{128}$/.test(e.hubSig) && ed.verify(fromHex(e.hubSig), e.nonce, fromHex(b.relayKey));
    } catch {
      sigOk = false;
    }
    if (!sigOk) return { ok: false, reason: "hubsig" };
    return { ok: true, relay: { relayId: b.relayId, relayKey: b.relayKey, tunnelHost: b.tunnelHost, blessing: b } };
  }

  /** The box-signed attachment for `relay` (§5.1): `attachedAt` is when this tunnel's HELLO_ACK arrived. */
  async signAttachment(relay: MeshRelay, attachedAt: number): Promise<AttachmentFramePayload> {
    const issuedAt = Math.max(this.now(), attachedAt);
    const attachment: BoxAttachment = {
      serverFqdn: this.opts.serverFqdn,
      boxPub: this.opts.boxPub,
      regGen: this.opts.regGen(),
      relayId: relay.relayId,
      attachedAt,
      issuedAt,
      notAfter: issuedAt + ATTACH_TTL_MS,
    };
    const sig = await this.opts.sign(canonicalBoxAttachment(attachment));
    return { attachment: { ...attachment }, signature: Buffer.from(sig).toString("hex") };
  }

  /**
   * May the box act on this hint (§9.3)? Fetches the directory first when it is older than a day (or missing).
   * `current` is this tunnel's verified relay.
   */
  async checkHint(payload: MoveHintFramePayload, current: MeshRelay): Promise<{ ok: true; target: MoveTarget } | { ok: false; reason: HintRefusal; toRelayId: string | null }> {
    // checkMoveHint refuses a malformed record itself (`malformed`).
    const hint = payload.hint as unknown as MoveHint;
    const caKeys = await this.caKeysSafe();
    const run = () =>
      checkMoveHint({
        hint,
        signature: payload.signature,
        target: payload.target as unknown as RelayBlessing,
        box: { serverFqdn: this.opts.serverFqdn, boxPub: this.opts.boxPub, servicesApex: this.opts.servicesApex },
        current: { relayId: current.relayId, relayKey: current.relayKey },
        directory: this.state.directory,
        directoryFetchedAt: this.state.directoryFetchedAt,
        caKeys,
        rate: this.state.rate,
        now: this.now(),
      });
    let r = run();
    if (!r.ok && r.reason === "directory-stale") {
      await this.refreshDirectory();
      r = run();
    }
    if (!r.ok) return { ok: false, reason: r.reason, toRelayId: typeof hint.toRelayId === "string" ? hint.toRelayId : null };
    const target = payload.target as unknown as RelayBlessing;
    return { ok: true, target: { relayId: target.relayId, relayKey: target.relayKey, url: relayTunnelUrl(target.tunnelHost), reason: hint.reason } };
  }

  /** The box acted on a hint: count it against the limits. */
  recordMove(reason: MoveHintReason): Promise<void> {
    return this.update((s) => ({ ...s, rate: recordMoveHint(s.rate, reason, this.now()) }));
  }

  /** A move to `relayId` failed: it is ignored for an hour. */
  recordFailed(relayId: string): Promise<void> {
    return this.update((s) => ({ ...s, rate: recordMoveTargetFailed(s.rate, relayId, this.now()) }));
  }

  /**
   * The hourly check (§9.4): the relay's blessing is still within its TTL, and a directory fetched within the day
   * lists it under the same key. A directory that can't be fetched keeps the box where it is (fail open for routing).
   */
  async checkRelay(current: MeshRelay): Promise<{ ok: true } | { ok: false; reason: RelayCheckFailure }> {
    const now = this.now();
    if (now >= current.blessing.expiresAt) return { ok: false, reason: "blessing-expired" };
    await this.refreshDirectory();
    const d = this.state.directory;
    if (!d || this.state.directoryFetchedAt === null || now - this.state.directoryFetchedAt > BOX_DIRECTORY_MAX_AGE_MS) return { ok: true };
    const entry = directoryRelay(d, current.relayId);
    if (!entry) return { ok: false, reason: "not-in-directory" };
    if (entry.relayKey !== current.relayKey) return { ok: false, reason: "key-changed" };
    return { ok: true };
  }

  /** Fetch and verify the directory; keep it only when newer. True when the box now holds a fresh one. */
  refreshDirectory(): Promise<boolean> {
    if (this.fetching) return this.fetching;
    this.fetching = this.fetchNow().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private async fetchNow(): Promise<boolean> {
    let body: unknown;
    try {
      body = await this.opts.fetchDirectory();
    } catch (e) {
      this.log(`[relay-mesh] couldn't fetch the relay directory: ${(e as Error).message}`);
      return false;
    }
    const d = (isObj(body) && isObj(body.directory) ? body.directory : body) as RelayDirectory;
    if (!(await this.directoryVerifies(d))) {
      this.log("[relay-mesh] the relay directory didn't verify; keeping the one held");
      return false;
    }
    const now = this.now();
    await this.update((s) => {
      if (s.directory && !newerRelayDirectory(s.directory, d)) {
        // Same or older: it still proves the held one is current when it is the same version.
        return s.directory.directoryVersion === d.directoryVersion ? { ...s, directoryFetchedAt: now } : s;
      }
      return { ...s, directory: d, directoryFetchedAt: now };
    });
    return true;
  }

  private async directoryVerifies(d: RelayDirectory): Promise<boolean> {
    const caKeys = await this.caKeysSafe();
    return verifyRelayDirectory(d, caKeys, this.now(), this.opts.servicesApex).ok;
  }

  private async caKeysSafe(): Promise<readonly string[]> {
    try {
      return await this.opts.caKeys();
    } catch {
      return [];
    }
  }

  private update(fn: (s: Persisted) => Persisted): Promise<void> {
    const run = this.chain.then(async () => {
      const next = fn(this.state);
      if (next === this.state) return;
      this.state = next;
      await this.persist();
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async persist(): Promise<void> {
    try {
      await writeFileDurable(this.opts.statePath, JSON.stringify(this.state));
    } catch (e) {
      this.log(`[relay-mesh] couldn't save relay-mesh.json: ${(e as Error).message}`);
    }
  }
}

function parseRate(v: unknown): MoveHintRateState {
  if (!isObj(v)) throw new Error("rate missing");
  const n = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x);
  if (v.lastLocalityAt !== null && !n(v.lastLocalityAt)) throw new Error("lastLocalityAt");
  if (!Array.isArray(v.coLocateAt) || !v.coLocateAt.every(n)) throw new Error("coLocateAt");
  if (!isObj(v.failedTargets) || !Object.values(v.failedTargets).every(n)) throw new Error("failedTargets");
  return {
    lastLocalityAt: v.lastLocalityAt as number | null,
    coLocateAt: [...(v.coLocateAt as number[])],
    failedTargets: { ...(v.failedTargets as Record<string, number>) },
  };
}

/**
 * The box's own routing gate for relay streams (relay-mesh.md §9.6): nothing while relay trust is locked down; while
 * the box's serving decision says apps are off, only its control name. A rogue holder relay can then black-hole the
 * box but cannot keep its apps serving past the owner's dead-man.
 */
export function boxStreamGate<T>(o: {
  controlName: string;
  relayAllowed: () => boolean;
  appsAllowed?: () => boolean;
  /** Names the relay may never carry: the direct domain's (docs/direct-access-and-domains.md §1, no relay fallback). */
  directApex?: string;
  target: T;
}): (sni: string) => T | null {
  const control = o.controlName.toLowerCase();
  const direct = o.directApex ? `.${o.directApex.toLowerCase()}` : null;
  return (sni) => {
    if (!o.relayAllowed()) return null;
    if (direct && sni.toLowerCase().replace(/\.$/, "").endsWith(direct)) return null;
    if (o.appsAllowed && sni.toLowerCase() !== control && !o.appsAllowed()) return null;
    return o.target;
  };
}

// ── Activity copy (chunk F renders these kinds in the apps) ───────────────

const MOVE_WHY: Record<MoveHintReason, (from: string) => string> = {
  locality: () => "closer to most of its visitors",
  "co-locate": () => "where this account's other servers are",
  retire: (from) => `because relay ${from} is shutting down`,
};

export function movedLine(from: string, to: string, reason: MoveHintReason | "relay-check", why?: RelayCheckFailure): string {
  if (reason === "relay-check") {
    const because =
      why === "blessing-expired" ? "is no longer approved by Flagship" : why === "key-changed" ? "no longer has the key on Flagship's list of relays" : "is no longer on Flagship's list of relays";
    return `This server reconnected to another Flagship relay because relay ${from} ${because}.`;
  }
  return `This server moved from relay ${from} to relay ${to}, ${MOVE_WHY[reason](from)}.`;
}

const REFUSED_WHY: Partial<Record<HintRefusal | "dial-failed", string>> = {
  "rate-limited": "it had moved recently",
  "target-failed": "a move there failed in the last hour",
  "bad-target": "that relay isn't approved by Flagship",
  "target-not-full": "that relay can't hold servers",
  "target-mismatch": "the request named a different relay than it proved",
  "not-in-directory": "that relay isn't on Flagship's list of relays",
  "directory-stale": "it couldn't get Flagship's list of relays",
  "bad-signature": "the request wasn't signed by its current relay",
  "wrong-from": "the request didn't come from its current relay",
  "not-this-box": "the request was for another server",
  expired: "the request had expired",
  future: "the request was dated in the future",
  "ttl-too-long": "the request was valid for too long",
  "dial-failed": "the new relay didn't answer in time, so it stayed where it was",
};

export function refusedLine(from: string, to: string | null, reason: HintRefusal | "dial-failed"): string {
  const why = REFUSED_WHY[reason] ?? "the request was malformed";
  return to ? `This server didn't move from relay ${from} to relay ${to}: ${why}.` : `This server ignored a move request from relay ${from}: ${why}.`;
}

export { relayTunnelHost };
