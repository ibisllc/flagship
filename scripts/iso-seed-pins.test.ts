import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the USB seed pins agree", () => {
  const workflow = read(".github/workflows/iso-seed.yml");
  const seedSha = /SEED_SHA256: ([0-9a-f]{64})/.exec(workflow)![1]!;
  const baseSha = /BASE_SHA256: ([0-9a-f]{64})/.exec(workflow)![1]!;
  const baseVersion = /archive\/([0-9.]+)\/amd64/.exec(workflow)![1]!;

  it("names one seed hash in the workflow, the design doc, the security page and wrangler.toml", () => {
    for (const p of ["docs/iso-seed-and-on-device-burn.md", "apps/web/public/security/iso-seed.html", "apps/com/wrangler.toml"]) {
      expect(read(p), p).toContain(seedSha);
    }
  });

  it("is the one seed the Android app trusts (SeedPins.kt)", () => {
    expect(read("apps/mobile/android/app/src/main/java/com/flagshipserver/app/builder/iso/SeedPins.kt")).toContain(`"${seedSha}"`);
  });

  it("builds the seed on the stock base .com serves to every other burn", () => {
    const toml = read("apps/com/wrangler.toml");
    const manifest = /^FLAGSHIP_ISO_MANIFEST = '(.*)'$/m.exec(toml)![1]!;
    const m = JSON.parse(manifest) as { version: string; sha256: string };
    expect(m.sha256).toBe(baseSha);
    expect(m.version).toBe(`debian-${baseVersion}`);
  });

  it("keeps rebuilding on the branches that ship, and keeps the seed for publishing", () => {
    expect(workflow).toMatch(/branches: \[main, "release\/\*\*"\]/);
    expect(workflow).toContain("name: iso-seed-amd64");
  });
});

describe("scripts/publish-iso-seed.sh", () => {
  let dir: string;
  const seedBytes = Buffer.from("not really an iso, but it has a hash");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "iso-seed-"));
    writeFileSync(join(dir, "wf.yml"), `BASE_URL: https://cdimage.debian.org/cdimage/archive/13.6.0/amd64/iso-cd/x.iso\n      SEED_SHA256: ${createHash("sha256").update(seedBytes).digest("hex")}\n`);
    writeFileSync(join(dir, "wrangler.toml"), `a = 1\n# FLAGSHIP_ISO_SEED = '{"url":"<tag>"}'\nb = 2\n`);
    writeFileSync(join(dir, "seed.iso"), seedBytes);
    mkdirSyncBin();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function mkdirSyncBin() {
    const bin = join(dir, "bin");
    execFileSync("mkdir", [bin]);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
echo "$@" >> "${dir}/gh.log"
case "$1 $2" in
  "run download") d=""; while [ $# -gt 0 ]; do [ "$1" = --dir ] && d="$2"; shift; done; cp "${dir}/seed.iso" "$d/seed.iso" ;;
  "release view") exit 1 ;;
esac
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
  }

  const run = () =>
    execFileSync("bash", [join(root, "scripts/publish-iso-seed.sh"), "123"], {
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, WORKFLOW: join(dir, "wf.yml"), WRANGLER_TOML: join(dir, "wrangler.toml") },
      encoding: "utf8",
    });

  it("uploads the seed and switches on FLAGSHIP_ISO_SEED with the real url and size", () => {
    run();
    const toml = readFileSync(join(dir, "wrangler.toml"), "utf8");
    const line = /^FLAGSHIP_ISO_SEED = '(.*)'$/m.exec(toml)![1]!;
    const m = JSON.parse(line);
    expect(m.url).toBe("https://github.com/ibisllc/flagship/releases/download/iso-seed-debian-13.6.0/flagship-seed-debian-13.6.0-amd64.iso");
    expect(m.sizeBytes).toBe(seedBytes.length);
    expect(m.sha256).toBe(createHash("sha256").update(seedBytes).digest("hex"));
    expect(toml).toContain("a = 1\n");
    expect(toml).toContain("b = 2\n");
    expect(readFileSync(join(dir, "gh.log"), "utf8")).toContain("release upload iso-seed-debian-13.6.0");
  });

  it("refuses an artifact that is not the pinned seed, and changes nothing", () => {
    writeFileSync(join(dir, "seed.iso"), "tampered");
    expect(() => run()).toThrow();
    expect(readFileSync(join(dir, "wrangler.toml"), "utf8")).toContain("# FLAGSHIP_ISO_SEED");
    expect(readFileSync(join(dir, "gh.log"), "utf8")).not.toContain("release upload");
  });
});
