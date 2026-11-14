import { describe, expect, it } from "vitest";
import { ed, signPushTokenRegister, type Keypair } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handlePushRegister, QUARANTINE_MS } from "../src/push.js";
import { buildPushForwarder, unifiedPushPayload, UNIFIEDPUSH_PAD_BLOCK, type FetchLike } from "../src/pushBridge.js";
import { checkPushEndpointUrl, checkWebPushSubscription, resolvePushEndpointHost } from "../src/pushEndpointGuard.js";

const VAPID_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgcVB2+bq/sRVh4a9z
XK+4vc8tAkTF5R7XlJLioNYePZehRANCAATxCC37T/vfvyrC9DWfgVwPQ21tFt1n
NCEaFHQPSliSCPNgeoIJnVCmBnBTHnJB70P222WNXY/q0LCdmx/jxPfr
-----END PRIVATE KEY-----`;

function b64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function uaKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, pub, auth };
}

function subscription(endpoint: string, pub: Uint8Array = new Uint8Array(65).fill(4), auth: Uint8Array = new Uint8Array(16).fill(1)) {
  return JSON.stringify({ endpoint, keys: { p256dh: b64url(pub), auth: b64url(auth) } });
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

async function decrypt(body: Uint8Array, ua: Awaited<ReturnType<typeof uaKeys>>): Promise<{ plaintext: Uint8Array; paddedLength: number }> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const ephPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const eph = await crypto.subtle.importKey("raw", ephPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: eph }, ua.kp.privateKey, 256));
  const enc = new TextEncoder();
  const ikm = await hkdf(ua.auth, shared, new Uint8Array([...enc.encode("WebPush: info\0"), ...ua.pub, ...ephPub]), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(0x02);
  return { plaintext: padded.slice(0, end), paddedLength: padded.length };
}

interface Call { url: string; init?: Parameters<FetchLike>[1] }

function recordingFetch(status = 201): { f: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return { ok: status >= 200 && status < 300, status, text: async () => "", json: async () => ({}) };
  };
  return { f, calls };
}

describe("push endpoint guard", () => {
  it("accepts public https push services", () => {
    for (const u of [
      "https://ntfy.sh/upAbc123?up=1",
      "https://push.example.org:8443/x",
      "https://fcm.googleapis.com/wp/abc",
      "https://[2606:4700::1111]/up",
      "https://1.1.1.1/up",
      "https://ntfy.alice.flagship.services/up",
    ]) expect(checkPushEndpointUrl(u).ok, u).toBe(true);
  });

  it("refuses http, credentials, private and loopback addresses, local names and Flagship's own hosts", () => {
    for (const u of [
      "http://ntfy.sh/up",
      "ftp://ntfy.sh/up",
      "https://user:pw@ntfy.sh/up",
      "https://localhost/up",
      "https://foo.localhost/up",
      "https://printer.local/up",
      "https://metadata.internal/up",
      "https://router.home.arpa/up",
      "https://intranet/up",
      "https://127.0.0.1/up",
      "https://10.1.2.3/up",
      "https://172.16.0.1/up",
      "https://192.168.1.1/up",
      "https://169.254.169.254/latest",
      "https://100.64.0.1/up",
      "https://0.0.0.0/up",
      "https://2130706433/up",
      "https://0x7f000001/up",
      "https://017700000001/up",
      "https://[::1]/up",
      "https://[::]/up",
      "https://[fe80::1]/up",
      "https://[fd00::1]/up",
      "https://[::ffff:127.0.0.1]/up",
      "https://[::ffff:10.0.0.1]/up",
      "https://[64:ff9b::a00:1]/up",
      "https://[2001:db8::1]/up",
      "https://[ff02::1]/up",
      "https://224.0.0.1/up",
      "https://flagshipserver.com/api/push/relay",
      "https://webapp.flagshipserver.com/x",
      "https://flagship-com.example.workers.dev/x",
      "not a url",
      `https://ntfy.sh/${"a".repeat(1100)}`,
    ]) expect(checkPushEndpointUrl(u).ok, u).toBe(false);
  });

  it("honours a deployment's extra blocked hosts", () => {
    expect(checkPushEndpointUrl("https://gym.example.com/x", { blockedHosts: ["gym.example.com"] }).ok).toBe(false);
  });

  it("checks a subscription's RFC 8291 keys", () => {
    expect(checkWebPushSubscription(subscription("https://ntfy.sh/up")).ok).toBe(true);
    expect(checkWebPushSubscription(subscription("https://ntfy.sh/up", new Uint8Array(33))).ok).toBe(false);
    expect(checkWebPushSubscription(subscription("https://ntfy.sh/up", undefined, new Uint8Array(8))).ok).toBe(false);
    expect(checkWebPushSubscription("{}").ok).toBe(false);
    expect(checkWebPushSubscription("not json").ok).toBe(false);
  });

  it("resolves the host over DoH and refuses any non-public answer", async () => {
    const answers: Record<string, Array<{ type: number; data: string }>> = {
      "ntfy.sh|A": [{ type: 5, data: "x." }, { type: 1, data: "159.203.148.75" }],
      "ntfy.sh|AAAA": [],
      "evil.example|A": [{ type: 1, data: "93.184.216.34" }, { type: 1, data: "10.0.0.5" }],
      "evil.example|AAAA": [],
      "six.example|A": [],
      "six.example|AAAA": [{ type: 28, data: "fd12::5" }],
      "none.example|A": [],
      "none.example|AAAA": [],
    };
    const doh: FetchLike = async (url) => {
      const u = new URL(url);
      const key = `${u.searchParams.get("name")}|${u.searchParams.get("type")}`;
      return { ok: true, status: 200, text: async () => "", json: async () => ({ Status: 0, Answer: answers[key] ?? [] }) };
    };
    expect(await resolvePushEndpointHost(new URL("https://ntfy.sh/up"), doh)).toBe(true);
    expect(await resolvePushEndpointHost(new URL("https://evil.example/up"), doh)).toBe(false);
    expect(await resolvePushEndpointHost(new URL("https://six.example/up"), doh)).toBe(false);
    expect(await resolvePushEndpointHost(new URL("https://none.example/up"), doh)).toBe(false);
    const down: FetchLike = async () => ({ ok: false, status: 502, text: async () => "", json: async () => ({}) });
    expect(await resolvePushEndpointHost(new URL("https://ntfy.sh/up"), down)).toBe(false);
  });
});

describe("UnifiedPush delivery", () => {
  const cfg = {
    webpush: { vapidPrivateKeyPem: VAPID_TEST_KEY, vapidPublicKeyB64Url: "BKey", contact: "mailto:ops@example.org" },
  };

  it("sends the FCM data map RFC 8291-encrypted and padded, with VAPID, high urgency and no redirects", async () => {
    const ua = await uaKeys();
    const { f, calls } = recordingFetch();
    const forward = buildPushForwarder({ ...cfg, fetchImpl: f, now: () => 1_700_000_000_000 });
    const r = await forward({
      targets: [{ tokenId: "t", platform: "unifiedpush", providerToken: subscription("https://ntfy.sh/upXYZ?up=1", ua.pub, ua.auth) }],
      category: "secret-request",
      sealedPayloadHex: "ab".repeat(3000),
      displayData: { kind: "secret-request", deepLink: "https://flagshipserver.com/app/secret-requests" },
    });
    expect(r).toEqual({ ok: true, sent: 1, failed: 0 });
    const c = calls[0]!;
    expect(c.url).toBe("https://ntfy.sh/upXYZ?up=1");
    expect(c.init?.redirect).toBe("manual");
    expect(c.init?.headers?.urgency).toBe("high");
    expect(c.init?.headers?.["content-encoding"]).toBe("aes128gcm");
    expect(c.init?.headers?.authorization).toMatch(/^vapid t=ey.+, k=BKey$/);
    const body = new Uint8Array(c.init!.body as ArrayBuffer);
    const { plaintext, paddedLength } = await decrypt(body, ua);
    expect(paddedLength % UNIFIEDPUSH_PAD_BLOCK).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      kind: "secret-request",
      deepLink: "https://flagshipserver.com/app/secret-requests",
      category: "secret-request",
    });
  });

  it("pads categories to the same length", async () => {
    const ua = await uaKeys();
    const { f, calls } = recordingFetch();
    const forward = buildPushForwarder({ ...cfg, fetchImpl: f });
    for (const category of ["messages", "secret-request", "abuse-notice"]) {
      await forward({
        targets: [{ tokenId: "t", platform: "unifiedpush", providerToken: subscription("https://ntfy.sh/up", ua.pub, ua.auth) }],
        category,
        sealedPayloadHex: "",
      });
    }
    const lengths = new Set(calls.map((c) => (c.init!.body as ArrayBuffer).byteLength));
    expect(lengths.size).toBe(1);
  });

  it("never calls a private or plain-http endpoint", async () => {
    const { f, calls } = recordingFetch();
    const forward = buildPushForwarder({ ...cfg, fetchImpl: f });
    const r = await forward({
      targets: [
        { tokenId: "a", platform: "unifiedpush", providerToken: subscription("https://169.254.169.254/latest") },
        { tokenId: "b", platform: "unifiedpush", providerToken: subscription("http://ntfy.sh/up") },
        { tokenId: "c", platform: "webpush", providerToken: subscription("https://192.168.0.10/push") },
      ],
      category: "messages",
      sealedPayloadHex: "",
    });
    expect(r).toEqual({ ok: false, sent: 0, failed: 3 });
    expect(calls).toHaveLength(0);
  });

  it("counts a redirect as a failure", async () => {
    const { f } = recordingFetch(307);
    const forward = buildPushForwarder({ ...cfg, fetchImpl: f });
    const r = await forward({
      targets: [{ tokenId: "a", platform: "unifiedpush", providerToken: subscription("https://ntfy.sh/up", (await uaKeys()).pub) }],
      category: "messages",
      sealedPayloadHex: "",
    });
    expect(r.failed).toBe(1);
  });

  it("drops display fields that would not fit in one record", () => {
    const big = unifiedPushPayload("provision-status", { kind: "k", detail: "x".repeat(5000) });
    expect(JSON.parse(new TextDecoder().decode(big))).toEqual({ kind: "k", category: "provision-status" });
  });
});

const deviceId = "01".repeat(16);

function keypair(fill: number): Keypair {
  const privateKey = new Uint8Array(32).fill(fill);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

async function harness() {
  const storage = new InMemoryStorage();
  const device = keypair(3);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(keypair(2).publicKey), claimedAt: 1 });
  await storage.deviceIdentities.put({
    accountId: "alice", deviceId, devicePubHex: hex(device.publicKey), platformClass: "android",
    createdAt: 1, lastSeenAt: 1, revokedAt: null,
  });
  return { storage, device };
}

function body(device: Keypair, platform: "fcm" | "unifiedpush", providerToken: string, issuedAt = 100) {
  const pushX25519Pub = new Uint8Array(32).fill(7);
  const claim = { username: "alice", deviceId, platform, providerToken, pushX25519Pub, issuedAt };
  return { request: { ...claim, pushX25519Pub: hex(pushX25519Pub) }, signature: hex(signPushTokenRegister(claim, device)) };
}

describe("UnifiedPush registration", () => {
  it("accepts a signed UnifiedPush subscription after the DNS check", async () => {
    const { storage, device } = await harness();
    const seen: string[] = [];
    const r = await handlePushRegister({
      pushTokens: storage.pushTokens, deviceIdentities: storage.deviceIdentities, usernames: storage.usernames,
      now: () => 100, checkPushEndpointHost: async (u) => { seen.push(u.hostname); return true; },
    }, body(device, "unifiedpush", subscription("https://ntfy.sh/upAbc?up=1")));
    expect(r.status).toBe(200);
    expect(seen).toEqual(["ntfy.sh"]);
    const [row] = await storage.pushTokens.listByUser("alice");
    expect(row?.platform).toBe("unifiedpush");
  });

  it("refuses non-https, private and non-resolving endpoints", async () => {
    const { storage, device } = await harness();
    const deps = { pushTokens: storage.pushTokens, deviceIdentities: storage.deviceIdentities, usernames: storage.usernames, now: () => 100 };
    expect((await handlePushRegister(deps, body(device, "unifiedpush", subscription("http://ntfy.sh/up")))).status).toBe(400);
    expect((await handlePushRegister(deps, body(device, "unifiedpush", subscription("https://10.0.0.1/up")))).status).toBe(400);
    expect((await handlePushRegister(deps, body(device, "unifiedpush", "opaque-token"))).status).toBe(400);
    expect((await handlePushRegister({ ...deps, checkPushEndpointHost: async () => false }, body(device, "unifiedpush", subscription("https://rebind.example/up")))).status).toBe(400);
    expect(await storage.pushTokens.listByUser("alice")).toHaveLength(0);
  });

  it("replaces the device's FCM token when it moves to UnifiedPush, keeping its quarantine", async () => {
    const { storage, device } = await harness();
    await storage.pushTokens.put({
      tokenId: "aa".repeat(16), username: "alice", deviceId, platform: "fcm", providerToken: "placeholder",
      pushX25519PubHex: "07".repeat(32), registrationSignatureHex: "00".repeat(64), registeredAt: 50, lastSeenAt: 50,
      quarantineUntil: 50 + QUARANTINE_MS, quarantineAlertsFiredBitmap: 1,
    });
    await storage.pushTokens.put({
      tokenId: "bb".repeat(16), username: "alice", deviceId: "02".repeat(16), platform: "fcm", providerToken: "other-device",
      pushX25519PubHex: "07".repeat(32), registrationSignatureHex: "00".repeat(64), registeredAt: 50, lastSeenAt: 50,
    });
    const r = await handlePushRegister({
      pushTokens: storage.pushTokens, deviceIdentities: storage.deviceIdentities, usernames: storage.usernames, now: () => 100,
    }, body(device, "unifiedpush", subscription("https://ntfy.sh/up")));
    expect(r.status).toBe(200);
    const rows = await storage.pushTokens.listByUser("alice");
    const mine = rows.filter((t) => t.deviceId === deviceId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.platform).toBe("unifiedpush");
    expect(mine[0]?.quarantineUntil).toBe(50 + QUARANTINE_MS);
    expect(mine[0]?.quarantineAlertsFiredBitmap).toBe(1);
    expect(rows.some((t) => t.providerToken === "other-device")).toBe(true);

    const back = await handlePushRegister({
      pushTokens: storage.pushTokens, deviceIdentities: storage.deviceIdentities, usernames: storage.usernames, now: () => 120,
    }, body(device, "fcm", "real-fcm-token", 120));
    expect(back.status).toBe(200);
    const after = (await storage.pushTokens.listByUser("alice")).filter((t) => t.deviceId === deviceId);
    expect(after.map((t) => t.platform)).toEqual(["fcm"]);
  });
});
