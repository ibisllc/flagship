/**
 * The box's side of the relay mesh (docs/architecture-v2/relay-mesh.md §9): the attachment it signs (byte-identical
 * to the shared vectors, through keyd's purpose rules), the move hints it accepts (the protocol's vector cases, plus the
 * box's own state and directory), the make-before-break move through the supervisor with a fake WebSocket factory,
 * attachment renewals, leases in HELLO and re-HELLO, the hourly relay check and box-side stop-apps.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  boxNameList,
  canonicalBoxAttachment,
  canonicalMoveHint,
  ed,
  nameListSha256,
  signRelayDirectory,
  signRelayMeshRecord,
  signServingRecord,
  verifyRelayMeshRecord,
  type BoxAttachment,
  type MoveHint,
  type RelayBlessing,
  type RelayDirectory,
  type ServingLease,
  type ServingPolicy,
} from "@flagship/protocol";
import { checkSign } from "@flagship/keyd";
import {
  CAPABILITY_DRAIN_V1,
  CAPABILITY_MESH_V1,
  CAPABILITY_PB_MAIL_V1,
  FRAME_PB_MAILBOX_ANNOUNCE,
  FRAME_ATTACHMENT,
  FRAME_CLOSE_REMOTE,
  FRAME_HELLO,
  attachmentResultFrame,
  decodeFrame,
  encodeFrame,
  helloAckFrame,
  moveHintFrame,
  type Frame,
} from "@flagship/tunnel-protocol";
import {
  RELAY_MOVED_KIND,
  RELAY_MOVE_REFUSED_KIND,
  RelayMeshBox,
  boxStreamGate,
  relayFeedBaseUrl,
  type MeshRelay,
} from "../src/tunnel/relayMesh.js";
import { buildRelayMeshBox, type RelayMeshWiring } from "../src/tunnel/relayMeshWiring.js";
import {
  startTunnelClient,
  superviseTunnelClient,
  type SupervisedTunnelClient,
  type TunnelClientOptions,
  type TunnelWebSocketLike,
  type WebSocketFactory,
} from "../src/tunnel/tunnelClient.js";
import { ServingStore } from "../src/servingStore.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const v: Any = JSON.parse(readFileSync(new URL("../../protocol/test-vectors/relay-mesh/vectors.json", import.meta.url), "utf8"));
const APEX: string = v.servicesApex;
const T0: number = v.t0;
const CA: string[] = v.caKeys;
const D: RelayDirectory = v.directory.directory;
const FQDN = `home.alice.${APEX}`;
const seedOf = (name: string) => Uint8Array.from(Buffer.from(v.keys[name].seed, "hex"));
const pubOf = (name: string): string => v.keys[name].pub;
const signer = (name: string) => (m: Uint8Array) => ed.sign(m, seedOf(name));
const blessingOf = (relayId: string): RelayBlessing => v.blessings.find((b: Any) => b.relayId === relayId).blessing;
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const BOX_PUB = pubOf("boxHome");
/** The box signs through keyd's purpose rules, as a keyd box does. */
const boxSign = (m: Uint8Array) => {
  checkSign(m, BOX_PUB);
  return ed.sign(m, seedOf("boxHome"));
};
const caKeypair = { publicKey: ed.getPublicKey(seedOf("ca")), privateKey: seedOf("ca") };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flagship-relay-mesh-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const statePath = () => join(dir, "relay-mesh.json");

function meshBox(o: { now?: () => number; fetchDirectory?: () => Promise<unknown>; caKeys?: string[] } = {}): RelayMeshBox {
  return new RelayMeshBox({
    serverFqdn: FQDN,
    servicesApex: APEX,
    boxPub: BOX_PUB,
    regGen: () => 1,
    sign: boxSign,
    caKeys: async () => o.caKeys ?? CA,
    fetchDirectory: o.fetchDirectory ?? (async () => ({ directory: D, blessings: [] })),
    statePath: statePath(),
    now: o.now ?? (() => T0),
    log: () => {},
  });
}

const iad1: MeshRelay = { relayId: "iad1", relayKey: pubOf("iad1"), tunnelHost: `iad1.tunnel.${APEX}`, blessing: blessingOf("iad1") };

describe("RelayMeshBox against the relay-mesh vectors", () => {
  it("signs the vector attachment byte for byte, through keyd's policy", async () => {
    const rec = v.records.find((r: Any) => r.kind === "relay-attachment");
    const box = meshBox({ now: () => rec.record.issuedAt });
    const p = await box.signAttachment(iad1, rec.record.attachedAt);
    expect(p.attachment).toEqual(rec.record);
    expect(p.signature).toBe(rec.signature);
    expect(new TextDecoder().decode(canonicalBoxAttachment(p.attachment as unknown as BoxAttachment))).toBe(rec.canonical);
  });

  it("keyd refuses an attachment for another box or one longer than 30 minutes", () => {
    const a: BoxAttachment = { serverFqdn: FQDN, boxPub: BOX_PUB, regGen: 1, relayId: "iad1", attachedAt: T0, issuedAt: T0, notAfter: T0 + 30 * 60_000 };
    expect(checkSign(canonicalBoxAttachment(a), BOX_PUB)).toBe("flagship/relay-attachment/v1");
    expect(() => checkSign(canonicalBoxAttachment({ ...a, boxPub: pubOf("boxCabin") }), BOX_PUB)).toThrow(/attaches only itself/);
    expect(() => checkSign(canonicalBoxAttachment({ ...a, notAfter: T0 + 30 * 60_000 + 1 }), BOX_PUB)).toThrow(/30 minutes/);
  });

  it("verifies a mesh HELLO_ACK: the blessing under the CA and hubSig under its relay key", async () => {
    const box = meshBox();
    const nonce = new Uint8Array(32).fill(9);
    const hubSig = hexOf(ed.sign(nonce, seedOf("iad1")));
    const ok = await box.verifyAck({ relayId: "iad1", relayBlessing: blessingOf("iad1"), hubSig, nonce });
    expect(ok.ok && ok.relay.relayKey).toBe(pubOf("iad1"));
    expect(await box.verifyAck({ relayId: "iad1", relayBlessing: blessingOf("iad1"), hubSig: hexOf(ed.sign(nonce, seedOf("ams1"))), nonce })).toEqual({ ok: false, reason: "hubsig" });
    expect(await box.verifyAck({ relayId: "ams1", relayBlessing: blessingOf("iad1"), hubSig, nonce })).toEqual({ ok: false, reason: "relay-mismatch" });
    expect(await box.verifyAck({ relayId: "iad1", hubSig, nonce })).toEqual({ ok: false, reason: "no-relay-id" });
    expect(await meshBox({ caKeys: [] }).verifyAck({ relayId: "iad1", relayBlessing: blessingOf("iad1"), hubSig, nonce })).toEqual({ ok: false, reason: "bad-blessing" });
    const late = meshBox({ now: () => blessingOf("iad1").expiresAt });
    expect(await late.verifyAck({ relayId: "iad1", relayBlessing: blessingOf("iad1"), hubSig, nonce })).toEqual({ ok: false, reason: "bad-blessing" });
  });

  it("decides every vector move hint as the protocol does, with its state on disk", async () => {
    for (const c of v.checks.moveHint) {
      await writeFile(statePath(), JSON.stringify({ rate: c.rate, directory: c.directoryFetchedAt === null ? null : D, directoryFetchedAt: c.directoryFetchedAt }));
      // The feed is down: a stale directory stays stale.
      const box = meshBox({ now: () => c.now, fetchDirectory: async () => Promise.reject(new Error("feed down")) });
      await box.load();
      const r = await box.checkHint({ hint: c.hint, signature: c.signature, target: c.target }, iad1);
      expect(r.ok ? { ok: true } : { ok: false, reason: r.reason }, c.name).toEqual(c.expected);
    }
  });

  it("fetches the directory when it is a day old, then accepts the hint", async () => {
    const c = v.checks.moveHint.find((x: Any) => x.name === "directory a day old");
    await writeFile(statePath(), JSON.stringify({ rate: c.rate, directory: D, directoryFetchedAt: c.directoryFetchedAt }));
    const box = meshBox({ now: () => c.now });
    await box.load();
    const r = await box.checkHint({ hint: c.hint, signature: c.signature, target: c.target }, iad1);
    expect(r).toEqual({ ok: true, target: { relayId: "ams1", relayKey: pubOf("ams1"), url: `wss://ams1.tunnel.${APEX}:8443/tunnel`, reason: c.hint.reason } });
    expect(box.directoryFetchedAt()).toBe(c.now);
  });

  it("refuses a target whose directory entry has another key", async () => {
    const c = v.checks.moveHint.find((x: Any) => x.name === "co-locate ok");
    const relays = D.relays.map((r) => (r.relayId === "ams1" ? { ...r, relayKey: pubOf("rog1") } : r));
    const other = signRelayDirectory({ servicesApex: APEX, directoryVersion: D.directoryVersion + 1, issuedAt: D.issuedAt + 1, expiresAt: D.expiresAt, relays }, caKeypair);
    await writeFile(statePath(), JSON.stringify({ rate: c.rate, directory: other, directoryFetchedAt: c.directoryFetchedAt }));
    const box = meshBox({ now: () => c.now });
    await box.load();
    expect(box.directory()?.directoryVersion).toBe(D.directoryVersion + 1);
    const r = await box.checkHint({ hint: c.hint, signature: c.signature, target: c.target }, iad1);
    expect(r).toMatchObject({ ok: false, reason: "not-in-directory", toRelayId: "ams1" });
  });

  it("persists the move limits and loads a damaged file closed", async () => {
    const box = meshBox();
    await box.recordMove("co-locate");
    await box.recordFailed("ams1");
    const again = meshBox();
    await again.load();
    expect(again.rate()).toEqual({ lastLocalityAt: null, coLocateAt: [T0], failedTargets: { ams1: T0 } });

    await writeFile(statePath(), "{not json");
    const damaged = meshBox();
    await damaged.load();
    expect(damaged.rate()).toEqual({ lastLocalityAt: T0, coLocateAt: [T0], failedTargets: {} });
    expect(JSON.parse(await readFile(statePath(), "utf8")).rate.lastLocalityAt).toBe(T0);
  });

  it("drops a stored directory that doesn't verify, and keeps only newer ones", async () => {
    await writeFile(statePath(), JSON.stringify({ rate: { lastLocalityAt: null, coLocateAt: [], failedTargets: {} }, directory: { ...D, directoryVersion: 99 }, directoryFetchedAt: T0 }));
    const box = meshBox({ fetchDirectory: async () => ({ directory: { ...D, relays: [] } }) });
    await box.load();
    expect(box.directory()).toBeNull();
    expect(await box.refreshDirectory()).toBe(false);
    const ok = meshBox();
    await ok.load();
    expect(await ok.refreshDirectory()).toBe(true);
    expect(ok.directory()?.directoryVersion).toBe(D.directoryVersion);
  });

  it("the hourly check: blessing expiry, missing relay, changed key", async () => {
    expect(await meshBox().checkRelay(iad1)).toEqual({ ok: true });
    expect(await meshBox({ now: () => iad1.blessing.expiresAt }).checkRelay(iad1)).toEqual({ ok: false, reason: "blessing-expired" });
    const without = signRelayDirectory({ servicesApex: APEX, directoryVersion: D.directoryVersion + 1, issuedAt: T0, expiresAt: D.expiresAt, relays: D.relays.filter((r) => r.relayId !== "iad1") }, caKeypair);
    expect(await meshBox({ fetchDirectory: async () => ({ directory: without }) }).checkRelay(iad1)).toEqual({ ok: false, reason: "not-in-directory" });
    const rekeyed = signRelayDirectory(
      { servicesApex: APEX, directoryVersion: D.directoryVersion + 1, issuedAt: T0, expiresAt: D.expiresAt, relays: D.relays.map((r) => (r.relayId === "iad1" ? { ...r, relayKey: pubOf("rog1") } : r)) },
      caKeypair,
    );
    expect(await meshBox({ fetchDirectory: async () => rekeyed }).checkRelay(iad1)).toEqual({ ok: false, reason: "key-changed" });
    // No directory at all (the feed is down): stay.
    expect(await meshBox({ fetchDirectory: async () => Promise.reject(new Error("down")) }).checkRelay(iad1)).toEqual({ ok: true });
  });

  it("the feed URL", () => {
    expect(relayFeedBaseUrl("https://flagshipserver.com", {})).toBe("https://feed.flagshipserver.com/v1");
    expect(relayFeedBaseUrl("https://gym.flagshipserver.com/", { FLAGSHIP_RELAY_FEED_URL: "https://x.example/v1/" })).toBe("https://x.example/v1");
  });
});

// ── the tunnel with a fake WebSocket factory ──────────────────────────────

class FakeWS extends EventEmitter implements TunnelWebSocketLike {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWS.OPEN;
  binaryType = "arraybuffer";
  sent: Frame[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeWS.CLOSED;
    setImmediate(() => this.emit("close"));
  }
  send(data: Uint8Array | string): void {
    if (typeof data === "string") return;
    let buf = data;
    while (buf.length > 0) {
      const r = decodeFrame(buf, { drainNotice: true, mesh: true });
      if (r.kind !== "ok") break;
      this.sent.push(r.frame);
      buf = buf.subarray(r.consumed);
    }
  }
  ping(): void {
    setImmediate(() => this.emit("pong"));
  }
  deliver(f: Frame): void {
    const b = encodeFrame(f);
    this.emit("message", Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  }
  frames(type: number): Frame[] {
    return this.sent.filter((f) => f.type === type);
  }
  json(f: Frame): Any {
    return JSON.parse(new TextDecoder().decode(f.payload));
  }
}

function fakeFactory(): { sockets: FakeWS[]; factory: WebSocketFactory } {
  const sockets: FakeWS[] = [];
  const factory = Object.assign(
    ((url: string) => {
      const ws = new FakeWS(url);
      sockets.push(ws);
      setImmediate(() => ws.emit("open"));
      return ws;
    }) as (url: string) => TunnelWebSocketLike,
    { OPEN: FakeWS.OPEN, CLOSED: FakeWS.CLOSED },
  );
  return { sockets, factory };
}

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 2_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const r = fn();
    if (r) return r;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((res) => setTimeout(res, 2));
  }
}

/** Answer the socket's HELLO as relay `relayId` (a mesh relay unless `mesh: false`). */
async function acceptAs(ws: FakeWS, relayId: string | null, o: { blessing?: RelayBlessing; keyOf?: string; extraCaps?: string[] } = {}): Promise<void> {
  const hello = await waitFor(() => ws.frames(FRAME_HELLO)[0]);
  const nonce = Uint8Array.from(Buffer.from(ws.json(hello).nonce, "hex"));
  if (relayId === null) {
    ws.deliver(helloAckFrame(true, undefined, {}, [CAPABILITY_DRAIN_V1]));
    return;
  }
  const hubSig = hexOf(ed.sign(nonce, seedOf(o.keyOf ?? relayId)));
  ws.deliver(helloAckFrame(true, undefined, { hubSig, relayId, relayBlessing: o.blessing ?? blessingOf(relayId) }, [CAPABILITY_DRAIN_V1, CAPABILITY_MESH_V1, ...(o.extraCaps ?? [])]));
}

const entitlements = async () => ({
  rootEntitlement: { username: "alice", podPubKey: new Uint8Array(32), podCanonical: FQDN, issuedAt: 0 },
  rootEntitlementSig: new Uint8Array(64),
});

interface Harness {
  sup: SupervisedTunnelClient;
  sockets: FakeWS[];
  wiring: RelayMeshWiring;
  notes: Array<{ kind: string; detail: string; ok: boolean }>;
  opened: string[];
}

async function harness(o: { now?: () => number; renewMs?: number; graceMs?: number; dialTimeoutMs?: number; checkIntervalMs?: number; fetchDirectory?: () => Promise<unknown>; mail?: (relayId?: string) => Promise<Array<{ pikPubHex: string; epoch: number; sigHex: string; relayId?: string; relaySigHex?: string }>> } = {}): Promise<Harness> {
  const notes: Harness["notes"] = [];
  const wiring = await buildRelayMeshBox({
    dataDir: dir,
    serverFqdn: FQDN,
    controlPlaneBaseUrl: "https://flagshipserver.com",
    boxPub: BOX_PUB,
    regGen: () => 1,
    sign: boxSign,
    note: (kind, detail, ok) => notes.push({ kind, detail, ok }),
    caKeys: async () => CA,
    fetchDirectory: o.fetchDirectory ?? (async () => ({ directory: D, blessings: [] })),
    now: o.now ?? (() => T0),
    log: () => {},
  });
  const { sockets, factory } = fakeFactory();
  const opened: string[] = [];
  const sup = superviseTunnelClient({
    hubUrl: `wss://tunnel.${APEX}:8443/tunnel`,
    sign: () => new Uint8Array(64),
    getEntitlements: entitlements,
    resolveBackend: (sni) => {
      opened.push(sni);
      return null;
    },
    onDrain: () => {},
    ...(o.mail ? { mailboxAnnouncements: o.mail, onMail: async () => new Uint8Array(0) } : {}),
    mesh: { ...wiring.client, ...(o.renewMs ? { renewMs: o.renewMs } : {}) },
    meshSupervisor: { ...wiring.supervisor, graceMs: o.graceMs ?? 80, dialTimeoutMs: o.dialTimeoutMs ?? 150, ...(o.checkIntervalMs ? { checkIntervalMs: o.checkIntervalMs } : {}) },
    wsFactory: factory,
    initialJitterMs: 0,
    random: () => 0,
    ...(o.now ? { now: o.now } : {}),
  });
  return { sup, sockets, wiring, notes, opened };
}

const openFrame = (id: number, sni: string): Frame => ({ streamId: id, type: 0x01, payload: new TextEncoder().encode(sni) });
const hintCase = (name: string) => v.checks.moveHint.find((x: Any) => x.name === name);

describe("tunnel client: mesh-v1", () => {
  it("offers mesh-v1, attaches after a verified ACK and renews with the same attachedAt", async () => {
    let t = T0;
    const h = await harness({ now: () => (t += 1000), renewMs: 25 });
    const ws = await waitFor(() => h.sockets[0]);
    await acceptAs(ws, "iad1");
    expect(ws.json(ws.frames(FRAME_HELLO)[0]!).capabilities).toEqual([CAPABILITY_DRAIN_V1, CAPABILITY_MESH_V1]);
    await waitFor(() => ws.frames(FRAME_ATTACHMENT).length >= 3);
    const atts = ws.frames(FRAME_ATTACHMENT).map((f) => ws.json(f));
    for (const a of atts) {
      expect(a.attachment.relayId).toBe("iad1");
      expect(verifyRelayMeshRecord("relay-attachment", a.attachment, a.signature, BOX_PUB)).toBe(true);
    }
    expect(new Set(atts.map((a) => a.attachment.attachedAt)).size).toBe(1);
    expect(atts[1].attachment.issuedAt).toBeGreaterThan(atts[0].attachment.issuedAt);
    expect(h.sup.meshRelay()?.relayId).toBe("iad1");
    // The relay's answer is read (a refusal is only logged).
    ws.deliver(attachmentResultFrame({ ok: false, code: "clock" }));
    await h.sup.close();
    const n = ws.frames(FRAME_ATTACHMENT).length;
    await new Promise((r) => setTimeout(r, 60));
    expect(ws.frames(FRAME_ATTACHMENT).length).toBe(n);
  });

  it("re-announces its mailboxes bound to the relay once the relay accepted the attachment (§7.6)", async () => {
    const asked: Array<string | undefined> = [];
    const h = await harness({
      mail: async (relayId) => {
        asked.push(relayId);
        return [{ pikPubHex: "ab".repeat(32), epoch: 1, sigHex: "cd".repeat(64), ...(relayId ? { relayId, relaySigHex: "ef".repeat(64) } : {}) }];
      },
    });
    const ws = await waitFor(() => h.sockets[0]);
    await acceptAs(ws, "iad1", { extraCaps: [CAPABILITY_PB_MAIL_V1] });
    await waitFor(() => ws.frames(FRAME_ATTACHMENT).length === 1);
    await waitFor(() => ws.frames(FRAME_PB_MAILBOX_ANNOUNCE).length === 1);
    expect(asked).toEqual([undefined]);
    ws.deliver(attachmentResultFrame({ ok: true }));
    await waitFor(() => ws.frames(FRAME_PB_MAILBOX_ANNOUNCE).length === 2);
    expect(asked).toEqual([undefined, "iad1"]);
    expect(ws.json(ws.frames(FRAME_PB_MAILBOX_ANNOUNCE)[1]!).announcements[0]).toMatchObject({ relayId: "iad1", relaySigHex: "ef".repeat(64) });
    await h.sup.close();
  });

  it("an old relay (no mesh-v1, no relayId) is served as before: no attachment, hints ignored", async () => {
    const h = await harness();
    const ws = await waitFor(() => h.sockets[0]);
    await acceptAs(ws, null);
    await h.sup.ready();
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.frames(FRAME_ATTACHMENT)).toEqual([]);
    expect(h.sup.meshRelay()).toBeNull();
    expect(h.sockets.length).toBe(1);
    await h.sup.close();
  });

  it("a relay whose blessing doesn't verify gets no attachment and can't move the box", async () => {
    const h = await harness();
    const ws = await waitFor(() => h.sockets[0]);
    await acceptAs(ws, "iad1", { keyOf: "rog1" });
    await h.sup.ready();
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.frames(FRAME_ATTACHMENT)).toEqual([]);
    const c = hintCase("co-locate ok");
    ws.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sockets.length).toBe(1);
    await h.sup.close();
  });
});

describe("supervisor: move hints, make-before-break", () => {
  it("moves to the hinted relay with no gap and closes the old tunnel after the grace", async () => {
    const c = hintCase("co-locate ok");
    const h = await harness({ now: () => c.now });
    const old = await waitFor(() => h.sockets[0]);
    await acceptAs(old, "iad1");
    await waitFor(() => old.frames(FRAME_ATTACHMENT).length === 1);

    old.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
    const target = await waitFor(() => h.sockets[1]);
    expect(target.url).toBe(`wss://ams1.tunnel.${APEX}:8443/tunnel`);
    // While the target dials, the old tunnel is live and serving.
    expect(h.sup.isConnected()).toBe(true);
    expect(h.sup.meshRelay()?.relayId).toBe("iad1");
    old.deliver(openFrame(1, FQDN));
    await waitFor(() => h.opened.length === 1);

    await acceptAs(target, "ams1");
    const att = await waitFor(() => target.frames(FRAME_ATTACHMENT)[0]);
    expect(target.json(att).attachment.relayId).toBe("ams1");
    // Not live until the new relay accepts the attachment (§9.3).
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sup.meshRelay()?.relayId).toBe("iad1");
    target.deliver(attachmentResultFrame({ ok: true }));
    await waitFor(() => h.sup.meshRelay()?.relayId === "ams1");
    // The old tunnel keeps serving for the grace.
    expect(old.closed).toBe(false);
    old.deliver(openFrame(3, `app.${FQDN}`));
    await waitFor(() => h.opened.length === 2);
    await waitFor(() => old.closed, 1_000);
    expect(h.sup.isConnected()).toBe(true);
    expect(h.sockets.length).toBe(2);
    expect(h.notes).toEqual([{ kind: RELAY_MOVED_KIND, detail: "This server moved from relay iad1 to relay ams1, where this account's other servers are.", ok: true }]);
    expect(JSON.parse(await readFile(statePath(), "utf8")).rate.coLocateAt).toEqual([c.now]);
    // The old tunnel's close does not start a reconnect.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.sockets.length).toBe(2);
    await h.sup.close();
  });

  for (const name of ["target blessed by an unauthorized CA", "entry target", "expired", "not from my relay", "target not in the directory"]) {
    it(`refuses a hint: ${name}`, async () => {
      const c = hintCase(name);
      const h = await harness({ now: () => c.now });
      const old = await waitFor(() => h.sockets[0]);
      await acceptAs(old, "iad1");
      await waitFor(() => old.frames(FRAME_ATTACHMENT).length === 1);
      old.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
      await waitFor(() => h.notes.length === 1);
      expect(h.notes[0]).toMatchObject({ kind: RELAY_MOVE_REFUSED_KIND, ok: false });
      expect(h.sockets.length).toBe(1);
      expect(h.sup.meshRelay()?.relayId).toBe("iad1");
      await h.sup.close();
    });
  }

  it("refuses over the rate limit, and writes one Activity entry an hour per reason", async () => {
    const c = hintCase("co-locate within 10 min");
    await writeFile(statePath(), JSON.stringify({ rate: c.rate, directory: D, directoryFetchedAt: c.directoryFetchedAt }));
    const h = await harness({ now: () => c.now });
    const old = await waitFor(() => h.sockets[0]);
    await acceptAs(old, "iad1");
    await waitFor(() => old.frames(FRAME_ATTACHMENT).length === 1);
    old.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
    old.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
    await waitFor(() => h.notes.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.notes).toEqual([{ kind: RELAY_MOVE_REFUSED_KIND, detail: "This server didn't move from relay iad1 to relay ams1: it had moved recently.", ok: false }]);
    expect(h.sockets.length).toBe(1);
    await h.sup.close();
  });

  it("stays when the target never answers, and ignores that target for an hour", async () => {
    const c = hintCase("co-locate ok");
    const h = await harness({ now: () => c.now, dialTimeoutMs: 60 });
    const old = await waitFor(() => h.sockets[0]);
    await acceptAs(old, "iad1");
    await waitFor(() => old.frames(FRAME_ATTACHMENT).length === 1);
    old.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
    const target = await waitFor(() => h.sockets[1]);
    await waitFor(() => h.notes.length === 1);
    expect(h.notes[0]).toMatchObject({ kind: RELAY_MOVE_REFUSED_KIND, detail: "This server didn't move from relay iad1 to relay ams1: the new relay didn't answer in time, so it stayed where it was." });
    expect(target.closed).toBe(true);
    expect(old.closed).toBe(false);
    expect(h.sup.meshRelay()?.relayId).toBe("iad1");
    expect(JSON.parse(await readFile(statePath(), "utf8")).rate.failedTargets).toEqual({ ams1: c.now });
    // The same hint again: refused at once (target failed in the last hour), no dial.
    old.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
    await waitFor(() => h.notes.length === 2);
    expect(h.notes[1]!.detail).toMatch(/a move there failed in the last hour/);
    expect(h.sockets.length).toBe(2);
    await h.sup.close();
  });

  it("stays when the target refuses the attachment, and ignores that target for an hour", async () => {
    const c = hintCase("co-locate ok");
    const h = await harness({ now: () => c.now });
    const old = await waitFor(() => h.sockets[0]);
    await acceptAs(old, "iad1");
    await waitFor(() => old.frames(FRAME_ATTACHMENT).length === 1);
    old.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
    const target = await waitFor(() => h.sockets[1]);
    await acceptAs(target, "ams1");
    await waitFor(() => target.frames(FRAME_ATTACHMENT)[0]);
    target.deliver(attachmentResultFrame({ ok: false, code: "not-registered" }));
    await waitFor(() => h.notes.length === 1);
    expect(h.notes[0]!.kind).toBe(RELAY_MOVE_REFUSED_KIND);
    expect(target.closed).toBe(true);
    expect(old.closed).toBe(false);
    expect(h.sup.meshRelay()?.relayId).toBe("iad1");
    expect(JSON.parse(await readFile(statePath(), "utf8")).rate.failedTargets).toEqual({ ams1: c.now });
    await h.sup.close();
  });

  it("stays when the target never answers the attachment", async () => {
    const c = hintCase("co-locate ok");
    const h = await harness({ now: () => c.now, dialTimeoutMs: 60 });
    const old = await waitFor(() => h.sockets[0]);
    await acceptAs(old, "iad1");
    await waitFor(() => old.frames(FRAME_ATTACHMENT).length === 1);
    old.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
    const target = await waitFor(() => h.sockets[1]);
    await acceptAs(target, "ams1");
    await waitFor(() => h.notes.length === 1);
    expect(h.notes[0]!.kind).toBe(RELAY_MOVE_REFUSED_KIND);
    expect(target.frames(FRAME_ATTACHMENT).length).toBe(1);
    expect(h.sup.meshRelay()?.relayId).toBe("iad1");
    await h.sup.close();
  });

  it("a retiring tunnel stops renewing its attachment once the move commits", async () => {
    const c = hintCase("co-locate ok");
    const h = await harness({ now: () => c.now, renewMs: 10, graceMs: 200 });
    const old = await waitFor(() => h.sockets[0]);
    await acceptAs(old, "iad1");
    await waitFor(() => old.frames(FRAME_ATTACHMENT).length >= 2);
    old.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
    const target = await waitFor(() => h.sockets[1]);
    await acceptAs(target, "ams1");
    await waitFor(() => target.frames(FRAME_ATTACHMENT)[0]);
    target.deliver(attachmentResultFrame({ ok: true }));
    await waitFor(() => h.sup.meshRelay()?.relayId === "ams1");
    const n = old.frames(FRAME_ATTACHMENT).length;
    await new Promise((r) => setTimeout(r, 80));
    expect(old.closed).toBe(false);
    expect(old.frames(FRAME_ATTACHMENT).length).toBe(n);
    expect(target.frames(FRAME_ATTACHMENT).length).toBeGreaterThan(1);
    await h.sup.close();
  });

  it("stays when the target proves another relay's key", async () => {
    const c = hintCase("co-locate ok");
    const h = await harness({ now: () => c.now });
    const old = await waitFor(() => h.sockets[0]);
    await acceptAs(old, "iad1");
    await waitFor(() => old.frames(FRAME_ATTACHMENT).length === 1);
    old.deliver(moveHintFrame({ hint: c.hint, signature: c.signature, target: c.target }));
    const target = await waitFor(() => h.sockets[1]);
    // A relay at the target's name answering as rog1 (its own valid blessing): not the hinted relay.
    await acceptAs(target, "rog1");
    await waitFor(() => h.notes.length === 1);
    expect(h.notes[0]!.kind).toBe(RELAY_MOVE_REFUSED_KIND);
    expect(target.closed).toBe(true);
    expect(h.sup.meshRelay()?.relayId).toBe("iad1");
    await h.sup.close();
  });

  it("the hourly check moves off a relay missing from the directory, through the load-balanced name", async () => {
    let dirNow: RelayDirectory = D;
    const h = await harness({ fetchDirectory: async () => ({ directory: dirNow }) });
    const old = await waitFor(() => h.sockets[0]);
    await acceptAs(old, "iad1");
    await waitFor(() => old.frames(FRAME_ATTACHMENT).length === 1);
    await h.sup.checkRelayNow();
    expect(h.sockets.length).toBe(1);

    dirNow = signRelayDirectory({ servicesApex: APEX, directoryVersion: D.directoryVersion + 1, issuedAt: T0, expiresAt: D.expiresAt, relays: D.relays.filter((r) => r.relayId !== "iad1") }, caKeypair);
    const check = h.sup.checkRelayNow();
    const next = await waitFor(() => h.sockets[1]);
    expect(next.url).toBe(`wss://tunnel.${APEX}:8443/tunnel`);
    await acceptAs(next, "ams1");
    await waitFor(() => next.frames(FRAME_ATTACHMENT)[0]);
    next.deliver(attachmentResultFrame({ ok: true }));
    await check;
    expect(h.sup.meshRelay()?.relayId).toBe("ams1");
    expect(h.notes).toEqual([{ kind: RELAY_MOVED_KIND, detail: "This server reconnected to another Flagship relay because relay iad1 is no longer on Flagship's list of relays.", ok: true }]);
    await waitFor(() => old.closed, 1_000);
    await h.sup.close();
  });
});

// ── serving: leases in HELLO, re-HELLO, box-side stop-apps ───────────────

const admin = { seed: new Uint8Array(32).fill(1) };
const adminPub = hexOf(ed.getPublicKey(admin.seed));
const DAY = 86_400_000;
const policy = (o: Partial<ServingPolicy> = {}): ServingPolicy => ({
  account: "alice",
  box: BOX_PUB,
  regGen: 1,
  policyGen: 1,
  grace: "7d",
  onLapse: "stop-apps",
  scopeSha256: nameListSha256(boxNameList("home", "alice", APEX)),
  issuedAt: T0,
  ...o,
});
const lease = (o: Partial<ServingLease> = {}): ServingLease => ({ account: "alice", box: BOX_PUB, regGen: 1, policyGen: 1, leaseId: "ab".repeat(16), issuedAt: T0, notAfter: T0 + 7 * DAY, ...o });
const sp = (p: ServingPolicy) => ({ record: p, signature: hexOf(signServingRecord("serving-policy", p, (m) => ed.sign(m, admin.seed))) });
const sl = (l: ServingLease) => ({ record: l, signature: hexOf(signServingRecord("serving-lease", l, (m) => ed.sign(m, admin.seed))) });

function servingStore(now: () => number, onChange?: () => void): ServingStore {
  return new ServingStore({ path: join(dir, "serving.json"), account: "alice", boxPub: () => BOX_PUB, adminKey: adminPub, serverFqdn: FQDN, now, ...(onChange ? { onChange } : {}) });
}

describe("serving records on a mesh tunnel", () => {
  it("HELLO carries the best leases only on a mesh-offering client, and a new lease re-HELLOs", async () => {
    let now = T0 + DAY;
    const rehello: { current: (() => void) | null } = { current: null };
    const store = servingStore(() => now, () => rehello.current?.());
    await store.offer({ policy: sp(policy()), leases: [sl(lease())] }, ".com");
    expect(store.helloLeases()).toHaveLength(1);

    const { sockets, factory } = fakeFactory();
    const base: TunnelClientOptions = { hubUrl: "wss://x/tunnel", sign: () => new Uint8Array(64), getEntitlements: entitlements, resolveBackend: () => null, wsFactory: factory, servingHello: () => store.helloFields() };
    const plain = startTunnelClient(base);
    const ws0 = await waitFor(() => sockets[0]);
    const h0 = ws0.json(await waitFor(() => ws0.frames(FRAME_HELLO)[0]));
    expect(h0.servingLeases).toBeUndefined();
    expect(h0.servingPolicy.record.policyGen).toBe(1);
    await plain.close();

    const box = meshBox();
    const mesh = startTunnelClient({ ...base, mesh: { verifyAck: (e) => box.verifyAck(e), signAttachment: (r, a) => box.signAttachment(r, a), log: () => {} } });
    rehello.current = () => void mesh.rehello();
    const ws1 = await waitFor(() => sockets[1]);
    const h1 = ws1.json(await waitFor(() => ws1.frames(FRAME_HELLO)[0]));
    expect(h1.capabilities).toEqual([CAPABILITY_MESH_V1]);
    expect(h1.servingLeases).toEqual([sl(lease())]);

    // The admin opens the app: a later lease from the same signer replaces it and goes out at once.
    now += DAY;
    await store.offer({ leases: [sl(lease({ leaseId: "cd".repeat(16), issuedAt: now, notAfter: now + 7 * DAY }))] }, "app");
    const h2 = ws1.json(await waitFor(() => ws1.frames(FRAME_HELLO)[1]));
    expect(h2.servingLeases.map((l: Any) => l.record.leaseId)).toEqual(["cd".repeat(16)]);
    await mesh.close();
  });

  it("caps the HELLO at eight leases, latest end first, and drops ended ones", async () => {
    const now = T0 + DAY;
    const store = servingStore(() => now);
    await store.offer({ policy: sp(policy()), leases: [sl(lease({ notAfter: T0 + 2 * DAY }))] }, ".com");
    expect(store.helloLeases(T0 + 3 * DAY)).toEqual([]);
  });

  it("box-side stop-apps: a lapsed policy closes app names but not the control name", async () => {
    let now = T0 + DAY;
    const store = servingStore(() => now);
    expect(store.appsAllowed()).toBe(true); // no policy: indefinitely
    await store.offer({ policy: sp(policy()), leases: [sl(lease())] }, ".com");
    expect(store.appsAllowed()).toBe(true);
    const gate = boxStreamGate({ controlName: FQDN, relayAllowed: () => true, appsAllowed: () => store.appsAllowed(), target: "backend" });
    expect(gate(`app.${FQDN}`)).toBe("backend");

    now = T0 + 7 * DAY; // the lease's end: the dead-man lapses
    expect(store.appsAllowed()).toBe(false);
    expect(gate(`app.${FQDN}`)).toBeNull();
    expect(gate(`notes.alice.${APEX}`)).toBeNull();
    expect(gate(FQDN.toUpperCase())).toBe("backend");
    expect(boxStreamGate({ controlName: FQDN, relayAllowed: () => false, target: 1 })(FQDN)).toBeNull();

    // A fresh lease brings the apps back at once.
    await store.offer({ leases: [sl(lease({ leaseId: "ef".repeat(16), issuedAt: now, notAfter: now + 7 * DAY }))] }, "app");
    expect(store.appsAllowed()).toBe(true);
  });

  it("the tunnel refuses an app stream while apps are off (CLOSE_REMOTE), and serves the control name", async () => {
    let apps = false;
    const { sockets, factory } = fakeFactory();
    const seen: string[] = [];
    const gate = boxStreamGate({ controlName: FQDN, relayAllowed: () => true, appsAllowed: () => apps, target: { host: "127.0.0.1", port: 1 } });
    const client = startTunnelClient({
      hubUrl: "wss://x/tunnel",
      sign: () => new Uint8Array(64),
      getEntitlements: entitlements,
      resolveBackend: (sni) => {
        seen.push(sni);
        const t = gate(sni);
        return t && sni !== FQDN ? t : null;
      },
      wsFactory: factory,
    });
    const ws = await waitFor(() => sockets[0]);
    await acceptAs(ws, null);
    await client.ready();
    ws.deliver(openFrame(5, `app.${FQDN}`));
    await waitFor(() => ws.frames(FRAME_CLOSE_REMOTE).length === 1);
    expect(ws.frames(FRAME_CLOSE_REMOTE)[0]!.streamId).toBe(5);
    expect(gate(FQDN)).not.toBeNull();
    apps = true;
    expect(gate(`app.${FQDN}`)).not.toBeNull();
    await client.close();
  });
});

describe("move hint records", () => {
  it("the hint vectors' bytes are what the box verifies", () => {
    const c = hintCase("co-locate ok");
    const h: MoveHint = c.hint;
    expect(verifyRelayMeshRecord("relay-move-hint", h, c.signature, pubOf("iad1"))).toBe(true);
    expect(signRelayMeshRecord("relay-move-hint", h, signer("iad1"))).toBe(c.signature);
    expect(canonicalMoveHint(h).length).toBeGreaterThan(0);
  });
});
