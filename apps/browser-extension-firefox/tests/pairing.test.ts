import { describe, expect, it } from "vitest";

import * as webRelay from "../../web/public/webapp/lib/pairingRelay.js";
import {
  aeadOpen, b64urlDecode, deriveMaterial, freshKeypair, freshSid, initialState, next, pairingUrl, parsePairPayload, parseRedeemReply,
} from "../src/lib/pairing.js";

const SERVER = "home.alice.flagship.services";
// The iPhone's payload, as CompanionDockViewModelTests pins it (sorted keys).
const IOS_PAYLOAD = {
  kind: "flagship/extension-pair/v1",
  podBaseUrl: `https://${SERVER}`,
  serverDomain: SERVER,
  stkPubHex: "ab".repeat(32),
  ticketId: "0f".repeat(16),
  ticketSecret: "1e".repeat(32),
  username: "alice",
};

describe("pairing link", () => {
  it("names only a relay session and a key", () => {
    const url = new URL(pairingUrl({ sid: "s-1", pkB64u: "k_2" }));
    expect(url.origin).toBe("https://flagshipserver.com");
    expect(url.pathname).toBe("/pair-extension");
    expect([...url.searchParams.keys()]).toEqual(["s", "k"]);
    expect(url.searchParams.get("s")).toBe("s-1");
  });

  it("uses fresh 16-byte session ids", () => {
    expect(b64urlDecode(freshSid()).length).toBe(16);
    expect(freshSid()).not.toBe(freshSid());
  });
});

describe("parsePairPayload", () => {
  it("accepts the phone's payload", () => {
    const r = parsePairPayload(JSON.stringify(IOS_PAYLOAD));
    expect(r).toEqual({ ok: true, payload: { ...Object.fromEntries(Object.entries(IOS_PAYLOAD).filter(([k]) => k !== "kind")) } });
  });

  it("refuses a Remote ticket, which would open a full session", () => {
    const r = parsePairPayload(JSON.stringify({ kind: "flagship/remote-ticket/v1", ticketId: "a", ticketSecret: "b", podBaseUrl: "https://h", username: "u" }));
    expect(r).toEqual({ ok: false, error: "remote-ticket" });
  });

  it("refuses a server that isn't one of the account's box names, or two names that differ", () => {
    const bad = (over: Record<string, string>) => parsePairPayload(JSON.stringify({ ...IOS_PAYLOAD, ...over }));
    expect(bad({ podBaseUrl: "https://evil.example/" })).toEqual({ ok: false, error: "bad-server" });
    expect(bad({ podBaseUrl: "https://work.alice.flagship.services" })).toEqual({ ok: false, error: "bad-server" });
    expect(bad({ serverDomain: "home.bob.flagship.services", podBaseUrl: "https://home.bob.flagship.services" })).toEqual({ ok: false, error: "bad-server" });
    expect(bad({ podBaseUrl: `http://${SERVER}` })).toEqual({ ok: false, error: "bad-server" });
    expect(bad({ podBaseUrl: `https://${SERVER}:8443` })).toEqual({ ok: false, error: "bad-server" });
    expect(bad({ podBaseUrl: `https://${SERVER}/x` })).toEqual({ ok: false, error: "bad-server" });
    expect(bad({ serverDomain: "a.b.alice.flagship.services", podBaseUrl: "https://a.b.alice.flagship.services" })).toEqual({ ok: false, error: "bad-server" });
  });

  it("refuses malformed tickets, accounts and keys", () => {
    const bad = (over: Record<string, string>) => parsePairPayload(JSON.stringify({ ...IOS_PAYLOAD, ...over })).ok;
    expect(bad({ ticketId: "xyz" })).toBe(false);
    expect(bad({ ticketSecret: "00" })).toBe(false);
    expect(bad({ username: "Alice" })).toBe(false);
    expect(bad({ stkPubHex: "ab" })).toBe(false);
    expect(parsePairPayload("not json")).toEqual({ ok: false, error: "unreadable" });
  });
});

describe("state machine", () => {
  const payload = (parsePairPayload(JSON.stringify(IOS_PAYLOAD)) as { payload: { serverDomain: string } }).payload;

  it("walks the happy path", () => {
    let s = initialState();
    s = next(s, { type: "start" });
    s = next(s, { type: "opened", url: "https://x" });
    expect(s).toEqual({ phase: "waiting", url: "https://x" });
    s = next(s, { type: "peer-hello", code: "123456" });
    expect(s).toMatchObject({ phase: "matching", code: "123456" });
    s = next(s, { type: "delivered", ok: true, payload });
    expect(s).toEqual({ phase: "redeeming", server: SERVER });
    s = next(s, { type: "closed", accepted: true });
    expect(s.phase).toBe("redeeming");
    s = next(s, { type: "redeemed", ok: true });
    expect(s).toEqual({ phase: "paired", server: SERVER });
  });

  it("ignores a delivery before the code was shown", () => {
    const s = next({ phase: "waiting", url: "u" }, { type: "delivered", ok: true, payload });
    expect(s.phase).toBe("waiting");
  });

  it("fails, expires and closes from live states only", () => {
    expect(next({ phase: "matching", url: "u", code: "1" }, { type: "delivered", ok: false, error: "bad-server" })).toEqual({ phase: "failed", reason: "bad-server" });
    expect(next({ phase: "waiting", url: "u" }, { type: "expired" })).toEqual({ phase: "expired" });
    expect(next({ phase: "paired", server: SERVER }, { type: "expired" }).phase).toBe("paired");
    expect(next({ phase: "connecting" }, { type: "closed", accepted: false })).toEqual({ phase: "failed", reason: "unreachable" });
  });
});

describe("relay crypto", () => {
  it("agrees with the webapp's relay: same code, and the phone's seal opens here", async () => {
    const ext = await freshKeypair();
    const phone = await webRelay.freshKeypair();
    const mine = await deriveMaterial(ext.sk, phone.pkB64u);
    const theirs = await webRelay.deriveMaterial(phone.sk, ext.pkB64u);
    expect(mine.code).toMatch(/^\d{6}$/);
    expect(mine.code).toBe(theirs.sas);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(IOS_PAYLOAD));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, theirs.kEncEncrypt, plain));
    const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
    expect(JSON.parse(await aeadOpen(mine.key, b64u(ct), b64u(iv)))).toEqual(IOS_PAYLOAD);
  });

  it("refuses a peer key of the wrong length", async () => {
    const ext = await freshKeypair();
    await expect(deriveMaterial(ext.sk, "AAAA")).rejects.toThrow();
  });
});

describe("parseRedeemReply", () => {
  const payload = (parsePairPayload(JSON.stringify(IOS_PAYLOAD)) as { payload: Record<string, string> }).payload;
  const now = 1_800_000_000_000;

  it("keeps an extension session with the phone's pinned key", () => {
    const r = parseRedeemReply({ scope: "extension", companionSessionToken: "aa".repeat(32), expiresAt: now + 1000 }, payload, now);
    expect(r).toMatchObject({ ok: true, box: { serverDomain: SERVER, stkPubHex: IOS_PAYLOAD.stkPubHex, token: "aa".repeat(32), session: "active", evidence: null } });
  });

  it("drops any other kind of session unused", () => {
    expect(parseRedeemReply({ companionSessionToken: "aa".repeat(32), expiresAt: now + 1000 }, payload, now)).toEqual({ ok: false, error: "not-extension-session" });
    expect(parseRedeemReply({ scope: "extension", companionSessionToken: "zz", expiresAt: now + 1000 }, payload, now).ok).toBe(false);
    expect(parseRedeemReply({ scope: "extension", companionSessionToken: "aa".repeat(32), expiresAt: now - 1 }, payload, now).ok).toBe(false);
  });
});
