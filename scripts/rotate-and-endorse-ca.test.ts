/**
 * Tests for the pure helpers in scripts/rotate-and-endorse-ca.mjs.
 * Interactive shell + spawn flows aren't exercised; the orchestration
 * primitives (snapshot/diff, bundle building, CLI argv shape, default
 * resolution, preflight) are.
 */
import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  snapshotEndorsementDir,
  detectNewEndorsementFile,
  buildBundleContent,
  buildCliArgs,
  resolveOpts,
  preflightErrors,
  daysFlagToDuration,
} from "./rotate-and-endorse-ca.mjs";

function tmpdir(prefix = "rae-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkEndorsement(dir: string, name: string, body: object = { kind: "CaEndorsement" }) {
  fs.mkdirSync(path.join(dir, "ca-endorsements"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ca-endorsements", name), JSON.stringify(body));
}

describe("snapshotEndorsementDir + detectNewEndorsementFile", () => {
  it("empty dir → empty snapshot, then a single addition is detected", () => {
    const d = tmpdir();
    expect(snapshotEndorsementDir(d).size).toBe(0);
    const before = snapshotEndorsementDir(d);
    mkEndorsement(d, "2026-01-01-aaaaaaaa.json");
    expect(detectNewEndorsementFile(d, before)).toBe("2026-01-01-aaaaaaaa.json");
  });

  it("ignores bundle.json in the snapshot AND the detect", () => {
    const d = tmpdir();
    mkEndorsement(d, "bundle.json", []);
    mkEndorsement(d, "2026-01-01-aaaaaaaa.json");
    const before = snapshotEndorsementDir(d);
    expect(before.has("bundle.json")).toBe(false);
    expect(before.has("2026-01-01-aaaaaaaa.json")).toBe(true);
    mkEndorsement(d, "2026-01-08-bbbbbbbb.json");
    expect(detectNewEndorsementFile(d, before)).toBe("2026-01-08-bbbbbbbb.json");
  });

  it("returns null on zero additions or multiple additions (anomaly)", () => {
    const d = tmpdir();
    const before = snapshotEndorsementDir(d);
    expect(detectNewEndorsementFile(d, before)).toBeNull();
    mkEndorsement(d, "a.json");
    mkEndorsement(d, "b.json");
    expect(detectNewEndorsementFile(d, before)).toBeNull();
  });
});

describe("buildBundleContent", () => {
  it("filename-sorts and keeps only kind=CaEndorsement entries", () => {
    const d = tmpdir();
    mkEndorsement(d, "20260108-b.json", { kind: "CaEndorsement", endorsementId: "b" });
    mkEndorsement(d, "20260101-a.json", { kind: "CaEndorsement", endorsementId: "a" });
    mkEndorsement(d, "20260115-noise.json", { kind: "NotACaEndorsement" });
    mkEndorsement(d, "bundle.json", []);
    const content = buildBundleContent(d);
    const arr = JSON.parse(content);
    expect(arr.map((e: { endorsementId: string }) => e.endorsementId)).toEqual(["a", "b"]);
  });

  it("tolerates malformed JSON files (skips them, doesn't throw)", () => {
    const d = tmpdir();
    mkEndorsement(d, "good.json", { kind: "CaEndorsement", endorsementId: "ok" });
    fs.mkdirSync(path.join(d, "ca-endorsements"), { recursive: true });
    fs.writeFileSync(path.join(d, "ca-endorsements", "garbage.json"), "{not json");
    const arr = JSON.parse(buildBundleContent(d));
    expect(arr).toHaveLength(1);
    expect(arr[0].endorsementId).toBe("ok");
  });
});

describe("buildCliArgs", () => {
  const base = {
    pubHex: "ab".repeat(32),
    scope: "flagship/directory-attestation",
    duration: "7d",
    track: "ca",
    signingKey: "yubikey-piv:slot=9c",
    maintainersDir: "/path/.maintainers",
  };

  it("emits the canonical CLI shape WITHOUT --dry-run", () => {
    const args = buildCliArgs({ ...base, dryRun: false });
    expect(args).toEqual([
      "ca-endorsement",
      "--ca-pubkey", "ab".repeat(32),
      "--scope", "flagship/directory-attestation",
      "--duration", "7d",
      "--track", "ca",
      "--signing-key", "yubikey-piv:slot=9c",
      "--path", "/path/.maintainers",
    ]);
    expect(args.includes("--dry-run")).toBe(false);
  });

  it("appends --dry-run when requested", () => {
    const args = buildCliArgs({ ...base, dryRun: true });
    expect(args[args.length - 1]).toBe("--dry-run");
  });
});

describe("daysFlagToDuration", () => {
  it("returns null when --days is not supplied", () => {
    expect(daysFlagToDuration(undefined)).toBeNull();
    expect(daysFlagToDuration("")).toBeNull();
  });
  it("maps a positive integer to '<N>d'", () => {
    expect(daysFlagToDuration("7")).toBe("7d");
    expect(daysFlagToDuration("14")).toBe("14d");
    expect(daysFlagToDuration("365")).toBe("365d");
  });
  it("rejects zero, negative, fractional, suffixed, or non-numeric", () => {
    for (const bad of ["0", "-1", "1.5", "7d", "abc", "14 ", " 7"]) {
      expect(() => daysFlagToDuration(bad)).toThrow(/positive integer/);
    }
  });
});

describe("resolveOpts", () => {
  it("uses sensible defaults rooted at the repo", () => {
    const opts = resolveOpts({}, "/r");
    expect(opts.maintainersCli).toBe("/r/maintainers/packages/cli/bin/maintainers");
    expect(opts.maintainersDir).toBe("/r/.maintainers");
    expect(opts.comDir).toBe("/r/apps/com");
    expect(opts.comUrl).toBe("https://flagshipserver.com");
    expect(opts.duration).toBe("7d");
    expect(opts.scope).toBe("flagship/directory-attestation");
    expect(opts.signingKey).toBe("yubikey-piv:slot=9c");
    expect(opts.track).toBe("ca");
    expect(opts.verifyUser).toBeNull();
    expect(opts.verbose).toBe(false);
    expect(opts.dryRun).toBe(false);
    expect(opts.yes).toBe(false);
  });

  it("--days N maps to duration 'Nd'", () => {
    expect(resolveOpts({ days: "14" }, "/r").duration).toBe("14d");
  });

  it("rejects --days combined with --duration (mutually exclusive)", () => {
    expect(() => resolveOpts({ days: "14", duration: "21d" }, "/r")).toThrow(/mutually exclusive/);
  });

  it("rejects --days with a non-integer value", () => {
    expect(() => resolveOpts({ days: "1.5" }, "/r")).toThrow(/positive integer/);
  });

  it("verbose: both --verbose and -v set the flag", () => {
    expect(resolveOpts({ verbose: true }, "/r").verbose).toBe(true);
    expect(resolveOpts({ v: true }, "/r").verbose).toBe(true);
  });

  it("flags override every default and verify-user is opt-in", () => {
    const opts = resolveOpts(
      {
        "maintainers-cli": "/x/cli",
        "maintainers-dir": "/x/.m",
        "com-dir": "/x/com",
        "com-url": "https://x",
        duration: "14d",
        scope: "custom",
        "signing-key": "file:k",
        track: "release",
        "verify-user": "alice",
        verbose: true,
        "dry-run": true,
        yes: true,
      },
      "/r",
    );
    expect(opts).toMatchObject({
      maintainersCli: "/x/cli",
      maintainersDir: "/x/.m",
      comDir: "/x/com",
      comUrl: "https://x",
      duration: "14d",
      scope: "custom",
      signingKey: "file:k",
      track: "release",
      verifyUser: "alice",
      verbose: true,
      dryRun: true,
      yes: true,
    });
  });
});

describe("preflightErrors", () => {
  function mkRepo(): { repo: string; opts: ReturnType<typeof resolveOpts> } {
    const repo = tmpdir("rae-repo-");
    fs.mkdirSync(path.join(repo, "maintainers/packages/cli/bin"), { recursive: true });
    fs.writeFileSync(path.join(repo, "maintainers/packages/cli/bin/maintainers"), "#!/usr/bin/env node\n");
    fs.mkdirSync(path.join(repo, ".maintainers/tracks/ca/mandates"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".maintainers/tracks/ca/mandates/g.json"), "{}");
    fs.mkdirSync(path.join(repo, "apps/com"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps/com/wrangler.toml"), "");
    return { repo, opts: resolveOpts({}, repo) };
  }

  it("a fully-set-up repo produces zero errors", () => {
    const { opts } = mkRepo();
    expect(preflightErrors(opts)).toEqual([]);
  });

  it("missing CLI is reported with override hint", () => {
    const { repo, opts } = mkRepo();
    fs.rmSync(path.join(repo, "maintainers/packages/cli/bin/maintainers"));
    const errs = preflightErrors(opts);
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/maintainers CLI not found/);
    expect(errs[0]).toMatch(/--maintainers-cli/);
  });

  it("missing ca-track mandates is reported (genesis-not-done case)", () => {
    const { repo, opts } = mkRepo();
    fs.rmSync(path.join(repo, ".maintainers/tracks/ca"), { recursive: true });
    const errs = preflightErrors(opts);
    expect(errs.some((e) => /no 'ca'-track mandates/.test(e))).toBe(true);
  });

  it("missing wrangler.toml is reported", () => {
    const { repo, opts } = mkRepo();
    fs.rmSync(path.join(repo, "apps/com/wrangler.toml"));
    const errs = preflightErrors(opts);
    expect(errs.some((e) => /wrangler\.toml not found/.test(e))).toBe(true);
  });

  it("reports every missing prerequisite at once (no fail-fast)", () => {
    const { repo, opts } = mkRepo();
    fs.rmSync(path.join(repo, "maintainers/packages/cli/bin/maintainers"));
    fs.rmSync(path.join(repo, "apps/com/wrangler.toml"));
    const errs = preflightErrors(opts);
    expect(errs.length).toBe(2);
  });
});
