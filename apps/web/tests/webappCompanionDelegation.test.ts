import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed, verifyCompanionDelegation } from "@flagship/protocol";
// @ts-expect-error plain browser module
import { allowCompanionBuild, canonicalCompanionDelegationBytes, endCompanionDelegation, listCompanionDelegations } from "../public/webapp/lib/companionDelegation.js";

const vectors = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/companion-delegation/vectors.json", import.meta.url), "utf8"));

describe("webapp companion delegation", () => {
  it("builds the shared vector's bytes with the operations sorted, and refuses malformed ones", () => {
    expect(new TextDecoder().decode(canonicalCompanionDelegationBytes(vectors.delegation))).toBe(vectors.canonical);
    for (const c of vectors.invalid) expect(new TextDecoder().decode(canonicalCompanionDelegationBytes(c.delegation))).toBe(c.canonical);
    const d = vectors.delegation;
    expect(() => canonicalCompanionDelegationBytes({ ...d, ops: [] })).toThrow();
    expect(() => canonicalCompanionDelegationBytes({ ...d, ops: ["root"] })).toThrow();
    expect(() => canonicalCompanionDelegationBytes({ ...d, sessionId: "short" })).toThrow();
  });

  it("signs exactly that session, app and window, and caps the window at a day", async () => {
    const priv = new Uint8Array(32).fill(5);
    let sent: { path: string; body: string } | null = null;
    await allowCompanionBuild(
      { sessionId: "0123456789abcdef", serviceRef: "alice--chess", ops: ["deploy", "build"], durationMs: 10 * 24 * 3600_000, umk: new Uint8Array(32), signWithIrk: async (_u: unknown, b: Uint8Array) => ed.sign(b, priv) },
      async (path: string, init: { body: string }) => { sent = { path, body: init.body }; return { ok: true }; },
      () => 1_000_000,
    );
    expect(sent!.path).toBe("/api/screens/companion-delegation");
    const body = JSON.parse(sent!.body);
    expect(body.delegation).toEqual({ sessionId: "0123456789abcdef", serviceRef: "alice--chess", ops: ["build", "deploy"], issuedAt: 1_000_000, expiresAt: 1_000_000 + 24 * 3600_000 });
    expect(verifyCompanionDelegation(body.delegation, Uint8Array.from(Buffer.from(body.signature, "hex")), ed.getPublicKey(priv))).toBe(true);
  });

  it("lists and ends delegations through the box", async () => {
    const calls: string[] = [];
    const f = async (path: string, init?: { method?: string }) => { calls.push(`${init?.method ?? "GET"} ${path}`); return { delegations: [] }; };
    await listCompanionDelegations("0123456789abcdef", f);
    await endCompanionDelegation("0123456789abcdef", "alice--chess", f);
    expect(calls).toEqual(["GET /api/screens/companion-delegation?sessionId=0123456789abcdef", "DELETE /api/screens/companion-delegation"]);
  });
});
