/**
 * The retail claim end to end on fakes (docs/retail-box-setup.md §13.2 item 8): a box on an
 * in-memory radio with a scripted power button, a scripted phone, and the real `.com` handlers
 * over in-memory storage. Covers the normal Bluetooth claim, a relay that passes the claim on,
 * contention, bad presses, the reset window and re-claim, an interrupted reset, the remote claim
 * by setup code through the blind mailbox, wrong codes and the network report.
 */
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOX_CLAIM_ADVERTISE_MS,
  BOX_CLAIM_RESET_WINDOW_MS,
  acceptBoxClaim,
  completeBoxClaim,
  decodeClaimMessage,
  encodeClaimMessage,
  ed,
  hybridSigKeygen,
  hybridSign,
  judgePressReport,
  setupCodeMailboxId,
  signAuthCode,
  signAuthCodeAdmin,
  signBoxClaimKey,
  signBoxClaimReceipt,
  signBoxRelease,
  type BoxReleaseOrder,
  signInstallBlob,
  signServerRegister,
  verifyBoxClaimReceipt,
  BOX_CLAIM_FRAME_HANDSHAKE,
  BOX_CLAIM_FRAME_RECORD,
  type AuthCode,
  type BoxClaimChannel,
  type BoxClaimReceiptWire,
  type InstallBlob,
  type Keypair,
  type ServerRegisterRequest,
  type WiFiConfig,
} from "@flagship/protocol";
import { InMemoryBoxClaimStorage, InMemoryStorage } from "@flagship/storage";
import {
  handleAuthCodeIssue,
  handleBoxClaimKey,
  handleBoxClaimMailboxPost,
  handleBoxClaimMailboxRead,
  handleServerRegister,
} from "@flagship/control-plane";
import { loadBlobFromString } from "@flagship/builder";
import { ClaimStateStore } from "../../src/retailClaim/claimState.js";
import { RetailClaimService, type ClaimIdentity, type RecipeCheck } from "../../src/retailClaim/claimService.js";
import type { NetworkResult } from "../../src/retailClaim/network.js";
import { FakePowerKeySource } from "../../src/retailClaim/powerKey.js";
import { SetupCodeStore } from "../../src/retailClaim/setupCode.js";
import { InMemoryBleRadio, MailboxLink, type ClaimLink, type MailboxClient } from "../../src/retailClaim/transport.js";
import { PhoneDriver } from "./phoneDriver.js";
import { BoxReleaseConsumer } from "../../src/retailClaim/releaseOrder.js";
import { verifyClaimRecipe } from "../../src/retailClaim/recipe.js";
import { RESET_WINDOW_OPENED, retailNotices } from "../../src/retailClaim/notices.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (byte: number): Keypair => {
  const priv = new Uint8Array(32).fill(byte);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
};
const irk = kp(0x11);
const admin = kp(0x22);
const WIFI: WiFiConfig = { ssid: "Home Net", psk: "correct horse battery", regulatoryRegion: "DE", issuedAt: 1 };

function wire(v: unknown): unknown {
  if (v instanceof Uint8Array) return hex(v);
  if (Array.isArray(v)) return v.map(wire);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)]));
  return v;
}

/** `.com` with one account, and a fresh admin-approved recipe per server name. */
async function makeCom(t0: number) {
  const s = new InMemoryStorage();
  const boxClaims = new InMemoryBoxClaimStorage();
  await s.usernames.put({ username: "harry", irkPubHex: hex(irk.publicKey), adminRootPubHex: hex(admin.publicKey), claimedAt: 1 });
  let n = 0;
  const recipe = async (serverName: string) => {
    const c: AuthCode = {
      version: 1,
      serial: `retail-serial-${++n}-xxxx`,
      username: "harry",
      serverName,
      serverDomain: `${serverName}.harry.flagship.services`,
      delegatedPubKey: kp(0x60 + n).publicKey,
      userPubKey: irk.publicKey,
      issuedAt: t0,
      expiresAt: t0 + 6 * 3600_000,
      adminRootPubKey: admin.publicKey,
    };
    const r = await handleAuthCodeIssue(
      { storage: s.authCodes, usernames: s.usernames, grants: s.deviceCapabilityGrants, now: () => t0 },
      { code: wire(c), signature: hex(signAuthCode(c, irk)), adminSignature: hex(signAuthCodeAdmin(c, admin)) } as never,
    );
    expect(r.status).toBe(200);
    const blob: InstallBlob = {
      version: 2,
      serverDomain: c.serverDomain,
      username: "harry",
      serverName,
      phoneDelegatedPubKey: c.delegatedPubKey,
      registrationUrl: "https://flagshipserver.com/api/server/register",
      authCode: c,
      authCodeUserSignature: signAuthCode(c, irk),
      installerGitRef: "main",
      rckPubKey: kp(0x70 + n).publicKey,
    };
    return { code: c, text: JSON.stringify({ blob: wire(blob), blobSignature: hex(signInstallBlob(blob, irk)) }) };
  };
  return { s, boxClaims, recipe };
}

type Com = Awaited<ReturnType<typeof makeCom>>;

/** The phone's step 8: register the receipt's key under the AuthCode, signed by the admin root. */
async function preRegister(com: Com, code: AuthCode, stkPubHex: string, now: number) {
  const key = { username: "harry", serial: code.serial, serverDomain: code.serverDomain, stkPubHex, issuedAt: now };
  return handleBoxClaimKey(
    { boxClaims: com.boxClaims, authCodes: com.s.authCodes, usernames: com.s.usernames, grants: com.s.deviceCapabilityGrants, now: () => now },
    { key, signature: hex(signBoxClaimKey(key, admin)) },
  );
}

function newIdentity(): ClaimIdentity & { edSeed: Uint8Array } {
  const edSeed = crypto.getRandomValues(new Uint8Array(32));
  const { publicKey, secretKey } = hybridSigKeygen(edSeed, crypto.getRandomValues(new Uint8Array(32)));
  return { edSeed, stkHybridPubHex: hex(publicKey), bootKeyBindingSha256: "", sign: (p, payload) => hybridSign(secretKey, p, payload) };
}

/** What the box's provision step does at `.com`: register under the AuthCode with its new STK. */
async function registerAtCom(com: Com, recipeText: string, edSeed: Uint8Array, now: number) {
  const env = JSON.parse(recipeText);
  const c: AuthCode = { ...env.blob.authCode, delegatedPubKey: Buffer.from(env.blob.authCode.delegatedPubKey, "hex"), userPubKey: Buffer.from(env.blob.authCode.userPubKey, "hex"), adminRootPubKey: Buffer.from(env.blob.authCode.adminRootPubKey, "hex") };
  const identity: Keypair = { privateKey: edSeed, publicKey: ed.getPublicKey(edSeed) };
  const nonce = new Uint8Array(16).fill(3);
  const userSig = signAuthCode(c, irk);
  const req: ServerRegisterRequest = { authCode: c, authCodeUserSignature: userSig, serverIdentityPubKey: identity.publicKey, issuedAt: now, nonce };
  return handleServerRegister(
    { authCodes: com.s.authCodes, servers: com.s.servers, usernames: com.s.usernames, boxClaims: com.boxClaims, now: () => now },
    { request: { authCode: wire(c), authCodeUserSignature: hex(userSig), serverIdentityPubKey: hex(identity.publicKey), issuedAt: now, nonce: hex(nonce) }, signature: hex(signServerRegister(req, identity)) } as never,
  );
}

function verifyRecipe(text: string): RecipeCheck {
  try {
    const b = loadBlobFromString(text);
    return { ok: true, serverDomain: b.blob.serverDomain, serial: b.blob.authCode.serial };
  } catch (e) {
    return { ok: false, reason: (e as { code?: string }).code === "expired" ? "recipe-expired" : "recipe-invalid" };
  }
}

/** One box: its disk under a temp dir, a fake button, a radio, scripted network and wipe. */
async function makeBox(com: Com, opts: { dir?: string; t0: number; mailbox?: boolean; wipeFails?: boolean; network?: Array<NetworkResult> } ) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "retail-box-"));
  let now = opts.t0;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const radio = new InMemoryBleRadio();
  const keys = new FakePowerKeySource();
  const shown: string[] = [];
  const events: string[] = [];
  const wipes: number[] = [];
  const registrations: Array<{ status: number; body: unknown }> = [];
  const identities: Array<ReturnType<typeof newIdentity>> = [];
  const netQueue = [...(opts.network ?? [])];
  const mailboxClient: MailboxClient = {
    async post(id, dir, body) {
      const r = await handleBoxClaimMailboxPost({ boxClaims: com.boxClaims, now: clock.now }, id, dir, { body });
      if (r.status !== 200) throw new Error(`post ${r.status}`);
    },
    async read(id, dir, after) {
      const r = await handleBoxClaimMailboxRead({ boxClaims: com.boxClaims, now: clock.now }, id, dir, String(after));
      return (r.body as { messages: Array<{ seq: number; body: string }> }).messages;
    },
  };
  const store = new ClaimStateStore(join(dir, "claim-state.json"), join(dir, "reset-marker.json"));
  const svc = new RetailClaimService({
    now: clock.now,
    bootAt: opts.t0,
    store,
    codes: new SetupCodeStore(join(dir, "setup-code.json")),
    peripheral: radio.peripheral(),
    keys,
    display: { show: async (code) => void shown.push(code), clear: async () => {} },
    ...(opts.mailbox ? { mailbox: mailboxClient } : {}),
    verifyRecipe,
    createIdentity: async () => {
      const id = newIdentity();
      identities.push(id);
      return id;
    },
    wipe: async () => {
      wipes.push(now);
      if (opts.wipeFails) throw new Error("power lost during the wipe");
    },
    network: {
      scan: async () => [{ ssid: "Home Net", security: "wpa2", signal: 80, band: "5" }],
      connect: async (w) => netQueue.shift() ?? { ok: true, via: w ? "wifi" : "ethernet" },
    },
    provision: async (text, identity) => {
      const id = identities.find((i) => i.stkHybridPubHex === identity.stkHybridPubHex)!;
      registrations.push(await registerAtCom(com, text, id.edSeed, now));
    },
    notify: (e) => void events.push(e),
    model: "Mini PC N100",
    imageVersion: "0.4.0",
    mailboxIdlePollMs: 1_000,
    mailboxActivePollMs: 1_000,
  });
  await svc.start({ timer: false });
  const settle = async () => {
    await svc.tick();
    await svc.settle();
  };
  /** One short press, then the burst's quiet time. */
  const press = async (count = 1, holdMs = 120) => {
    for (let i = 0; i < count; i++) {
      keys.down();
      clock.advance(holdMs);
      keys.up();
      clock.advance(300);
    }
    clock.advance(2_100);
    await settle();
  };
  const phone = (link?: ClaimLink) => new PhoneDriver(link ?? radio.connect(radio.scan()[0]!.id), settle);
  return { dir, svc, radio, keys, clock, shown, events, wipes, registrations, identities, press, settle, phone, store };
}

/** The phone's whole Bluetooth claim, with the hidden pause and its own press check. */
async function bluetoothClaim(box: Awaited<ReturnType<typeof makeBox>>, recipeText: string, opts: { serverDomain: string; serial: string }) {
  const p = box.phone();
  const ch = await p.handshake("open");
  const armSentAt = box.clock.now();
  await p.send({ t: "arm" });
  expect((await p.next()).t).toBe("armed");
  box.clock.advance(3_000);
  const instructionAt = box.clock.now();
  box.clock.advance(1_200);
  await box.press();
  const { msg: press } = await p.until("press");
  expect(judgePressReport({ armSentAt, instructionAt, atMs: press.atMs, count: press.count, long: press.long, receivedAt: box.clock.now() })).toBe("ok");
  expect(await p.next()).toEqual({ t: "press-result", ok: true });
  await p.send({ t: "claim", recipe: recipeText });
  const { msg } = await p.until("receipt");
  const v = verifyBoxClaimReceipt(msg.receipt, { transcriptHex: ch.transcriptHex, mode: "open", ...opts });
  return { p, ch, receipt: msg.receipt, stkPubHex: v.stkPubHex };
}

const T0 = Date.now();

describe("retail claim over Bluetooth", () => {
  it("app first, power, one press, recipe, key at .com, Wi-Fi, online under the receipt's key", async () => {
    const com = await makeCom(T0);
    const r = await com.recipe("home");
    const box = await makeBox(com, { t0: T0 });
    expect(box.radio.scan()).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{32}$/), state: "unclaimed" }]);
    box.clock.advance(15_000);

    const { p, stkPubHex } = await bluetoothClaim(box, r.text, { serverDomain: r.code.serverDomain, serial: r.code.serial });
    expect(box.svc.lifecycle).toBe("claimed");
    expect(box.radio.scan()).toEqual([]);

    expect((await preRegister(com, r.code, stkPubHex, box.clock.now())).status).toBe(200);
    await p.send({ t: "network", wifi: WIFI });
    const { msg: status, seen } = await p.until("network-status");
    expect(status).toEqual({ t: "network-status", stage: "connecting", via: "wifi" });
    expect(seen).toHaveLength(1);
    expect((await p.until("network-status")).msg).toEqual({ t: "network-status", stage: "online", via: "wifi" });
    await box.settle();

    expect(box.registrations).toEqual([expect.objectContaining({ status: 200 })]);
    expect((await com.s.servers.get(r.code.serverDomain))?.identityPubKeyHex).toBe(stkPubHex);
    const air = Buffer.concat(box.radio.frames.map((f) => Buffer.from(f))).toString("latin1");
    expect(air).not.toContain(WIFI.psk);
    expect(air).not.toContain(r.code.serial);
    expect(box.events).toContain("claimed");
  });

  it("a second claim of a claimed box finds nothing to connect to", async () => {
    const com = await makeCom(T0);
    const r = await com.recipe("home");
    const box = await makeBox(com, { t0: T0 });
    box.clock.advance(15_000);
    await bluetoothClaim(box, r.text, { serverDomain: r.code.serverDomain, serial: r.code.serial });
    expect(box.radio.scan()).toEqual([]);
    expect(() => box.radio.connect("anything")).toThrow();
  });

  it("goes quiet after its 10-minute window, and 5 presses reopen it on an unclaimed box", async () => {
    const com = await makeCom(T0);
    const box = await makeBox(com, { t0: T0 });
    box.clock.advance(BOX_CLAIM_ADVERTISE_MS);
    await box.settle();
    expect(box.radio.scan()).toEqual([]);
    await box.press(5);
    expect(box.radio.scan()[0]?.state).toBe("unclaimed");
  });

  it("refuses a recipe without a passed press, two presses, and a press before arm", async () => {
    const com = await makeCom(T0);
    const r = await com.recipe("home");
    const box = await makeBox(com, { t0: T0 });
    box.clock.advance(15_000);
    await box.press();
    const p = box.phone();
    await p.handshake("open");
    await p.send({ t: "claim", recipe: r.text });
    expect(await p.next()).toEqual({ t: "refused", reason: "no-grant" });
    await p.send({ t: "arm" });
    await p.next();
    box.clock.advance(3_000);
    await box.press(2);
    expect((await p.until("press-result")).msg).toEqual({ t: "press-result", ok: false, reason: "burst" });
    await p.send({ t: "claim", recipe: r.text });
    expect(await p.next()).toEqual({ t: "refused", reason: "no-grant" });
    expect(box.svc.lifecycle).toBe("unclaimed");
  });

  it("two phones arming at once abort each other", async () => {
    const com = await makeCom(T0);
    const box = await makeBox(com, { t0: T0 });
    box.clock.advance(15_000);
    const a = box.phone();
    const b = box.phone();
    await a.handshake("open");
    await b.handshake("open");
    await a.send({ t: "arm" });
    expect((await a.next()).t).toBe("armed");
    box.clock.advance(2_000);
    await b.send({ t: "arm" });
    expect(await b.next()).toEqual({ t: "press-result", ok: false, reason: "contention" });
    expect((await a.until("press-result")).msg).toEqual({ t: "press-result", ok: false, reason: "contention" });
    await box.press();
    expect(a.pending() + b.pending()).toBe(0);
  });

  it("reports the exact network failure and takes a corrected password", async () => {
    const com = await makeCom(T0);
    const r = await com.recipe("home");
    const box = await makeBox(com, { t0: T0, network: [{ ok: false, via: "wifi", failure: "wrong-password" }] });
    box.clock.advance(15_000);
    const { p, stkPubHex } = await bluetoothClaim(box, r.text, { serverDomain: r.code.serverDomain, serial: r.code.serial });
    await preRegister(com, r.code, stkPubHex, box.clock.now());
    await p.send({ t: "wifi-scan" });
    expect((await p.until("wifi-list")).msg.networks[0]?.ssid).toBe("Home Net");
    await p.send({ t: "network", wifi: { ...WIFI, psk: "wrong password" } });
    await p.until("network-status");
    expect((await p.until("network-status")).msg).toEqual({ t: "network-status", stage: "failed", via: "wifi", failure: "wrong-password" });
    expect(box.registrations).toEqual([]);
    await p.send({ t: "network", wifi: WIFI });
    await p.until("network-status");
    expect((await p.until("network-status")).msg).toMatchObject({ stage: "online" });
    await box.settle();
    expect(box.registrations[0]?.status).toBe(200);
  });
});

/**
 * A relay in Bluetooth range: it plays the box to the phone and the phone to the box, passes the
 * user's real press on, forwards the recipe to the real box and signs its own receipt (§6.1
 * "pass it on"). The phone pre-registers the relay's key, so the real box is refused at `.com`.
 */
describe("a relay that passes the claim on", () => {
  it("is caught: the real box is refused at registration and never comes online", async () => {
    const com = await makeCom(T0);
    const r = await com.recipe("home");
    const box = await makeBox(com, { t0: T0 });
    box.clock.advance(15_000);

    const toBox = box.phone();
    await toBox.handshake("open");

    const fakeRadio = new InMemoryBleRadio();
    let phoneSide: ClaimLink | null = null;
    fakeRadio.peripheral().onLink((l) => {
      phoneSide = l;
    });
    await fakeRadio.peripheral().advertise({ id: "f".repeat(32), state: "unclaimed" });
    const relayInbox: Uint8Array[] = [];
    const phoneLink = fakeRadio.connect("f".repeat(32));
    phoneSide!.onMessage((m) => relayInbox.push(m));
    let relayCh: BoxClaimChannel | null = null;
    let pending: ReturnType<typeof acceptBoxClaim>["pending"] | null = null;
    const attacker = newIdentity();
    const relaySend = (obj: unknown, kind = BOX_CLAIM_FRAME_RECORD) =>
      phoneSide!.send(encodeClaimMessage(kind, kind === BOX_CLAIM_FRAME_RECORD ? relayCh!.sealJson(obj as never) : new TextEncoder().encode(JSON.stringify(obj))));
    const relayPump = async () => {
      await box.settle();
      for (let m = relayInbox.shift(); m; m = relayInbox.shift()) {
        const { kind, payload } = decodeClaimMessage(m);
        if (kind === BOX_CLAIM_FRAME_HANDSHAKE) {
          const o = JSON.parse(new TextDecoder().decode(payload));
          if (o.t === "hello") {
            const a = acceptBoxClaim({ hello: o, state: "unclaimed", codeKey: null });
            pending = a.pending;
            await relaySend(a.accept, BOX_CLAIM_FRAME_HANDSHAKE);
          } else {
            const c = completeBoxClaim(pending!, o);
            relayCh = c.channel;
            await relaySend(c.ready, BOX_CLAIM_FRAME_HANDSHAKE);
          }
          continue;
        }
        await toBox.send(relayCh!.openJson(payload) as never);
        await box.settle();
      }
      while (toBox.pending() > 0) {
        const back = await toBox.next();
        if (back.t === "receipt") {
          const forged: BoxClaimReceiptWire = await signBoxClaimReceipt(
            { ...back.receipt, transcript: relayCh!.transcriptHex, stkHybridPub: attacker.stkHybridPubHex },
            attacker.sign,
          );
          await relaySend({ t: "receipt", receipt: forged });
        } else {
          await relaySend(back);
        }
      }
    };

    const phone = new PhoneDriver(phoneLink, relayPump);
    const ch = await phone.handshake("open");
    await phone.send({ t: "arm" });
    expect((await phone.next()).t).toBe("armed");
    box.clock.advance(3_000);
    await box.press();
    await phone.until("press-result");
    await phone.send({ t: "claim", recipe: r.text });
    const { msg } = await phone.until("receipt");
    const v = verifyBoxClaimReceipt(msg.receipt, { transcriptHex: ch.transcriptHex, mode: "open", serverDomain: r.code.serverDomain, serial: r.code.serial });
    expect(v.stkPubHex).toBe(attacker.stkHybridPubHex.slice(0, 64));

    expect((await preRegister(com, r.code, v.stkPubHex, box.clock.now())).status).toBe(200);
    await phone.send({ t: "network", wifi: null });
    await phone.until("network-status");
    await box.settle();

    expect(box.registrations).toEqual([{ status: 403, body: expect.objectContaining({ code: "box-key-mismatch" }) }]);
    expect(await com.s.servers.get(r.code.serverDomain)).toBeFalsy();
    expect((await com.s.authCodes.get(r.code.serial))?.status).toBe("active");
  });

  it("forwarding the real box's own receipt is refused on the phone", async () => {
    const com = await makeCom(T0);
    const r = await com.recipe("home");
    const box = await makeBox(com, { t0: T0 });
    box.clock.advance(15_000);
    const { receipt } = await bluetoothClaim(box, r.text, { serverDomain: r.code.serverDomain, serial: r.code.serial });
    const otherSession = "ab".repeat(64);
    expect(() => verifyBoxClaimReceipt(receipt, { transcriptHex: otherSession, mode: "open", serverDomain: r.code.serverDomain, serial: r.code.serial })).toThrow("transcript-mismatch");
  });
});

describe("reset window and re-claim", () => {
  it("5 presses keep the server unchanged unless a new claim completes; then wipe, new key, new owner", async () => {
    const com = await makeCom(T0);
    const first = await com.recipe("home");
    const box = await makeBox(com, { t0: T0 });
    box.clock.advance(15_000);
    const one = await bluetoothClaim(box, first.text, { serverDomain: first.code.serverDomain, serial: first.code.serial });

    await box.press(5);
    expect(box.events).toContain("reset-window-opened");
    expect(box.radio.scan()[0]?.state).toBe("reset-window");
    box.clock.advance(BOX_CLAIM_RESET_WINDOW_MS);
    await box.settle();
    expect(box.events).toContain("reset-window-closed");
    expect(box.radio.scan()).toEqual([]);
    expect(box.svc.lifecycle).toBe("claimed");
    expect(box.wipes).toEqual([]);

    const second = await com.recipe("cabin");
    await box.press(5);
    const two = await bluetoothClaim(box, second.text, { serverDomain: second.code.serverDomain, serial: second.code.serial });
    expect(box.wipes).toHaveLength(1);
    expect(two.stkPubHex).not.toBe(one.stkPubHex);
    expect(box.svc.lifecycle).toBe("claimed");
    expect(existsSync(join(box.dir, "reset-marker.json"))).toBe(false);
  });

  it("a power cut during the wipe leaves the box locked until a fresh 5-press reset", async () => {
    const com = await makeCom(T0);
    const first = await com.recipe("home");
    const dir = mkdtempSync(join(tmpdir(), "retail-box-"));
    const box = await makeBox(com, { t0: T0, dir, wipeFails: true });
    box.clock.advance(15_000);
    await bluetoothClaim(box, first.text, { serverDomain: first.code.serverDomain, serial: first.code.serial });
    await box.press(5);
    const second = await com.recipe("cabin");
    const p = box.phone();
    await p.handshake("open");
    await p.send({ t: "arm" });
    await p.next();
    box.clock.advance(3_000);
    await box.press();
    await p.until("press-result");
    await p.send({ t: "claim", recipe: second.text });
    await box.settle();
    expect(existsSync(join(dir, "reset-marker.json"))).toBe(true);

    const rebooted = await makeBox(com, { t0: box.clock.now(), dir });
    expect(rebooted.svc.lifecycle).toBe("locked");
    expect(rebooted.events).toContain("locked");
    rebooted.clock.advance(15_000);
    await rebooted.settle();
    expect(rebooted.radio.scan()).toEqual([]);
    await rebooted.press(5);
    expect(rebooted.radio.scan()[0]?.state).toBe("reset-window");
    const third = await com.recipe("attic");
    await bluetoothClaim(rebooted, third.text, { serverDomain: third.code.serverDomain, serial: third.code.serial });
    expect(rebooted.svc.lifecycle).toBe("claimed");
    expect(existsSync(join(dir, "reset-marker.json"))).toBe(false);
  });
});

describe("the sharing method: a setup code on a monitor and a remote claim", () => {
  it("3 presses show a code; whoever holds it claims over the internet through a blind mailbox", async () => {
    const com = await makeCom(T0);
    const r = await com.recipe("home");
    const box = await makeBox(com, { t0: T0, mailbox: true });
    box.clock.advance(15_000);
    await box.press(3);
    expect(box.shown).toHaveLength(1);
    const code = box.shown[0]!;

    box.clock.advance(BOX_CLAIM_ADVERTISE_MS);
    await box.settle();
    expect(box.radio.scan()).toEqual([]);

    const mailboxId = setupCodeMailboxId(code);
    const client: MailboxClient = {
      post: async (id, dir, body) => void (await handleBoxClaimMailboxPost({ boxClaims: com.boxClaims, now: box.clock.now }, id, dir, { body })),
      read: async (id, dir, after) => ((await handleBoxClaimMailboxRead({ boxClaims: com.boxClaims, now: box.clock.now }, id, dir, String(after))).body as { messages: Array<{ seq: number; body: string }> }).messages,
    };
    const remote = new MailboxLink("remote", client, mailboxId, "phone");
    const phone = new PhoneDriver(remote, async () => {
      box.clock.advance(1_000);
      await box.settle();
      await remote.poll();
    });
    const ch = await phone.handshake("code", code);
    await phone.send({ t: "claim", recipe: r.text });
    const { msg } = await phone.until("receipt");
    const v = verifyBoxClaimReceipt(msg.receipt, { transcriptHex: ch.transcriptHex, mode: "code", serverDomain: r.code.serverDomain, serial: r.code.serial });
    expect((await preRegister(com, r.code, v.stkPubHex, box.clock.now())).status).toBe(200);
    await phone.send({ t: "network", wifi: null });
    await phone.until("network-status");
    expect((await phone.until("network-status")).msg).toEqual({ t: "network-status", stage: "online", via: "ethernet" });
    await box.settle();
    expect(box.registrations[0]?.status).toBe(200);

    const stored = await com.boxClaims.readMessages(mailboxId, "to-box", 0, box.clock.now());
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(mailboxId).not.toContain(code);
    expect(existsSync(join(box.dir, "setup-code.json"))).toBe(false);
  });

  it("five wrong codes close the radio until the next power-on", async () => {
    const com = await makeCom(T0);
    const box = await makeBox(com, { t0: T0 });
    box.clock.advance(15_000);
    await box.press(3);
    for (let i = 0; i < 5; i++) {
      const p = box.phone();
      await expect(p.handshake("code", "0000-0000-0000-0000-0000")).rejects.toThrow();
    }
    await box.settle();
    expect(box.events).toContain("radio-closed");
    expect(box.radio.scan()).toEqual([]);
  });

  it("a code dies when the reset window opens", async () => {
    const com = await makeCom(T0);
    const r = await com.recipe("home");
    const box = await makeBox(com, { t0: T0 });
    box.clock.advance(15_000);
    await bluetoothClaim(box, r.text, { serverDomain: r.code.serverDomain, serial: r.code.serial });
    await box.press(5);
    await box.press(3);
    expect(existsSync(join(box.dir, "setup-code.json"))).toBe(true);
    box.clock.advance(BOX_CLAIM_RESET_WINDOW_MS);
    await box.settle();
    expect(box.radio.scan()).toEqual([]);
    await box.press(5);
    expect(existsSync(join(box.dir, "setup-code.json"))).toBe(false);
  });
});

describe("Release this box (an admin-root order) and the owner's notices", () => {
  async function claimedBox(opts: { wipeFails?: boolean } = {}) {
    const com = await makeCom(T0);
    const r = await com.recipe("home");
    const dir = mkdtempSync(join(tmpdir(), "retail-box-"));
    const box = await makeBox(com, { t0: T0, dir, ...(opts.wipeFails ? { wipeFails: true } : {}) });
    box.clock.advance(15_000);
    const c = await bluetoothClaim(box, r.text, { serverDomain: r.code.serverDomain, serial: r.code.serial });
    const stkPubHex = c.stkPubHex.slice(0, 64);
    let restarted = 0;
    const consumer = new BoxReleaseConsumer({
      serverDomain: r.code.serverDomain,
      stkPubHex: () => stkPubHex,
      adminRootPub: () => admin.publicKey,
      statePath: join(dir, "box-release.json"),
      now: box.clock.now,
      release: () => box.svc.release(),
      afterRelease: () => void restarted++,
    });
    const order = (o: Partial<BoxReleaseOrder> = {}): BoxReleaseOrder => ({ serverDomain: r.code.serverDomain, stkPubHex, issuedAt: box.clock.now(), nonceHex: "ab".repeat(16), ...o });
    const signed = (o: BoxReleaseOrder, key: Keypair = admin) => ({ order: o, signatureHex: hex(signBoxRelease(o, key)) });
    return { box, consumer, order, signed, restarted: () => restarted, dir, r };
  }

  it("wipes back to unclaimed under the admin root, and the box advertises again", async () => {
    const t = await claimedBox();
    const res = await t.consumer.take(t.signed(t.order()));
    expect(res).toEqual({ ok: true });
    expect(t.box.wipes).toHaveLength(1);
    expect(t.box.svc.lifecycle).toBe("unclaimed");
    expect(t.box.events).toEqual(expect.arrayContaining(["locked", "released"]));
    expect(existsSync(join(t.dir, "reset-marker.json"))).toBe(false);
    expect((await t.box.store.load()).lifecycle).toBe("unclaimed");
    await t.box.settle();
    expect(t.box.radio.scan()[0]?.state).toBe("unclaimed");
    expect(await t.consumer.take(t.signed(t.order({ issuedAt: t.box.clock.now() + 1 })))).toMatchObject({ ok: false, code: "release-not-claimed" });
  });

  it("refuses the IRK, another box, a replay, a far clock and junk", async () => {
    const t = await claimedBox();
    expect(await t.consumer.take(t.signed(t.order(), irk))).toMatchObject({ ok: false, status: 403, code: "release-not-admin" });
    expect(await t.consumer.take(t.signed(t.order({ stkPubHex: "00".repeat(32) })))).toMatchObject({ ok: false, code: "release-other-server" });
    expect(await t.consumer.take(t.signed(t.order({ serverDomain: "cabin.harry.flagship.services" })))).toMatchObject({ ok: false, code: "release-other-server" });
    expect(await t.consumer.take(t.signed(t.order({ issuedAt: t.box.clock.now() - 11 * 60_000 })))).toMatchObject({ ok: false, code: "release-clock" });
    expect(await t.consumer.take({ order: { nope: 1 }, signatureHex: "00" })).toMatchObject({ ok: false, code: "release-unreadable" });
    expect(t.box.wipes).toEqual([]);
    const o = t.order();
    t.box.wipes.length = 0;
    const noRoot = new BoxReleaseConsumer({ serverDomain: t.r.code.serverDomain, stkPubHex: () => o.stkPubHex, adminRootPub: () => null, statePath: join(t.dir, "x.json"), release: async () => {} });
    expect(await noRoot.take(t.signed(o))).toMatchObject({ ok: false, code: "release-no-admin-root" });
    const tampered = t.signed(o);
    tampered.order = { ...o, nonceHex: "cd".repeat(16) };
    expect(await t.consumer.take(tampered)).toMatchObject({ ok: false, code: "release-not-admin" });
    expect(t.box.svc.lifecycle).toBe("claimed");
  });

  it("an order is taken once", async () => {
    const t = await claimedBox({ wipeFails: true });
    const o = t.signed(t.order());
    expect(await t.consumer.take(o)).toMatchObject({ ok: false, code: "release-failed" });
    expect(t.box.svc.lifecycle).toBe("locked");
    expect(existsSync(join(t.dir, "reset-marker.json"))).toBe(true);
    expect(await t.consumer.take(o)).toMatchObject({ ok: false, code: "release-replayed" });
  });

  it("the reset window becomes an Activity entry, a phone alert and one content-free wake", async () => {
    const notes: Array<{ kind: string; ok?: boolean }> = [];
    const alerts: unknown[] = [];
    let wakes = 0;
    const notify = retailNotices({ note: (kind, _d, o) => void notes.push({ kind, ...o }), alert: (a) => void alerts.push(a), wake: async () => void wakes++, now: () => 1000 });
    notify("reset-window-opened");
    notify("reset-window-closed");
    notify("claimed");
    expect(notes.map((n) => n.kind)).toEqual([RESET_WINDOW_OPENED, "server.retail.reset-window-closed"]);
    expect(notes[0]!.ok).toBe(false);
    expect(alerts).toEqual([{ kind: "reset-window-opened", serviceId: "", at: 1000, until: 1000 + BOX_CLAIM_RESET_WINDOW_MS }]);
    expect(wakes).toBe(1);
  });

  it("the box's recipe check takes a signed recipe and refuses a changed or expired one", async () => {
    const com = await makeCom(T0);
    const r = await com.recipe("home");
    expect(verifyClaimRecipe(r.text, T0)).toEqual({ ok: true, serverDomain: r.code.serverDomain, serial: r.code.serial });
    expect(verifyClaimRecipe(r.text, T0 + 7 * 3600_000)).toEqual({ ok: false, reason: "recipe-expired" });
    expect(verifyClaimRecipe(r.text.replace('"home"', '"cabin"'), T0)).toEqual({ ok: false, reason: "recipe-invalid" });
    expect(verifyClaimRecipe("{", T0)).toEqual({ ok: false, reason: "recipe-invalid" });
  });
});
