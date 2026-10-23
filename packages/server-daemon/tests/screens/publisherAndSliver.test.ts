import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signPublisherTrust } from "@flagship/protocol";
import { buildScreensHttp, type ScreensHttpDeps } from "../../src/screens/screensHttp.js";
import { PublisherPins } from "../../src/publisherPins.js";
import { SecuritySliver } from "../../src/securitySliver.js";
import type { HttpRequest } from "../../src/runtime.js";

const owner = (() => { const privateKey = new Uint8Array(32).fill(3); return { privateKey, publicKey: ed.getPublicKey(privateKey) }; })();
const gate = { check: (r: HttpRequest) => (r.headers["x-flagship-session"] === "tok" ? null : { status: 401, headers: {}, body: "{}" }) };
const req = (method: string, path: string, body?: unknown): HttpRequest => ({ method, path, headers: { "x-flagship-session": "tok" }, body: Buffer.from(body ? JSON.stringify(body) : "") });

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "pas-"));
  const pins = new PublisherPins(join(dir, "p.json"));
  await pins.load();
  const sliver = new SecuritySliver(join(dir, "s.json"), () => 1_000);
  await sliver.load();
  await pins.pin("chess", { appId: "alice--chess", identityGeneration: 1, keyHex: "a".repeat(64), keyEpoch: 0, firstVerifiedAt: 1 });
  await pins.setPending({
    serviceId: "chess", continuity: "none", from: (pins.get("chess"))!, toKeyHex: "b".repeat(64), toEpoch: 1, seenAt: 2,
    release: { appId: "alice--chess", identityGeneration: 1, version: "2", packageDigestHex: "d".repeat(40), capabilityDigestHex: "c".repeat(64), keyEpoch: 1, issuedAt: 2 },
  });
  await sliver.raise({ issueKey: "publisher-key:chess", kind: "publisher-key", severity: "high", target: "chess", summary: "x", action: "Review" });
  const handle = buildScreensHttp({
    serverFqdn: "home.alice.flagship.services", username: "alice", daemonVersion: "t", startedAt: 1, now: () => 5_000,
    gate, publisherPins: pins, securitySliver: sliver, publisherTrustKeys: () => [owner.publicKey],
  } as unknown as ScreensHttpDeps);
  return { handle, pins, sliver };
}

describe("publisher approval and the security sliver, over HTTP", () => {
  it("shows the waiting key with fingerprints and the exact statement to sign", async () => {
    const { handle } = await rig();
    const r = await handle(req("GET", "/api/screens/services/chess/publisher"));
    const body = JSON.parse(r!.body as string);
    expect(body.pinned).toEqual({ fingerprint: "aaaa aaaa aaaa aaaa", epoch: 0 });
    expect(body.waiting).toMatchObject({ continuity: "none", oldFingerprint: "aaaa aaaa aaaa aaaa", newFingerprint: "bbbb bbbb bbbb bbbb", rejected: false });
    expect(body.waiting.trust).toMatchObject({ serviceId: "chess", oldKeyHex: "a".repeat(64), newKeyHex: "b".repeat(64), newEpoch: 1 });
  });

  it("the owner's signature moves the pin and clears the sliver line; anyone else's does not", async () => {
    const { handle, pins, sliver } = await rig();
    const trust = JSON.parse((await handle(req("GET", "/api/screens/services/chess/publisher")))!.body as string).waiting.trust;
    const full = { ...trust, issuedAt: 9 };
    const bad = await handle(req("POST", "/api/screens/services/chess/publisher/trust", { trust: full, signatureHex: signPublisherTrust(full, { privateKey: new Uint8Array(32).fill(8), publicKey: ed.getPublicKey(new Uint8Array(32).fill(8)) }) }));
    expect(bad?.status).toBe(403);
    expect(pins.get("chess")?.keyHex).toBe("a".repeat(64));
    const ok = await handle(req("POST", "/api/screens/services/chess/publisher/trust", { trust: full, signatureHex: signPublisherTrust(full, owner) }));
    expect(ok?.status).toBe(200);
    expect(pins.get("chess")?.keyHex).toBe("b".repeat(64));
    expect(sliver.lines()[0]).toMatchObject({ issueKey: "publisher-key:chess", state: "resolved" }); // retained, not erased
  });

  it("rejecting pauses updates and says so; the pin is unchanged", async () => {
    const { handle, pins } = await rig();
    const r = await handle(req("POST", "/api/screens/services/chess/publisher/reject"));
    expect(JSON.parse(r!.body as string)).toEqual({ ok: true, updatesPaused: true });
    expect(pins.pendingFor("chess")?.rejectedAt).toBeDefined();
    expect(pins.get("chess")?.keyHex).toBe("a".repeat(64));
  });

  it("serves the sliver's lines in full", async () => {
    const { handle } = await rig();
    const body = JSON.parse((await handle(req("GET", "/api/screens/security-sliver")))!.body as string);
    expect(body.lostHistory).toBe(false);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ severity: "high", target: "chess", action: "Review", state: "active" });
  });
});
