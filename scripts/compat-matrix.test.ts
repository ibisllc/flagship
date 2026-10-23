import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const matrix = JSON.parse(read("release/compatibility.json")) as {
  components: Record<string, { current: number; minimumSecurity: number; preferred: number; unknownVersion: string; where: string }>;
  receiverFirst: string[];
};

describe("compatibility matrix (N13)", () => {
  it("keeps the minimum safe version apart from, and never above, the preferred and current ones", () => {
    for (const [name, c] of Object.entries(matrix.components)) {
      expect(c.minimumSecurity, name).toBeLessThanOrEqual(c.preferred);
      expect(c.preferred, name).toBeLessThanOrEqual(c.current);
    }
  });

  it("no signed format falls back to an older authority on a version it does not know", () => {
    for (const [name, c] of Object.entries(matrix.components)) expect(c.unknownVersion, name).toBe("refuse");
  });

  it("every listed part exists in the tree", () => {
    for (const [name, c] of Object.entries(matrix.components)) expect(() => read(c.where), name).not.toThrow();
  });

  it("the shell number matches the shell, and the deploy order puts verifiers before issuers", () => {
    const build = /WEB_BUILD = (\d+)/.exec(read("apps/web/public/webapp/lib/buildInfo.js"))![1];
    expect(matrix.components["webapp-shell"]!.current).toBe(Number(build));
    expect(matrix.receiverFirst[0]).toMatch(/verify/);
    expect(matrix.receiverFirst.at(-1)).toMatch(/raise minimumSecurity/);
  });

  it("the tags the matrix names are the ones the code signs", () => {
    expect(read("packages/protocol/src/recoveryRecord.ts")).toContain("flagship/recovery-record/v2");
    expect(read("packages/protocol/src/appRelease.ts")).toContain("flagship/app-release/v1");
    expect(read("packages/protocol/src/adapterAttestation.ts")).toContain("flagship/adapter-index/v1");
  });
});
