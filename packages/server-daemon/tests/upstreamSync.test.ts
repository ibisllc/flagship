import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildOrchestrator } from "../src/buildmodes/buildOrchestrator.js";
import { buildBuildModesHttpHandlers } from "../src/buildmodes/buildModesHttp.js";
import { GitImporter } from "../src/buildmodes/gitImport.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";
import { InMemoryMcpKeyStore } from "../src/buildmodes/mcpKeyStore.js";
import { ImportProvenanceStore } from "../src/buildmodes/appProvenance.js";
import type { DeployResult } from "../src/buildmodes/deployArtifact.js";
import type { HttpRequest } from "../src/runtime.js";

const FQDN = "home.harry.flagship.services";
const manifest = (egress: string[]) => JSON.stringify({ name: "notes", runtime: { base: "node-24", port: 8080, start: "node index.js" }, network: { egress } });

function clone(files: Record<string, string>) {
  return async ({ dest }: { dest: string }) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dest, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  };
}

function setup(upstream: Record<string, string>) {
  const provenance = new ImportProvenanceStore(mkdtempSync(join(tmpdir(), "prov-")));
  const o = new BuildOrchestrator({
    journal: new InMemoryBuildJournal(),
    gitImporter: new GitImporter({ cmd: { run: async () => {} }, workingDir: mkdtempSync(join(tmpdir(), "sync-")), cloneInto: clone(upstream) }),
    mcpKeys: new InMemoryMcpKeyStore(),
    serverFqdn: FQDN,
    deployArtifact: async (): Promise<DeployResult> => ({ ok: true, serviceId: "harry--notes", url: `https://notes.${FQDN}`, image: "i" }),
    provenance,
  });
  const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: { check: () => null } as never });
  return { o, provenance, handle };
}

const base = { "flagship.app.json": manifest([]), "index.js": "v1", "README.md": "readme", "style.css": "a" };

describe("syncing an imported app with one upstream version", () => {
  it("merges what only upstream changed, keeps the owner's changes, lists conflicts and new capabilities, and puts nothing live", async () => {
    const upstream = { ...base, "flagship.app.json": manifest(["api.example.com"]), "index.js": "v2", "style.css": "upstream" };
    const { o, provenance, handle } = setup(upstream);
    await provenance.save("harry--notes", { repoUrl: "https://github.com/me/notes", commit: "a".repeat(40), base, local: { ...base, "style.css": "mine", "extra.js": "mine" }, at: 1 });
    const r = await handle({ method: "POST", path: "/api/build/apps/harry--notes/sync", headers: {}, body: Buffer.from("{}") } as unknown as HttpRequest);
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as { buildId: string; proposal: { takeUpstream: string[]; conflicts: string[]; capabilityChanges: Array<{ section: string; added: string[] }>; clean: boolean }; upToDate: boolean };
    expect(body.proposal.takeUpstream).toContain("index.js");
    expect(body.proposal.conflicts).toEqual(["style.css"]);
    expect(body.proposal.capabilityChanges).toEqual([expect.objectContaining({ section: "network.egress", added: ["api.example.com"] })]);
    expect(body.proposal.clean).toBe(false);
    const files = o.workspace(body.buildId)!.snapshot();
    expect(files["index.js"]).toBe("v2");
    expect(files["style.css"]).toBe("mine"); // a conflict keeps the owner's version
    expect(files["extra.js"]).toBe("mine");
    expect(o.state(body.buildId)).toMatchObject({ editsServiceId: "harry--notes" });
    expect(o.state(body.buildId)?.deployedUrl).toBeUndefined();
  });

  it("refuses an app with no import record and a ref that is not a branch, tag or commit", async () => {
    const { handle } = setup(base);
    const post = (path: string, body: unknown) => handle({ method: "POST", path, headers: {}, body: Buffer.from(JSON.stringify(body)) } as unknown as HttpRequest);
    expect((await post("/api/build/apps/harry--other/sync", {}))?.status).toBe(404);
    expect((await post("/api/build/apps/harry--notes/sync", { ref: "../../etc" }))?.status).toBe(400);
    expect((await post("/api/build/apps/Not_An_Id/sync", {}))?.status).not.toBe(200);
  });

  it("keeps where an imported app came from once it goes live, and forgets it with the app", async () => {
    const { o, provenance } = setup(base);
    const created = await o.createGit({ gitUrl: "https://github.com/me/notes" });
    expect("buildId" in created).toBe(true);
    const d = await o.deploy((created as { buildId: string }).buildId);
    expect(d.ok).toBe(true);
    let p = await provenance.load("harry--notes");
    for (let i = 0; i < 100 && !p; i++) {
      await new Promise((r) => setTimeout(r, 20));
      p = await provenance.load("harry--notes");
    }
    expect(p).toMatchObject({ repoUrl: "https://github.com/me/notes", base: expect.objectContaining({ "index.js": "v1" }) });
    await provenance.forget("harry--notes");
    expect(await provenance.load("harry--notes")).toBeNull();
  });
});
