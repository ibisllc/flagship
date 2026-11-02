/**
 * Relay mesh conformance (docs/architecture-v2/relay-mesh.md §14.2, MESH01-MESH13): three relays in one mesh with mixed
 * runtimes, `ra`+`rb`+`rc` as TS+TS+Rust and Rust+Rust+TS, so every scenario that names an entry and a holder runs
 * TS→TS, TS→Rust, Rust→TS and Rust→Rust. Both relays read the same mock `.com` (mesh.ts): the relay log sealed to the
 * mesh key, the CA-signed directory, blessings issued with proof of possession. A harness peer (`aa-obs`, an admitted
 * `entry` relay; it sorts first, so it dials and is never dialled) watches announcements and queries and forges what
 * a rogue relay would. MESH13 is the existing suite (relayConformance.test.ts) with the mesh off; here it is the
 * mesh-off relay's own answers to mesh traffic.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountHash,
  canonicalPbMailboxAnnounce,
  ed,
  pbMailboxEpoch,
  pbMailboxId,
  phoneLedgerRanking,
  signDeviceCapabilityGrant,
  signRelayMeshRecord,
  verifyRelayMeshRecord,
  type BoxAttachment,
  type Keypair,
  type MoveHint,
  type ServingPolicy,
} from "@flagship/protocol";
import { checkMoveHint, emptyMoveHintRateState, recordMoveHint } from "@flagship/protocol";
import { FRAME_CLOSE, FRAME_DATA, FRAME_OPEN, mailboxAnnounceFrame } from "@flagship/tunnel-protocol";
import { SimPhone } from "../../live-e2e/lib/phoneSim.js";
import { lease, policy, type Ed } from "../../../apps/web/tests/support/serving.js";
import { superviseTunnelClient } from "../../../packages/server-daemon/src/tunnel/tunnelClient.js";
import { RelayMeshBox } from "../../../packages/server-daemon/src/tunnel/relayMesh.js";
import { rustAvailable, httpPost, clientHello, Visitor } from "../harness.js";
import {
  APEX,
  bulkReply,
  HOLD_MS,
  hex,
  joinAs,
  key,
  launchMesh,
  MeshBox,
  MeshCom,
  meshStats,
  PeerSim,
  reaches,
  rejectedFrom,
  sleep,
  stopMesh,
  visit,
  waitFor,
  waitMeshReady,
  waitReaches,
  health,
  implStarter,
  type Impl,
  type MeshRelay,
} from "../mesh.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer, type Server as NetServer } from "node:net";

const RUST = rustAvailable();
const CONFIGS: Array<{ name: string; layout: Array<{ relayId: string; impl: Impl }> }> = RUST
  ? [
      { name: "ts+ts+rust", layout: [{ relayId: "ra", impl: "ts" }, { relayId: "rb", impl: "ts" }, { relayId: "rc", impl: "rust" }] },
      { name: "rust+rust+ts", layout: [{ relayId: "ra", impl: "rust" }, { relayId: "rb", impl: "rust" }, { relayId: "rc", impl: "ts" }] },
    ]
  : [{ name: "ts+ts+ts (no Rust toolchain: the mixed meshes are skipped)", layout: [{ relayId: "ra", impl: "ts" }, { relayId: "rb", impl: "ts" }, { relayId: "rc", impl: "ts" }] }];

const IDS = ["ra", "rb", "rc"] as const;
const PAIRS: Array<[string, string]> = IDS.flatMap((e) => IDS.filter((h) => h !== e).map((h) => [e, h] as [string, string]));
const TOLERANCE_MS = 250;

let n = 0;
const uniq = (p: string) => `${p}${++n}`;

function adminGrant(device: Uint8Array, account: string, signer: Keypair) {
  const now = Date.now();
  const grantId = hex(crypto.getRandomValues(new Uint8Array(32)));
  const g = { grantId, username: account, deviceId: hex(device).slice(32), devicePubKey: ed.getPublicKey(device), scopes: ["admin"] as never, issuedAt: now - 60_000, expiresAt: now + 30 * 86_400_000 };
  const signatureHex = hex(signDeviceCapabilityGrant(g, signer));
  return { grant: { grantId, username: account, deviceId: g.deviceId, devicePubHex: hex(g.devicePubKey), scopes: ["admin"], issuedAt: g.issuedAt, expiresAt: g.expiresAt }, signatureHex, signerRoot: "admin-root" };
}

for (const cfg of CONFIGS) {
  describe(`relay mesh conformance: ${cfg.name}`, () => {
    const com = new MeshCom();
    let relays: Map<string, MeshRelay> | null = null;
    const R = (id: string): MeshRelay => relays!.get(id)!;
    const label = (id: string) => `${id}/${R(id).impl}`;
    const boxes: MeshBox[] = [];
    const sims: PeerSim[] = [];
    const mk = (b: MeshBox) => (boxes.push(b), b);
    const peer = async (on: string, as = "aa-obs") => {
      const s = await joinAs(com, R(on), as);
      sims.push(s);
      return s;
    };
    /** Every relay has applied the log up to `.com`'s tip (its `/api/stats` sequence). */
    const synced = () =>
      waitFor(
        async () => (await Promise.all(IDS.map(async (id) => Number(((await meshStats(R(id))).state as { sequence?: number } | undefined)?.sequence ?? ((await meshStats(R(id))).feed as { sequence?: number } | undefined)?.sequence ?? -1)))).every((s) => s >= com.entries.length),
        8_000,
        "every relay applied the log",
      );
    const attached = async (b: MeshBox, on: string) => {
      const ack = await b.connect(R(on));
      expect(ack.ok, `${b.label} HELLO on ${label(on)}: ${ack.reason}`).toBe(true);
      expect(await b.attach()).toEqual({ ok: true });
      return ack;
    };

    beforeAll(async () => {
      com.admit("aa-obs", "entry", "iad");
      com.admit("ab-gone", "full", "iad");
      com.retire("ab-gone");
      for (const l of cfg.layout) com.admit(l.relayId, "full", l.relayId === "rc" ? "ams" : "iad");
      await com.start();
      relays = await launchMesh(com, cfg.layout, { rebalanceMs: 30_000 });
    }, 120_000);

    afterAll(async () => {
      for (const s of sims) s.close();
      for (const b of boxes) b.raw?.close();
      await stopMesh(relays);
      await com.stop();
    }, 30_000);

    it("blessings were issued only with proof of the relay key, with the mesh keys sealed to each relay", () => {
      for (const id of IDS) expect(com.blessingRequests.some((r) => r.relayId === id && r.status === 200)).toBe(true);
      expect(com.blessingRequests.filter((r) => r.status !== 200)).toEqual([]);
      // The feed is sealed under epoch 2 (ab-gone's retirement rotated it): every relay opened it.
      expect(com.current).toBe(2);
    });

    it("MESH01 bridge handshake: good; wrong peer; unblessed key; expired blessing; not in directory; revoked relay; stale at", async () => {
      const obs = com.specs.get("aa-obs")!;
      const gone = com.specs.get("ab-gone")!;
      const stranger = { relayId: "ac-stranger", ...(() => { const k = key(); return { key: k, pub: hex(k.publicKey) }; })(), kind: "full" as const };
      const other = key();
      for (const id of IDS) {
        const r = R(id);
        const good = await PeerSim.dial(r, { relayId: "aa-obs", key: obs.key, blessing: com.relayBlessings.get("aa-obs")! });
        expect(good.authed, `${label(id)} accepts a good handshake`).toBe(true);
        const sa = good.serverAuth! as { relayId: string; peer: string; nonce: string; at: number; sig: string };
        expect(sa).toMatchObject({ type: "mesh-auth", v: 1, relayId: id, peer: "aa-obs" });
        good.close();
        const cases: Array<[string, Parameters<typeof PeerSim.dial>[1], string]> = [
          ["wrong peer", { relayId: "aa-obs", key: obs.key, blessing: com.relayBlessings.get("aa-obs")!, peer: id === "ra" ? "rb" : "ra" }, "wrong-peer"],
          ["unblessed key (blessing by a non-CA key)", { relayId: "aa-obs", key: obs.key, blessing: com.bless(obs, { ca: other }) }, "bad-blessing"],
          ["a key the directory does not list for it", { relayId: "aa-obs", key: other, blessing: com.bless({ relayId: "aa-obs", pub: hex(other.publicKey), kind: "entry" }) }, "not-in-directory"],
          ["expired blessing", { relayId: "aa-obs", key: obs.key, blessing: com.bless(obs, { issuedAt: Date.now() - 3 * 86_400_000, expiresAt: Date.now() - 60_000 }) }, "bad-blessing"],
          ["not in directory", { relayId: stranger.relayId, key: stranger.key, blessing: com.bless(stranger) }, "not-in-directory"],
          ["revoked relay", { relayId: "ab-gone", key: gone.key, blessing: com.bless(gone) }, "revoked"],
          ["stale at", { relayId: "aa-obs", key: obs.key, blessing: com.relayBlessings.get("aa-obs")!, at: Date.now() - 120_000 }, "stale"],
          ["signature by another key", { relayId: "aa-obs", key: obs.key, blessing: com.relayBlessings.get("aa-obs")!, signWith: other }, "bad-signature"],
          ["no blessing and none held for it", { relayId: stranger.relayId, key: stranger.key, blessing: null }, "bad-blessing"],
        ];
        for (const [what, o, reason] of cases) {
          const s = await PeerSim.dial(r, o);
          await Promise.race([s.closed, sleep(3_000)]);
          expect(s.closeInfo, `${label(id)}: ${what}`).toEqual({ code: 4401, reason });
        }
      }
    });

    it("MESH02 attachment checks at the holder and at peers; precedence; a withdrawal by another relay is ignored", async () => {
      const a = com.account(uniq("att"));
      const b = mk(new MeshBox(com.box(a, "home"), "ATT"));
      const thief = key();
      await synced();
      await b.connect(R("ra"));
      // The holder's checks, answered on the ATTACHMENT frame.
      const now = Date.now();
      expect(await b.attach({}, thief)).toEqual({ ok: false, code: "mismatch" });
      expect(await b.attach({ regGen: 2 })).toEqual({ ok: false, code: "mismatch" });
      expect(await b.attach({ relayId: "rb" })).toEqual({ ok: false, code: "mismatch" });
      expect(await b.attach({ issuedAt: now + 5 * 60_000, notAfter: now + 20 * 60_000 })).toEqual({ ok: false, code: "clock" });
      expect(await b.attach({ notAfter: now + 31 * 60_000 })).toEqual({ ok: false, code: "mismatch" });
      expect(await b.attach()).toEqual({ ok: true });
      for (const id of ["rb", "rc"]) await waitReaches(R(id), b.pod, "ATT");
      // Items announced by a peer (aa-obs) are verified by every receiver: each bad one is dropped and counted.
      const obsOn = await Promise.all(IDS.map((id) => peer(id)));
      const ghost = com.box(a, "ghost");
      com.append({ kind: "box-revoke", boxPub: hex(ghost.stk.publicKey), regGen: 1 });
      const unreg = { ...b.id, pod: `nobody.${a.username}.${APEX}` };
      await synced();
      const item = (o: Partial<BoxAttachment>, signer: Keypair = b.id.stk) => {
        const t = Date.now();
        const at: BoxAttachment = { serverFqdn: b.pod, boxPub: b.boxPub, regGen: 1, relayId: "aa-obs", attachedAt: t, issuedAt: t, notAfter: t + 10 * 60_000, ...o };
        return { kind: "box", attachment: at, signature: signRelayMeshRecord("relay-attachment", at, (m) => ed.sign(m, signer.privateKey)) };
      };
      const bad = [
        item({}, thief), // bad signature
        item({ serverFqdn: unreg.pod }), // unregistered name
        item({ regGen: 2 }), // wrong regGen
        item({ serverFqdn: ghost.pod, boxPub: hex(ghost.stk.publicKey) }, ghost.stk), // revoked
        item({ issuedAt: Date.now() + 5 * 60_000, notAfter: Date.now() + 10 * 60_000 }), // future issuedAt
        item({ notAfter: Date.now() + 31 * 60_000 }), // TTL too long
      ];
      for (const [i, id] of IDS.entries()) {
        const before = await rejectedFrom(R(id), "aa-obs");
        obsOn[i]!.send({ type: "announce", items: bad });
        await waitFor(async () => (await rejectedFrom(R(id), "aa-obs")) >= before + bad.length, 3_000, `${label(id)} rejected all ${bad.length} bad items`);
        expect(await reaches(R(id), b.pod, "ATT")).toBe(true);
      }
      // A withdrawal of ra's item signed by another relay (aa-obs) is ignored everywhere.
      const w = { subjectKind: "box" as const, subject: b.pod, relayId: "ra", withdrawnIssuedAt: Date.now(), at: Date.now() };
      const wsig = signRelayMeshRecord("relay-withdraw", w, (m) => ed.sign(m, com.specs.get("aa-obs")!.key.privateKey));
      for (const s of obsOn) s.send({ type: "withdraw", items: [{ withdraw: w, signature: wsig }] });
      await sleep(500);
      for (const id of ["rb", "rc"]) expect(await reaches(R(id), b.pod, "ATT"), `${label(id)} ignores a foreign withdrawal`).toBe(true);
      for (const s of obsOn) s.close();
      // Precedence: the same box attaches on rc later: the newer attachment wins on every relay.
      const b2 = mk(new MeshBox(b.id, "ATT2"));
      await attached(b2, "rc");
      for (const id of ["ra", "rb"]) await waitReaches(R(id), b.pod, "ATT2");
      b.close();
      b2.close();
    });

    it("MESH03 cross-relay forward for every (entry, holder) pair: ClientHello and a 70 KB reply verbatim both ways; closes both ways; credit honoured", async () => {
      for (const [entry, holder] of PAIRS) {
        const a = com.account(uniq("fw"));
        const tag = `FW-${entry}-${holder}`;
        const b = mk(new MeshBox(com.box(a, "home"), tag, { mode: "bulk" }));
        await synced();
        await attached(b, holder);
        await waitFor(async () => (await visit(R(entry), b.pod, 800)).text.startsWith(`${tag}|`), 8_000, `${tag}: announced`);
        // A visitor: ClientHello, then 70 KB; the box answers 70 KB after the ClientHello.
        const hello = clientHello(b.pod);
        const upload = Buffer.alloc(70_000, 0x5a);
        const v = await Visitor.open(R(entry).ports.sni, hello);
        const want = bulkReply(tag);
        await waitFor(() => v.received.length >= want.length, 8_000, `${tag}: reply`);
        expect(Buffer.compare(v.received, want), `${tag}: reply verbatim`).toBe(0);
        v.write(upload);
        const s = [...b.streams.values()].filter((x) => x.received.subarray(0, hello.length).equals(Buffer.from(hello))).pop()!;
        await waitFor(() => s.received.length >= hello.length + upload.length, 8_000, `${tag}: upload`);
        expect(Buffer.compare(s.received, Buffer.concat([Buffer.from(hello), upload])), `${tag}: ClientHello and upload verbatim`).toBe(0);
        // The box closes: the visitor's socket ends.
        b.closeStream(s.id);
        await Promise.race([v.done, sleep(5_000)]);
        expect(v.ended, `${tag}: box close reaches the visitor`).toBe(true);
        // The visitor closes: the box gets CLOSE.
        const v2 = await Visitor.open(R(entry).ports.sni, clientHello(b.pod));
        await waitFor(() => v2.received.length >= want.length, 8_000, `${tag}: second reply`);
        const s2 = [...b.streams.values()].pop()!;
        v2.end();
        await waitFor(() => b.raw.frames.some((f) => f.type === FRAME_CLOSE && f.streamId === s2.id), 5_000, `${tag}: visitor close reaches the box`);
        b.close();
      }
      // Credit: 1 MiB in each direction over one bridge (four times the 256 KiB window) arrives whole.
      const a = com.account(uniq("credit"));
      const b = mk(new MeshBox(com.box(a, "home"), "CR"));
      await synced();
      await attached(b, "rc");
      await waitReaches(R("ra"), b.pod, "CR");
      const big = Buffer.alloc(1024 * 1024, 7);
      const v = await Visitor.open(R("ra").ports.sni, Buffer.concat([Buffer.from(clientHello(b.pod)), big]));
      // The echo box answers every chunk `CR:<chunk>`: everything sent comes back with one prefix per chunk.
      await waitFor(() => v.received.length >= big.length + clientHello(b.pod).length, 15_000, "1 MiB echoed through the bridge");
      v.sock.destroy();
      b.close();
    }, 180_000);

    it("MESH04 query on a miss; negative cache; inbound query limit answers busy; no query for a name absent from the log", async () => {
      for (const id of IDS) {
        const sim = await peer(id);
        const a = com.account(uniq("q"));
        const off = com.box(a, "offline");
        await synced();
        // Registered, held nowhere: the entry asks its peers (aa-obs among them).
        const from = sim.msgs.length;
        const r = await visit(R(id), off.pod, HOLD_MS + 1_500);
        expect(r.text).toBe("");
        const q = await sim.next((m) => m.type === "query" && m.name === off.pod, 1_000, from);
        expect(q.qid, `${label(id)} queried with a qid`).toBeDefined();
        // Again within 10 s: the negative cache answers, no new query.
        const from2 = sim.msgs.length;
        await visit(R(id), off.pod, HOLD_MS + 1_000);
        expect(sim.msgs.slice(from2).some((m) => m.type === "query" && m.name === off.pod), `${label(id)} negative cache`).toBe(false);
        // A name the log does not have: no query at all.
        const from3 = sim.msgs.length;
        await visit(R(id), `nobody.${a.username}.${APEX}`, HOLD_MS + 1_000);
        expect(sim.msgs.slice(from3).some((m) => m.type === "query"), `${label(id)} queries no unknown name`).toBe(false);
        // 1,500 queries at once from one peer: past the burst (1,000) the answer is busy.
        const from4 = sim.msgs.length;
        for (let i = 0; i < 1_500; i++) sim.send({ type: "query", qid: `f${i}`, name: off.pod });
        await waitFor(() => sim.msgs.slice(from4).filter((m) => m.type === "answer").length >= 1_500, 10_000, `${label(id)} answered every query`);
        const answers = sim.msgs.slice(from4).filter((m) => m.type === "answer");
        expect(answers.filter((m) => m.busy === true).length, `${label(id)} busy past the burst`).toBeGreaterThanOrEqual(400);
        expect(answers.filter((m) => m.busy !== true).length, `${label(id)} answers within the burst`).toBeGreaterThanOrEqual(1_000);
        sim.close();
      }
    }, 120_000);

    it("MESH05 one hop: a bridged OPEN for a name not held here is refused not-holder and never forwarded on; no hop is refused hop", async () => {
      const a = com.account(uniq("hop"));
      const b = mk(new MeshBox(com.box(a, "home"), "HOP"));
      await synced();
      await attached(b, "rb");
      await waitReaches(R("ra"), b.pod, "HOP");
      for (const id of ["ra", "rc"]) {
        const sim = await peer(id);
        const before = b.streams.size;
        const sid = sim.open(b.pod);
        const refusal = await sim.next((m) => m.type === "refuse" && m.stream === sid, 3_000);
        expect(refusal.code, `${label(id)} refuses a name held by rb`).toBe("not-holder");
        await waitFor(() => sim.frames.some((f) => f.type === FRAME_CLOSE && f.streamId === sid), 3_000, "CLOSE after refuse");
        expect(b.streams.size, `${label(id)} never forwarded it to rb`).toBe(before);
        const sid2 = sim.open(b.pod, { sni: b.pod, kind: "tls" });
        expect((await sim.next((m) => m.type === "refuse" && m.stream === sid2, 3_000)).code).toBe("hop");
        sim.close();
      }
      // The holder serves a bridged OPEN for its own box; the bytes are the box's.
      const simB = await peer("rb");
      const sid = simB.open(b.pod);
      await waitFor(() => simB.frames.some((f) => f.type === FRAME_DATA && f.streamId === sid), 3_000, "holder answered");
      simB.close();
      // The entry re-queries once: aa-obs claims the box with a valid box-signed attachment, then refuses not-holder;
      // ra drops that item, asks again (excluding aa-obs), and the visitor reaches the real holder.
      const sim = await peer("ra");
      const t = Date.now();
      const at: BoxAttachment = { serverFqdn: b.pod, boxPub: b.boxPub, regGen: 1, relayId: "aa-obs", attachedAt: t, issuedAt: t, notAfter: t + 10 * 60_000 };
      sim.queryAnswer = () => [];
      sim.send({ type: "announce", items: [{ kind: "box", attachment: at, signature: signRelayMeshRecord("relay-attachment", at, (m) => ed.sign(m, b.id.stk.privateKey)) }] });
      const v = visit(R("ra"), b.pod, 4_000);
      // aa-obs refuses whatever ra forwards to it.
      let forwardedToObs = false;
      const refuser = setInterval(() => {
        for (const f of sim.frames.splice(0)) {
          if (f.type !== FRAME_OPEN) continue;
          sim.send({ type: "refuse", stream: f.streamId, code: "not-holder" });
          sim.sendFrame({ streamId: f.streamId, type: FRAME_CLOSE, payload: new Uint8Array(0) });
          forwardedToObs = true;
        }
      }, 10);
      const got = await v;
      clearInterval(refuser);
      // Either ra took aa-obs's newer claim, was refused, re-queried and reached rb; or it kept rb's attachment
      // (an entry relay holds no tunnels): the visitor reaches the box both ways.
      expect(got.text.startsWith("HOP:"), `${label("ra")} (forwarded to aa-obs first: ${forwardedToObs})`).toBe(true);
      sim.close();
      b.close();
    });

    it("MESH06 move hint: a real mesh box (the daemon's client) follows a co-locate hint make-before-break; tampered hints are refused by the box", async () => {
      // The account's home is rc (its first box); a second box lands on ra and is hinted to co-locate.
      const a = com.account(uniq("mv"));
      const first = mk(new MeshBox(com.box(a, "home"), "MV1"));
      const second = com.box(a, "cabin");
      await synced();
      await attached(first, "rc");
      for (const id of ["ra", "rb"]) await waitReaches(R(id), first.pod, "MV1");
      const backend: NetServer = createNetServer((s) => s.on("data", (d) => s.write(Buffer.concat([Buffer.from("MV2:"), d]))));
      await new Promise<void>((r) => backend.listen(0, "127.0.0.1", () => r()));
      const port = (backend.address() as { port: number }).port;
      const portOf = new Map(IDS.map((id) => [`${id}.tunnel.${APEX}`, R(id).ports.hub]));
      const mb = new RelayMeshBox({
        serverFqdn: second.pod,
        servicesApex: APEX,
        boxPub: hex(second.stk.publicKey),
        regGen: () => 1,
        sign: (m) => ed.sign(m, second.stk.privateKey),
        caKeys: async () => [com.caPub],
        fetchDirectory: async () => ({ directory: com.directory, blessings: [...com.relayBlessings.values()] }),
        statePath: join(mkdtempSync(join(tmpdir(), "mesh06-")), "relay-mesh.json"),
        log: () => undefined,
      });
      await mb.load();
      const hints: unknown[] = [];
      const moved: string[] = [];
      const client = superviseTunnelClient({
        hubUrl: `ws://127.0.0.1:${R("ra").ports.hub}/tunnel`,
        signingKey: second.stk,
        getEntitlements: async () => {
          const { mintDevEntitlements } = await import("@flagship/protocol");
          return mintDevEntitlements({ irk: a.irk, podPubKey: second.stk.publicKey, username: a.username, podCanonical: second.pod, serviceCanonicals: [second.pod] });
        },
        resolveBackend: () => ({ host: "127.0.0.1", port }),
        servingHello: () => ({ servingAdminKey: hex(a.irk.publicKey), servingPolicy: null }),
        mesh: { verifyAck: (e) => mb.verifyAck(e), signAttachment: (r, t) => mb.signAttachment(r, t), log: () => undefined },
        meshSupervisor: {
          checkHint: async (p, cur) => {
            const r = await mb.checkHint(p, cur);
            if (!r.ok) return r;
            const host = r.target.url.replace(/^wss:\/\//, "").split(":")[0]!;
            return { ok: true, target: { ...r.target, url: `ws://127.0.0.1:${portOf.get(host)}/tunnel` } };
          },
          checkRelay: (c) => mb.checkRelay(c),
          recordMove: (reason) => mb.recordMove(reason),
          recordFailed: (id) => mb.recordFailed(id),
          onMoved: (e) => void moved.push(`${e.from}->${e.to}:${e.reason}`),
          graceMs: 500,
        },
        initialJitterMs: 0,
        baseReconnectMs: 100,
        maxReconnectMs: 400,
        keepAliveIntervalMs: 1_000,
      } as Parameters<typeof superviseTunnelClient>[0]);
      try {
        await client.ready();
        await waitFor(() => moved.length > 0, 10_000, `the box moved (hints seen: ${hints.length})`);
        expect(moved[0]).toBe("ra->rc:co-locate");
        for (const id of IDS) {
          await waitFor(async () => (await visit(R(id), second.pod, 1_000)).text.startsWith("MV2:"), 8_000, `${second.pod} through ${label(id)} after the move`);
        }
      } finally {
        client.close();
        await new Promise<void>((r) => backend.close(() => r()));
      }
      // The relay's hint, checked by the box's own rules (chunk A checkMoveHint) with tampered fields: refused.
      const raw = mk(new MeshBox(second, "MV3"));
      await attached(raw, "rb");
      await waitFor(() => raw.hints.length > 0, 8_000, "co-locate hint from rb");
      const h = raw.hints[0]!;
      const hint = h.hint as unknown as MoveHint;
      expect(hint).toMatchObject({ reason: "co-locate", fromRelayId: "rb", toRelayId: "rc", serverFqdn: second.pod });
      expect(verifyRelayMeshRecord("relay-move-hint", hint, h.signature, com.specs.get("rb")!.pub), "signed by rb's relay key").toBe(true);
      const now = Date.now();
      const rbPub = com.specs.get("rb")!.pub;
      const base = {
        hint,
        signature: h.signature,
        target: h.target as never,
        box: { serverFqdn: second.pod, boxPub: hex(second.stk.publicKey), servicesApex: APEX },
        current: { relayId: "rb", relayKey: rbPub },
        directory: com.directory,
        directoryFetchedAt: now,
        caKeys: [com.caPub],
        rate: emptyMoveHintRateState(),
        now,
      };
      expect(checkMoveHint(base)).toEqual({ ok: true });
      const tampered: Array<[typeof base, string]> = [
        [{ ...base, current: { relayId: "ra", relayKey: com.specs.get("ra")!.pub } }, "wrong-from"],
        [{ ...base, target: com.bless(com.specs.get("rc")!, { ca: key() }) as never }, "bad-target"],
        [{ ...base, rate: recordMoveHint(emptyMoveHintRateState(), "co-locate", now) }, "rate-limited"],
      ];
      for (const [t, why] of tampered) expect(checkMoveHint(t)).toEqual({ ok: false, reason: why });
      raw.close();
    }, 60_000);

    it("MESH07 account home: the shortened name is answered by one box from every entry; no ping-pong after the move", async () => {
      const a = com.account(uniq("home"));
      const app = `notes.${a.username}.${APEX}`;
      const h1 = mk(new MeshBox(com.box(a, "home", ["notes"]), "H1"));
      const h2 = mk(new MeshBox(com.box(a, "cabin", ["notes"]), "H2"));
      await synced();
      await attached(h1, "rb");
      for (const id of ["ra", "rc"]) await waitReaches(R(id), h1.pod, "H1");
      await attached(h2, "rc");
      await waitFor(() => h2.hints.length > 0, 8_000, "co-locate hint");
      expect(h2.hints[0]!.hint).toMatchObject({ reason: "co-locate", fromRelayId: "rc", toRelayId: "rb" });
      await h2.moveTo(R("rb"));
      await sleep(1_500);
      const seen = new Set<string>();
      for (const id of IDS) {
        const t = (await visit(R(id), app, 1_500)).text;
        expect(t.startsWith("H1:") || t.startsWith("H2:"), `${app} through ${label(id)}: ${JSON.stringify(t.slice(0, 20))}`).toBe(true);
        seen.add(t.slice(0, 3));
      }
      // Nobody tells the boxes at the home to go anywhere.
      await sleep(1_500);
      expect(h1.hints.length, "no hint to the home's boxes").toBe(0);
      // FLAGSHIP_MESH_MIN_MOVE_MS=0 lets rc repeat its co-locate hint until the box leaves; at the home, none.
      expect(h2.hintTunnels.filter((t) => t === h2.raw).length, "no hint once the box is at the home").toBe(0);
      h1.close();
      h2.close();
    });

    it("MESH08 phone: the ledger relay ranks first; a claim through P is granted by L; vacancy across relays; eligibility revocation closes 4403", async () => {
      const a = com.account(uniq("ph"));
      const admin = key();
      com.append({ kind: "account-authority", accountHash: accountHash(a.username), adminRootPub: hex(admin.publicKey), irkPub: hex(a.irk.publicKey), authorityGen: 2 });
      await synced();
      const rank = phoneLedgerRanking(a.username, com.directory, null);
      expect(rank.length).toBe(3);
      const L = rank[0]!;
      const P = IDS.find((x) => x !== L)!;
      const Q = IDS.find((x) => x !== L && x !== P)!;
      const step = <T,>(what: string, p: Promise<T>): Promise<T> => p.catch((e: Error) => { throw new Error(`${what} (P ${label(P)}, L ${label(L)}, Q ${label(Q)}): ${e.message} [L logs: ${R(L).target.logs.slice(-12).join(" | ")}]`); });
      const bare = `${a.username}.${APEX}`;
      const seedA = crypto.getRandomValues(new Uint8Array(32));
      const seedB = crypto.getRandomValues(new Uint8Array(32));
      const gA = adminGrant(seedA, a.username, admin);
      const gB = adminGrant(seedB, a.username, admin);
      const pa = await SimPhone.connect(`ws://127.0.0.1:${R(P).ports.hub}/phone-tunnel`, { account: a.username, seed: seedA, label: "PA" });
      pa.send({ type: "begin", account: a.username, grants: [gA] });
      const ch = await step("PA challenge", pa.next((m) => m.type === "challenge" || m.type === "refused"));
      expect(ch.type, `begin on ${label(P)} (ledger ${label(L)}): ${JSON.stringify(ch)}`).toBe("challenge");
      expect(await step("PA claim", pa.sendClaim(pa.sign(ch)))).toMatchObject({ type: "granted" });
      for (const id of IDS) await waitFor(async () => (await visit(R(id), bare, 1_200)).text.startsWith("PA:"), 8_000, `${bare} through ${label(id)}`);
      // A second phone on Q: route-held; a phone without grants is not eligible.
      const pb = await SimPhone.connect(`ws://127.0.0.1:${R(Q).ports.hub}/phone-tunnel`, { account: a.username, seed: seedB, label: "PB" });
      pb.send({ type: "begin", account: a.username, grants: [gB] });
      const ch2 = await step("PB challenge", pb.next((m) => m.type === "challenge" || m.type === "refused"));
      expect(ch2.type).toBe("challenge");
      expect(await step("PB claim (held)", pb.sendClaim(pb.sign(ch2)))).toMatchObject({ type: "refused", code: "route-held" });
      const pc = await SimPhone.connect(`ws://127.0.0.1:${R(L).ports.hub}/phone-tunnel`, { account: a.username, seed: seedB, label: "PC" });
      expect(await step("PC acquire", pc.acquire())).toMatchObject({ type: "refused", code: "not-eligible" });
      pc.close();
      // The holder leaves: the vacancy reaches the standby on another relay, which claims.
      pa.close();
      await step("PB route-vacant", pb.next((m) => m.type === "route-vacant", 8_000));
      pb.send({ type: "begin", account: a.username, grants: [gB] });
      const ch3 = await step("PB challenge 2", pb.next((m) => m.type === "challenge" || m.type === "refused"));
      expect(await step("PB claim 2", pb.sendClaim(pb.sign(ch3)))).toMatchObject({ type: "granted" });
      for (const id of IDS) await waitFor(async () => (await visit(R(id), bare, 1_200)).text.startsWith("PB:"), 8_000, `${bare} through ${label(id)} after the vacancy`);
      // The holder's grant revoked in the log: its tunnel closes 4403.
      com.append({ kind: "device-grant-revoke", grantId: gB.grant.grantId, devicePub: gB.grant.devicePubHex });
      await Promise.race([pb.closed, sleep(10_000)]);
      expect(pb.closedWith?.code).toBe(4403);
      pa.terminate();
      pb.terminate();
    }, 60_000);

    it("MESH10 legacy box: announced legacy by its full holder, an entry relay's legacy claim refused, beaten by a box-signed attachment", async () => {
      const a = com.account(uniq("old"));
      const id = com.box(a, "home");
      const old = mk(new MeshBox(id, "OLD", { mesh: false }));
      await synced();
      const ack = await old.connect(R("ra"));
      expect(ack.ok).toBe(true);
      expect(ack.relayId).toBeUndefined();
      expect(ack.capabilities ?? []).not.toContain("mesh-v1");
      for (const x of ["rb", "rc"]) await waitReaches(R(x), old.pod, "OLD", 15_000);
      // aa-obs (an entry relay) announces a legacy attachment it signed: refused by every peer.
      const sims = await Promise.all(IDS.map((x) => peer(x)));
      const t = Date.now();
      const la: BoxAttachment = { serverFqdn: old.pod, boxPub: old.boxPub, regGen: 1, relayId: "aa-obs", attachedAt: t + 1, issuedAt: t + 1, notAfter: t + 120_000 };
      const lsig = signRelayMeshRecord("relay-legacy-attachment", la, (m) => ed.sign(m, com.specs.get("aa-obs")!.key.privateKey));
      for (const [i, x] of IDS.entries()) {
        const before = await rejectedFrom(R(x), "aa-obs");
        sims[i]!.send({ type: "announce", items: [{ kind: "legacy", attachment: la, signature: lsig }] });
        await waitFor(async () => (await rejectedFrom(R(x), "aa-obs")) > before, 3_000, `${label(x)} refuses an entry relay's legacy item`);
      }
      for (const s of sims) s.close();
      // The box updates and attaches itself on rc: the box-signed attachment wins on every relay.
      const now = mk(new MeshBox(id, "NEW"));
      await attached(now, "rc");
      for (const x of ["ra", "rb"]) await waitReaches(R(x), old.pod, "NEW");
      old.close();
      now.close();
    });

    it("MESH11 timing: a local miss, a mesh miss and a holder's refusal all close at the hold time", async () => {
      const a = com.account(uniq("tm"));
      const offline = com.box(a, "offline");
      const ctl = com.box(a, "ctl");
      await synced();
      // The holder's refusal: a box with no serving admin key keeps only its control name, so an app name is refused.
      const c = mk(new MeshBox(ctl, "CTL", { hello: { serving: {} } }));
      await attached(c, "rb");
      await waitReaches(R("ra"), ctl.pod, "CTL");
      for (const id of ["ra", "rc"]) {
        const cases: Array<[string, string]> = [
          ["local miss (no such name)", `nobody.${a.username}.${APEX}`],
          ["mesh miss (registered, held nowhere)", offline.pod],
          ["holder refusal (apps off)", `x.${ctl.pod}`],
        ];
        for (const [what, sni] of cases) {
          const r = await visit(R(id), sni, HOLD_MS + 2_000);
          expect(r.text, `${label(id)} ${what}`).toBe("");
          expect(Math.abs(r.closedAfterMs - HOLD_MS), `${label(id)} ${what} closed after ${r.closedAfterMs} ms`).toBeLessThanOrEqual(TOLERANCE_MS);
        }
      }
      c.close();
    }, 60_000);

    it("MESH12 a peer-backup mailbox held behind another relay is delivered over a bridge", async () => {
      for (const [entry, holder] of PAIRS.filter(([e]) => e === "ra" || e === "rc")) {
        const a = com.account(uniq("pb"));
        const b = mk(new MeshBox(com.box(a, "home"), "PB"));
        await synced();
        await attached(b, holder);
        const pik = key();
        const epoch = pbMailboxEpoch(Date.now());
        const sigHex = hex(ed.sign(canonicalPbMailboxAnnounce(hex(pik.publicKey), epoch), pik.privateKey));
        b.raw.send(mailboxAnnounceFrame([{ pikPubHex: hex(pik.publicKey), epoch, sigHex }]));
        const id = pbMailboxId(hex(pik.publicKey), epoch);
        const envelope = Buffer.alloc(200_000, 7);
        let res = { status: 0, body: Buffer.alloc(0) };
        await waitFor(async () => (res = await httpPost(R(entry).ports.hub, `/pb/m/${id}`, envelope)).status === 200, 8_000, `mailbox through ${label(entry)} to ${label(holder)}`);
        expect(res.body.subarray(0, 5).toString()).toBe("MAIL:");
        expect(res.body.subarray(5).equals(envelope)).toBe(true);
        b.close();
      }
    });

    it("MESH07b rebalancing: visits through one entry dominate; the home moves the account there with no failed visit", async () => {
      const a = com.account(uniq("rb"));
      const b = mk(new MeshBox(com.box(a, "home"), "RBL"));
      await synced();
      await attached(b, "ra");
      await waitReaches(R("rc"), b.pod, "RBL");
      let failed = 0;
      const batch = async () => {
        const rs = await Promise.all(Array.from({ length: 100 }, () => visit(R("rc"), b.pod, 1_500)));
        failed += rs.filter((r) => !r.text.startsWith("RBL:")).length;
      };
      for (let i = 0; i < 6; i++) await batch();
      // The TS home counts over one interval (FLAGSHIP_MESH_REBALANCE_MS shortens its window too); the Rust home over
      // the hour: 600 streams inside 30 s pass both.
      await waitFor(() => b.hints.some((h) => (h.hint as { reason?: string }).reason === "locality"), 45_000, "locality hint").catch(async (e) => {
        const st = await meshStats(R("ra"));
        throw new Error(`${(e as Error).message} (failed visits ${failed}; ra: ${JSON.stringify({ rebalance: st.rebalance, homes: st.homes, counters: st.counters })})`);
      });
      const h = b.hints.find((x) => (x.hint as { reason?: string }).reason === "locality")!;
      expect(h.hint).toMatchObject({ fromRelayId: "ra", toRelayId: "rc" });
      const moving = batch();
      await b.moveTo(R("rc"));
      await moving;
      await batch();
      expect(failed, "no visit failed during the move").toBe(0);
      for (const id of IDS) expect(await reaches(R(id), b.pod, "RBL")).toBe(true);
      b.close();
    }, 90_000);

    it("MESH09 feed: head polling applies a revocation everywhere; a forged gossiped entry and head are refused; one relay's paused feed is covered by its peers", async () => {
      // A revocation through the feed: the holder closes, every entry stops routing.
      const a = com.account(uniq("feed"));
      const r1 = mk(new MeshBox(com.box(a, "home"), "R1"));
      await synced();
      await attached(r1, "rc");
      for (const id of ["ra", "rb"]) await waitReaches(R(id), r1.pod, "R1");
      const t0 = Date.now();
      com.revokeBox(r1.id);
      await r1.raw.closed;
      expect(r1.raw.closeInfo?.code).toBe(1008);
      for (const id of IDS) expect(await reaches(R(id), r1.pod, "R1", 800)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(65_000);
      for (const id of IDS) {
        const again = new MeshBox(r1.id, "R1b");
        expect((await again.connect(R(id))).ok, `${label(id)} refuses the revoked box's HELLO`).toBe(false);
        again.raw.close();
      }
      // A forged gossiped entry and head from a peer are refused: nothing changes.
      const live = mk(new MeshBox(com.box(a, "live"), "LIVE"));
      await synced();
      await attached(live, "rb");
      const sim = await peer("rb");
      const forged = { entry: { sequence: com.entries.length + 1, kind: "box-revoke", at: Date.now(), f1: live.boxPub, f2: "1", f3: "", f4: "" }, signature: "00".repeat(64) };
      sim.send({ type: "log", entries: [forged] });
      const fakeHead = { ...com.head().head, sequence: com.entries.length + 1 };
      sim.send({ type: "head", head: fakeHead, signature: "11".repeat(64) });
      await sleep(1_000);
      expect(live.raw.closeInfo, "a forged revocation closes nothing").toBeNull();
      expect(await reaches(R("ra"), live.pod, "LIVE")).toBe(true);
      sim.close();
      // rc's own feed paused: heads and entries from its peers keep it fresh (it stays 200 past the 60 s rule would
      // need; here the relays run the production thresholds, so a few seconds show it still applies new entries).
      com.feedPaused.add("rc");
      const late = mk(new MeshBox(com.box(a, "late"), "LATE"));
      await waitFor(async () => (await late.connect(R("rc"))).ok, 15_000, `${label("rc")} applies a box-register it can only have from its peers`);
      expect((await health(R("rc"))).status).toBe(200);
      com.feedPaused.delete("rc");
      late.close();
      live.close();
    }, 90_000);

    it("MESH13 a mesh-off relay: no relayId in the ACK for a mesh-v1 box and no /mesh endpoint", async () => {
      const a = com.account(uniq("off"));
      const b = com.box(a, "home");
      for (const impl of [...new Set(cfg.layout.map((l) => l.impl))]) {
        const r = await implStarter(impl).start(com, {});
        try {
          const box = new MeshBox(b, "OFF");
          const ack = await box.connect({ ports: { hub: r.hubPort } }, { serving: {} });
          expect(ack.ok).toBe(true);
          expect(ack.relayId, `${impl} mesh off`).toBeUndefined();
          expect(ack.capabilities ?? []).not.toContain("mesh-v1");
          box.raw.close();
          const sim = await PeerSim.dial({ relayId: "x", impl, spec: null as never, target: r, ports: { hub: r.hubPort, sni: r.sniPort, echo: r.echoPort } }, { relayId: "aa-obs", key: com.specs.get("aa-obs")!.key, blessing: com.relayBlessings.get("aa-obs")! }).catch(() => null);
          expect(sim?.authed ?? false, `${impl} mesh off has no bridge`).toBe(false);
          sim?.close();
        } finally {
          await r.kill();
        }
      }
    });
  });
}

describe("relay mesh conformance: the .com outage rule (MESH09, shortened thresholds)", () => {
  const layout = RUST
    ? [{ relayId: "ra", impl: "ts" as Impl }, { relayId: "rb", impl: "rust" as Impl }, { relayId: "rc", impl: "rust" as Impl }]
    : [{ relayId: "ra", impl: "ts" as Impl }, { relayId: "rb", impl: "ts" as Impl }, { relayId: "rc", impl: "ts" as Impl }];
  const com = new MeshCom();
  let relays: Map<string, MeshRelay> | null = null;
  const R = (id: string) => relays!.get(id)!;
  const REFUSE = 3_000;
  const CLOSE = 7_000;
  beforeAll(async () => {
    for (const l of layout) com.admit(l.relayId, "full", "iad");
    await com.start();
    relays = await launchMesh(com, layout, { refuseNewMs: REFUSE, closeAllMs: CLOSE });
  }, 60_000);
  afterAll(async () => {
    await stopMesh(relays);
    await com.stop();
  });

  it("stale → 503 and only exempt HELLOs; past close-all only no-time-limit boxes keep serving; resumed → healthy", async () => {
    const ivy = com.account("ivy");
    const tom = com.account("tom");
    const adminT: Ed = { priv: tom.irk.privateKey, pub: hex(tom.irk.publicKey) };
    const limited = (server: string, lbl: string) => {
      const id = com.box(tom, server);
      const p = policy({ account: "tom", box: hex(id.stk.publicKey), admin: adminT, grace: "7d", server });
      com.policyHead(id, 1, p.record as ServingPolicy);
      const l = lease(p, adminT, Date.now(), Date.now() + 60 * 60_000);
      return new MeshBox(id, lbl, { hello: { serving: { servingAdminKey: adminT.pub, servingPolicy: p, servingLeases: [l] } } });
    };
    const ivyBox = new MeshBox(com.box(ivy, "home"), "IVY");
    const tomBox = limited("home", "TOM");
    const lateTom = limited("late", "LATET");
    const lateIvy = new MeshBox(com.box(ivy, "late"), "LATEI");
    await waitFor(async () => (await ivyBox.connect(R("rb"))).ok, 8_000, "ivy on rb");
    expect(await ivyBox.attach()).toEqual({ ok: true });
    expect((await tomBox.connect(R("rb"))).ok).toBe(true);
    await waitReaches(R("rc"), ivyBox.pod, "IVY");
    com.feedPaused.add("*");
    await waitFor(async () => (await Promise.all(layout.map((l) => health(R(l.relayId))))).every((h) => h.status === 503), REFUSE + 6_000, "every relay 503");
    expect(await lateTom.connect(R("rc"))).toMatchObject({ ok: false, reason: "try-again" });
    lateTom.raw.close();
    expect((await lateIvy.connect(R("rc"))).ok, "an exempt box's HELLO is taken while stale").toBe(true);
    await lateTom.raw.closed;
    await Promise.race([tomBox.raw.closed, sleep(CLOSE + 4_000)]);
    expect(tomBox.raw.closeInfo?.code, "time-limited box closed at close-all").toBe(1013);
    expect(ivyBox.raw.closeInfo).toBeNull();
    expect(lateIvy.raw.closeInfo).toBeNull();
    expect(await reaches(R("rc"), ivyBox.pod, "IVY"), "a stale entry still forwards to an exempt box").toBe(true);
    com.feedPaused.delete("*");
    await waitMeshReady(layout.map((l) => R(l.relayId)), 10_000);
    ivyBox.close();
    lateIvy.close();
  }, 60_000);
});

