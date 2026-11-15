import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runOrgAuditVerify } from "../verify.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../packages/protocol/test-vectors/org-servers/vectors.json"), "utf8"));

function file(x: unknown) {
  const p = join(mkdtempSync(join(tmpdir(), "org-audit-")), "export.json");
  writeFileSync(p, JSON.stringify(x));
  return p;
}

describe("org audit verify CLI", () => {
  it("passes a signed export and summarizes it", () => {
    const lines: string[] = [];
    const code = runOrgAuditVerify([file(V.audit.export), "--genesis", V.genesisHash, "--now", String(V.audit.cases[0].now)], (s) => lines.push(s));
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^OK {2}org /);
    expect(lines.join("\n")).toContain("log: 10 entries");
    expect(lines.join("\n")).toContain("home.acme.flagship.services: its log up to entry 2 is");
  });

  it("fails a box log head the box did not sign, and warns about a server that sent none", () => {
    const x = structuredClone(V.audit.export);
    x.boxLogHeads[0].head.headHash = "00".repeat(32);
    const out: string[] = [];
    expect(runOrgAuditVerify([file(x), "--genesis", V.genesisHash, "--now", String(V.audit.cases[0].now)], (s) => out.push(s))).toBe(1);
    expect(out[0]).toMatch(/^FAIL: bad-signature/);
    const none = structuredClone(V.audit.export);
    none.boxLogHeads = [];
    const lines: string[] = [];
    expect(runOrgAuditVerify([file(none), "--genesis", V.genesisHash, "--now", String(V.audit.cases[0].now)], (s) => lines.push(s))).toBe(0);
    expect(lines.join("\n")).toContain("WARN 1 server(s) sent no signed log head");
  });

  it("fails a tampered log and another genesis", () => {
    const x = structuredClone(V.audit.export);
    x.log[2].at += 1;
    const out: string[] = [];
    expect(runOrgAuditVerify([file(x), "--genesis", V.genesisHash, "--now", String(V.audit.cases[0].now)], (s) => out.push(s))).toBe(1);
    expect(out[0]).toMatch(/^FAIL/);
    expect(runOrgAuditVerify([file(V.audit.export), "--genesis", "11".repeat(32)], () => undefined)).toBe(1);
  });

  it("prints JSON with --json", () => {
    let s = "";
    runOrgAuditVerify([file(V.audit.export), "--genesis", V.genesisHash, "--now", String(V.audit.cases[0].now), "--json"], (x) => (s += x));
    expect(JSON.parse(s)).toMatchObject({ ok: true, logEntries: 10, unlogged: [], servers: ["home.acme.flagship.services"], serversWithoutHead: [] });
  });
});
