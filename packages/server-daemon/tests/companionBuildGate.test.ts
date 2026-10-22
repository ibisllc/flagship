/**
 * SEC-AUTH-001: a companion (Remote) token is read-only. It must never reach
 * the build, MCP-key or AI-session routes, whatever the verb, and the daemon
 * boots with every pre-fix companion session ended.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBuildModesHttpHandlers } from "../src/buildmodes/buildModesHttp.js";
import { buildVibeCodeHttpHandlers } from "../src/llm/vibeCodeHttp.js";
import { ownerOnlyGate, COMPANION_DENIED_CODE } from "../src/ownerOnlyGate.js";
import { FilePairedSessionStore, defaultPairedSessionPath } from "../src/pairedSessionStore.js";
import type { HttpRequest } from "../src/runtime.js";

const OWNER = "o".repeat(32);
const COMPANION = "c".repeat(32);

let dir: string;
let sessions: FilePairedSessionStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flagship-companion-gate-"));
  sessions = new FilePairedSessionStore(defaultPairedSessionPath(dir));
  await sessions.load();
  await sessions.add(OWNER);
  await sessions.addCompanion({ token: COMPANION, addedAt: Date.now(), expiresAt: Date.now() + 60_000 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const touched: string[] = [];
const hostile = (name: string): never =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        touched.push(`${name}.${String(prop)}`);
        throw new Error(`${name}.${String(prop)} reached by a companion`);
      },
    },
  ) as never;

function req(method: string, path: string, token: string): HttpRequest {
  return {
    method,
    path,
    headers: { authorization: `Flagship-Session ${token}`, "content-type": "application/json" },
    body: Buffer.from("{}"),
  };
}

const BUILD_ROUTES = [
  ["POST", "/api/build/git"],
  ["POST", "/api/build/mcp"],
  ["GET", "/api/build/sessions"],
  ["GET", "/api/build/sessions/b1"],
  ["POST", "/api/build/sessions/b1/adapt"],
  ["POST", "/api/build/sessions/b1/deploy"],
  ["POST", "/api/build/sessions/b1/discard"],
  ["POST", "/api/build/sessions/b1/mcp-key"],
  ["DELETE", "/api/build/sessions/b1"],
  ["GET", "/api/build/unknown"],
] as const;

const LLM_ROUTES = [
  ["POST", "/api/llm/sessions"],
  ["GET", "/api/llm/sessions"],
  ["GET", "/api/llm/sessions/s1"],
  ["POST", "/api/llm/sessions/s1/message"],
  ["POST", "/api/llm/sessions/s1/deploy"],
  ["POST", "/api/llm/sessions/s1/credential"],
  ["DELETE", "/api/llm/sessions/s1"],
] as const;

describe("companion tokens at build and AI-session routes", () => {
  it.each(BUILD_ROUTES)("%s %s is refused before any build work", async (method, path) => {
    const handle = buildBuildModesHttpHandlers({
      orchestrator: hostile("orchestrator"),
      gate: ownerOnlyGate(sessions, sessions),
      credentials: hostile("credentials"),
    });
    const res = await handle(req(method, path, COMPANION));
    expect(res?.status).toBe(403);
    expect(JSON.parse(res!.body as string).code).toBe(COMPANION_DENIED_CODE);
    expect(touched).toEqual([]);
  });

  it.each(LLM_ROUTES)("%s %s is refused before any session work", async (method, path) => {
    const handle = buildVibeCodeHttpHandlers({
      registry: hostile("registry"),
      gate: ownerOnlyGate(sessions, sessions),
      username: "alice",
      serverFqdn: "home.alice.flagship.services",
      credentials: hostile("credentials"),
    } as never);
    const res = await handle(req(method, path, COMPANION));
    expect(res?.status).toBe(403);
    expect(JSON.parse(res!.body as string).code).toBe(COMPANION_DENIED_CODE);
    expect(touched).toEqual([]);
  });

  it("an owner token still passes the gate, and a missing or bad token still gets 401", () => {
    const gate = ownerOnlyGate(sessions, sessions);
    expect(gate.check(req("POST", "/api/build/git", OWNER))).toBeNull();
    expect(gate.check(req("POST", "/api/build/git", "x".repeat(32)))?.status).toBe(401);
    expect(gate.check({ ...req("GET", "/api/build/sessions", OWNER), headers: {} })?.status).toBe(401);
  });

  it("a companion token carried in the query string is refused too", () => {
    const gate = ownerOnlyGate(sessions, sessions);
    const r: HttpRequest = {
      method: "GET",
      path: `/api/screens/vibe-code/s1/stream?sessionToken=${COMPANION}`,
      headers: {},
      body: Buffer.alloc(0),
    };
    expect(gate.check(r)?.status).toBe(403);
  });
});

describe("removeCompanions", () => {
  it("ends every Remote session and keeps the owner's, durably", async () => {
    expect(await sessions.removeCompanions()).toBe(1);
    const again = new FilePairedSessionStore(defaultPairedSessionPath(dir));
    await again.load();
    expect(again.list().map((r) => r.token)).toEqual([OWNER]);
    expect(await again.removeCompanions()).toBe(0);
  });
});
