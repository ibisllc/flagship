import { describe, expect, it } from "vitest";
import { parseArgs, requireFlag, optionalFlag, CliError } from "../src/lib/args.js";

describe("parseArgs", () => {
  it("captures the leading command", () => {
    const p = parseArgs(["genesis", "--track", "release"]);
    expect(p.command).toBe("genesis");
    expect(p.flags.track).toBe("release");
  });

  it("supports --flag=value form", () => {
    const p = parseArgs(["verify", "--path=./.maintainers/", "--as-of=now"]);
    expect(p.flags.path).toBe("./.maintainers/");
    expect(p.flags["as-of"]).toBe("now");
  });

  it("treats a trailing --flag with no value as boolean", () => {
    const p = parseArgs(["status", "--verbose"]);
    expect(p.flags.verbose).toBe(true);
  });

  it("collects positionals separately from flags", () => {
    const p = parseArgs(["endorsement", "--commit", "abc", "extra-pos"]);
    expect(p.command).toBe("endorsement");
    expect(p.flags.commit).toBe("abc");
    expect(p.positionals).toEqual(["extra-pos"]);
  });

  it("requireFlag throws CliError when missing", () => {
    const p = parseArgs(["mandate"]);
    expect(() => requireFlag(p, "track")).toThrow(CliError);
  });

  it("optionalFlag returns undefined when missing", () => {
    const p = parseArgs(["mandate"]);
    expect(optionalFlag(p, "track")).toBeUndefined();
  });
});
