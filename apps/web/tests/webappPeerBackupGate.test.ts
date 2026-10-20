import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { PEER_BACKUP_OFFERED, policiesOffered, policyFromDraft } from "../public/webapp/lib/backupPolicy.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../public/webapp");

describe("backups on other servers are not offered while the feature is off", () => {
  it("offers phone and none, and Peer only to a server already on it", () => {
    expect(PEER_BACKUP_OFFERED).toBe(false);
    expect(policiesOffered(null)).toEqual(["phone", "none"]);
    expect(policiesOffered("unset")).toEqual(["phone", "none"]);
    expect(policiesOffered("peer")).toEqual(["phone", "peer", "none"]);
  });

  it("turns a saved Peer draft into the default instead of creating a Peer server", () => {
    expect(policyFromDraft("peer")).toBe("phone");
    expect(policyFromDraft("none")).toBe("none");
    expect(policyFromDraft("phone-only")).toBe("phone");
  });

  it("the create form has no Peer radio, and the Backups section hides it unless it is the current policy", () => {
    expect(readFileSync(join(root, "index.html"), "utf8")).not.toMatch(/name="cs-backup-policy" value="peer"/);
    const view = readFileSync(join(root, "views/server-backups.js"), "utf8");
    expect(view).toMatch(/policiesOffered\(null\)\.includes\(p\) \? "" : " hidden"/);
    expect(view).toMatch(/policiesOffered\(p\)\.includes\(opt\.dataset\.bkPolicyOption\)/);
    const create = readFileSync(join(root, "views/create-server.js"), "utf8");
    expect(create).toMatch(/const want = v === "none" \|\| v === "phone-only" \? v : null;/);
  });
});
