/**
 * The relay conformance suite (G7 / R7): every scenario runs against the TypeScript hub and the Rust relay with the
 * same mock `.com`, the same boxes and the same visitors, and must give the same observable answer on both. The Rust
 * half needs the binary (`cargo build -p flagship-relay --bin flagship-relay --features conformance`, or FLAGSHIP_RELAY_BIN; the feature only lets S18 fake a public address); without it that
 * half is skipped and says so. Scenario ids are listed in docs/architecture-v2/relay-transport.md §7.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { connect as netConnect } from "node:net";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { ed } from "@flagship/protocol";
import {
  CAPABILITY_DRAIN_V1,
  CAPABILITY_OUTBOUND_V1,
  CAPABILITY_PB_MAIL_V1,
  FRAME_CLOSE,
  FRAME_DATA,
  FRAME_DRAIN_NOTICE,
  FRAME_OPEN,
  FRAME_OUTBOUND_RESULT,
  FRAME_PB_MAIL_REQ,
  HELLO_REFUSED_TRY_AGAIN,
  MailAssembler,
  closeFrame,
  dataFrame,
  mailboxAnnounceFrame,
  mailResponseFrames,
  outboundOpenFrame,
  parseOutboundResult,
  FRAME_OUTBOUND_CREDIT,
} from "@flagship/tunnel-protocol";
import { SimPhone } from "../../live-e2e/lib/phoneSim.js";
import { superviseTunnelClient, type SupervisedTunnelClient } from "../../../packages/server-daemon/src/tunnel/tunnelClient.js";
import { lease, policy, revocation, type Ed } from "../../../apps/web/tests/support/serving.js";
import {
  APEX,
  IMPLS,
  MockCom,
  RawBox,
  USAGE_SECRET,
  Visitor,
  boxIdentity,
  clientHello,
  helloPayload,
  hex,
  httpGet,
  httpPost,
  key,
  mailboxAnnouncement,
  phoneEligibility,
  revokeCert,
  sleep,
  waitFor,
  type BoxIdentity,
  type RelayOptions,
  type RunningRelayTarget,
} from "../harness.js";

const td = new TextDecoder();

for (const impl of IMPLS) {
  const suite = impl.available() ? describe : describe.skip;
  suite(`relay conformance: ${impl.name}`, () => {
    let com: MockCom;
    let relay: RunningRelayTarget | null = null;
    const boxes: RawBox[] = [];
    const cleanups: Array<() => Promise<void> | void> = [];

    beforeEach(async () => {
      com = new MockCom();
      await com.start();
    });
    afterEach(async () => {
      for (const c of cleanups.splice(0)) await c();
      for (const b of boxes.splice(0)) b.close();
      await relay?.kill();
      relay = null;
      await com.stop();
    });

    const start = async (o: RelayOptions = {}) => {
      relay = await impl.start(com, o);
      // The blessing is fetched once at start; HELLO_ACKs carry it once it is held.
      await waitFor(() => com.blessed !== null, 5_000, "the hub blessing request");
      await sleep(50);
      return relay;
    };

    const connect = async (b: BoxIdentity, o: Parameters<typeof helloPayload>[1] = {}) => {
      const raw = await RawBox.connect(relay!.hubPort);
      boxes.push(raw);
      const h = await helloPayload(b, o);
      raw.hello(h.payload);
      return { raw, ...h };
    };

    /** Answer a visitor stream: echo what the box was sent back, uppercased, and keep the bytes. */
    const openOn = async (raw: RawBox, sni: string, skip = 0) => {
      const f = await raw.waitFrame((x, ) => x.type === FRAME_OPEN && td.decode(x.payload) === sni && raw.frames.filter((y) => y.type === FRAME_OPEN && td.decode(y.payload) === sni).indexOf(x) === skip, 5_000, `OPEN ${sni}`);
      return f.streamId;
    };
    /** Streams opened for `sni` that carried a visitor's ClientHello (a park-on-miss nudge opens a stream too). */
    const routed = (raw: RawBox, sni: string) =>
      raw.frames.filter((f) => f.type === FRAME_OPEN && td.decode(f.payload) === sni && dataOf(raw, f.streamId)[0] === 0x16);
    const dataOf = (raw: RawBox, id: number) =>
      Buffer.concat(raw.frames.filter((f) => f.type === FRAME_DATA && f.streamId === id).map((f) => Buffer.from(f.payload)));

    it("S01 HELLO admission: ack ok with capabilities and a hub signature over the nonce under the blessed key", async () => {
      await start();
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home", ["notes"]);
      const { raw, nonce } = await connect(b, { capabilities: [CAPABILITY_DRAIN_V1] });
      const ack = await raw.ack();
      expect(ack.ok).toBe(true);
      expect(new Set(ack.capabilities)).toEqual(new Set([CAPABILITY_OUTBOUND_V1, CAPABILITY_PB_MAIL_V1, CAPABILITY_DRAIN_V1]));
      const blessing = ack.serviceBlessing as { hubKeyPub: string };
      expect(blessing.hubKeyPub).toBe(com.blessed!.hubKeyPub);
      expect(ed.verify(Buffer.from(ack.hubSig!, "hex"), nonce, Buffer.from(blessing.hubKeyPub, "hex"))).toBe(true);
      // `.com` was asked over the TS hub's routes.
      expect(com.paths).toEqual(expect.arrayContaining(["GET /api/username/alice", `GET /api/server/by-domain/${b.pod}`]));
    });

    it("S02 HELLO refusals: same ack reason and close code", async () => {
      await start();
      const a = com.account("alice");
      const cases: Array<{ name: string; run: () => Promise<RawBox>; reason: string | RegExp; code: number }> = [
        {
          name: "first frame not HELLO",
          run: async () => {
            const raw = await RawBox.connect(relay!.hubPort);
            boxes.push(raw);
            raw.send(dataFrame(1, new Uint8Array([1])));
            return raw;
          },
          reason: "expected HELLO as first frame",
          code: 1002,
        },
        {
          name: "not JSON",
          run: async () => {
            const raw = await RawBox.connect(relay!.hubPort);
            boxes.push(raw);
            raw.send({ streamId: 0, type: 0x10, payload: new TextEncoder().encode("{nope") });
            return raw;
          },
          reason: "HELLO payload not JSON",
          code: 1002,
        },
        {
          name: "unknown server",
          run: async () => {
            const b = boxIdentity(com, a, "ghost");
            com.stks.delete(b.pod);
            return (await connect(b)).raw;
          },
          reason: "serverId not registered with .com",
          code: 1008,
        },
        { name: "HELLO signed by another key", run: async () => (await connect(boxIdentity(com, a, "k1"), { helloKey: key() })).raw, reason: "HELLO STK signature failed verification", code: 1008 },
        { name: "entitlements not signed by the IRK", run: async () => (await connect(boxIdentity(com, a, "k2"), { entitlementKey: key() })).raw, reason: "rootEntitlement signature failed verification", code: 1008 },
        { name: "stale HELLO", run: async () => (await connect(boxIdentity(com, a, "k3"), { issuedAt: Date.now() - 10 * 60_000 })).raw, reason: "HELLO issuedAt is stale or in the future", code: 1008 },
        {
          name: "claim in another account's zone",
          run: async () => (await connect(boxIdentity(com, a, "k4"), { extraCanonicals: [`notes.bob.${APEX}`] })).raw,
          reason: `claim notes.bob.${APEX} rejected — outside user zone 'alice' (foreign-zone canonical)`,
          code: 1008,
        },
      ];
      const seen: Record<string, { reason?: string; code: number }> = {};
      for (const c of cases) {
        const raw = await c.run();
        const ack = await raw.ack();
        const closed = await raw.closed;
        expect(ack.ok, c.name).toBe(false);
        if (typeof c.reason === "string") expect(ack.reason, c.name).toBe(c.reason);
        else expect(ack.reason, c.name).toMatch(c.reason);
        expect(closed.code, c.name).toBe(c.code);
        seen[c.name] = { reason: ack.reason, code: closed.code };
      }
      // A revoked root entitlement (the account's signed list) is refused too (a fresh account: lists are cached).
      const carol = com.account("carol");
      const r = boxIdentity(com, carol, "revoked");
      const h = await helloPayload(r);
      revokeCert(com, carol, [h.rootId]);
      const raw = await RawBox.connect(relay!.hubPort);
      boxes.push(raw);
      raw.hello(h.payload);
      const ack = await raw.ack();
      expect(ack.ok).toBe(false);
      expect(ack.reason).toBe("rootEntitlement is revoked");
      expect((await raw.closed).code).toBe(1008);
      expect(Object.keys(seen)).toHaveLength(cases.length);
    });

    it("S03 routing and opaque passthrough: ClientHello and later bytes verbatim both ways; closes propagate", async () => {
      await start();
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home", ["notes"]);
      const { raw } = await connect(b);
      expect((await raw.ack()).ok).toBe(true);
      for (const sni of [b.pod, `notes.alice.${APEX}`, `notes.home.alice.${APEX}`]) {
        const hello = clientHello(sni);
        const v = await Visitor.open(relay!.sniPort, hello);
        const id = await openOn(raw, sni);
        v.write(Buffer.from([0x17, 0x03, 0x03, 0, 3, 9, 8, 7]));
        await waitFor(() => dataOf(raw, id).length >= hello.length + 8, 5_000, "visitor bytes at the box");
        expect(Buffer.compare(dataOf(raw, id), Buffer.concat([Buffer.from(hello), Buffer.from([0x17, 3, 3, 0, 3, 9, 8, 7])]))).toBe(0);
        const reply = new Uint8Array(randomBytes(70_000));
        raw.send(dataFrame(id, reply.subarray(0, 40_000)));
        raw.send(dataFrame(id, reply.subarray(40_000)));
        await waitFor(() => v.received.length === reply.length, 5_000, "box bytes at the visitor");
        expect(Buffer.compare(v.received, Buffer.from(reply))).toBe(0);
        raw.send(closeFrame(id));
        await v.done;
      }
      // The visitor's end reaches the box as CLOSE.
      const v = await Visitor.open(relay!.sniPort, clientHello(b.pod));
      const id = await openOn(raw, b.pod, 1);
      v.end();
      await raw.waitFrame((f) => f.type === FRAME_CLOSE && f.streamId === id, 5_000, "CLOSE at the box");
    });

    it("S04 unroutable visitors are closed: unknown name, no SNI, not TLS, the account's bare name", async () => {
      await start();
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home");
      const { raw } = await connect(b);
      expect((await raw.ack()).ok).toBe(true);
      const cases = [clientHello(`nobody.bob.${APEX}`), clientHello(`alice.${APEX}`), new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n")];
      for (const first of cases) {
        const v = await Visitor.open(relay!.sniPort, first);
        await Promise.race([v.done, sleep(8_000)]);
        expect(v.ended).toBe(true);
        expect(v.received.length).toBe(0);
      }
      expect(raw.frames.some((f) => f.type === FRAME_OPEN)).toBe(false);
    });

    it("S05 the :8444 echo answers the PROXY header's destination (v1 and v2)", async () => {
      await start();
      const ask = async (head: Buffer) => {
        const s = netConnect(relay!.echoPort, "127.0.0.1");
        let got = Buffer.alloc(0);
        s.on("data", (d) => (got = Buffer.concat([got, d])));
        await new Promise<void>((r) => s.once("connect", () => r()));
        s.write(Buffer.concat([head, Buffer.from("GET / HTTP/1.1\r\nhost: x\r\n\r\n")]));
        await new Promise<void>((r) => s.on("close", () => r()));
        const text = got.toString();
        return { status: text.split(" ")[1], body: JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)) as Record<string, unknown> };
      };
      const v1 = await ask(Buffer.from("PROXY TCP4 198.51.100.7 203.0.113.9 51000 8444\r\n"));
      expect(v1.status).toBe("200");
      const v2head = Buffer.concat([
        Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a, 0x21, 0x11, 0, 12]),
        Buffer.from([198, 51, 100, 7, 203, 0, 113, 9, 0xc7, 0x38, 0x20, 0xfc]),
      ]);
      const v2 = await ask(v2head);
      expect(v2.status).toBe("200");
      expect(v1.body).toEqual({ relay: "flagship.services", reachedAt: "203.0.113.9", reachedPort: 8444 });
      expect(v2.body).toEqual({ relay: "flagship.services", reachedAt: "203.0.113.9", reachedPort: 8444 });
    });

    it("S06 quotas: bytes are reported per account and an over-quota answer slows the account", async () => {
      await start({ usage: { flushMs: 200, overQuotaKbps: 80 } });
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home");
      const { raw } = await connect(b);
      expect((await raw.ack()).ok).toBe(true);
      const v = await Visitor.open(relay!.sniPort, clientHello(b.pod));
      const id = await openOn(raw, b.pod);
      raw.send(dataFrame(id, new Uint8Array(4_000)));
      await waitFor(() => v.received.length === 4_000, 5_000, "first bytes");
      await waitFor(() => com.usage.some((u) => u.username === "alice" && u.bytes > 0), 5_000, "a usage report for alice");
      com.usageAnswer = (u) => ({ username: u, admit: false, lease: { action: "throttle", policy: "throttle", grantBytes: 0, ttlMs: 60_000 } });
      // The next report settles the throttle lease.
      raw.send(dataFrame(id, new Uint8Array(1_000)));
      const reports = com.usage.length;
      await waitFor(() => com.usage.length > reports, 5_000, "a second report");
      await sleep(300);
      const before = v.received.length;
      const t0 = Date.now();
      // The meter charges after each frame and holds the tunnel for the debt (both relays), so frames are kept small.
      for (let i = 0; i < 40; i++) raw.send(dataFrame(id, new Uint8Array(1_000)));
      await waitFor(() => v.received.length >= before + 40_000, 20_000, "throttled bytes");
      // 80 kbit/s = 10,000 B/s: 40 KB takes well over a second even with a one-second burst.
      expect(Date.now() - t0).toBeGreaterThan(1_500);
      // The stats route is guarded by the usage secret.
      expect((await httpGet(relay!.hubPort, "/api/stats")).status).toBe(403);
      const st = await httpGet(relay!.hubPort, "/api/stats", { "x-usage-secret": USAGE_SECRET });
      expect(st.status).toBe(200);
      expect((st.body as { tunnelsOnline: number }).tunnelsOnline).toBe(1);
    });

    it("S07 outbound AI streams: refused destinations answer the same codes; off answers disabled", async () => {
      await start();
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home");
      const { raw } = await connect(b);
      expect((await raw.ack()).ok).toBe(true);
      const ask = async (id: number, host: string, port: number) => {
        raw.send(outboundOpenFrame(id, { host, port }));
        const f = await raw.waitFrame((x) => x.type === FRAME_OUTBOUND_RESULT && x.streamId === id, 10_000, `OUTBOUND_RESULT ${host}`);
        return parseOutboundResult(f.payload);
      };
      expect(await ask(0x8000_0001, "127.0.0.1", 443)).toEqual({ ok: false, reason: "forbidden-host" });
      expect(await ask(0x8000_0004, "localhost", 443)).toMatchObject({ ok: false });
      expect(await ask(0x8000_0002, "api.openai.com", 22)).toEqual({ ok: false, reason: "forbidden-port" });
      expect(await ask(0x8000_0003, "metadata.google.internal", 443)).toMatchObject({ ok: false });
      await relay!.kill();
      relay = null;
      com.blessed = null;
      await start({ outbound: false });
      const { raw: r2 } = await connect(b);
      const ack = await r2.ack();
      expect(ack.ok).toBe(true);
      expect(ack.capabilities ?? []).not.toContain(CAPABILITY_OUTBOUND_V1);
      r2.send(outboundOpenFrame(0x8000_0001, { host: "api.openai.com", port: 443 }));
      const f = await r2.waitFrame((x) => x.type === FRAME_OUTBOUND_RESULT, 5_000, "disabled");
      expect(parseOutboundResult(f.payload)).toEqual({ ok: false, reason: "disabled" });
    });

    it("S08 peer-backup mailboxes: a PIK-signed announce routes /pb/m/<id> over the tunnel and back", async () => {
      await start();
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home");
      const { raw } = await connect(b);
      expect((await raw.ack()).ok).toBe(true);
      const { id, ann } = mailboxAnnouncement(key());
      raw.send(mailboxAnnounceFrame([ann]));
      await sleep(200);
      const envelope = crypto.getRandomValues(new Uint8Array(3_000));
      const answering = (async () => {
        const req = await raw.waitFrame((f) => f.type === FRAME_PB_MAIL_REQ, 5_000, "mail request");
        const asm = new MailAssembler("req");
        let body: Uint8Array | null = null;
        for (const f of raw.frames.filter((x) => x.type === FRAME_PB_MAIL_REQ && x.streamId === req.streamId)) {
          const r = asm.push(f.payload);
          if (r.done) body = r.body;
        }
        expect(asm.mailboxId).toBe(id);
        expect(Buffer.compare(Buffer.from(body!), Buffer.from(envelope))).toBe(0);
        for (const f of mailResponseFrames(req.streamId, 200, new TextEncoder().encode("sealed-reply"))) raw.send(f);
      })();
      const res = await httpPost(relay!.hubPort, `/pb/m/${id}`, envelope);
      await answering;
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe("sealed-reply");
      // An unknown mailbox is a 404 on both.
      expect((await httpPost(relay!.hubPort, `/pb/m/${"0".repeat(id.length)}`, envelope)).status).toBe(404);
    });

    it("S09 eviction: a box whose STK was retired for its pod is answered replaced (1008)", async () => {
      await start();
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home");
      com.evictions.set(b.pod, [hex(b.stk.publicKey)]);
      const { raw } = await connect(b);
      expect(await raw.ack()).toMatchObject({ ok: false, reason: "replaced" });
      expect((await raw.closed).code).toBe(1008);
    });

    it("S10 drain: drain-v1 boxes get DRAIN_NOTICE, every tunnel closes 1012 after the grace, no new tunnels", async () => {
      await start({ drainGraceMs: 1_500 });
      const a = com.account("alice");
      const b1 = boxIdentity(com, a, "home");
      const b2 = boxIdentity(com, a, "cabin");
      const { raw: d } = await connect(b1, { capabilities: [CAPABILITY_DRAIN_V1] });
      const { raw: v1 } = await connect(b2);
      expect((await d.ack()).capabilities).toContain(CAPABILITY_DRAIN_V1);
      expect((await v1.ack()).capabilities ?? []).not.toContain(CAPABILITY_DRAIN_V1);
      const t0 = Date.now();
      const draining = relay!.drain();
      const notice = await d.waitFrame((f) => f.type === FRAME_DRAIN_NOTICE, 3_000, "DRAIN_NOTICE");
      expect(JSON.parse(td.decode(notice.payload))).toEqual({ graceMs: 1_500 });
      expect(v1.frames.some((f) => f.type === FRAME_DRAIN_NOTICE)).toBe(false);
      await expect(RawBox.connect(relay!.hubPort)).rejects.toBeTruthy();
      const [c1, c2] = await Promise.all([d.closed, v1.closed]);
      expect(c1.code).toBe(1012);
      expect(c2.code).toBe(1012);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_200);
      await draining;
    });

    it("S11 reconnect: a box's second tunnel takes the name and the first one's close does not unroute it", async () => {
      await start();
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home");
      const { raw: old } = await connect(b);
      expect((await old.ack()).ok).toBe(true);
      const { raw: fresh } = await connect(b);
      expect((await fresh.ack()).ok).toBe(true);
      old.close();
      await old.closed;
      await sleep(200);
      const v = await Visitor.open(relay!.sniPort, clientHello(b.pod));
      const id = await openOn(fresh, b.pod);
      fresh.send(dataFrame(id, new Uint8Array([1, 2, 3])));
      await waitFor(() => v.received.length === 3, 5_000, "bytes over the new tunnel");
      // A HELLO refresh that does not advance issuedAt is refused; one that does is accepted.
      const again = await helloPayload(b, { issuedAt: 1 });
      fresh.hello(again.payload);
      expect((await fresh.ack(1)).reason).toBe("HELLO issuedAt did not advance (replay?)");
      fresh.hello((await helloPayload(b)).payload);
      expect((await fresh.ack(2)).ok).toBe(true);
    });

    it("S12 bounded flow: a visitor that never reads does not stall a sibling stream on the same tunnel", async () => {
      await start();
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home", ["notes"]);
      const { raw } = await connect(b);
      expect((await raw.ack()).ok).toBe(true);
      const slow = await Visitor.open(relay!.sniPort, clientHello(b.pod));
      slow.sock.pause();
      const slowId = await openOn(raw, b.pod);
      const chunk = new Uint8Array(512 * 1024);
      for (let i = 0; i < 16; i++) raw.send(dataFrame(slowId, chunk));
      const fast = await Visitor.open(relay!.sniPort, clientHello(`notes.alice.${APEX}`));
      const fastId = await openOn(raw, `notes.alice.${APEX}`);
      raw.send(dataFrame(fastId, new Uint8Array(10_000)));
      await waitFor(() => fast.received.length === 10_000, 10_000, "the sibling stream's bytes");
      const health = await httpGet(relay!.hubPort, "/api/health");
      expect(health.status).toBe(200);
      expect((health.body as { ok?: boolean }).ok ?? true).toBeTruthy();
    });

    describe("serving authority", () => {
      const rk = (): Ed => {
        const priv = crypto.getRandomValues(new Uint8Array(32));
        return { priv, pub: hex(ed.getPublicKey(priv)) };
      };
      const adminOf = (b: BoxIdentity): Ed => ({ priv: b.account.irk.privateKey, pub: hex(b.account.irk.publicKey) });
      const record = (b: BoxIdentity, extra: Record<string, unknown> = {}) => {
        com.serving.set(`${b.account.username}|${hex(b.stk.publicKey)}`, {
          adminKey: hex(b.account.irk.publicKey),
          regGen: 1,
          policy: null,
          leases: [],
          delegations: [],
          ...extra,
        });
      };

      it("S13 a matching admin key serves; a differing one is refused; none keeps only the control name", async () => {
        const revocationKey = rk();
        await start({ serving: { revocationPub: revocationKey.pub } });
        await waitFor(() => com.feeds.size === 1, 5_000, "the relay's feed connection");
        const a = com.account("alice");
        const good = boxIdentity(com, a, "home", ["notes"]);
        record(good);
        const g = await connect(good, { serving: { servingAdminKey: hex(a.irk.publicKey), servingPolicy: null } });
        expect((await g.raw.ack()).ok).toBe(true);
        const v = await Visitor.open(relay!.sniPort, clientHello(`notes.alice.${APEX}`));
        await openOn(g.raw, `notes.alice.${APEX}`);
        v.sock.destroy();

        const bad = boxIdentity(com, a, "cabin");
        record(bad);
        const x = await connect(bad, { serving: { servingAdminKey: hex(key().publicKey) } });
        expect(await x.raw.ack()).toMatchObject({ ok: false, reason: "admin-keys-differ" });
        expect((await x.raw.closed).code).toBe(1008);

        const b2 = com.account("bob");
        const old = boxIdentity(com, b2, "shed", ["wiki"]);
        record(old);
        const o = await connect(old);
        expect((await o.raw.ack()).ok).toBe(true);
        const c = await Visitor.open(relay!.sniPort, clientHello(old.pod));
        await openOn(o.raw, old.pod);
        c.sock.destroy();
        const app = await Visitor.open(relay!.sniPort, clientHello(`wiki.bob.${APEX}`));
        await Promise.race([app.done, sleep(8_000)]);
        expect(app.ended).toBe(true);
        expect(routed(o.raw, `wiki.bob.${APEX}`)).toHaveLength(0);
        expect(routed(o.raw, old.pod)).toHaveLength(1);
      });

      it("S14 a revocation pushed on the feed ends the box's tunnel and its routes; the relay acks it", async () => {
        const revocationKey = rk();
        await start({ serving: { revocationPub: revocationKey.pub } });
        await waitFor(() => com.feeds.size === 1, 5_000, "the relay's feed connection");
        const a = com.account("alice");
        const b = boxIdentity(com, a, "home");
        record(b);
        const { raw } = await connect(b, { serving: { servingAdminKey: hex(a.irk.publicKey) } });
        expect((await raw.ack()).ok).toBe(true);
        com.pushRevocation(revocation(1, "alice", hex(b.stk.publicKey), revocationKey));
        expect((await raw.closed).code).toBe(1008);
        await waitFor(() => com.acks.includes(1), 5_000, "the ack");
        const v = await Visitor.open(relay!.sniPort, clientHello(b.pod));
        await Promise.race([v.done, sleep(8_000)]);
        expect(v.ended).toBe(true);
        // A box revoked before it connects is refused.
        const again = await connect(b, { serving: { servingAdminKey: hex(a.irk.publicKey) } });
        expect(await again.raw.ack()).toMatchObject({ ok: false, reason: "revoked" });
        // A gap is filled from `.com`'s log: entry 2 is only in the log, entry 3 is pushed.
        const c = boxIdentity(com, a, "cabin");
        const d = boxIdentity(com, a, "shed");
        record(c);
        record(d);
        const cc = await connect(c, { serving: { servingAdminKey: hex(a.irk.publicKey) } });
        const dd = await connect(d, { serving: { servingAdminKey: hex(a.irk.publicKey) } });
        expect((await cc.raw.ack()).ok).toBe(true);
        expect((await dd.raw.ack()).ok).toBe(true);
        com.revocationLog.push(revocation(2, "alice", hex(c.stk.publicKey), revocationKey));
        com.pushRevocation(revocation(3, "alice", hex(d.stk.publicKey), revocationKey));
        expect((await cc.raw.closed).code).toBe(1008);
        expect((await dd.raw.closed).code).toBe(1008);
        expect(com.paths).toContain("GET /api/internal/serving-revocations");
        await waitFor(() => com.acks.includes(3), 5_000, "the ack of 3");
        // An entry signed by another key is not applied.
        const e = boxIdentity(com, a, "barn");
        record(e);
        const ee = await connect(e, { serving: { servingAdminKey: hex(a.irk.publicKey) } });
        expect((await ee.raw.ack()).ok).toBe(true);
        com.pushRevocation(revocation(4, "alice", hex(e.stk.publicKey), rk()));
        await sleep(500);
        expect(ee.raw.closeInfo).toBeNull();
      });

      it("S15 at the lease's end app streams close within 5 s while the control stream and name stay", async () => {
        const revocationKey = rk();
        await start({ serving: { revocationPub: revocationKey.pub } });
        await waitFor(() => com.feeds.size === 1, 5_000, "the relay's feed connection");
        const a = com.account("alice");
        const b = boxIdentity(com, a, "home", ["notes"]);
        const admin = adminOf(b);
        const p = policy({ account: "alice", box: hex(b.stk.publicKey), admin, server: "home" });
        const now = Date.now();
        const end = now + 2_000;
        record(b, { policy: p, leases: [lease(p, admin, now, end)] });
        const { raw } = await connect(b, { serving: { servingAdminKey: admin.pub, servingPolicy: p } });
        expect((await raw.ack()).ok).toBe(true);
        const appV = await Visitor.open(relay!.sniPort, clientHello(`notes.alice.${APEX}`));
        const appId = await openOn(raw, `notes.alice.${APEX}`);
        const ctlV = await Visitor.open(relay!.sniPort, clientHello(b.pod));
        const ctlId = await openOn(raw, b.pod);
        await appV.done;
        const lag = Date.now() - end;
        expect(lag).toBeLessThan(5_000);
        await raw.waitFrame((f) => f.type === FRAME_CLOSE && f.streamId === appId, 2_000, "CLOSE of the app stream at the box");
        expect(ctlV.ended).toBe(false);
        raw.send(dataFrame(ctlId, new Uint8Array([7])));
        await waitFor(() => ctlV.received.length === 1, 5_000, "the control stream still flows");
        const late = await Visitor.open(relay!.sniPort, clientHello(`notes.alice.${APEX}`));
        await Promise.race([late.done, sleep(8_000)]);
        expect(late.ended).toBe(true);
        const ctl2 = await Visitor.open(relay!.sniPort, clientHello(b.pod));
        await openOn(raw, b.pod, 1);
        ctl2.sock.destroy();
        const st = await httpGet(relay!.hubPort, "/api/stats", { "x-usage-secret": USAGE_SECRET });
        expect(st.status === 200 || st.status === 503).toBe(true);
      });

      it("S16 feed contact: no new tunnels after the quiet threshold, every tunnel closed after the second", async () => {
        const revocationKey = rk();
        await start({ serving: { revocationPub: revocationKey.pub, refuseNewMs: 1_000, closeAllMs: 3_000, checkMs: 100 } });
        await waitFor(() => com.feeds.size === 1, 5_000, "the relay's feed connection");
        const a = com.account("alice");
        const b = boxIdentity(com, a, "home");
        record(b);
        const { raw } = await connect(b, { serving: { servingAdminKey: hex(a.irk.publicKey) } });
        expect((await raw.ack()).ok).toBe(true);
        com.feedDown();
        await sleep(1_500);
        const c = boxIdentity(com, a, "cabin");
        record(c);
        const late = await connect(c, { serving: { servingAdminKey: hex(a.irk.publicKey) } });
        expect(await late.raw.ack()).toMatchObject({ ok: false, reason: HELLO_REFUSED_TRY_AGAIN });
        expect((await late.raw.closed).code).toBe(1013);
        const closed = await Promise.race([raw.closed, sleep(6_000).then(() => null)]);
        expect(closed).toEqual({ code: 1013, reason: "serving-feed-lost" });
        com.feedBack();
        await waitFor(() => com.feeds.size === 1, 40_000, "the feed reconnecting");
        await sleep(300);
        const back = await connect(c, { serving: { servingAdminKey: hex(a.irk.publicKey) } });
        expect((await back.raw.ack()).ok).toBe(true);
      }, 60_000);
    });

    describe("mixed versions: the current daemon tunnel client (an old box)", () => {
      let backend: NetServer;
      let backendPort = 0;
      beforeEach(async () => {
        backend = createNetServer((s) => s.on("data", (d) => s.write(Buffer.concat([Buffer.from("echo:"), d]))));
        await new Promise<void>((r) => backend.listen(0, "127.0.0.1", () => r()));
        backendPort = (backend.address() as { port: number }).port;
      });
      afterEach(async () => {
        await new Promise<void>((r) => backend.close(() => r()));
      });

      const daemon = (b: BoxIdentity, hubPort: number): { client: SupervisedTunnelClient; acks: () => number } => {
        let acks = 0;
        const client = superviseTunnelClient({
          hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
          signingKey: b.stk,
          getEntitlements: async () => {
            const { mintDevEntitlements } = await import("@flagship/protocol");
            return mintDevEntitlements({ irk: b.account.irk, podPubKey: b.stk.publicKey, username: b.account.username, podCanonical: b.pod, serviceCanonicals: [b.pod, ...b.services] });
          },
          resolveBackend: () => ({ host: "127.0.0.1", port: backendPort }),
          onHelloAckTrust: () => {
            acks += 1;
          },
          initialJitterMs: 0,
          baseReconnectMs: 100,
          maxReconnectMs: 400,
          keepAliveIntervalMs: 1_000,
        });
        cleanups.push(() => client.close());
        return { client, acks: () => acks };
      };

      const roundTrip = async (port: number, sni: string) => {
        const hello = clientHello(sni);
        const v = await Visitor.open(port, hello);
        await waitFor(() => v.received.length >= hello.length + 5, 5_000, `echo through ${sni}`);
        expect(v.received.subarray(0, 5).toString()).toBe("echo:");
        expect(Buffer.compare(v.received.subarray(5, 5 + hello.length), Buffer.from(hello))).toBe(0);
        v.sock.destroy();
      };

      it("M01 an old box registers and serves through this relay", async () => {
        await start();
        const a = com.account("alice");
        const b = boxIdentity(com, a, "home", ["notes"]);
        const d = daemon(b, relay!.hubPort);
        await d.client.ready();
        await roundTrip(relay!.sniPort, b.pod);
        await roundTrip(relay!.sniPort, `notes.alice.${APEX}`);
      });

      it("M02 a relay restart: the box reconnects to the new process on the same address by itself", async () => {
        const r1 = await start();
        const a = com.account("alice");
        const b = boxIdentity(com, a, "home");
        const d = daemon(b, r1.hubPort);
        await d.client.ready();
        await roundTrip(r1.sniPort, b.pod);
        const portsUsed = { hub: r1.hubPort, sni: r1.sniPort, echo: r1.echoPort };
        await r1.kill();
        relay = null;
        com.blessed = null;
        relay = await impl.start(com, { ports: portsUsed });
        const before = d.acks();
        await waitFor(() => d.acks() > before, 15_000, "the box's reconnect");
        await roundTrip(relay.sniPort, b.pod);
      });

      it("M03 rollback and forward: the same box moves between the Rust relay and the TS hub with no change", async () => {
        const other = IMPLS.find((x) => x.name !== impl.name)!;
        if (!other.available()) return;
        const r1 = await start();
        const a = com.account("alice");
        const b = boxIdentity(com, a, "home", ["notes"]);
        const d = daemon(b, r1.hubPort);
        await d.client.ready();
        await roundTrip(r1.sniPort, `notes.alice.${APEX}`);
        const portsUsed = { hub: r1.hubPort, sni: r1.sniPort, echo: r1.echoPort };
        await r1.drain();
        relay = null;
        const before = d.acks();
        relay = await other.start(com, { ports: portsUsed });
        await waitFor(() => d.acks() > before, 15_000, `the box's reconnect to the ${other.name} relay`);
        await roundTrip(relay.sniPort, `notes.alice.${APEX}`);
        await roundTrip(relay.sniPort, b.pod);
      }, 40_000);
    });

    describe("phone route (the bare name, H3)", () => {
      const seed = (n: number) => new Uint8Array(32).fill(n);
      const ADMIN = { privateKey: seed(1), publicKey: ed.getPublicKey(seed(1)) };
      const [A, B, C, MEMBER] = [seed(2), seed(3), seed(6), seed(4)];
      const BARE = `alice.${APEX}`;
      const allGranted = () =>
        com.phoneEligibility.set("alice", phoneEligibility("alice", ADMIN, [{ seed: A }, { seed: B }, { seed: C }, { seed: MEMBER, scopes: ["browse"] }]));
      const phoneOpts = (rk: string, id = "relay-1"): RelayOptions => ({ serving: { revocationPub: rk }, phone: true, relayId: id });
      const phone = async (port: number, s: Uint8Array, label: string) => {
        const p = await SimPhone.connect(`ws://127.0.0.1:${port}/phone-tunnel`, { account: "alice", seed: s, label });
        cleanups.push(() => p.terminate());
        return p;
      };
      const reach = async (port: number, extra = "") => {
        const hello = clientHello(BARE);
        const v = await Visitor.open(port, Buffer.concat([Buffer.from(hello), Buffer.from(extra)]));
        await Promise.race([v.done, waitFor(() => v.received.length > 0, 5_000).catch(() => undefined)]);
        const text = v.received.toString("latin1");
        v.sock.destroy();
        return { label: text.slice(0, text.indexOf(":")), text, hello };
      };
      const rk = () => hex(ed.getPublicKey(seed(9)));

      it("P01 an eligible phone claims the vacant name; visitors and presence bytes reach it verbatim; never a box", async () => {
        allGranted();
        await start(phoneOpts(rk()));
        await waitFor(() => com.feeds.size === 1, 5_000, "feed");
        const a = await phone(relay!.hubPort, A, "phone-a");
        expect(await a.acquire()).toMatchObject({ type: "granted", hostname: BARE, generation: 1, leaseMs: 60_000 });
        const presence = "GET / HTTP/1.1\r\nhost: alice.flagship.services\r\nx-flagship-presence-device: ab\r\n\r\n";
        const r = await reach(relay!.sniPort, presence);
        expect(r.label).toBe("phone-a");
        expect(r.text).toContain("x-flagship-presence-device: ab");
        // A second begin while holding is refused.
        a.send({ type: "begin", account: "alice" });
        expect(await a.next((m) => m.type === "refused")).toMatchObject({ code: "holding", generation: 1 });
      });

      it("P02 refusals: not-eligible (member grant, unknown key), bad-signature, wrong-generation, no-challenge, not-holder, malformed", async () => {
        allGranted();
        await start(phoneOpts(rk()));
        await waitFor(() => com.feeds.size === 1, 5_000, "feed");
        const m = await phone(relay!.hubPort, MEMBER, "member");
        expect(await m.acquire()).toMatchObject({ type: "refused", code: "not-eligible" });
        const x = await phone(relay!.hubPort, seed(7), "stranger");
        expect(await x.acquire()).toMatchObject({ type: "refused", code: "not-eligible" });
        const a = await phone(relay!.hubPort, A, "phone-a");
        const ch = await a.begin();
        const bad = a.sign(ch);
        expect(await a.sendClaim({ claim: bad.claim, signature: "00".repeat(64) })).toMatchObject({ type: "refused", code: "bad-signature" });
        const ch2 = await a.begin();
        expect(await a.sendClaim(a.sign(ch2, { generation: Number(ch2.generation) + 1 }))).toMatchObject({ type: "refused", code: "wrong-generation" });
        expect(await a.sendClaim(a.sign(ch2))).toMatchObject({ type: "refused", code: "no-challenge" });
        a.send({ type: "release", release: {}, signature: "00" });
        expect(await a.next((q) => q.type === "refused")).toMatchObject({ code: "not-holder" });
        a.send({ type: "begin", account: "Not An Account" });
        expect(await a.next((q) => q.type === "refused")).toMatchObject({ code: "malformed" });
        expect((await reach(relay!.sniPort)).text).toBe("");
      });

      it("P03 vacancy-only: a second phone is refused route-held and waits; the holder leaving makes it vacant; release is signed", async () => {
        allGranted();
        await start(phoneOpts(rk()));
        await waitFor(() => com.feeds.size === 1, 5_000, "feed");
        const a = await phone(relay!.hubPort, A, "phone-a");
        expect(await a.acquire()).toMatchObject({ type: "granted", generation: 1 });
        const b = await phone(relay!.hubPort, B, "phone-b");
        expect(await b.acquire()).toMatchObject({ type: "refused", code: "route-held", generation: 1 });
        expect((await reach(relay!.sniPort)).label).toBe("phone-a");
        a.close();
        expect(await b.next((q) => q.type === "route-vacant", 5_000)).toMatchObject({ hostname: BARE, generation: 1 });
        expect(await b.acquire()).toMatchObject({ type: "granted", generation: 2 });
        expect((await reach(relay!.sniPort)).label).toBe("phone-b");
        const c = await phone(relay!.hubPort, C, "phone-c");
        expect(await c.acquire()).toMatchObject({ type: "refused", code: "route-held", generation: 2 });
        expect(await b.release({ generation: 1 })).toMatchObject({ type: "refused", code: "wrong-generation" });
        expect(await b.release()).toMatchObject({ type: "released", hostname: BARE, generation: 2, confirmed: true });
        expect(await b.next((q) => q.type === "lost")).toMatchObject({ reason: "released" });
        expect(await c.next((q) => q.type === "route-vacant", 5_000)).toMatchObject({ generation: 2 });
        expect((await reach(relay!.sniPort)).text).toBe("");
        expect(await c.acquire()).toMatchObject({ type: "granted", generation: 3 });
      });

      it("P07 gym run 21: after a release the standby's grant is routed, and the releaser (tunnel kept) is told only the next vacancy", async () => {
        allGranted();
        await start(phoneOpts(rk()));
        await waitFor(() => com.feeds.size === 1, 5_000, "feed");
        const a = await phone(relay!.hubPort, A, "phone-a");
        expect(await a.acquire()).toMatchObject({ type: "granted", generation: 1 });
        const b = await phone(relay!.hubPort, B, "phone-b");
        expect(await b.acquire()).toMatchObject({ type: "refused", code: "route-held", generation: 1 });
        expect(await a.release()).toMatchObject({ type: "released", generation: 1 });
        expect(await b.next((q) => q.type === "route-vacant", 5_000)).toMatchObject({ generation: 1 });
        expect(await b.acquire()).toMatchObject({ type: "granted", generation: 2 });
        for (let i = 0; i < 3; i++) expect((await reach(relay!.sniPort)).label).toBe("phone-b");
        b.close();
        expect(await a.next((q) => q.type === "route-vacant", 5_000)).toMatchObject({ hostname: BARE, generation: 2 });
        expect(a.control.some((q) => q.type === "route-vacant" && q.generation === 1)).toBe(false);
        expect((await reach(relay!.sniPort)).text).toBe("");
      });

      it("P04 a revoked admin grant closes the holder with 4403 and its streams within 5 s", async () => {
        allGranted();
        await start(phoneOpts(rk()));
        await waitFor(() => com.feeds.size === 1, 5_000, "feed");
        const a = await phone(relay!.hubPort, A, "phone-a");
        expect(await a.acquire()).toMatchObject({ type: "granted" });
        const v = await Visitor.open(relay!.sniPort, clientHello(BARE));
        await waitFor(() => v.received.length > 0, 5_000, "the visitor's stream");
        com.phoneEligibility.set("alice", phoneEligibility("alice", ADMIN, [{ seed: B }]));
        const t0 = Date.now();
        com.pushPhoneEligibility("alice");
        await a.closed;
        expect(a.closedWith?.code).toBe(4403);
        await Promise.race([v.done, sleep(5_000)]);
        expect(v.ended).toBe(true);
        expect(Date.now() - t0).toBeLessThan(5_000);
        expect((await reach(relay!.sniPort)).text).toBe("");
      });

      const twoRelays = async () => {
        await start(phoneOpts(rk(), "relay-1"));
        const r2 = await impl.start(com, phoneOpts(rk(), "relay-2"));
        cleanups.push(() => r2.kill());
        await waitFor(() => com.feeds.size === 2, 5_000, "both feeds");
        return r2;
      };

      it("P05 across instances: a standby on another relay is told route-vacant by the ledger's push", async () => {
        allGranted();
        const r2 = await twoRelays();
        const a = await phone(relay!.hubPort, A, "phone-a");
        expect(await a.acquire()).toMatchObject({ type: "granted", generation: 1 });
        const b = await phone(r2.hubPort, B, "phone-b");
        expect(await b.acquire()).toMatchObject({ type: "refused", code: "route-held", generation: 1 });
        // The other relay does not route a name its own sessions do not hold.
        expect((await reach(r2.sniPort)).text).toBe("");
        a.close();
        expect(await b.next((q) => q.type === "route-vacant", 5_000)).toMatchObject({ hostname: BARE, generation: 1 });
        expect(await b.acquire()).toMatchObject({ type: "granted", generation: 2 });
        expect((await reach(r2.sniPort)).label).toBe("phone-b");
      }, 40_000);

      it("P06 a lost vacancy push: the standby relay's 15 s ledger re-read tells it", async () => {
        allGranted();
        const r2 = await twoRelays();
        const a = await phone(relay!.hubPort, A, "phone-a");
        expect(await a.acquire()).toMatchObject({ type: "granted", generation: 1 });
        const b = await phone(r2.hubPort, B, "phone-b");
        expect(await b.acquire()).toMatchObject({ type: "refused", code: "route-held" });
        com.phonePush = false;
        a.close();
        const t0 = Date.now();
        expect(await b.next((q) => q.type === "route-vacant", 20_000)).toMatchObject({ generation: 1 });
        expect(Date.now() - t0).toBeLessThan(17_000);
      }, 45_000);
    });

    it("S18 outbound: a successful splice to an allowed host's (faked) public address, both directions", async () => {
      const upstream = createNetServer((sock) => sock.on("data", (d) => sock.write(Buffer.concat([Buffer.from("up:"), d]))));
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
      cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));
      const port = (upstream.address() as { port: number }).port;
      await start({ outboundUpstream: { host: "api.openai.com", publicIp: "8.8.8.8", local: `127.0.0.1:${port}` } });
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home");
      const { raw } = await connect(b);
      expect((await raw.ack()).ok).toBe(true);
      const id = 0x8000_0001;
      raw.send(outboundOpenFrame(id, { host: "api.openai.com", port: 443 }));
      const res = await raw.waitFrame((x) => x.type === FRAME_OUTBOUND_RESULT && x.streamId === id, 10_000, "OUTBOUND_RESULT");
      expect(parseOutboundResult(res.payload)).toEqual({ ok: true });
      raw.send(dataFrame(id, new TextEncoder().encode("hello-provider")));
      await waitFor(() => dataOf(raw, id).toString().includes("up:hello-provider"), 5_000, "the upstream's answer at the box");
      expect(dataOf(raw, id).toString()).toBe("up:hello-provider");
      raw.send(closeFrame(id));
      await sleep(200);
      expect(raw.frames.some((f) => f.type === FRAME_OUTBOUND_CREDIT || f.type === FRAME_DATA)).toBe(true);
    });

    it("S19 /api/stats lists the names that missed (no box registered), newest last, at most 20", async () => {
      await start({ usage: { flushMs: 60_000 } });
      const a = com.account("alice");
      const b = boxIdentity(com, a, "home");
      const { raw } = await connect(b);
      expect((await raw.ack()).ok).toBe(true);
      // A name of an account with no box online is a "no-box-registered" miss (dropped after the hold).
      const v = await Visitor.open(relay!.sniPort, clientHello(`nobody.bob.${APEX}`));
      await Promise.race([v.done, sleep(8_000)]);
      const st = await httpGet(relay!.hubPort, "/api/stats", { "x-usage-secret": USAGE_SECRET });
      const router = (st.body as { router: { recentMisses: Array<{ at: string; domain: string; kind: string }>; noBoxRegistered: number } }).router;
      // The TS hub's counters are process-wide (earlier scenarios in this process add to them): read the newest.
      expect(router.recentMisses.length).toBeGreaterThanOrEqual(1);
      expect(router.recentMisses.length).toBeLessThanOrEqual(20);
      const last = router.recentMisses[router.recentMisses.length - 1]!;
      expect(last).toMatchObject({ domain: `nobody.bob.${APEX}`, kind: "no-box-registered" });
      expect(new Date(last.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it("S17 /api/health answers on the hub port", async () => {
      await start();
      const h = await httpGet(relay!.hubPort, "/api/health");
      expect(h.status).toBe(200);
      expect(h.body).toMatchObject({ ok: true });
    });
  });
}
