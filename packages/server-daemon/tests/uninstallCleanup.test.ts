import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ServiceSessionStore } from "../src/serviceAccess.js";
import { AuthorityHub, GrantIndex, OperationLedger } from "../src/authority/index.js";

const aid = "ab".repeat(32);

describe("what an uninstall takes with it", () => {
  it("ends the app's browser sessions and no one else's", async () => {
    const s = new ServiceSessionStore(join(mkdtempSync(join(tmpdir(), "un-")), "sessions.json"));
    await s.load();
    const gone = await s.issue("alice--chess", aid, 1_000, 60_000);
    const other = await s.issue("alice--other", aid, 1_000, 60_000);
    expect(await s.closeAllForService("alice--chess")).toBe(1);
    expect(s.lookup(gone, 2_000)).toBeNull();
    expect(s.lookup(other, 2_000)).not.toBeNull();
    const reloaded = new ServiceSessionStore(join(mkdtempSync(join(tmpdir(), "un-")), "x.json"));
    expect(await reloaded.closeAllForService("alice--chess")).toBe(0);
  });

  it("revokes every grant that named the app, including what hangs below them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "un-"));
    const idx = new GrantIndex(join(dir, "g.json"));
    await idx.load();
    const base = { kind: "app-api-key" as const, issuer: "dev", subject: "k", accountGeneration: 1, audience: "box", policyRevision: 1, issuedAt: 1 };
    await idx.issue({ ...base, id: "k1", service: "alice--chess", capability: "read" });
    await idx.issue({ ...base, id: "job1", kind: "job", service: "alice--chess", capability: "run", parents: ["k1"] });
    await idx.issue({ ...base, id: "k2", service: "alice--other", capability: "read" });
    const ledger = new OperationLedger(join(dir, "o.json"), { grantsLive: () => true, currentRevision: () => 0, verifyApproval: () => false });
    await ledger.load();
    const hub = new AuthorityHub(idx, ledger);
    await hub.revokeService("alice--chess", "app uninstalled");
    expect(idx.isLive("k1", 5_000)).toBe(false);
    expect(idx.isLive("job1", 5_000)).toBe(false);
    expect(idx.isLive("k2", 5_000)).toBe(true);
  });
});
