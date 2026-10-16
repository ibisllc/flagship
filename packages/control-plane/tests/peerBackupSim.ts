/**
 * A peer-backup network in one process: the real `.com` handlers on an
 * in-memory store, real box engines (holder + owner) on in-memory disks, and
 * a relay that routes mailboxes like the hub does. Tests drive a shared clock.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed, rsaPrivateKeyFromJwk, type PbNetwork } from "@flagship/protocol";
import type { ServerRecord, ServerStorage } from "@flagship/storage";
import { InMemoryPbNetStore, routePbNet, type PbNetDeps, type PbNetStore } from "../src/peerBackupNetwork.js";
import { buildHttpPbCom } from "../../server-daemon/src/peerNet/comClient.js";
import { HolderEngine } from "../../server-daemon/src/peerNet/holder.js";
import { OwnerEngine, type ArchiveRef } from "../../server-daemon/src/peerNet/owner.js";
import { MemoryBlobStore, MemoryStateFile } from "../../server-daemon/src/peerNet/stores.js";
import { PbUnreachable, type PbComClient, type PbMailTransport } from "../../server-daemon/src/peerNet/types.js";

export const SIM_NETWORK: PbNetwork = {
  brickBytes: 4096,
  leafBytes: 256,
  k: 4,
  n: 8,
  slotBricks: 4,
  leaseMs: 90 * 24 * 3600_000,
  diversity: "account+network",
};

let rsaJwk: Record<string, string> | null = null;
function testRsaJwk(): Record<string, string> {
  if (!rsaJwk) rsaJwk = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }) as Record<string, string>;
  return rsaJwk;
}

class FakeServers implements ServerStorage {
  rows = new Map<string, ServerRecord>();
  async put(r: ServerRecord) {
    this.rows.set(r.serverDomain, { ...r });
  }
  async get(d: string) {
    const r = this.rows.get(d);
    return r ? { ...r } : undefined;
  }
  async listForUser(u: string) {
    return [...this.rows.values()].filter((r) => r.username === u);
  }
  async listAll() {
    return [...this.rows.values()];
  }
  async revoke(d: string, reason: string, at: number) {
    const r = this.rows.get(d);
    if (!r) return false;
    r.revokedAt = at;
    r.revocationReason = reason;
    return true;
  }
  async unrevoke(d: string) {
    const r = this.rows.get(d);
    if (!r?.revokedAt) return false;
    delete r.revokedAt;
    return true;
  }
}

export interface SimBox {
  serverId: string;
  username: string;
  ip: string;
  stk: { privateKey: Uint8Array; publicKey: Uint8Array };
  com: PbComClient;
  holder: HolderEngine;
  owner: OwnerEngine;
  holderBlobs: MemoryBlobStore;
  pbk: Uint8Array;
  poolBytes: number;
}

/** How a holder misbehaves in a test. */
export type Misbehaviour = "none" | "offline" | "drop-bricks" | "garbage";

export class Sim {
  t = Date.UTC(2026, 9, 16);
  readonly servers: ServerStorage = new FakeServers();
  readonly store: PbNetStore;
  readonly deps: PbNetDeps;
  readonly boxes: SimBox[] = [];
  readonly behaviour = new Map<string, Misbehaviour>();
  readonly dir = mkdtempSync(join(tmpdir(), "pb-sim-"));
  relayCalls = 0;
  readonly logs: string[] = [];
  private pending: Promise<void>[] = [];

  constructor(network: PbNetwork = SIM_NETWORK, store: PbNetStore = new InMemoryPbNetStore(), servers?: ServerStorage) {
    this.store = store;
    if (servers) this.servers = servers;
    this.deps = {
      servers: this.servers,
      store: this.store,
      network,
      relayBase: "https://relay.test:8443",
      tokenKey: rsaPrivateKeyFromJwk(testRsaJwk()),
      fillerSecret: new Uint8Array(32).fill(9),
      tagSecret: new Uint8Array(32).fill(7),
      now: () => this.t,
    };
  }

  now = () => this.t;

  advance(ms: number) {
    this.t += ms;
  }

  /** `.com` over a fetch that never leaves the process. */
  private fetchFor(ip: string): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const raw = init?.body;
      const json = typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined;
      const r = await routePbNet(this.deps, { method: init?.method ?? "GET", path: url.pathname, json, clientIp: ip, query: url.searchParams });
      if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      if (r.body instanceof Uint8Array) return new Response(r.body, { status: r.status });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  /** The relay: finds the holder owning the mailbox, as the hub does from announcements. */
  readonly transport: PbMailTransport = {
    send: async (mailboxId, envelope) => {
      this.relayCalls++;
      for (const b of this.boxes) {
        if (!(await b.holder.ownsMailbox(mailboxId))) continue;
        const how = this.behaviour.get(b.serverId) ?? "none";
        if (how === "offline") throw new PbUnreachable("offline");
        return b.holder.handleMail(mailboxId, envelope);
      }
      throw new PbUnreachable("no such mailbox");
    },
  };

  addBox(opts: { username?: string; ip?: string; poolBricks?: number } = {}): SimBox {
    const i = this.boxes.length;
    const username = opts.username ?? `user${i}`;
    const serverId = `home${i}.${username}.flagship.services`;
    const ip = opts.ip ?? `198.51.${i}.10`;
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const stk = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
    this.pending.push(this.servers.put({ serverDomain: serverId, username, identityPubKeyHex: Buffer.from(stk.publicKey).toString("hex"), registeredAt: this.t }));
    const com = buildHttpPbCom({ baseUrl: "https://com.test", serverDomain: serverId, sign: (m) => ed.sign(m, seed), fetchImpl: this.fetchFor(ip), now: this.now });
    const poolBytes = (opts.poolBricks ?? 200) * this.deps.network.brickBytes;
    const holderBlobs = new MemoryBlobStore();
    const pbk = crypto.getRandomValues(new Uint8Array(32));
    const box: SimBox = {
      serverId,
      username,
      ip,
      stk,
      com,
      holderBlobs,
      pbk,
      poolBytes,
      holder: new HolderEngine({
        serverId,
        com,
        state: new MemoryStateFile(),
        blobs: holderBlobs,
        poolBytes: () => poolBytes,
        now: this.now,
        redeemJitterMs: 3600_000,
        fillerPerTick: 1000,
        log: (m) => this.logs.push(`${serverId} holder: ${m}`),
      }),
      owner: new OwnerEngine({
        serverId,
        pbk,
        com,
        transport: this.transport,
        state: new MemoryStateFile(),
        blobs: new MemoryBlobStore(),
        now: this.now,
        log: (m) => this.logs.push(`${serverId}: ${m}`),
      }),
    };
    this.boxes.push(box);
    return box;
  }

  /** Every holder checks in (and fills / answers / redeems). */
  async holderTicks(): Promise<void> {
    await Promise.all(this.pending.splice(0));
    for (const b of this.boxes) {
      if (this.behaviour.get(b.serverId) === "offline") continue;
      await b.holder.tick();
    }
  }

  /** Make the holder behave badly from now on. */
  async misbehave(b: SimBox, how: Misbehaviour): Promise<void> {
    this.behaviour.set(b.serverId, how);
    if (how === "drop-bricks" || how === "garbage") {
      for (const [name, bytes] of b.holderBlobs.blobs) {
        if (!name.startsWith("b-")) continue;
        if (how === "drop-bricks") b.holderBlobs.blobs.delete(name);
        else b.holderBlobs.blobs.set(name, bytes.map((x) => x ^ 0x5a));
      }
    }
  }

  writeArchive(name: string, bytes: number): ArchiveRef & { content: Uint8Array } {
    const content = new Uint8Array(bytes);
    for (let o = 0; o < bytes; o += 65536) crypto.getRandomValues(content.subarray(o, Math.min(bytes, o + 65536)));
    const dataPath = join(this.dir, `${name}.data`);
    const backupPath = join(this.dir, `${name}.backup`);
    writeFileSync(dataPath, content);
    writeFileSync(backupPath, JSON.stringify({ v: 2, archiveId: name, slots: [] }));
    const sha256 = createHash("sha256").update(content).digest("hex");
    return { archiveId: createHash("sha256").update(name).digest("hex").slice(0, 32), createdAt: this.t, bytes, sha256, dataPath, backupPath, content };
  }
}
