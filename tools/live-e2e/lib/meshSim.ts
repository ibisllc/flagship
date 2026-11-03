/**
 * The gym relay mesh as the live groups see it (docs/architecture-v2/relay-mesh.md §14.1): the relays the gym `.com`
 * lists (`GET /api/services/endpoints` `relays`, the directory at `https://feed.<control>/v1/directory.json`), their
 * health, and `MeshSimRelay`, a harness relay that holds a gym-admitted relay key (`GYM_MESH_SIM_SEED`, id
 * `GYM_MESH_SIM_ID`, default `gym-0sim`), gets its blessing from the gym `.com` by proof of possession (§3.2) and opens
 * a bridge to a real relay's `/mesh` (§6.2) as the dialer (its id sorts before `gym-a`). The relay-mesh group uses it
 * as the rogue peer: forged and replayed attachments, a query flood.
 *
 * CA keys: the harness takes the keys that signed the directory it fetched over TLS from the gym `.com` (trust on
 * first use). It is not the code under test; the relays verify against their own CA source.
 */
import { randomBytes } from "node:crypto";
import { connect as netConnect } from "node:net";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { WebSocket } from "ws";
import {
  bridgeEphemeral,
  bridgeMacKeys,
  canonicalRelayBlessingRequest,
  ed,
  openBridgeText,
  sealBridgeText,
  type BridgeMacKeys,
  isRelayId,
  signRelayMeshRecord,
  verifyRelayBlessing,
  type RelayBlessing,
  type RelayDirectory,
} from "@flagship/protocol";
import { CONTROL, SERVICES } from "./harness.js";

export const MESH_RUNBOOK = 'docs/runbooks/relay-mesh.md "Gym"';

export interface GymRelay {
  relayId: string;
  tunnelHost: string;
  ipv4: string[];
  ipv6: string[];
  /** The address visitors are pinned to (:443): the first IPv4, else the first IPv6. */
  ip: string;
  /** `https://<tunnelHost>:8443`: `/api/health`, `/api/stats`. */
  base: string;
}

export interface GymMesh {
  relays: GymRelay[];
  tunnelHub: string | null;
  directory: RelayDirectory | null;
  directoryFetchedAt: number | null;
  /** The CA keys that signed the directory (see the header). */
  caKeys: string[];
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : []);

/** Parse `/api/services/endpoints` `relays` into relays visitors can be pinned to. */
export function parseEndpointRelays(json: unknown, servicesApex = SERVICES): GymRelay[] {
  const list = (json as { relays?: unknown })?.relays;
  if (!Array.isArray(list)) return [];
  const out: GymRelay[] = [];
  for (const r of list) {
    const o = r as Record<string, unknown>;
    if (!isRelayId(o.relayId)) continue;
    const tunnelHost = str(o.tunnelHost) ? o.tunnelHost.toLowerCase() : `${o.relayId}.tunnel.${servicesApex}`;
    const ipv4 = strList(o.ipv4);
    const ipv6 = strList(o.ipv6);
    const ip = ipv4[0] ?? ipv6[0];
    if (!ip) continue;
    out.push({ relayId: o.relayId, tunnelHost, ipv4, ipv6, ip, base: `https://${tunnelHost}:8443` });
  }
  return out.sort((a, b) => (a.relayId < b.relayId ? -1 : a.relayId > b.relayId ? 1 : 0));
}

/** The CA keys a directory's envelope names (signedBy and every signature's pubkey). */
export function caKeysOf(env: { signedBy?: unknown; signatures?: unknown } | null | undefined): string[] {
  if (!env) return [];
  const keys = new Set<string>();
  if (str(env.signedBy)) keys.add(env.signedBy.toLowerCase());
  for (const s of Array.isArray(env.signatures) ? env.signatures : []) {
    const k = (s as { pubkey?: unknown })?.pubkey;
    if (str(k)) keys.add(k.toLowerCase());
  }
  return [...keys];
}

async function getJson(url: string, ms = 15_000): Promise<{ status: number; json: unknown }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

/** The gym mesh from the gym `.com`: relays from the endpoints, the directory from the feed. */
export async function gymMesh(control = CONTROL, servicesApex = SERVICES): Promise<GymMesh> {
  const ep = await getJson(`https://${control}/api/services/endpoints`);
  const relays = parseEndpointRelays(ep.json, servicesApex);
  const tunnelHub = str((ep.json as { tunnelHub?: unknown })?.tunnelHub) ? ((ep.json as { tunnelHub: string }).tunnelHub) : null;
  const d = await getJson(`https://feed.${control}/v1/directory.json`);
  const directory = ((d.json as { directory?: unknown })?.directory ?? null) as RelayDirectory | null;
  return { relays, tunnelHub, directory, directoryFetchedAt: directory ? Date.now() : null, caKeys: caKeysOf(directory) };
}

/** A relay's `/api/health`: ready when 200 and `mesh.ready` (both relays answer that shape, §15.3.1 / §15.4.1). */
export async function relayHealth(r: GymRelay): Promise<{ status: number; ready: boolean; detail: string }> {
  const h = await getJson(`${r.base}/api/health`, 10_000);
  const mesh = (h.json as { mesh?: { ready?: unknown; reasons?: unknown; readiness?: unknown } })?.mesh;
  const ready = h.status === 200 && mesh?.ready === true;
  const detail = mesh ? JSON.stringify(mesh.reasons ?? mesh.readiness ?? mesh) : h.status === 0 ? "unreachable" : "no mesh block";
  return { status: h.status, ready, detail };
}

/** Waits up to `ms` for every relay to be mesh-ready; returns the ones that are not. */
export async function waitReady(relays: GymRelay[], ms: number): Promise<string[]> {
  const end = Date.now() + ms;
  for (;;) {
    const bad: string[] = [];
    for (const r of relays) {
      const h = await relayHealth(r);
      if (!h.ready) bad.push(`${r.relayId}: ${h.status} ${h.detail}`);
    }
    if (bad.length === 0 || Date.now() > end) return bad;
    await new Promise((res) => setTimeout(res, 5_000));
  }
}

/** Whether `ip:port` takes a TCP connection within `ms` (an IPv6-only relay from an IPv4-only runner does not). */
export function tcpReachable(ip: string, port = 443, ms = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect(port, ip);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** `/api/stats` of a relay, when the gym's stats secret is known (`GYM_RELAY_STATS_SECRET`); else null. */
export async function relayStats(r: GymRelay, secret = process.env.GYM_RELAY_STATS_SECRET): Promise<Record<string, unknown> | null> {
  if (!secret) return null;
  try {
    const res = await fetch(`${r.base}/api/stats`, { headers: { "x-usage-secret": secret }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The mesh sim's key from the environment, or why there is none. */
export function simRelayFromEnv(env: NodeJS.ProcessEnv = process.env): { relayId: string; seed: Uint8Array } | { why: string } {
  const seedHex = (env.GYM_MESH_SIM_SEED ?? "").trim().toLowerCase();
  const relayId = (env.GYM_MESH_SIM_ID ?? "gym-0sim").trim();
  if (!seedHex) return { why: `GYM_MESH_SIM_SEED is unset (a relay key the owner admitted on the gym: ${MESH_RUNBOOK})` };
  if (!/^[0-9a-f]{64}$/.test(seedHex)) return { why: "GYM_MESH_SIM_SEED must be 64 hex" };
  if (!isRelayId(relayId)) return { why: `GYM_MESH_SIM_ID ${relayId} is not a relay id` };
  return { relayId, seed: hexToBytes(seedHex) };
}

/** Ask the gym `.com` for a relay blessing by proof of possession (§3.2). */
export async function fetchRelayBlessing(o: { relayId: string; seed: Uint8Array; control?: string; servicesApex?: string }): Promise<{ status: number; blessing: RelayBlessing | null; body: unknown }> {
  const relayKey = bytesToHex(ed.getPublicKey(o.seed));
  const req = { relayId: o.relayId, relayKey, servicesApex: o.servicesApex ?? SERVICES, issuedAt: Date.now() };
  const signature = bytesToHex(ed.sign(canonicalRelayBlessingRequest(req), o.seed));
  try {
    const r = await fetch(`https://${o.control ?? CONTROL}/api/services/relay-blessing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...req, signature }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json().catch(() => null)) as { relayBlessing?: RelayBlessing } | null;
    return { status: r.status, blessing: r.ok ? (body?.relayBlessing ?? null) : null, body };
  } catch (e) {
    return { status: 0, blessing: null, body: String(e) };
  }
}

export type MeshMsg = Record<string, unknown> & { type: string };

/**
 * A harness relay on one bridge to a real relay: it dials `wss://<peer>:8443/mesh`, answers `mesh-hello` with its
 * blessing and signature (§6.2), checks nothing of the peer beyond its relay id (it is not the code under test), then
 * answers the peer's `sync` with the peer's own head (it holds no mesh key, so it cannot read the feed) and
 * `sync-done`. Every control message is kept; `items` mirrors what the peer announced and withdrew.
 */
export class MeshSimRelay {
  readonly messages: MeshMsg[] = [];
  /** serverFqdn (or bare name) → the newest announced item from the peer. */
  readonly items = new Map<string, Record<string, unknown>>();
  closedWith: { code: number; reason: string } | null = null;
  readonly closed: Promise<void>;
  private waiters: Array<() => void> = [];
  /** §6.2 bridge MAC: this harness dials, so it sends with `c2s` and reads with `s2c`. */
  private keys: BridgeMacKeys | null = null;
  private eph: { secret: Uint8Array; serverNonce: string; clientNonce: string } | null = null;
  private sendSeq = 0;
  private recvSeq = 0;

  private constructor(
    readonly ws: WebSocket,
    readonly relayId: string,
    readonly seed: Uint8Array,
    readonly peer: GymRelay,
    readonly blessing: RelayBlessing,
  ) {
    let done!: () => void;
    this.closed = new Promise((r) => (done = r));
    ws.on("close", (code, reason) => {
      this.closedWith = { code, reason: reason.toString() };
      this.wake();
      done();
    });
    ws.on("error", () => undefined);
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let text = raw.toString();
      if (this.keys) {
        const opened = openBridgeText(this.keys.s2c, this.recvSeq, text);
        if (opened === null) return void ws.close(4401, "bad-mac");
        this.recvSeq++;
        text = opened;
      }
      let m: MeshMsg;
      try {
        m = JSON.parse(text) as MeshMsg;
      } catch {
        return;
      }
      if (typeof m?.type !== "string") return;
      if (!this.keys && m.type === "mesh-auth" && this.eph) {
        this.keys = bridgeMacKeys({ secret: this.eph.secret, peerKx: String(m.kx), serverNonce: this.eph.serverNonce, clientNonce: this.eph.clientNonce, clientRelayId: this.relayId, serverRelayId: String(m.relayId) });
      }
      this.messages.push(m);
      this.note(m);
      this.wake();
    });
  }

  get relayKey(): string {
    return bytesToHex(ed.getPublicKey(this.seed));
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private note(m: MeshMsg): void {
    if (m.type === "announce" && Array.isArray(m.items)) {
      for (const it of m.items as Array<Record<string, unknown>>) {
        const rec = (it.attachment ?? it.grant) as { serverFqdn?: string; hostname?: string } | undefined;
        const name = rec?.serverFqdn ?? rec?.hostname;
        if (name) this.items.set(name, it);
      }
    } else if (m.type === "withdraw" && Array.isArray(m.items)) {
      for (const it of m.items as Array<{ withdraw?: { subject?: string } }>) if (it.withdraw?.subject) this.items.delete(it.withdraw.subject);
    }
  }

  /** The first kept message matching `pred` (received at or after index `from`), within `ms`. */
  async next(pred: (m: MeshMsg) => boolean, ms = 10_000, from = 0): Promise<MeshMsg | null> {
    const end = Date.now() + ms;
    for (;;) {
      const m = this.messages.slice(from).find(pred);
      if (m) return m;
      if (Date.now() > end || this.closedWith) return null;
      await Promise.race([new Promise<void>((r) => this.waiters.push(r)), new Promise<void>((r) => setTimeout(r, 250))]);
    }
  }

  send(m: MeshMsg): boolean {
    if (this.ws.readyState !== this.ws.OPEN) return false;
    const json = JSON.stringify(m);
    this.ws.send(this.keys ? sealBridgeText(this.keys.c2s, this.sendSeq++, json) : json);
    return true;
  }

  /** Dial `peer`'s `/mesh` and complete the handshake and the sync; throws with the peer's close reason. */
  static async connect(o: { relayId: string; seed: Uint8Array; peer: GymRelay; blessing: RelayBlessing; url?: string }): Promise<MeshSimRelay> {
    const ws = new WebSocket(o.url ?? `wss://${o.peer.tunnelHost}:8443/mesh`);
    const sim = new MeshSimRelay(ws, o.relayId, o.seed, o.peer, o.blessing);
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
      ws.once("unexpected-response", (_q, resp) => rej(new Error(`/mesh upgrade refused ${resp.statusCode}`)));
    });
    const hello = await sim.next((m) => m.type === "mesh-hello", 5_000);
    if (!hello) throw new Error(`no mesh-hello from ${o.peer.relayId}: ${JSON.stringify(sim.closedWith)}`);
    if (hello.relayId !== o.peer.relayId) throw new Error(`mesh-hello names ${String(hello.relayId)}, not ${o.peer.relayId}`);
    const nc = randomBytes(32).toString("hex");
    const at = Date.now();
    const eph = bridgeEphemeral();
    sim.eph = { secret: eph.secret, serverNonce: String(hello.nonce), clientNonce: nc };
    const sig = signRelayMeshRecord(
      "relay-bridge-auth",
      { role: "client", signerRelayId: o.relayId, peerRelayId: o.peer.relayId, serverNonce: String(hello.nonce), clientNonce: nc, at, kx: eph.kx },
      (msg) => ed.sign(msg, o.seed),
    );
    sim.send({ type: "mesh-auth", v: 1, relayId: o.relayId, peer: o.peer.relayId, nonce: nc, at, kx: eph.kx, blessing: o.blessing, sig });
    const auth = await sim.next((m) => m.type === "mesh-auth", 5_000);
    if (!auth) throw new Error(`the handshake with ${o.peer.relayId} failed: ${JSON.stringify(sim.closedWith)}`);
    const sync = await sim.next((m) => m.type === "sync", 5_000);
    sim.send({ type: "sync", directoryVersion: Number(sync?.directoryVersion ?? 0), head: sync?.head ?? null, features: [], load: { tunnels: 0, capacity: 1 } });
    sim.send({ type: "sync-done" });
    await sim.next((m) => m.type === "sync-done", 10_000);
    return sim;
  }

  /** Send `count` queries for `name` as fast as the socket takes them; the answers that say `busy`, and all answers. */
  async flood(name: string, count: number, waitMs = 5_000): Promise<{ answers: number; busy: number }> {
    const from = this.messages.length;
    const qids = new Set<string>();
    for (let i = 0; i < count; i++) {
      const qid = `f${i}-${randomBytes(4).toString("hex")}`;
      qids.add(qid);
      this.send({ type: "query", qid, name });
    }
    const end = Date.now() + waitMs;
    let answers: MeshMsg[] = [];
    while (Date.now() < end) {
      answers = this.messages.slice(from).filter((m) => m.type === "answer" && qids.has(String(m.qid)));
      if (answers.length >= count || this.closedWith) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return { answers: answers.length, busy: answers.filter((m) => m.busy === true).length };
  }

  close(): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(1000, "done");
    else this.ws.terminate();
  }
}

/** Whether a blessing verifies under the CA keys the harness holds (a sanity check on what `.com` returned). */
export function blessingVerifies(b: RelayBlessing | null, caKeys: readonly string[], servicesApex = SERVICES): boolean {
  return !!b && verifyRelayBlessing(b, caKeys, Date.now(), servicesApex).ok;
}
