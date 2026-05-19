import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, renderPlan, main } from "../src/cli.js";
import { plannedChain } from "../src/runE2E.js";

describe("parseArgs", () => {
  // Defaults fill in when only the required-ish flags are present.
  it("applies sane defaults", () => {
    const a = parseArgs(["--iso", "my-iso"]);
    expect(a.iso).toBe("my-iso");
    expect(a.provider).toBe("hetzner");
    expect(a.providerTokenEnv).toBe("HCLOUD_TOKEN");
    expect(a.comBase).toBe("https://flagshipserver.com");
    expect(a.servicesBase).toBe("https://flagship.services");
    expect(a.plan).toBe(false);
    expect(a.keep).toBe(false);
  });

  // Boolean flags and explicit overrides parse correctly.
  it("parses booleans and overrides", () => {
    const a = parseArgs([
      "--iso",
      "iso-x",
      "--provider",
      "hetzner",
      "--provider-token",
      "MY_TOKEN",
      "--com-base",
      "https://com.test",
      "--plan",
      "--keep",
    ]);
    expect(a.providerTokenEnv).toBe("MY_TOKEN");
    expect(a.comBase).toBe("https://com.test");
    expect(a.plan).toBe(true);
    expect(a.keep).toBe(true);
  });

  // Unknown / valueless flags are deterministic errors (no silent skip).
  it("throws on a flag missing its value", () => {
    expect(() => parseArgs(["--iso"])).toThrow(/requires a value/);
    expect(() => parseArgs(["bare"])).toThrow(/unexpected argument/);
  });
});

describe("renderPlan", () => {
  // The plan text lists every stage and both KNOWN-GATED tags + reasons.
  it("prints the ordered chain with both gates and their reasons", () => {
    const txt = renderPlan(plannedChain());
    expect(txt).toMatch(/1\.\s+mintBuildCode/);
    expect(txt).toMatch(/byokVibeApp \[KNOWN-GATED\]/);
    expect(txt).toMatch(/assertCaAuthorized \[KNOWN-GATED\]/);
    expect(txt).toMatch(/teardown \[ALWAYS — try\/finally\]/);
    expect(txt).toMatch(/vibeCodeSession\.ts/);
    expect(txt).toMatch(/CaEndorsement/);
  });
});

describe("main (no I/O paths)", () => {
  let logs: string[];
  let errs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    errs = [];
    logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => void errs.push(a.join(" ")));
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  // --plan exits 0, prints the chain, and provisions NOTHING (works
  // with zero credentials — no token env consulted).
  it("--plan prints the chain and exits 0 without provisioning", async () => {
    delete process.env["HCLOUD_TOKEN"];
    const code = await main(["--plan"]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/full ordered chain/);
    expect(out).toMatch(/byokVibeApp \[KNOWN-GATED\]/);
    expect(out).toMatch(/assertCaAuthorized \[KNOWN-GATED\]/);
  });

  // A real run with no provider token fails closed deterministically
  // (non-zero exit, exact instructions) — it must NEVER hang or fake.
  it("missing provider token => deterministic fail-closed exit 3", async () => {
    delete process.env["HCLOUD_TOKEN"];
    const code = await main(["--iso", "my-iso"]);
    expect(code).toBe(3);
    const out = errs.join("\n");
    expect(out).toMatch(/fail-closed/);
    expect(out).toMatch(/HCLOUD_TOKEN/);
    expect(out).toMatch(/export HCLOUD_TOKEN=/);
  });

  // Missing --iso on a real run is also a deterministic fail-closed.
  it("missing --iso (non-plan) => exit 2 with the INPUT explanation", async () => {
    const code = await main([]);
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/--iso is required/);
  });

  // Bad args => usage + exit 2 (no provisioning attempted).
  it("argument error => usage and exit 2", async () => {
    const code = await main(["--iso"]);
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/argument error/);
    expect(errs.join("\n")).toMatch(/usage: create-vps/);
  });

  // An unknown provider with a token present still fails closed before
  // any network I/O.
  it("unknown provider => fail-closed exit 3 (no I/O)", async () => {
    process.env["MY_TOK"] = "tok";
    const code = await main([
      "--iso",
      "x",
      "--provider",
      "nope",
      "--provider-token",
      "MY_TOK",
    ]);
    delete process.env["MY_TOK"];
    expect(code).toBe(3);
    expect(errs.join("\n")).toMatch(/unknown provider "nope"/);
  });
});
