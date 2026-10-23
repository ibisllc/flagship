import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import { VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import { AuthorityHub, GrantIndex, OperationLedger } from "../../src/authority/index.js";
import { buildTrackWork, sessionGrantId } from "../../src/authority/sessionWork.js";
import type { HttpRequest } from "../../src/runtime.js";

const gate = { has: (t: string) => t === "tok", check: (r: HttpRequest) => (r.headers["x-flagship-session"] === "tok" ? null : { status: 401, headers: {}, body: "{}" }) };
const start = (): HttpRequest => ({ method: "POST", path: "/api/screens/vibe-code/start", headers: { "x-flagship-session": "tok", "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ prompt: "a chess club" })) });

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "build-work-"));
  const idx = new GrantIndex(join(dir, "g.json"));
  await idx.load();
  await idx.issue({ id: sessionGrantId("tok", false), kind: "owner-session", issuer: "account", subject: "s", accountGeneration: 1, audience: "box", capability: "owner", policyRevision: 1, issuedAt: Date.now() });
  const ledger = new OperationLedger(join(dir, "o.json"), { grantsLive: () => true, currentRevision: () => 0, verifyApproval: () => false });
  await ledger.load();
  const hub = new AuthorityHub(idx, ledger);
  const registry = new VibeCodeSessionRegistry();
  const handle = buildScreensHttp({
    gate, serverFqdn: "home.alice.flagship.services", username: "alice", daemonVersion: "t", startedAt: 0,
    vibeCode: { registry, username: "alice", serverFqdn: "home.alice.flagship.services" },
    trackWork: buildTrackWork(hub, () => false),
  } as never);
  return { hub, registry, handle };
}

describe("a build runs on the authority of the session that started it", () => {
  it("ending that session cancels the build", async () => {
    const { hub, registry, handle } = await rig();
    const { sessionId } = JSON.parse((await handle(start()))!.body as string);
    expect(hub.openWorkFor(sessionGrantId("tok", false))).toEqual([`build ${sessionId}`]);
    await hub.revoke(sessionGrantId("tok", false), "session removed");
    expect(registry.get(sessionId)!.meta.status).toBe("cancelled");
  });

  it("a finished build leaves nothing registered", async () => {
    const { hub, registry, handle } = await rig();
    const { sessionId } = JSON.parse((await handle(start()))!.body as string);
    registry.get(sessionId)!.cancel();
    expect(hub.openWorkFor(sessionGrantId("tok", false))).toEqual([]);
  });
});
