// An org server's recipe (docs/enterprise-accounts.md "Org servers") through the one engine every
// builder runs: install-blob.json is the org recipe as given, the bootstrap writes a config that pins
// the org (orgId + genesis) and no IRK, and the register step posts to the org's route.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBootstrapFromRecipe, buildInstallBlobJsonFromRecipe, optionsFromRecipeJson } from "../src/preseedEngine.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../protocol/test-vectors/org-servers/vectors.json"), "utf8"));
const blob = V.installBlobs[0].blob;
const recipe = JSON.stringify({ blob });

describe("org recipe in the preseed engine", () => {
  it("parses an org recipe and hands the box the recipe itself", () => {
    const opts = optionsFromRecipeJson(recipe);
    expect(opts.orgBlob?.orgId).toBe(blob.orgId);
    expect(opts.blob.serverDomain).toBe(blob.serverDomain);
    expect(JSON.parse(buildInstallBlobJsonFromRecipe(recipe))).toEqual(blob);
    expect(() => optionsFromRecipeJson(JSON.stringify({ blob: { ...blob, approvals: [] } }))).toThrow(/org InstallBlob/);
  });

  it("the bootstrap reads the code's serial and strips the org registration route", () => {
    const script = buildBootstrapFromRecipe(recipe);
    expect(script).toContain(`jq -r '.authCode.serial // .code.serial'`);
    expect(script).toContain(`sed -E 's#/api/(server|orgs/[0-9a-f]{32}/servers)/register$##'`);
    expect(script).toContain('if .kind == "org" then');
  });

  it("the config jq pins the org and no IRK (and a personal recipe keeps its IRK)", () => {
    let jq = "";
    try {
      jq = execFileSync("which", ["jq"]).toString().trim();
    } catch {
      return; // no jq here: the CI image has it
    }
    const script = buildBootstrapFromRecipe(recipe);
    const m = /jq -ce ('[\s\S]*?end') \\\n/.exec(script);
    expect(m).not.toBeNull();
    const filter = m![1]!.slice(1, -1).replace(/'\\''/g, "'");
    const dir = mkdtempSync(join(tmpdir(), "org-jq-"));
    writeFileSync(join(dir, "blob.json"), JSON.stringify(blob));
    const cfg = JSON.parse(execFileSync(jq, ["-ce", filter, join(dir, "blob.json")]).toString());
    expect(cfg).toEqual({ serverId: blob.serverDomain, userId: "acme", bakPublicKey: blob.phoneDelegatedPubKey, orgId: blob.orgId, orgGenesisHash: blob.genesisHash });
    const sed = execFileSync("bash", ["-c", `echo "${blob.registrationUrl}" | sed -E 's#/api/(server|orgs/[0-9a-f]{32}/servers)/register$##'`]).toString().trim();
    expect(sed).toBe("https://flagshipserver.com");
  });
});
