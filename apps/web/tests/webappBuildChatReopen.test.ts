// A build chat opened by session id alone (an AI-needs-you notification, the
// operations sliver) used to land on a bare view with no server and no key:
// its env-var send signed an empty serverId and its replies carried no AI key
// or model choice. Now it opens the one build chat (views/vibe-code.js) on
// the server that holds the session, and its replies carry the key
// lib/freeAiSessions.js picks (MIRRORS iOS VibeCodeReplyCredential).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const load = (...p: string[]) =>
  import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", ...p)).href);
const src = (...p: string[]) => readFileSync(resolve(__dirname, "..", "public", "webapp", ...p), "utf8");

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    raw: m,
  };
}

const PASS = { provider: "flagship", apiKey: "fa.1", source: "promo", relay: true };
const FRESH = { ...PASS, apiKey: "fa.2" };
const KEY = { provider: "openai", apiKey: "sk-1", relay: true };

describe("free-AI sessions on this device", () => {
  it("remembers sessions started on Flagship Inference, newest 50", async () => {
    const { markFreeAiSession, isFreeAiSession } = await load("lib", "freeAiSessions.js");
    const s = memoryStorage();
    expect(isFreeAiSession("a", s)).toBe(false);
    markFreeAiSession("a", s);
    expect(isFreeAiSession("a", s)).toBe(true);
    for (let i = 0; i < 60; i++) markFreeAiSession(`s${i}`, s);
    expect(isFreeAiSession("a", s)).toBe(false);
    expect(isFreeAiSession("s59", s)).toBe(true);
    expect(JSON.parse(s.raw.get("flagship.freeAi.sessions.v1")!)).toHaveLength(50);
  });

  it("survives unreadable or missing storage", async () => {
    const { markFreeAiSession, isFreeAiSession } = await load("lib", "freeAiSessions.js");
    const broken = { getItem: () => "{not json", setItem: () => { throw new Error("full"); } };
    expect(isFreeAiSession("a", broken)).toBe(false);
    expect(() => markFreeAiSession("a", broken)).not.toThrow();
    expect(isFreeAiSession("a", null)).toBe(false);
  });
});

describe("the key a build-chat reply carries", () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const marked: string[] = [];
    let mints = 0;
    return {
      marked,
      mints: () => mints,
      args: {
        sessionId: "sess-1",
        saved: async () => null,
        mintFree: async () => {
          mints++;
          return FRESH;
        },
        isFree: () => false,
        markFree: (id: string) => marked.push(id),
        ...over,
      },
    };
  };

  it("swaps a pass the chat holds for a fresh one", async () => {
    const { replyCredential } = await load("lib", "freeAiSessions.js");
    const d = deps();
    expect(await replyCredential({ ...d.args, known: PASS })).toEqual(FRESH);
    expect(d.mints()).toBe(1);
  });

  it("sends a key the chat holds as is", async () => {
    const { replyCredential } = await load("lib", "freeAiSessions.js");
    const d = deps();
    expect(await replyCredential({ ...d.args, known: KEY })).toEqual(KEY);
    expect(d.mints()).toBe(0);
  });

  it("mints a pass for a reopened free-AI session", async () => {
    const { replyCredential } = await load("lib", "freeAiSessions.js");
    const d = deps({ isFree: (id: string) => id === "sess-1", saved: async () => KEY });
    expect(await replyCredential(d.args)).toEqual(FRESH);
  });

  it("lets the box keep its key when it has one", async () => {
    const { replyCredential } = await load("lib", "freeAiSessions.js");
    const d = deps({ saved: async () => KEY });
    expect(await replyCredential({ ...d.args, boxNeedsKey: false })).toBeNull();
    expect(d.mints()).toBe(0);
  });

  it("sends the saved key when the box has none, else a pass it then remembers", async () => {
    const { replyCredential } = await load("lib", "freeAiSessions.js");
    const withKey = deps({ saved: async () => KEY });
    expect(await replyCredential({ ...withKey.args, boxNeedsKey: true })).toEqual(KEY);
    const noKey = deps();
    expect(await replyCredential({ ...noKey.args, boxNeedsKey: true })).toEqual(FRESH);
    expect(noKey.marked).toEqual(["sess-1"]);
  });

  it("says why free AI refused, but sends nothing while it is only unavailable", async () => {
    const { replyCredential } = await load("lib", "freeAiSessions.js");
    const refuse = (code: string) => async () => {
      throw Object.assign(new Error(code), { code });
    };
    await expect(
      replyCredential({ ...deps({ mintFree: refuse("free-ai-used-up") }).args, known: PASS }),
    ).rejects.toMatchObject({ code: "free-ai-used-up" });
    expect(
      await replyCredential({ ...deps({ mintFree: refuse("free-ai-unavailable") }).args, known: PASS }),
    ).toBeNull();
  });

  it("builds the model menu for the session's provider", async () => {
    const { menuCredential, FLAGSHIP_MENU_CREDENTIAL } = await load("lib", "freeAiSessions.js");
    expect(await menuCredential({ known: KEY, sessionId: "s", saved: async () => null })).toEqual(KEY);
    expect(await menuCredential({ sessionId: "s", isFree: () => true, saved: async () => KEY })).toEqual(
      FLAGSHIP_MENU_CREDENTIAL,
    );
    expect(await menuCredential({ sessionId: "s", isFree: () => false, saved: async () => KEY })).toEqual(KEY);
    expect(await menuCredential({ sessionId: "s", isFree: () => false, saved: async () => null })).toBeNull();
    // The box lost its key and none is saved: the reply will carry a pass.
    expect(
      await menuCredential({ sessionId: "s", boxNeedsKey: true, isFree: () => false, saved: async () => null }),
    ).toEqual(FLAGSHIP_MENU_CREDENTIAL);
  });
});

describe("finding the server that holds a session", () => {
  it("tries the hint, then the current server, then the rest, each once", async () => {
    const { findSessionServer } = await load("lib", "vibeSessions.js");
    const asked: string[] = [];
    let listed = 0;
    const fqdn = await findSessionServer("s1", {
      first: ["Office.alice.flagship.services", "home.alice.flagship.services", ""],
      more: async () => {
        listed++;
        return ["home.alice.flagship.services", "office.alice.flagship.services", "lab.alice.flagship.services"];
      },
      probe: async (f: string) => {
        asked.push(f);
        if (f === "home.alice.flagship.services") throw new Error("404");
        return f === "lab.alice.flagship.services";
      },
    });
    expect(fqdn).toBe("lab.alice.flagship.services");
    expect(asked).toEqual([
      "office.alice.flagship.services",
      "home.alice.flagship.services",
      "lab.alice.flagship.services",
    ]);
    expect(listed).toBe(1);
  });

  it("never lists the account's servers when the hint holds it", async () => {
    const { findSessionServer } = await load("lib", "vibeSessions.js");
    let listed = 0;
    const fqdn = await findSessionServer("s1", {
      first: ["home.alice.flagship.services"],
      more: async () => {
        listed++;
        return [];
      },
      probe: async () => true,
    });
    expect(fqdn).toBe("home.alice.flagship.services");
    expect(listed).toBe(0);
  });

  it("is null when no server holds it (or there's no id)", async () => {
    const { findSessionServer } = await load("lib", "vibeSessions.js");
    expect(await findSessionServer("s1", { first: ["a"], more: async () => { throw new Error("offline"); }, probe: async () => false })).toBeNull();
    expect(await findSessionServer("", { first: ["a"], probe: async () => true })).toBeNull();
  });
});

describe("one build chat for every way in", () => {
  it("the bare session view is gone; links, the sliver and notifications open the build chat", () => {
    expect(() => src("views", "vibecode-chat.js")).toThrow();
    expect(src("index.html")).not.toContain('id="view-vibecode-chat"');
    expect(src("lib", "operationsBar.js")).toMatch(
      /openVibeCodeSessionById\(params\.sessionId, \{ server: params\.server \|\| "" \}\)/,
    );
    const app = src("app.js");
    expect(app).not.toContain("vibecode-chat.js");
    expect(app).toContain("deepLink: aiChatDeepLink(n)");
    expect(app).toContain('openVibeCodeSessionById(n.sessionId, { server: n.server || "" })');
    expect(app).toContain("server: () => currentPodFqdn()");
    const sw = src("service-worker.js");
    expect(sw).not.toContain("/views/vibecode-chat.js");
    expect(sw).toContain('"/lib/freeAiSessions.js"');
  });

  it("the chat signs env values for the box it talks to and sends a key and model with every reply", () => {
    const vibe = src("views", "vibe-code.js");
    expect(vibe).toContain("serverId: client().fqdn");
    expect(vibe).toContain("box = boxClient(server)");
    // Both reply paths (a question, an env var) carry the key and the model.
    expect(vibe.match(/await credentialForReply\(\)/g)).toHaveLength(2);
    expect(vibe.match(/wireChoice\(modelMenu, modelChoice, \{ reply: true \}\)/g)).toHaveLength(2);
    expect(vibe).toContain("const needsKey = state.needsCredential === true");
    expect(vibe).toContain("markFreeAiSession(r.sessionId)");
    expect(vibe).toContain("export async function openVibeCodeSessionById");
  });
});
