// A build chat opened by session id alone (an AI-needs-you notification, the
// operations sliver) used to land on a bare view with no server and no key:
// its env-var send signed an empty serverId and its replies carried no AI key
// or model choice. Now it opens the one build chat (views/vibe-code.js) on
// the server that holds the session, whose menu follows the provider the box
// reports and whose every reply (an env-var ack too) carries the key and model.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const load = (...p: string[]) =>
  import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", ...p)).href);
const src = (...p: string[]) => readFileSync(resolve(__dirname, "..", "public", "webapp", ...p), "utf8");

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
    const offline = async () => {
      throw new Error("offline");
    };
    expect(await findSessionServer("s1", { first: ["a"], more: offline, probe: async () => false })).toBeNull();
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
    expect(sw).toContain("&server=${encodeURIComponent(data.server)}");
  });

  it("the chat signs env values for the box it talks to, and the ack carries the key and model", () => {
    const vibe = src("views", "vibe-code.js");
    expect(vibe).toContain("serverId: client().fqdn");
    expect(vibe).toContain("box = boxClient(server)");
    expect(vibe).toContain("export async function openVibeCodeSessionById");
    const ack = vibe.slice(vibe.indexOf("async function answerEnvVar"));
    expect(ack.slice(0, 1200)).toContain("await messageCredential()");
    expect(ack.slice(0, 1200)).toContain("wireChoice(currentMenu(), modelChoice, { reply: true })");
    expect(ack.slice(0, 1200)).not.toContain("freshCredential(buildCredential");
  });
});
