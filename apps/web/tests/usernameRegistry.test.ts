import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  signClaimUsername,
  type ClaimUsername,
} from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import {
  InMemoryUsernameRegistry,
} from "../src/routes/usernameRegistry.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);

const sarahUmk = { seed: new Uint8Array(32).fill(22) };
const sarahIrk = deriveIRK(sarahUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function buildSignedClaim(
  username: string,
  signer = harryIrk,
  over: Partial<{ irkPub: Uint8Array; issuedAt: number }> = {},
) {
  const claim: ClaimUsername = {
    username,
    irkPub: over.irkPub ?? signer.publicKey,
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: {
      username: claim.username,
      irkPub: bytesToHex(claim.irkPub),
      issuedAt: claim.issuedAt,
    },
    signature: bytesToHex(signClaimUsername(claim, signer)),
  };
}

function makeApp() {
  const registry = new InMemoryUsernameRegistry();
  const app = buildServer({ surface: "com", usernameRegistry: registry });
  return { app, registry };
}

describe("/api/username/claim", () => {
  it("accepts a valid IRK-signed claim and stores it", async () => {
    const { app, registry } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry"),
    });
    expect(r.statusCode).toBe(200);
    expect(registry.lookup("harry")?.irkPub).toEqual(harryIrk.publicKey);
  });

  it("re-claim by the same IRK is idempotent (image rebuild / recovery)", async () => {
    const { app } = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry"),
    });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry"),
    });
    expect(again.statusCode).toBe(200);
  });

  it("rejects re-claim by a different IRK with 409 (no name squatting / takeover)", async () => {
    const { app } = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry"),
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry", sarahIrk),
    });
    expect(r.statusCode).toBe(409);
  });

  it("rejects when irkPub in body doesn't match the signer (impersonation defense)", async () => {
    const { app } = makeApp();
    // Harry's signature, but request body claims Sarah's irkPub. The signature
    // commits to (username, irkPub, issuedAt), so verification reads the body's
    // irkPub — but we pass harryIrk's pubkey to verify, which won't match the
    // signer's pubkey. The route uses the body irkPub as the verifying key, so
    // an attacker would need a signature from Sarah's IRK (which Harry doesn't have).
    const claim = buildSignedClaim("harry", harryIrk, { irkPub: sarahIrk.publicKey });
    const r = await app.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: claim,
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects reserved usernames (api / admin / git / etc.)", async () => {
    const { app } = makeApp();
    for (const reserved of ["api", "admin", "git", "console"]) {
      const r = await app.inject({
        method: "POST",
        url: "/api/username/claim",
        payload: buildSignedClaim(reserved),
      });
      expect(r.statusCode).toBe(400);
    }
  });

  it("rejects malformed labels (leading hyphen, dots, underscore)", async () => {
    const { app } = makeApp();
    for (const bad of ["-bad", "with.dot", "has_underscore", "trail-"]) {
      const r = await app.inject({
        method: "POST",
        url: "/api/username/claim",
        payload: buildSignedClaim(bad),
      });
      expect(r.statusCode).toBe(400);
    }
  });

  it("normalizes case so 'Harry' and 'harry' map to the same row (idempotent)", async () => {
    const { app, registry } = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("Harry"),
    });
    expect(registry.lookup("HARRY")?.username).toBe("harry");
  });

  it("rejects stale claims (5-minute replay window)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry", harryIrk, { issuedAt: Date.now() - 6 * 60_000 }),
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("GET /api/username/:username", () => {
  it("returns the IRK pubkey for a claimed username (so .services can look it up)", async () => {
    const { app } = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry"),
    });
    const r = await app.inject({ method: "GET", url: "/api/username/harry" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.username).toBe("harry");
    expect(body.irkPub).toBe(bytesToHex(harryIrk.publicKey));
    expect(typeof body.claimedAt).toBe("number");
  });

  it("404 for unknown usernames", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/api/username/ghost" });
    expect(r.statusCode).toBe(404);
  });
});

describe("the registry route is .com-only", () => {
  it("returns 404 in surface=services mode", async () => {
    const app = buildServer({
      surface: "services",
      usernameRegistry: new InMemoryUsernameRegistry(),
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry"),
    });
    expect(r.statusCode).toBe(404);
  });
});
