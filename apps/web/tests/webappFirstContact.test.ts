// First contact on the webapp (docs/first-contact.md): one pin store per device, the enrollment
// proof checked at the first blessing against the shared vectors, the code computed locally, a
// changed key refused, the app-name grant signed over the pinned key, and Studio's confirmation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";

import {
  pinnedStk,
  pinServerKey,
  retrustServer,
  trustedStk,
  sealingStk,
  podStk,
  serverKeyChanged,
  keepEnrollmentSecret,
  loadEnrollmentSecret,
  forgetEnrollmentSecret,
  keepStudioConfirmKey,
  codeConfirmed,
  _test,
} from "../public/webapp/lib/serverPins.js";
import {
  classifyFirstContact,
  codeBoxHtml,
  formatServerCode,
  refusalText,
  signWildcardGrant,
  upkeepWildcardGrant,
  grantAppNames,
  pendingWildcardGrant,
  sendPendingWildcardGrants,
  NOT_YOUR_RECIPE,
  KEY_CHANGED,
} from "../public/webapp/lib/firstContact.js";
import { serverSeenMacHex, verifyServerSeen, noteServerSeen } from "../public/webapp/lib/studioConfirm.js";
import { serverKeyState, serverKeyCardHtml } from "../public/webapp/lib/serverKeyCard.js";
import { canonicalServerWildcardGrant } from "../public/webapp/lib/serverWildcardGrant.js";
import { SENSITIVE_TAGS } from "../public/webapp/lib/adminRoot.js";

const vectors = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, `../../../packages/protocol/test-vectors/${name}/vectors.json`), "utf8"));
const ENR = vectors("enrollment");
const GRANT = vectors("server-wildcard-grant");

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};
const kv = () => {
  const m = new Map<string, unknown>();
  return {
    kvGet: async (k: string) => m.get(k),
    kvPut: async (k: string, v: unknown) => void m.set(k, v),
    kvDel: async (k: string) => void m.delete(k),
    raw: m,
  };
};

const UMK = new Uint8Array(32).fill(9);
const P = ENR.proofs[0];
const DOMAIN = P.statement.serverDomain.toLowerCase();
const STK = P.statement.stkPubHex;
const OTHER = "cd".repeat(32);

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  _test.reset();
});
afterEach(() => vi.unstubAllGlobals());

describe("pin store", () => {
  it("pins once, refuses another key, and changes only through an explicit re-trust", () => {
    expect(pinnedStk(DOMAIN)).toBeNull();
    expect(trustedStk(DOMAIN, STK)).toBe(STK); // first sight: the offered key, nothing sealed on it
    expect(sealingStk(DOMAIN, STK)).toBeNull();
    pinServerKey(DOMAIN.toUpperCase(), STK.toUpperCase(), "proof");
    expect(pinnedStk(DOMAIN)).toBe(STK);
    expect(sealingStk(DOMAIN, STK)).toBe(STK);
    expect(sealingStk(DOMAIN, "")).toBe(STK);
    expect(() => pinServerKey(DOMAIN, OTHER)).toThrow(/key changed/);
    expect(pinnedStk(DOMAIN)).toBe(STK);
    expect(trustedStk(DOMAIN, OTHER)).toBeNull();
    expect(sealingStk(DOMAIN, OTHER)).toBeNull();
    expect(podStk({ serverDomain: DOMAIN, identityPubKey: OTHER })).toBe("");
    expect(podStk({ serverDomain: DOMAIN, identityPubKey: STK })).toBe(STK);
    expect(serverKeyChanged(DOMAIN)).toBe(true);
    retrustServer(DOMAIN);
    expect(pinnedStk(DOMAIN)).toBeNull();
    expect(serverKeyChanged(DOMAIN)).toBe(false);
    pinServerKey(DOMAIN, OTHER);
    expect(pinnedStk(DOMAIN)).toBe(OTHER);
  });

  it("keeps the enrollment secret wrapped under the account key, readable only with it", async () => {
    const store = kv();
    await keepEnrollmentSecret(UMK, DOMAIN, { secretHex: ENR.secretHex, serial: P.statement.authCodeSerial }, store);
    const rec = [...store.raw.values()][0] as { ciphertext: string };
    expect(JSON.stringify(rec)).not.toContain(ENR.secretHex);
    expect(await loadEnrollmentSecret(UMK, DOMAIN, store)).toEqual({ secretHex: ENR.secretHex, serial: P.statement.authCodeSerial });
    expect(await loadEnrollmentSecret(new Uint8Array(32).fill(1), DOMAIN, store)).toBeNull();
    await forgetEnrollmentSecret(DOMAIN, store);
    expect(await loadEnrollmentSecret(UMK, DOMAIN, store)).toBeNull();
  });
});

describe("first blessing", () => {
  const secretLoader = async () => ({ secretHex: ENR.secretHex, serial: P.statement.authCodeSerial });
  const none = async () => null;
  const req = (extra: Record<string, unknown> = {}) => ({
    serverDomain: DOMAIN,
    stkPubHex: STK,
    purpose: "entitlement",
    deviceInfo: { enrollmentProof: P.proofHex },
    ...extra,
  });

  it("the shared proof verifies and the code is computed from the key here", async () => {
    const fc = await classifyFirstContact(req(), { umk: UMK, loadEnrollmentSecret: secretLoader });
    expect(fc).toMatchObject({ pinState: "proven", refusal: null, code: ENR.codes[0].code });
    expect(formatServerCode("482913")).toBe("482 913");
    expect(codeBoxHtml(fc)).toContain(`it is showing this code: ${formatServerCode(ENR.codes[0].code)}`);
  });

  it("a wrong or missing proof is refused with the sentence, and so is another key's proof", async () => {
    for (const deviceInfo of [{}, { enrollmentProof: "00".repeat(32) }, { enrollmentProof: ENR.proofs[1].proofHex }, null]) {
      const fc = await classifyFirstContact(req({ deviceInfo }), { umk: UMK, loadEnrollmentSecret: secretLoader });
      expect(fc.refusal).toBe(NOT_YOUR_RECIPE);
      expect(codeBoxHtml(fc)).toBe("");
    }
    expect(refusalText(NOT_YOUR_RECIPE)).toBe("This server was not built from your recipe. Do not approve it.");
  });

  it("a start-up unlock from the recipe's device waits for the proof; others pin on first sight", async () => {
    const unlock = await classifyFirstContact(req({ purpose: "unlock-key", deviceInfo: null }), { umk: UMK, loadEnrollmentSecret: secretLoader });
    expect(unlock.pinState).toBe("awaiting-proof");
    expect(codeBoxHtml(unlock)).toContain("it is showing this code");
    const other = await classifyFirstContact(req({ deviceInfo: null }), { umk: UMK, loadEnrollmentSecret: none });
    expect(other).toMatchObject({ pinState: "first-sight", refusal: null });
    const online = await classifyFirstContact(req({ deviceInfo: null, cameOnline: true }), { umk: UMK, loadEnrollmentSecret: secretLoader });
    expect(online.pinState).toBe("first-sight");
  });

  it("after the pin, a request under another key is refused; under the pin it shows no code", async () => {
    pinServerKey(DOMAIN, OTHER);
    const changed = await classifyFirstContact(req(), { umk: UMK, loadEnrollmentSecret: secretLoader });
    expect(changed.refusal).toBe(KEY_CHANGED);
    expect(refusalText(KEY_CHANGED)).toBe("This server's key changed. If you did not rebuild it, do not approve anything for it.");
    retrustServer(DOMAIN);
    pinServerKey(DOMAIN, STK);
    const pinned = await classifyFirstContact(req(), { umk: UMK, loadEnrollmentSecret: secretLoader });
    expect(pinned).toMatchObject({ pinState: "pinned", refusal: null });
    expect(codeBoxHtml(pinned)).toBe("");
  });
});

describe("app-name certificate grant", () => {
  const G = GRANT.grants[0];
  const seed = Uint8Array.from(Buffer.from(GRANT.seedHex, "hex"));
  const sign = async (_umk: Uint8Array, bytes: Uint8Array) => ed25519.sign(bytes, seed);
  const session = { umk: UMK, username: G.grant.username };
  const gd = G.grant.serverDomain.toLowerCase();

  it("is a sensitive order, signed over the pinned key, byte-for-byte the shared vector", async () => {
    expect(SENSITIVE_TAGS.has("flagship/server-wildcard-grant/v1")).toBe(true);
    await expect(signWildcardGrant(gd, { session, sign, now: () => G.grant.issuedAt })).rejects.toThrow(/not pinned/);
    pinServerKey(gd, G.grant.stkPubHex);
    const body = await signWildcardGrant(gd, { session, sign, now: () => G.grant.issuedAt });
    expect(body).toEqual({ issuedAt: G.grant.issuedAt, signature: G.signatureHex });
    expect(new TextDecoder().decode(canonicalServerWildcardGrant({ ...G.grant }))).toBe(G.canonical);
  });

  it("upkeep signs silently on granted:false, leaves a granted server alone, and needs a pin", async () => {
    const calls: Array<{ path: string; init?: { method?: string; body?: string } }> = [];
    let granted = false;
    const screensFetchForPod = async (_d: string, path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, init });
      return init?.method === "POST" ? { ok: true } : { granted };
    };
    const deps = { session, sign, now: () => G.grant.issuedAt, screensFetchForPod, canSign: () => true };
    expect(await upkeepWildcardGrant(gd, deps)).toEqual({ checked: false });
    expect(calls).toHaveLength(0);
    pinServerKey(gd, G.grant.stkPubHex);
    expect(await upkeepWildcardGrant(gd, deps)).toMatchObject({ checked: true, granted: false, sent: true });
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.path).toBe("/api/screens/server-wildcard-grant");
    expect(JSON.parse(post.init!.body!)).toEqual({ issuedAt: G.grant.issuedAt, signature: G.signatureHex });
    calls.length = 0;
    granted = true;
    expect(await upkeepWildcardGrant(gd, deps)).toMatchObject({ checked: true, granted: true });
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(0);
    expect(await upkeepWildcardGrant(gd, { ...deps, canSign: () => false })).toEqual({ checked: false });
  });

  it("a server that isn't up yet gets the signed grant later, and never for another key", async () => {
    pinServerKey(gd, G.grant.stkPubHex);
    let up = false;
    const posts: string[] = [];
    const screensFetchForPod = async (_d: string, _p: string, init?: { body?: string }) => {
      if (!up) throw new Error("offline");
      posts.push(init!.body!);
      return { ok: true };
    };
    const deps = { session, sign, now: () => G.grant.issuedAt, screensFetchForPod, canSign: () => true };
    expect(await grantAppNames(gd, deps)).toEqual({ sent: false });
    expect(pendingWildcardGrant(gd)).toMatchObject({ signature: G.signatureHex });
    up = true;
    await sendPendingWildcardGrants([gd], deps);
    expect(posts).toHaveLength(1);
    expect(pendingWildcardGrant(gd)).toBeNull();
    up = false;
    await grantAppNames(gd, deps);
    retrustServer(gd);
    pinServerKey(gd, OTHER);
    up = true;
    await sendPendingWildcardGrants([gd], deps);
    expect(posts).toHaveLength(1);
    expect(pendingWildcardGrant(gd)).toBeNull();
  });
});

describe("Confirmed by Studio", () => {
  const KEY = "5c".repeat(32);
  it("a report whose MAC verifies under the kept key confirms the code; a wrong one is ignored", async () => {
    const macHex = await serverSeenMacHex(KEY, DOMAIN.toUpperCase(), STK);
    expect(await verifyServerSeen(KEY, DOMAIN, { stkPubHex: STK, macHex })).toBe(true);
    expect(await verifyServerSeen(KEY, DOMAIN, { stkPubHex: OTHER, macHex })).toBe(false);
    const store = kv();
    await keepStudioConfirmKey(UMK, DOMAIN, KEY, store);
    const loadKey = async (umk: Uint8Array, d: string) =>
      (await import("../public/webapp/lib/serverPins.js")).loadStudioConfirmKey(umk, d, store);
    expect(await noteServerSeen(DOMAIN, { serverSeen: [{ stkPubHex: STK, macHex: "00".repeat(32), at: 1 }] }, { umk: UMK, loadKey })).toEqual([]);
    expect(codeConfirmed(DOMAIN, STK)).toBe(false);
    // Up to four entries, newest last: any entry whose MAC verifies counts for its own key.
    const otherMac = await serverSeenMacHex(KEY, DOMAIN, OTHER);
    const seen = [
      { stkPubHex: STK, macHex, at: 1 },
      { stkPubHex: OTHER, macHex: "11".repeat(32), at: 2 },
      { stkPubHex: "ef".repeat(32), macHex: otherMac, at: 3 },
    ];
    expect(await noteServerSeen(DOMAIN, { serverSeen: seen }, { umk: UMK, loadKey })).toEqual([STK]);
    expect(codeConfirmed(DOMAIN, STK)).toBe(true);
    expect(codeConfirmed(DOMAIN, OTHER)).toBe(false);
    expect(codeConfirmed(DOMAIN, "ef".repeat(32))).toBe(false);
    const fc = await classifyFirstContact({ serverDomain: DOMAIN, stkPubHex: STK, purpose: "entitlement", deviceInfo: null }, { umk: UMK, loadEnrollmentSecret: async () => null });
    expect(codeBoxHtml(fc)).toContain("Confirmed by Studio");
    expect(codeBoxHtml(fc)).not.toContain("showing this code");
  });
});

describe("server page key card", () => {
  it("offers Trust this server with the code for an unpinned server, says a changed key, and is empty once pinned", async () => {
    const pod = { serverDomain: DOMAIN, identityPubKey: STK, lastReported: Date.now() };
    const s = await serverKeyState(DOMAIN, pod, { umk: UMK, loadEnrollmentSecret: async () => null });
    expect(serverKeyCardHtml(s)).toContain("Trust this server");
    expect(serverKeyCardHtml(s)).toContain(formatServerCode(ENR.codes[0].code));
    expect(await serverKeyState(DOMAIN, { ...pod, lastReported: null }, { umk: UMK, loadEnrollmentSecret: async () => ({ secretHex: ENR.secretHex, serial: "x" }) })).toBeNull();
    pinServerKey(DOMAIN, STK);
    expect(await serverKeyState(DOMAIN, pod, { umk: UMK })).toBeNull();
    const changed = await serverKeyState(DOMAIN, { ...pod, identityPubKey: OTHER }, { umk: UMK });
    expect(serverKeyCardHtml(changed)).toContain("This server's key changed.");
  });
});
