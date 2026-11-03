/**
 * After 0.3 ships, a 0.2 app or Studio may only be told to update, but it must be told clearly (owner rule
 * 2026-11-02, RELEASE-0.3-JOURNAL.md F9). These replay the 0.2 clients' requests that 0.3 refuses and check the
 * answer is a sentence the 0.2 clients actually show: their own rule is copied below from main (iOS
 * `UserErrorText.boxSentence`, Android `UserErrorText.boxSentence`, webapp `boxErrorText`).
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database, type DemoUserRecord } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { deriveIRK, ed } from "@flagship/protocol";
import { APP_UPDATE_REQUIRED, handleFetchWrappedUmkWithToken, UPDATE_APP_SENTENCES } from "@flagship/control-plane";
import { STUDIO_OUTDATED_REASON } from "../src/builderRelay.js";

// ---- the 0.2 apps' rule (main, 2026-10-20 release) ----
const KNOWN_REASONS = [/subdomain already controlled by a different rck/i, /^stale request/i, /^invalid signature/i, /^not authorized/i];
const IOS_RAW =
  /(^HTTP\s*\d{3}|\bexception\b|nsurlerrordomain|nsposixerrordomain|kcferror|error domain=|\buserinfo=|\bcode=-?\d+|\bswift\.|\boptional\(|\bhandshake|\berrno|\beconn|\bsocket\b|unexpected end of stream|\bEOF\b|broken pipe|error code:? ?\d+|^[[{<]|unexpected json|could not parse|stacktrace|\bnil\b|\(null\)|couldn.t be completed|\bdecodingerror|\bkeynotfound)/i;
const ANDROID_RAW =
  /(^HTTP\s*\d{3}|\bexception\b|\bjava\.|\bkotlin|\bokhttp|\bokio|\bjavax|\bssl\b|handshake|\berrno|\beconn|\bsocket\b|unexpected end of stream|\bEOF\b|broken pipe|software caused|error code:? ?\d+|^[[{<]|unexpected json|could not parse|stacktrace|\bnull\b|standalonecoroutine|jobcancellation|no value passed|illegalargument|illegalstate)/i;
const LINE_NUMBER = /\s*[([]?\b(at )?lines? ?\d+[)\]]?/i;

/** What a 0.2 phone shows for a 4xx body: the server's sentence, or null (its own generic line instead). */
function shownBy02Phone(body: unknown): string | null {
  const o = body as Record<string, unknown>;
  const text = [o.error, o.message].find((v): v is string => typeof v === "string");
  if (!text?.trim()) return null;
  if (KNOWN_REASONS.some((r) => r.test(text))) return null;
  const first = text[0]!;
  const readable = first === first.toUpperCase() && first !== first.toLowerCase() && /[.!?]$/.test(text)
    && text.length >= 4 && text.includes(" ") && !IOS_RAW.test(text) && !ANDROID_RAW.test(text) && !LINE_NUMBER.test(text);
  return readable ? text : null;
}

const SAYS_UPDATE = /\b(update|download the new one)\b/i;

describe("the update sentences pass the 0.2 clients' own filter", () => {
  for (const [k, s] of Object.entries({ ...UPDATE_APP_SENTENCES, studio: STUDIO_OUTDATED_REASON })) {
    it(k, () => {
      expect(shownBy02Phone({ error: s })).toBe(s);
      expect(s).toMatch(SAYS_UPDATE);
    });
  }
  it("the retired DNS-01 answer a 0.2 box logs also says to update", () => {
    expect("Certificates are issued by Flagship now. Update this server.").toMatch(SAYS_UPDATE);
  });
});

const ORIGIN = "https://flagshipserver.com";
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const REAL_HOST = "home.alice.flagship.services";
const DEMO_HOST = "home.demo02.flagship.services";

async function setup() {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  // Demo provisioning marks the account row demo (`is_demo = 1`) in the batch that writes its demo row.
  for (const u of ["alice", "demo02"]) await storage.usernames.put({ username: u, irkPubHex: hex(irk.publicKey), claimedAt: 1, isDemo: u === "demo02" });
  const demo: DemoUserRecord = {
    username: "demo02", idempotencyKey: "k", snapshotId: null, isoR2Key: null, ttlIdleMinutes: 60, region: "r", size: "s",
    activeServerId: null, activeServerIp: null, image: null, activeServerFqdn: DEMO_HOST, lastActivityAt: 1, state: "ready",
    createdAt: 1, provisionPhase: null, provisionPhaseAt: null, provisionLastError: null,
  };
  await storage.demoUsers.insert(demo);
  const box = hex(ed.getPublicKey(new Uint8Array(32).fill(10)));
  await storage.servers.put({ serverDomain: REAL_HOST, username: "alice", identityPubKeyHex: box, registeredAt: 1 });
  await storage.servers.put({ serverDomain: DEMO_HOST, username: "demo02", identityPubKeyHex: box.replace(/^../, "ab"), registeredAt: 1 });
  const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "route-secret" };
  return { env, close: () => sqlite.close() };
}

const call = async (env: ControlPlaneEnv, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  (await tryControlPlane(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    { stream: { sleep: async () => {} } },
  ))!;

const V02_RECOVERY_REQUEST = {
  request: { username: "alice", credentialId: "aa".repeat(16), wrappedUmk: "bb".repeat(40), wrappedUmkHash: "cc".repeat(32), issuedAt: Date.now() },
  signature: "dd".repeat(64),
};

describe("0.2 app requests 0.3 refuses get an update sentence", () => {
  it("share accept: the retired account-key-attestation read answers 410 with the sentence", async () => {
    const { env, close } = await setup();
    try {
      const r = await call(env, "GET", "/api/users/alice/account-key-attestation");
      expect(r.status).toBe(410);
      const b = (await r.json()) as { error: string; code: string };
      expect(b.code).toBe(APP_UPDATE_REQUIRED);
      expect(shownBy02Phone(b)).toBe(UPDATE_APP_SENTENCES.shareAccept);
    } finally {
      close();
    }
  });

  it("cloud recovery: a 0.2 upload or delete ({request, signature}) is told to update", async () => {
    const { env, close } = await setup();
    try {
      for (const [method, path] of [["POST", "/api/recovery"], ["DELETE", "/api/recovery/by-username/alice"]] as const) {
        const r = await call(env, method, path, V02_RECOVERY_REQUEST);
        expect(r.status, path).toBe(400);
        const b = (await r.json()) as { error: string; code: string };
        expect(b.code).toBe(APP_UPDATE_REQUIRED);
        expect(shownBy02Phone(b)).toBe(UPDATE_APP_SENTENCES.recoverySave);
      }
      // A 0.3-shaped envelope still gets the ordinary refusal (here: no claim parses), not the update line.
      const r = await call(env, "POST", "/api/recovery", { claim: { op: "put" }, signature: "dd".repeat(64) });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { code?: string }).code).not.toBe(APP_UPDATE_REQUIRED);
    } finally {
      close();
    }
  });

  it("start-up approval: a tokenless sealed-luks-key read on a real account says to update; demo accounts unchanged", async () => {
    const { env, close } = await setup();
    try {
      const r = await call(env, "GET", `/api/server/${REAL_HOST}/sealed-luks-key`);
      expect(r.status).toBe(401);
      expect(shownBy02Phone(await r.json())).toBe(UPDATE_APP_SENTENCES.startUp);
      // Same answer for a name with no server, so it reveals nothing.
      const u = await call(env, "GET", "/api/server/nobody.alice.flagship.services/sealed-luks-key");
      expect(u.status).toBe(401);
      expect(shownBy02Phone(await u.json())).toBe(UPDATE_APP_SENTENCES.startUp);
      // A 0.3 client with a bad token keeps the plain token refusal.
      const t = await call(env, "GET", `/api/server/${REAL_HOST}/sealed-luks-key`, undefined, { authorization: "Bearer nope" });
      expect(t.status).toBe(401);
      expect(((await t.json()) as { error: string }).error).toBe("an account read token is required");
      expect((await call(env, "GET", `/api/server/${DEMO_HOST}/sealed-luks-key`)).status).toBe(404);
    } finally {
      close();
    }
  });

  it("recovery fetch from a 0.2 app (no passkey) on a 0.3 passkey record says to update, code unchanged for 0.3 apps", async () => {
    const r = await handleFetchWrappedUmkWithToken(
      {
        webauthnRecovery: { get: async () => ({ passkey: { coseHex: "00", alg: -7 }, credentialIdHex: "aa" }) },
        recoveryProofSecret: "s".repeat(32),
      } as never,
      "alice",
      { fetchToken: "ab".repeat(16), issuedAt: Date.now() },
    );
    expect(r.status).toBe(403);
    expect((r.body as { code: string }).code).toBe("passkey-required");
    expect(shownBy02Phone(r.body)).toBe(UPDATE_APP_SENTENCES.recoveryPasskey);
  });
});
