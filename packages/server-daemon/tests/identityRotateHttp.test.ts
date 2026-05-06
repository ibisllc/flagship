/**
 * Tests for /api/identity/pending — the phone-paired-session-gated
 * route that mints a fresh server-identity keypair and persists the
 * priv to disk so the next rotate-server-identity order can swap it in.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { TokenSetSessionGate } from "../src/alertInboxHttp.js";
import {
  buildIdentityRotateHandlers,
  defaultPendingIdentityPath,
} from "../src/identityRotateHttp.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flagship-rotate-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function req(args: { method?: string; token?: string; path?: string }) {
  const headers: Record<string, string> = {};
  if (args.token) headers["authorization"] = `Flagship-Session ${args.token}`;
  return {
    method: args.method ?? "POST",
    path: args.path ?? "/api/identity/pending",
    headers,
    body: Buffer.alloc(0),
  };
}

describe("/api/identity/pending", () => {
  it("returns null for non-matching paths", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const handle = buildIdentityRotateHandlers({
      gate,
      pendingPath: defaultPendingIdentityPath(dir),
    });
    const r = await handle(req({ path: "/api/health" }));
    expect(r).toBeNull();
  });

  it("rejects without paired-session token (401)", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const handle = buildIdentityRotateHandlers({
      gate,
      pendingPath: defaultPendingIdentityPath(dir),
    });
    const r = await handle(req({}));
    expect(r?.status).toBe(401);
  });

  it("405 for non-POST", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const handle = buildIdentityRotateHandlers({
      gate,
      pendingPath: defaultPendingIdentityPath(dir),
    });
    const r = await handle(req({ method: "GET", token: "s" }));
    expect(r?.status).toBe(405);
  });

  it("POST mints a fresh keypair, returns pubkey, persists priv", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const path = defaultPendingIdentityPath(dir);
    const handle = buildIdentityRotateHandlers({ gate, pendingPath: path });
    const r = await handle(req({ method: "POST", token: "s" }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body.toString());
    expect(body.pubKeyHex).toMatch(/^[0-9a-f]{64}$/);

    // The priv on disk derives to that pubkey.
    const privHex = (await readFile(path, "utf8")).trim();
    const priv = new Uint8Array(privHex.length / 2);
    for (let i = 0; i < priv.length; i++) priv[i] = parseInt(privHex.slice(i * 2, i * 2 + 2), 16);
    const derivedPub = ed.getPublicKey(priv);
    let derivedHex = "";
    for (const x of derivedPub) derivedHex += x.toString(16).padStart(2, "0");
    expect(derivedHex).toBe(body.pubKeyHex);
  });

  it("repeated POST replaces the pending priv (different output each time)", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const path = defaultPendingIdentityPath(dir);
    const handle = buildIdentityRotateHandlers({ gate, pendingPath: path });
    const r1 = await handle(req({ method: "POST", token: "s" }));
    const r2 = await handle(req({ method: "POST", token: "s" }));
    const b1 = JSON.parse(r1!.body.toString());
    const b2 = JSON.parse(r2!.body.toString());
    expect(b1.pubKeyHex).not.toBe(b2.pubKeyHex);
  });
});
