import { describe, expect, it } from "vitest";
import { buildModelRedactor } from "../../src/llm/modelPrivacy.js";
import { buildUserContext } from "../../src/llm/systemPrompt.js";
import { BuildToolHost } from "../../src/buildmodes/buildToolHost.js";
import { BuildWorkspace } from "../../src/buildmodes/buildWorkspace.js";
import { InMemoryBuildJournal } from "../../src/buildmodes/buildJournal.js";

const redact = buildModelRedactor(() => ({
  username: "plucky-avocet",
  serverFqdn: "home3.plucky-avocet.flagship.services",
  extra: ["plucky-avocet--notes"],
}));

describe("what a model may learn about the owner: nothing", () => {
  it("replaces the account, the server, its apps' addresses and public IPs", () => {
    const out = redact(
      "live at https://hello.home3.plucky-avocet.flagship.services (alias notes.plucky-avocet.flagship.services), " +
        "container flagship-plucky-avocet--notes, from 81.12.3.4 and 2a02:8109:1:2::5, bridge 172.18.0.2",
    );
    expect(out).not.toMatch(/plucky|avocet|home3|81\.12|2a02/);
    expect(out).toContain("app.example");
    expect(out).toContain("172.18.0.2");
  });

  it("the chat prompt carries no account, server, plan or other apps", () => {
    const prompt = buildUserContext({ appEnvNames: ["STRIPE_KEY"] } as never);
    expect(prompt).not.toMatch(/# Session context[\s\S]*(- User:|- Server:|- Tier:|Apps already on this box)/);
    // Even a caller that still passes the old fields can't get them in.
    const legacy = buildUserContext({ username: "plucky-avocet", hostname: "home3", tier: "free", existingApps: [{ name: "taxes-2026", stores: "" }] } as never);
    expect(legacy).not.toMatch(/plucky-avocet|home3|taxes-2026/);
  });

  it("tool results the box writes are redacted; the repo's own files are not", async () => {
    const ws = new BuildWorkspace({ "README.md": "made by plucky-avocet" });
    const tools = new BuildToolHost({
      buildId: "b1",
      workspace: ws,
      journal: new InMemoryBuildJournal(),
      serverFqdn: "home3.plucky-avocet.flagship.services",
      envNames: async () => [],
      redact,
      logs: async () => "listening; FLAGSHIP_HOST=home3.plucky-avocet.flagship.services",
      deploy: async () => ({ ok: false, reason: "container flagship-plucky-avocet--notes exited" }),
    });
    expect((await tools.call("get_logs", {})).text).not.toContain("plucky");
    expect((await tools.call("deploy", {})).text).toBe(JSON.stringify({ ok: false, error: "nothing to deploy: write flagship.app.json first" }));
    ws.write("flagship.app.json", "{}");
    expect((await tools.call("deploy", {})).text).not.toContain("plucky");
    expect((await tools.call("read_file", { path: "README.md" })).text).toBe("made by plucky-avocet");
    const journal = JSON.parse((await tools.call("get_journal", {})).text) as Record<string, unknown>[];
    expect(journal.every((e) => !("ts" in e) && !("serviceId" in e))).toBe(true);
  });
});
