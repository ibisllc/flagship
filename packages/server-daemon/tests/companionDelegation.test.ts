import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signCompanionDelegation, type CompanionDelegation } from "@flagship/protocol";
import { AuthorityHub, GrantIndex, OperationLedger } from "../src/authority/index.js";
import { CompanionDelegations } from "../src/authority/companionDelegations.js";
import { sessionGrantId } from "../src/authority/sessionWork.js";
import { centralAuthorization } from "../src/centralAuthorization.js";
import type { HttpRequest } from "../src/runtime.js";

const adminPriv = new Uint8Array(32).fill(31);
const admin = { privateKey: adminPriv, publicKey: ed.getPublicKey(adminPriv) };
const otherPriv = new Uint8Array(32).fill(32);
const other = { privateKey: otherPriv, publicKey: ed.getPublicKey(otherPriv) };
const TOKEN = "remote-token";
const NOW = 100_000_000;

async function rig(sessionExpiresAt: number | null = NOW + 3_600_000) {
  const dir = mkdtempSync(join(tmpdir(), "deleg-"));
  const idx = new GrantIndex(join(dir, "g.json"), () => NOW);
  await idx.load();
  const ref = sessionGrantId(TOKEN, true).split(":")[1]!;
  await idx.issue({ id: `companion-session:${ref}`, kind: "companion-session", issuer: "account", subject: ref, accountGeneration: 1, audience: "box", capability: "read", policyRevision: 1, issuedAt: NOW });
  const ledger = new OperationLedger(join(dir, "o.json"), { grantsLive: () => true, currentRevision: () => 0, verifyApproval: () => false });
  await ledger.load();
  const hub = new AuthorityHub(idx, ledger, () => NOW);
  const listed = ref.slice(0, 16);
  const d = new CompanionDelegations(
    hub,
    { companionRefByListedId: (id) => (id === listed ? { ref, expiresAt: sessionExpiresAt } : null) },
    (dl, sig, verify) => verify(dl, sig, admin.publicKey),
    (id) => id === "alice--chess" || id === "alice--other",
    () => NOW,
  );
  d.buildSessionService = (sid) => (sid === "s-chess" ? "alice--chess" : sid === "s-other" ? "alice--other" : null);
  const order = (over: Partial<CompanionDelegation> = {}): CompanionDelegation => ({ sessionId: listed, serviceRef: "alice--chess", ops: ["build", "deploy"], issuedAt: NOW, expiresAt: NOW + 1_800_000, ...over });
  const sign = (o: CompanionDelegation, key = admin) => Buffer.from(signCompanionDelegation(o, key)).toString("hex");
  return { d, hub, idx, order, sign, ref };
}

describe("delegating build and deploy to a Remote session", () => {
  it("an admin's signature lets that session build and deploy that app only", async () => {
    const { d, order, sign } = await rig();
    const o = order();
    expect(await d.grant(o, sign(o))).toMatchObject({ ok: true });
    expect(d.allows(TOKEN, "alice--chess", "build")).toBe(true);
    expect(d.allows(TOKEN, "alice--chess", "deploy")).toBe(true);
    expect(d.allows(TOKEN, "alice--other", "build")).toBe(false);
    expect(d.allows("someone-elses-token", "alice--chess", "build")).toBe(false);
  });

  it("only the operations named are allowed", async () => {
    const { d, order, sign } = await rig();
    const o = order({ ops: ["build"] });
    await d.grant(o, sign(o));
    expect(d.allows(TOKEN, "alice--chess", "build")).toBe(true);
    expect(d.allows(TOKEN, "alice--chess", "deploy")).toBe(false);
  });

  it("refuses a signature that is not an admin's, a stale order, a missing app or session, and a window past the session", async () => {
    const { d, order, sign } = await rig();
    expect(await d.grant(order(), sign(order(), other))).toMatchObject({ ok: false, status: 403 });
    const stale = order({ issuedAt: NOW - 3_600_000, expiresAt: NOW + 1_000 });
    expect(await d.grant(stale, sign(stale))).toMatchObject({ ok: false, status: 403 });
    const noApp = order({ serviceRef: "alice--nothing" });
    expect(await d.grant(noApp, sign(noApp))).toMatchObject({ ok: false, status: 404 });
    const noSession = order({ sessionId: "ffffffffffffffff" });
    expect(await d.grant(noSession, sign(noSession))).toMatchObject({ ok: false, status: 404 });
    const tooLong = order({ expiresAt: NOW + 3_700_000 });
    expect(await d.grant(tooLong, sign(tooLong))).toMatchObject({ ok: false, status: 400 });
    const tooBig = order({ expiresAt: NOW + 25 * 3_600_000 });
    expect((await (await rig(null)).d.grant(tooBig, sign(tooBig)))).toMatchObject({ ok: false, status: 400 });
    expect(await d.grant(order(), "00".repeat(64))).toMatchObject({ ok: false, status: 403 });
    expect(d.allows(TOKEN, "alice--chess", "build")).toBe(false);
  });

  it("ends when its time ends, when it is revoked, when it is replaced, and when the session ends", async () => {
    const r = await rig();
    const o = r.order();
    await r.d.grant(o, r.sign(o));
    expect(r.d.forSession(r.ref.slice(0, 16))).toMatchObject([{ serviceRef: "alice--chess", ops: ["build", "deploy"] }]);
    // replaced by a narrower one
    const narrow = r.order({ ops: ["build"], issuedAt: NOW + 1 });
    await r.d.grant(narrow, r.sign(narrow));
    expect(r.d.allows(TOKEN, "alice--chess", "deploy")).toBe(false);
    expect(r.d.allows(TOKEN, "alice--chess", "build")).toBe(true);
    expect(await r.d.revoke(r.ref.slice(0, 16), "alice--chess")).toBe(1);
    expect(r.d.allows(TOKEN, "alice--chess", "build")).toBe(false);
    // the session ending takes a fresh delegation with it
    const again = r.order({ issuedAt: NOW + 2 });
    await r.d.grant(again, r.sign(again));
    expect(r.d.allows(TOKEN, "alice--chess", "build")).toBe(true);
    await r.hub.revoke(`companion-session:${r.ref}`, "session removed");
    expect(r.d.allows(TOKEN, "alice--chess", "build")).toBe(false);
  });
});

describe("the route gate with a delegation", () => {
  const body = (o: unknown) => Buffer.from(JSON.stringify(o));
  const req = (method: string, path: string, b?: unknown): HttpRequest => ({ method, path, headers: { "x-flagship-session": TOKEN }, body: b ? body(b) : Buffer.alloc(0) });

  async function gate() {
    const r = await rig();
    const o = r.order();
    await r.d.grant(o, r.sign(o));
    const handle = centralAuthorization({
      isCompanionRequest: () => true,
      delegation: { allows: (t, s, op) => r.d.allows(t, s, op), sessionService: (id) => r.d.buildSessionService(id) },
    });
    return { handle, r };
  }

  it("lets the delegated Remote session start a build on the named app, drive it and deploy it", async () => {
    const { handle } = await gate();
    expect(await handle(req("POST", "/api/screens/vibe-code/start", { prompt: "x", editServiceId: "alice--chess" }))).toBeNull();
    expect(await handle(req("POST", "/api/llm/sessions/s-chess/user-reply", { text: "x" }))).toBeNull();
    expect(await handle(req("POST", "/api/llm/sessions/s-chess/deploy"))).toBeNull();
    expect(await handle(req("GET", "/api/screens/vibe-code/s-chess"))).toBeNull();
  });

  it("refuses another app, a brand-new app, an unknown session and everything else a Remote session was refused", async () => {
    const { handle } = await gate();
    const denied = async (r: HttpRequest) => (await handle(r))?.status;
    expect(await denied(req("POST", "/api/screens/vibe-code/start", { prompt: "x", editServiceId: "alice--other" }))).toBe(403);
    expect(await denied(req("POST", "/api/screens/vibe-code/start", { prompt: "x" }))).toBe(403);
    expect(await denied(req("POST", "/api/llm/sessions/s-other/deploy"))).toBe(403);
    expect(await denied(req("POST", "/api/llm/sessions/nope/deploy"))).toBe(403);
    expect(await denied(req("POST", "/api/screens/api-keys"))).toBe(403);
    expect(await denied(req("POST", "/api/screens/server-archive/start"))).toBe(403);
    expect(await denied(req("POST", "/api/screens/paired-sessions/abc"))).toBe(403);
    expect(await denied(req("POST", "/api/llm/sessions/s-chess/../s-other/deploy"))).toBe(403);
  });

  it("without a delegation (or after it ends) the session is read-only again", async () => {
    const { handle, r } = await gate();
    await r.d.revoke(r.ref.slice(0, 16), "alice--chess");
    expect((await handle(req("POST", "/api/llm/sessions/s-chess/deploy")))?.status).toBe(403);
    const none = centralAuthorization({ isCompanionRequest: () => true });
    expect((await none(req("POST", "/api/screens/vibe-code/start", { editServiceId: "alice--chess" })))?.status).toBe(403);
  });
});
