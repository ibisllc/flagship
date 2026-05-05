import { describe, expect, it } from "vitest";
import {
  signAuthCode,
  signClaimUsername,
  signInstallBlob,
  type AuthCode,
  type ClaimUsername,
  type InstallBlob,
} from "@flagship/protocol";
import { deriveIRK, ed } from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import {
  generateTicketCode,
  normalizeCode,
  _internal,
} from "../src/routes/buildTicket.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const malloryUmk = { seed: new Uint8Array(32).fill(99) };
const malloryIrk = deriveIRK(malloryUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function freshKeypair(seed = 0) {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 31 + i * 13 + 7) & 0xff;
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

async function setUpClaimedHarry() {
  const app = buildServer({ surface: "both" });
  const claim: ClaimUsername = {
    username: "harry",
    irkPub: harryIrk.publicKey,
    issuedAt: Date.now(),
  };
  const sig = signClaimUsername(claim, harryIrk);
  const r = await app.inject({
    method: "POST",
    url: "/api/username/claim",
    payload: {
      request: {
        username: "harry",
        irkPub: bytesToHex(harryIrk.publicKey),
        issuedAt: claim.issuedAt,
      },
      signature: bytesToHex(sig),
    },
  });
  if (r.statusCode !== 200) throw new Error(`claim failed: ${r.body}`);
  return app;
}

function buildSignedBlob(): {
  blob: InstallBlob;
  blobJson: object;
  blobSignature: Uint8Array;
} {
  const delegated = freshKeypair(1).publicKey;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 3_600_000;
  const code: AuthCode = {
    version: 1,
    serial: "01HXAFTICKETSER1",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: delegated,
    userPubKey: harryIrk.publicKey,
    issuedAt,
    expiresAt,
  };
  const userSig = signAuthCode(code, harryIrk);
  const blob: InstallBlob = {
    version: 1,
    serverDomain: code.serverDomain,
    username: code.username,
    serverName: code.serverName,
    phoneDelegatedPubKey: delegated,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode: code,
    authCodeUserSignature: userSig,
    issuedAt,
    expiresAt,
  };
  const blobSignature = signInstallBlob(blob, harryIrk);
  const blobJson = {
    version: 1,
    serverDomain: blob.serverDomain,
    username: blob.username,
    serverName: blob.serverName,
    phoneDelegatedPubKey: bytesToHex(blob.phoneDelegatedPubKey),
    registrationUrl: blob.registrationUrl,
    authCode: {
      version: 1,
      serial: code.serial,
      username: code.username,
      serverName: code.serverName,
      serverDomain: code.serverDomain,
      delegatedPubKey: bytesToHex(code.delegatedPubKey),
      userPubKey: bytesToHex(code.userPubKey),
      issuedAt: code.issuedAt,
      expiresAt: code.expiresAt,
    },
    authCodeUserSignature: bytesToHex(userSig),
    issuedAt: blob.issuedAt,
    expiresAt: blob.expiresAt,
  };
  return { blob, blobJson, blobSignature };
}

describe("ticket code helpers", () => {
  it("generateTicketCode produces 14 chars in the 4-4-4 grouped format", () => {
    const code = generateTicketCode((n) => new Uint8Array(n).fill(0));
    expect(code).toMatch(_internal.CODE_RE);
    expect(code.length).toBe(14);
    expect(code[4]).toBe("-");
    expect(code[9]).toBe("-");
  });
  it("alphabet excludes ambiguous characters (no 0, O, 1, I, L)", () => {
    for (const c of "01ILO") {
      expect(_internal.ALPHABET).not.toContain(c);
    }
  });
  it("normalizeCode tolerates lowercase / no hyphens / mixed", () => {
    expect(normalizeCode("abcd-efgh-jkmn")).toBe("ABCD-EFGH-JKMN");
    expect(normalizeCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
    expect(normalizeCode("AbCd-eFgH-jKmN")).toBe("ABCD-EFGH-JKMN");
  });
  it("normalizeCode rejects invalid characters and lengths", () => {
    expect(normalizeCode("ABCD-EFGH")).toBeNull();
    expect(normalizeCode("ABCD-EFGH-IJKL")).toBeNull();
    expect(normalizeCode("0000-0000-0000")).toBeNull();
  });
});

describe("POST /api/build-tickets/issue", () => {
  it("happy path: phone-signed blob → short code, redeem returns the same blob", async () => {
    const app = await setUpClaimedHarry();
    const { blobJson, blobSignature } = buildSignedBlob();
    const r = await app.inject({
      method: "POST",
      url: "/api/build-tickets/issue",
      payload: { blob: blobJson, signature: bytesToHex(blobSignature) },
    });
    expect(r.statusCode).toBe(200);
    const issued = JSON.parse(r.body);
    expect(issued.code).toMatch(_internal.CODE_RE);
    expect(issued.expiresAt).toBeGreaterThan(Date.now());

    const redeem = await app.inject({
      method: "POST",
      url: "/api/build-tickets/redeem",
      payload: { code: issued.code },
    });
    expect(redeem.statusCode).toBe(200);
    const r2 = JSON.parse(redeem.body);
    expect(r2.blob.serverDomain).toBe("home.harry.flagship.services");
    expect(r2.blob.username).toBe("harry");
    expect(r2.blobSignature).toBe(bytesToHex(blobSignature));
    expect(r2.redemptions).toBe(1);
  });

  it("403 when blob signature is from a different IRK than the registered one", async () => {
    const app = await setUpClaimedHarry();
    const { blobJson, blob } = buildSignedBlob();
    const wrongSig = signInstallBlob(blob, malloryIrk);
    const r = await app.inject({
      method: "POST",
      url: "/api/build-tickets/issue",
      payload: { blob: blobJson, signature: bytesToHex(wrongSig) },
    });
    expect(r.statusCode).toBe(403);
  });

  it("404 when the username has not been claimed", async () => {
    const app = buildServer({ surface: "both" });
    const { blobJson, blobSignature } = buildSignedBlob();
    const r = await app.inject({
      method: "POST",
      url: "/api/build-tickets/issue",
      payload: { blob: blobJson, signature: bytesToHex(blobSignature) },
    });
    expect(r.statusCode).toBe(404);
  });

  it("400 on malformed install blob", async () => {
    const app = await setUpClaimedHarry();
    const r = await app.inject({
      method: "POST",
      url: "/api/build-tickets/issue",
      payload: { blob: { version: 1 }, signature: "00".repeat(64) },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("POST /api/build-tickets/redeem", () => {
  it("reads many times until expiry — redemption count increments", async () => {
    const app = await setUpClaimedHarry();
    const { blobJson, blobSignature } = buildSignedBlob();
    const issued = JSON.parse(
      (await app.inject({
        method: "POST",
        url: "/api/build-tickets/issue",
        payload: { blob: blobJson, signature: bytesToHex(blobSignature) },
      })).body,
    );

    for (let i = 1; i <= 3; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/build-tickets/redeem",
        payload: { code: issued.code },
      });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body).redemptions).toBe(i);
    }
  });

  it("404 on a code that was never issued", async () => {
    const app = await setUpClaimedHarry();
    const r = await app.inject({
      method: "POST",
      url: "/api/build-tickets/redeem",
      payload: { code: "ABCD-EFGH-JKMN" },
    });
    expect(r.statusCode).toBe(404);
  });

  it("400 on garbage code", async () => {
    const app = await setUpClaimedHarry();
    const r = await app.inject({
      method: "POST",
      url: "/api/build-tickets/redeem",
      payload: { code: "not a code" },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("POST /api/build-tickets/:code/refresh", () => {
  it("extends expiry on a still-active ticket", async () => {
    const app = await setUpClaimedHarry();
    const { blobJson, blobSignature } = buildSignedBlob();
    const issued = JSON.parse(
      (await app.inject({
        method: "POST",
        url: "/api/build-tickets/issue",
        payload: { blob: blobJson, signature: bytesToHex(blobSignature) },
      })).body,
    );
    const before = issued.expiresAt;
    await new Promise((r) => setTimeout(r, 10));
    const refresh = await app.inject({
      method: "POST",
      url: `/api/build-tickets/${issued.code}/refresh`,
      payload: { ttlMs: 30 * 60_000 },
    });
    expect(refresh.statusCode).toBe(200);
    const r2 = JSON.parse(refresh.body);
    expect(r2.expiresAt).toBeGreaterThanOrEqual(before);
  });

  it("404 on unknown code", async () => {
    const app = await setUpClaimedHarry();
    const r = await app.inject({
      method: "POST",
      url: "/api/build-tickets/ABCD-EFGH-JKMN/refresh",
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });
});

describe("GET /api/build-tickets/:code", () => {
  it("returns metadata without revealing the blob", async () => {
    const app = await setUpClaimedHarry();
    const { blobJson, blobSignature } = buildSignedBlob();
    const issued = JSON.parse(
      (await app.inject({
        method: "POST",
        url: "/api/build-tickets/issue",
        payload: { blob: blobJson, signature: bytesToHex(blobSignature) },
      })).body,
    );
    const r = await app.inject({
      method: "GET",
      url: `/api/build-tickets/${issued.code}`,
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.code).toBe(issued.code);
    expect(body.username).toBe("harry");
    expect(body.serverName).toBe("home");
    expect(body).not.toHaveProperty("blob");
  });
});
