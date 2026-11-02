/**
 * POST /api/accounts/<u>/messages-attestation (docs/voici-and-messages.md §6.3, §9.4, §9.5) over a real
 * D1-over-sqlite binding, with the device checks faked (FakeDeviceIntegrity). The last case is the privacy rule:
 * after many attestations no D1 row and no log line holds a pseudonym, a tag or an attestation hash.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { D1Storage, type D1Database } from "@flagship/storage";
import {
  checkMessagesKeyAttestation,
  ed,
  hybridSealKeygen,
  messagesAttestationHash,
  openVoiciAbuseTag,
  signAbuseKeyEntry,
  signAccountDirectoryRequest,
  signMessagesKeyAttestationRequest,
  b64Decode,
  type AbuseKeyEntry,
  type MessagesKeyAttestation,
  type MessagesKeyAttestationRequest,
} from "@flagship/protocol";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { handleVoiciAbuseRoute } from "../src/voiciAbuseRoutes.js";
import { FakeDeviceIntegrity } from "../src/deviceIntegrity.js";
import { newRecipientLimit } from "../src/messagesAttestation.js";
import { bundledAbuseKeys, caTrackHolders, verifiedAbuseKeys } from "../src/abuseKeys.js";
import { memoryRateLimits } from "./rateLimitFakes.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seed = (n: number) => new Uint8Array(32).fill(n);
const CA_PRIV = "ab".repeat(32);
const CA_PUB = hex(ed.getPublicKey(Buffer.from(CA_PRIV, "hex")));
const ABUSE_SEED = seed(0x55);
const ABUSE_PUB = hex(hybridSealKeygen(ABUSE_SEED).publicKey);
const ABUSE_KEYS: AbuseKeyEntry[] = [{ epoch: 4, xwingPub: ABUSE_PUB, notBefore: NOW - 30 * DAY, notAfter: NOW + 60 * DAY }];

interface Account {
  name: string;
  deviceSeed: Uint8Array;
  deviceId: string;
}

let reqSeq = 0;

async function world(opts: { ages?: Record<string, number>; rateLimits?: boolean } = {}) {
  const db = createSqliteD1() as unknown as D1Database;
  const storage = new D1Storage(db);
  const ages = opts.ages ?? { alice: 40 * DAY, bob: 40 * DAY, carol: 2 * DAY, dave: 10 * DAY, erin: 10 * DAY };
  const accounts: Record<string, Account> = {};
  let n = 10;
  for (const [name, age] of Object.entries(ages)) {
    n++;
    await storage.usernames.put({ username: name, irkPubHex: hex(ed.getPublicKey(seed(n + 100))), claimedAt: NOW - age });
    const a: Account = { name, deviceSeed: seed(n), deviceId: n.toString(16).padStart(32, "0") };
    await storage.deviceIdentities.put({ accountId: name, deviceId: a.deviceId, devicePubHex: hex(ed.getPublicKey(a.deviceSeed)), platformClass: "ios", createdAt: 1, lastSeenAt: 1, revokedAt: null });
    accounts[name] = a;
  }
  const integrity = new FakeDeviceIntegrity();
  let now = NOW;
  const limits = opts.rateLimits ? memoryRateLimits({ now: () => now }) : null;
  const env = { DB: db, VOICI_ENABLED: "on", FLAGSHIP_CA_PRIV_HEX: CA_PRIV, ...(limits ? { RATE_LIMITS: limits.ns } : {}) };

  async function attest(
    who: string,
    o: { p?: string; ref?: "ios" | "android" | "none"; integrity?: unknown; renewOf?: MessagesKeyAttestation; badSig?: boolean; ip?: string; username?: string; issuedAt?: number; abuseKeys?: AbuseKeyEntry[]; env?: Record<string, unknown> } = {},
  ) {
    const a = accounts[who]!;
    const p = o.p ?? hex(ed.getPublicKey(crypto.getRandomValues(new Uint8Array(32))));
    const ref = o.ref ?? "android";
    const request: MessagesKeyAttestationRequest = {
      username: o.username ?? who,
      pseudonymPub: p,
      renewOfHash: o.renewOf ? messagesAttestationHash(o.renewOf) : "",
      deviceCheckRef: ref,
      issuedAt: o.issuedAt ?? now,
    };
    const signature = signMessagesKeyAttestationRequest(request, o.badSig ? seed(0xee) : a.deviceSeed);
    const path = `/api/accounts/${who}/messages-attestation`;
    const dirReq = {
      accountId: who,
      deviceId: a.deviceId,
      signerPubHex: hex(ed.getPublicKey(a.deviceSeed)),
      method: "POST",
      path,
      requestId: (++reqSeq).toString(16).padStart(32, "0"),
      issuedAt: now,
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-flagship-device-id": dirReq.deviceId,
      "x-flagship-device-pub": dirReq.signerPubHex,
      "x-flagship-request-id": dirReq.requestId,
      "x-flagship-issued-at": String(now),
      "x-flagship-signature": signAccountDirectoryRequest(dirReq, { privateKey: a.deviceSeed, publicKey: ed.getPublicKey(a.deviceSeed) }),
      "cf-connecting-ip": o.ip ?? "203.0.113.9",
    };
    const integrityField = o.integrity !== undefined ? o.integrity : ref === "android" ? { platform: "android", token: `device-${who}` } : ref === "ios" ? { platform: "ios", keyId: "a2V5", assertion: "YXNy", deviceToken: `ZGV2${who}` } : undefined;
    const body = { request, signature, ...(integrityField !== undefined ? { integrity: integrityField } : {}), ...(o.renewOf ? { previous: o.renewOf } : {}) };
    const res = await handleVoiciAbuseRoute(
      new Request(`https://flagshipserver.com${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
      { ...env, ...(o.env ?? {}) } as never,
      undefined,
      { now: () => now, integrity, abuseKeys: o.abuseKeys ?? ABUSE_KEYS },
    );
    return { res, status: res.status, body: (await res.json()) as Record<string, any>, p };
  }
  return { db, storage, accounts, integrity, env, attest, advance: (ms: number) => (now += ms), now: () => now };
}

afterEach(() => vi.restoreAllMocks());

describe("messages key attestation", () => {
  it("answers 404 while VOICI_ENABLED is off", async () => {
    const w = await world();
    const r = await w.attest("alice", { env: { VOICI_ENABLED: "off" } });
    expect(r.status).toBe(404);
  });

  it("vouches for P with an abuse tag only the offline key opens, naming the asking account", async () => {
    const w = await world();
    const r = await w.attest("alice");
    expect(r.status).toBe(200);
    const att = r.body.attestation as MessagesKeyAttestation;
    const check = checkMessagesKeyAttestation(att, { caKeys: [CA_PUB], now: NOW, pseudonymPub: r.p });
    expect(check.ok).toBe(true);
    expect(att.abuseEpoch).toBe(4);
    expect(att.expiresAt - att.issuedAt).toBe(30 * DAY);
    const tag = openVoiciAbuseTag(ABUSE_SEED, r.p, b64Decode(att.abuseTag)!);
    expect(tag).toEqual({ v: 1, username: "alice", accountCreatedAt: NOW - 40 * DAY, issuedAt: NOW });
    const enr = await w.db.prepare("SELECT platform, device_token FROM messages_enrollments WHERE username = 'alice'").first<{ platform: string; device_token: string }>();
    expect(enr).toEqual({ platform: "android", device_token: "device-alice" });
    await Promise.resolve();
    expect(w.integrity.devices.get("device-alice")?.enrolledMonth).toBe("2026-11");
  });

  it("refuses bad device auth, another account's name, a stale request and malformed evidence", async () => {
    const w = await world();
    expect((await w.attest("alice", { badSig: true })).body.code).toBe("not-authorized");
    expect((await w.attest("alice", { username: "bob" })).status).toBe(400);
    expect((await w.attest("alice", { issuedAt: NOW - 11 * 60_000 })).body.code).toBe("stale");
    expect((await w.attest("alice", { integrity: { platform: "ios", keyId: "x", deviceToken: "y" } })).status).toBe(400);
    expect((await w.attest("alice", { ref: "none", integrity: { platform: "android", token: "t" } })).status).toBe(400);
  });

  it("caps new recipients per day by account age, and starts again the next UTC day", async () => {
    expect(newRecipientLimit(2 * DAY, true)).toBe(3);
    expect(newRecipientLimit(10 * DAY, true)).toBe(10);
    expect(newRecipientLimit(31 * DAY, true)).toBe(25);
    expect(newRecipientLimit(10 * DAY, false)).toBe(1);
    expect(newRecipientLimit(6 * DAY, false)).toBe("unattested-too-new");
    const w = await world();
    for (let i = 0; i < 3; i++) expect((await w.attest("carol")).status).toBe(200);
    const over = await w.attest("carol");
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ code: "first-contact-limit", limit: 3 });
    expect(over.body.retryAfterSec).toBe(12 * 3600);
    w.advance(12 * 3600_000);
    expect((await w.attest("carol")).status).toBe(200);
    for (let i = 0; i < 25; i++) expect((await w.attest("alice")).status).toBe(200);
    expect((await w.attest("alice")).body.code).toBe("first-contact-limit");
  });

  it("serves the webapp (no attestation) and failed checks on the slow tier", async () => {
    const w = await world();
    expect((await w.attest("carol", { ref: "none" })).body.code).toBe("unattested-too-new");
    expect((await w.attest("dave", { ref: "none" })).status).toBe(200);
    expect((await w.attest("dave", { ref: "none" })).body.code).toBe("first-contact-limit");
    w.integrity.failing.add("device-erin");
    expect((await w.attest("erin")).status).toBe(200);
    expect((await w.attest("erin")).body.code).toBe("first-contact-limit");
    const enr = await w.db.prepare("SELECT platform FROM messages_enrollments WHERE username = 'erin'").first<{ platform: string }>();
    expect(enr?.platform).toBe("none");
  });

  it("allows one unattested enrollment per address per day", async () => {
    const w = await world({ rateLimits: true });
    expect((await w.attest("dave", { ref: "none", ip: "198.51.100.1" })).status).toBe(200);
    const second = await w.attest("erin", { ref: "none", ip: "198.51.100.1" });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("rate-limited");
    expect((await w.attest("erin", { ref: "none", ip: "198.51.100.2" })).status).toBe(200);
  });

  it("allows one new Messages account per device per month, not counting the same account again", async () => {
    const w = await world();
    expect((await w.attest("alice", { integrity: { platform: "android", token: "shared-phone" } })).status).toBe(200);
    await Promise.resolve();
    expect((await w.attest("bob", { integrity: { platform: "android", token: "shared-phone" } })).body.code).toBe("device-limit");
    expect((await w.attest("alice", { integrity: { platform: "android", token: "shared-phone" } })).status).toBe(200);
    w.advance(30 * DAY);
    expect((await w.attest("bob", { integrity: { platform: "android", token: "shared-phone" } })).status).toBe(200);
  });

  it("renews the same P without counting it, and refuses a renewal that doesn't check out", async () => {
    const w = await world();
    const first = await w.attest("carol");
    const att = first.body.attestation as MessagesKeyAttestation;
    await w.attest("carol");
    await w.attest("carol");
    expect((await w.attest("carol")).body.code).toBe("first-contact-limit");
    const renewed = await w.attest("carol", { p: first.p, renewOf: att });
    expect(renewed.status).toBe(200);
    expect(renewed.body.attestation.pseudonymPub).toBe(first.p);
    expect((await w.attest("carol", { renewOf: att })).body.code).toBe("bad-renewal");
    const forged = { ...att, abuseEpoch: 5 };
    expect((await w.attest("carol", { p: first.p, renewOf: forged })).body.code).toBe("bad-renewal");
    w.advance(38 * DAY);
    expect((await w.attest("carol", { p: first.p, renewOf: att })).body.code).toBe("bad-renewal");
  });

  it("refuses a banned account, and marks the device it asked from", async () => {
    const w = await world();
    await w.db.prepare("INSERT INTO voici_bans (username, reason, report_id, banned_at) VALUES ('alice', 'spam', NULL, 1)").run();
    const r = await w.attest("alice", { integrity: { platform: "android", token: "alices-phone" } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("banned");
    await Promise.resolve();
    expect(w.integrity.devices.get("alices-phone")?.banned).toBe(true);
    expect((await w.attest("bob", { integrity: { platform: "android", token: "alices-phone" } })).body.code).toBe("banned");
  });

  it("answers 503 without a current abuse key and never counts that", async () => {
    const w = await world();
    expect((await w.attest("carol", { abuseKeys: [] })).body.code).toBe("no-abuse-key");
    const row = await w.db.prepare("SELECT COUNT(*) AS n FROM messages_attest_counters").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("stores and logs nothing that links a pseudonym, a tag or an attestation to the account (§6.3)", async () => {
    const lines: string[] = [];
    for (const k of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, k).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    }
    const w = await world();
    const secrets: string[] = [];
    for (const who of ["alice", "bob", "dave"]) {
      for (let i = 0; i < 3; i++) {
        const r = await w.attest(who, { ref: i === 2 ? "none" : "android" });
        if (r.status !== 200) continue;
        const att = r.body.attestation as MessagesKeyAttestation;
        secrets.push(r.p, att.abuseTagHash, att.abuseTag.slice(0, 40), messagesAttestationHash(att), att.signature);
        const renewed = await w.attest(who, { p: r.p, renewOf: att });
        expect(renewed.status).toBe(200);
        secrets.push(messagesAttestationHash(renewed.body.attestation));
      }
    }
    expect(secrets.length).toBeGreaterThan(20);
    const tables = await w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    let dump = "";
    for (const t of tables.results) {
      const rows = await w.db.prepare(`SELECT * FROM "${t.name}"`).all();
      dump += JSON.stringify(rows.results);
    }
    for (const s of secrets) {
      expect(dump.includes(s)).toBe(false);
      expect(lines.some((l) => l.includes(s))).toBe(false);
    }
    expect(lines.some((l) => /alice|bob|dave/.test(l))).toBe(false);
  });
});

describe("abuse key list", () => {
  const track = seed(0x45);
  const trackPub = hex(ed.getPublicKey(track));
  const entry = ABUSE_KEYS[0]!;

  it("uses only entries signed by a ca-track holder", () => {
    const signature = signAbuseKeyEntry(entry, track);
    expect(verifiedAbuseKeys({ version: 1, entries: [{ ...entry, signature }] }, [trackPub])).toEqual([entry]);
    expect(verifiedAbuseKeys({ version: 1, entries: [{ ...entry, signature }] }, [hex(ed.getPublicKey(seed(1)))])).toEqual([]);
    expect(verifiedAbuseKeys({ version: 1, entries: [{ ...entry, notAfter: entry.notAfter + 1, signature }] }, [trackPub])).toEqual([]);
    expect(verifiedAbuseKeys({ version: 1, entries: [{ ...entry }] }, [trackPub])).toEqual([]);
    expect(verifiedAbuseKeys(null, [trackPub])).toEqual([]);
  });

  it("reads the committed chain and the committed (empty) list", () => {
    expect(caTrackHolders().length).toBeGreaterThan(0);
    expect(bundledAbuseKeys()).toEqual([]);
  });
});
