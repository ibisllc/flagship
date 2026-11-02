/**
 * deviceIntegrity.ts against Apple's and Google's documented formats, with a test CA standing in for Apple's App
 * Attest root (certificates built here in DER) and a fake fetch standing in for DeviceCheck, Google OAuth and the
 * Play Integrity API.
 */
import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCertificate, pemBlocks } from "@flagship/control-plane";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  APPLE_APP_ATTEST_ROOT_PEM,
  certDigestsB64url,
  checkPlayIntegrityVerdict,
  LiveDeviceIntegrity,
  parseIntegrityEvidence,
  verifyAppAttestAssertion,
  verifyAppAttestAttestation,
  type AppAttestPolicy,
} from "../src/deviceIntegrity.js";

const subtle = webcrypto.subtle as unknown as SubtleCrypto;
const NOW = Date.UTC(2026, 10, 2, 12);
const sha = (...parts: Uint8Array[]) => new Uint8Array(createHash("sha256").update(Buffer.concat(parts)).digest());
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

// ── DER ────────────────────────────────────────────────────────────────────
function tlv(tag: number, body: Uint8Array): Uint8Array {
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return cat(new Uint8Array([tag, ...len]), body);
}
const seq = (...xs: Uint8Array[]) => tlv(0x30, cat(...xs));
const set = (...xs: Uint8Array[]) => tlv(0x31, cat(...xs));
const int = (n: number) => tlv(0x02, new Uint8Array([n]));
const octets = (b: Uint8Array) => tlv(0x04, b);
function oid(s: string): Uint8Array {
  const p = s.split(".").map(Number);
  const out = [p[0]! * 40 + p[1]!];
  for (const v of p.slice(2)) {
    const bytes = [v & 0x7f];
    let x = Math.floor(v / 128);
    while (x > 0) {
      bytes.unshift((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
    out.push(...bytes);
  }
  return tlv(0x06, new Uint8Array(out));
}
const utc = (ms: number) => tlv(0x17, utf8(new Date(ms).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, utf8(cn)))));
function rawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const i = (b: Uint8Array) => {
    let v = b;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    return tlv(0x02, v[0]! & 0x80 ? cat(new Uint8Array([0]), v) : v);
  };
  return seq(i(raw.subarray(0, half)), i(raw.subarray(half)));
}

type Key = { pair: CryptoKeyPair; curve: "P-256" | "P-384"; spki: Uint8Array };
async function key(curve: "P-256" | "P-384"): Promise<Key> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { pair, curve, spki: new Uint8Array((await subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer) };
}
async function cert(o: { subject: string; issuer: string; key: Key; signer: Key; exts?: Uint8Array[]; notAfter?: number }): Promise<Uint8Array> {
  const hash = o.signer.curve === "P-384" ? "SHA-384" : "SHA-256";
  const alg = seq(oid(o.signer.curve === "P-384" ? "1.2.840.10045.4.3.3" : "1.2.840.10045.4.3.2"));
  const tbs = seq(
    tlv(0xa0, int(2)),
    int(7),
    alg,
    name(o.issuer),
    seq(utc(NOW - 86_400_000), utc(o.notAfter ?? NOW + 86_400_000 * 300)),
    name(o.subject),
    o.key.spki,
    ...(o.exts?.length ? [tlv(0xa3, seq(...o.exts))] : []),
  );
  const raw = new Uint8Array(await subtle.sign({ name: "ECDSA", hash }, o.signer.pair.privateKey, tbs));
  return seq(tbs, alg, tlv(0x03, cat(new Uint8Array([0]), rawToDer(raw))));
}

// ── CBOR ───────────────────────────────────────────────────────────────────
type C = number | string | Uint8Array | C[] | Map<C, C>;
function cbor(v: C): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24 ? new Uint8Array([(major << 5) | n]) : n < 256 ? new Uint8Array([(major << 5) | 24, n]) : new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return cat(head(3, utf8(v).length), utf8(v));
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (Array.isArray(v)) return cat(head(4, v.length), ...v.map(cbor));
  return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

// ── an App Attest world ────────────────────────────────────────────────────
const APP_ID = "TEAMID1234.com.flagshipserver.app";
const AAGUID_PROD = cat(utf8("appattest"), new Uint8Array(7));

async function appAttest(o: { aaguid?: Uint8Array; counter?: number; category?: number; badNonce?: boolean; credId?: Uint8Array } = {}) {
  const root = await key("P-384");
  const inter = await key("P-384");
  const leaf = await key("P-256");
  const rootDer = await cert({ subject: "Test Root", issuer: "Test Root", key: root, signer: root });
  const interDer = await cert({ subject: "Test App Attest CA", issuer: "Test Root", key: inter, signer: root });
  const pubRaw = leaf.spki.slice(leaf.spki.length - 65);
  const keyId = sha(pubRaw);
  const clientData = utf8("flagship/messages-key-attestation-request/v1|bob|...");
  const flags = o.category !== undefined ? 0x40 | 0x80 : 0x40;
  const counter = o.counter ?? 0;
  const authData = cat(
    sha(utf8(APP_ID)),
    new Uint8Array([flags, (counter >>> 24) & 0xff, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff]),
    o.aaguid ?? AAGUID_PROD,
    new Uint8Array([0, 32]),
    o.credId ?? keyId,
    cbor(new Map<C, C>([[1, 2], [3, -7]])),
    ...(o.category !== undefined ? [cbor(new Map<C, C>([["apple_validation_category_01", o.category]]))] : []),
  );
  const nonce = o.badNonce ? sha(utf8("other")) : sha(authData, sha(clientData));
  const nonceExt = seq(oid("1.2.840.113635.100.8.2"), octets(seq(tlv(0xa1, octets(nonce)))));
  const leafDer = await cert({ subject: "leaf", issuer: "Test App Attest CA", key: leaf, signer: inter, exts: [nonceExt] });
  const attestation = cbor(new Map<C, C>([["fmt", "apple-appattest"], ["attStmt", new Map<C, C>([["x5c", [leafDer, interDer]], ["receipt", new Uint8Array([1])]])], ["authData", authData]]));
  const policy: AppAttestPolicy = { appId: APP_ID, environment: "production", rootDer };
  async function assertion(data: Uint8Array, ctr: number): Promise<Uint8Array> {
    const ad = cat(sha(utf8(APP_ID)), new Uint8Array([0, 0, 0, 0, ctr]));
    const n = sha(ad, sha(data));
    const raw = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, leaf.pair.privateKey, n));
    return cbor(new Map<C, C>([["signature", rawToDer(raw)], ["authenticatorData", ad]]));
  }
  return { rootDer, attestation, keyId, clientData, clientDataHash: sha(clientData), policy, pubRaw, assertion };
}

describe("App Attest", () => {
  it("embeds Apple's root as published", () => {
    const der = pemBlocks(APPLE_APP_ATTEST_ROOT_PEM)[0]!;
    expect(createHash("sha256").update(der).digest("hex").toUpperCase()).toBe("1CB9823BA28BA6AD2D33A006941DE2AE4F513EF1D4E831B9F7E0FA7B6242C932");
    const c = parseCertificate(der);
    expect(c.publicKey.key).toEqual({ kind: "ec", curve: "P-384" });
    expect(c.notAfter).toBe(Date.UTC(2045, 2, 15));
  });

  it("verifies an attestation object and returns the attested key", async () => {
    const w = await appAttest({ category: 4 });
    const r = await verifyAppAttestAttestation(w.attestation, w.keyId, w.clientDataHash, w.policy, NOW);
    expect(r).toEqual({ ok: true, publicKey: w.pubRaw });
  });

  it("refuses each broken attestation", async () => {
    const cases: [Parameters<typeof appAttest>[0], string][] = [
      [{ badNonce: true }, "nonce"],
      [{ counter: 1 }, "counter"],
      [{ aaguid: utf8("appattestdevelop") }, "aaguid"],
      [{ credId: new Uint8Array(32) }, "credential id"],
      [{ category: 3 }, "validation category"],
    ];
    for (const [o, why] of cases) {
      const w = await appAttest(o);
      expect(await verifyAppAttestAttestation(w.attestation, w.keyId, w.clientDataHash, w.policy, NOW)).toEqual({ ok: false, why });
    }
    const w = await appAttest();
    expect((await verifyAppAttestAttestation(w.attestation, sha(utf8("x")), w.clientDataHash, w.policy, NOW)).ok).toBe(false);
    expect((await verifyAppAttestAttestation(w.attestation, w.keyId, sha(utf8("x")), w.policy, NOW)).ok).toBe(false);
    const other = await appAttest();
    expect(await verifyAppAttestAttestation(w.attestation, w.keyId, w.clientDataHash, { ...w.policy, rootDer: other.rootDer }, NOW)).toMatchObject({ ok: false });
    expect(await verifyAppAttestAttestation(w.attestation, w.keyId, w.clientDataHash, { ...w.policy, appId: "X.other" }, NOW)).toEqual({ ok: false, why: "rp id" });
    expect(await verifyAppAttestAttestation(w.attestation, w.keyId, w.clientDataHash, w.policy, NOW + 400 * 86_400_000)).toEqual({ ok: false, why: "certificate outside its validity" });
    expect(await verifyAppAttestAttestation(w.attestation, w.keyId, w.clientDataHash, { ...w.policy, environment: "development" }, NOW)).toEqual({ ok: false, why: "aaguid" });
  });

  it("verifies assertions over the request bytes with a rising counter", async () => {
    const w = await appAttest();
    const a1 = await w.assertion(w.clientData, 1);
    expect(await verifyAppAttestAssertion(a1, w.clientData, w.pubRaw, 0, w.policy)).toEqual({ ok: true, counter: 1 });
    expect(await verifyAppAttestAssertion(a1, w.clientData, w.pubRaw, 1, w.policy)).toEqual({ ok: false, why: "counter" });
    expect(await verifyAppAttestAssertion(a1, utf8("other request"), w.pubRaw, 0, w.policy)).toEqual({ ok: false, why: "signature" });
  });
});

describe("Play Integrity verdict", () => {
  const policy = { packageName: "com.flagshipserver.app", certDigests: certDigestsB64url(["3C:BF:B3:A6:75:A9:E0:73:91:D6:1C:25:58:D9:91:0C:E0:1D:A9:7C:2D:F3:55:9E:58:02:A2:94:ED:8F:7C:DD"]) };
  const good = (over: Record<string, unknown> = {}) => ({
    requestDetails: { requestPackageName: "com.flagshipserver.app", requestHash: "ab".repeat(32), timestampMillis: String(NOW - 5_000) },
    appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.flagshipserver.app", certificateSha256Digest: [policy.certDigests[0]], versionCode: "9" },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"], deviceRecall: { values: { bitFirst: true, bitSecond: false }, writeDates: { yyyymmFirst: 202611 } } },
    accountDetails: { appLicensingVerdict: "LICENSED" },
    ...over,
  });
  const want = { requestHash: "ab".repeat(32), now: NOW };

  it("reads the recall bits of a good verdict", () => {
    expect(checkPlayIntegrityVerdict(good(), want, policy)).toEqual({ ok: true, enrolledThisMonth: true, banned: false });
    const older = good({ deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"], deviceRecall: { values: { bitFirst: true, bitSecond: true }, writeDates: { yyyymmFirst: 202610 } } } });
    expect(checkPlayIntegrityVerdict(older, want, policy)).toEqual({ ok: true, enrolledThisMonth: false, banned: true });
    const noRecall = good({ deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] } });
    expect(checkPlayIntegrityVerdict(noRecall, want, policy)).toEqual({ ok: true, enrolledThisMonth: false, banned: false });
  });

  it("refuses a verdict for another request, app, certificate or device", () => {
    expect(checkPlayIntegrityVerdict(good(), { ...want, requestHash: "cd".repeat(32) }, policy)).toEqual({ ok: false, why: "request hash" });
    expect(checkPlayIntegrityVerdict(good(), { ...want, now: NOW + 3600_000 }, policy)).toEqual({ ok: false, why: "stale" });
    expect(checkPlayIntegrityVerdict(good({ appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" } }), want, policy)).toEqual({ ok: false, why: "app" });
    expect(checkPlayIntegrityVerdict(good({ appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.flagshipserver.app", certificateSha256Digest: ["AAAA"] } }), want, policy)).toEqual({ ok: false, why: "certificate" });
    expect(checkPlayIntegrityVerdict(good({ deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] } }), want, policy)).toEqual({ ok: false, why: "device" });
    expect(checkPlayIntegrityVerdict(good({ deviceIntegrity: {} }), want, policy)).toEqual({ ok: false, why: "device" });
  });
});

describe("evidence shape", () => {
  it("takes exactly one of attestation or assertion on iOS, and a token on Android", () => {
    expect(parseIntegrityEvidence({ platform: "ios", keyId: "a", attestation: "b", deviceToken: "c" }, "ios")).not.toBeNull();
    expect(parseIntegrityEvidence({ platform: "ios", keyId: "a", assertion: "b", deviceToken: "c" }, "ios")).not.toBeNull();
    expect(parseIntegrityEvidence({ platform: "ios", keyId: "a", attestation: "b", assertion: "b", deviceToken: "c" }, "ios")).toBeNull();
    expect(parseIntegrityEvidence({ platform: "ios", keyId: "a", deviceToken: "c" }, "ios")).toBeNull();
    expect(parseIntegrityEvidence({ platform: "android", token: "t.u-v_w" }, "android")).not.toBeNull();
    expect(parseIntegrityEvidence({ platform: "android", token: "t" }, "ios")).toBeNull();
    expect(parseIntegrityEvidence({ platform: "android", token: "t", extra: 1 }, "android")).toBeNull();
  });
});

async function pkcs8Pem(alg: "ec" | "rsa"): Promise<string> {
  const pair = (await subtle.generateKey(
    alg === "ec" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${b64(der)}\n-----END PRIVATE KEY-----\n`;
}

describe("LiveDeviceIntegrity", () => {
  it("iOS: attests once, then asserts, reads and writes DeviceCheck bits", async () => {
    const w = await appAttest();
    const db = createSqliteD1() as unknown as D1Database;
    const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    let bits: Record<string, unknown> | string = "Failed to find bit state";
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body, auth: new Headers(init.headers).get("authorization") ?? "" });
      if (url.endsWith("/v1/query_two_bits")) return new Response(typeof bits === "string" ? bits : JSON.stringify(bits));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const env = {
      DB: db,
      VOICI_DEVICE_SECRET: "s".repeat(32),
      APPLE_TEAM_ID: "TEAMID1234",
      APPLE_DEVICECHECK_KEY_ID: "KEY123",
      APPLE_DEVICECHECK_KEY: await pkcs8Pem("ec"),
    };
    const rootPem = `-----BEGIN CERTIFICATE-----\n${b64(w.rootDer)}\n-----END CERTIFICATE-----`;
    const live = new LiveDeviceIntegrity(env, fetchFn, rootPem);
    const first = await live.check({ platform: "ios", keyId: b64(w.keyId), attestation: b64(w.attestation), deviceToken: "dGtu" }, w.clientData, NOW);
    expect(first).toMatchObject({ attested: true, platform: "ios", enrolledThisMonth: false, banned: false, deviceToken: "dGtu" });
    expect(calls[0]!.url).toBe("https://api.devicecheck.apple.com/v1/query_two_bits");
    expect(calls[0]!.body).toMatchObject({ device_token: "dGtu", timestamp: NOW });
    const [h, c] = calls[0]!.auth.slice(7).split(".").slice(0, 2).map((p) => JSON.parse(Buffer.from(p, "base64url").toString()));
    expect(h).toEqual({ kid: "KEY123", alg: "ES256" });
    expect(c).toEqual({ iss: "TEAMID1234", iat: Math.floor(NOW / 1000) });
    expect((await live.check({ platform: "ios", keyId: b64(w.keyId), attestation: b64(w.attestation), deviceToken: "dGtu" }, w.clientData, NOW)).attested).toBe(false);

    bits = { bit0: true, bit1: false, last_update_time: "2026-11" };
    const req2 = utf8("second request");
    const ok = await live.check({ platform: "ios", keyId: b64(w.keyId), assertion: b64(await w.assertion(req2, 1)), deviceToken: "dGtu" }, req2, NOW);
    expect(ok).toMatchObject({ attested: true, enrolledThisMonth: true });
    const replay = await live.check({ platform: "ios", keyId: b64(w.keyId), assertion: b64(await w.assertion(req2, 1)), deviceToken: "dGtu" }, req2, NOW);
    expect(replay).toEqual({ attested: false, reason: "assertion: counter" });

    expect(await live.setBits("ios", "dGtu", { banned: true }, NOW)).toBe(true);
    expect(calls.at(-1)!.url).toBe("https://api.devicecheck.apple.com/v1/update_two_bits");
    expect(calls.at(-1)!.body).toMatchObject({ device_token: "dGtu", bit1: true });
    expect(calls.at(-1)!.body.bit0).toBeUndefined();
  });

  it("Android: decodes through Google and writes device recall", async () => {
    const requestBytes = utf8("the request");
    const requestHash = createHash("sha256").update(requestBytes).digest("hex");
    const calls: { url: string; body: string; auth: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: new Headers(init.headers).get("authorization") ?? "" });
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ya29.test", expires_in: 3600 });
      if (url.endsWith(":decodeIntegrityToken")) {
        return Response.json({
          tokenPayloadExternal: {
            requestDetails: { requestPackageName: "com.flagshipserver.app", requestHash, timestampMillis: String(NOW) },
            appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.flagshipserver.app", certificateSha256Digest: certDigestsB64url(["AC:A5:B6:B8:82:16:7C:01:1A:96:C4:46:33:03:65:EB:11:94:80:5C:2D:97:0A:7C:6D:CA:31:0F:C6:69:43:96"]) },
            deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
          },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const sa = JSON.stringify({ client_email: "pi@example.iam.gserviceaccount.com", private_key: await pkcs8Pem("rsa") });
    const live = new LiveDeviceIntegrity({ PLAY_INTEGRITY_SA_JSON: sa }, fetchFn);
    const r = await live.check({ platform: "android", token: "tok" }, requestBytes, NOW);
    expect(r).toMatchObject({ attested: true, platform: "android", enrolledThisMonth: false, banned: false, deviceToken: "tok" });
    expect(calls[0]!.body).toMatch(/^grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
    expect(calls[1]!.url).toBe("https://playintegrity.googleapis.com/v1/com.flagshipserver.app:decodeIntegrityToken");
    expect(calls[1]!.auth).toBe("Bearer ya29.test");
    expect(JSON.parse(calls[1]!.body)).toEqual({ integrityToken: "tok" });
    expect((await live.check({ platform: "android", token: "tok" }, utf8("another request"), NOW)).attested).toBe(false);
    expect(await live.setBits("android", "tok", { enrolled: true }, NOW)).toBe(true);
    expect(calls.at(-1)!.url).toBe("https://playintegrity.googleapis.com/v1/com.flagshipserver.app/deviceRecall:write");
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ integrityToken: "tok", newValues: { bitFirst: true } });
  });

  it("is unattested, not an error, when nothing is configured", async () => {
    const live = new LiveDeviceIntegrity({});
    expect(await live.check({ platform: "android", token: "t" }, utf8("x"), NOW)).toEqual({ attested: false, reason: "not-configured" });
    expect(await live.check({ platform: "ios", keyId: "a", assertion: "b", deviceToken: "c" }, utf8("x"), NOW)).toEqual({ attested: false, reason: "not-configured" });
    expect(await live.setBits("ios", "c", { banned: true }, NOW)).toBe(false);
  });
});
