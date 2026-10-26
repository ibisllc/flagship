/**
 * Seed-ISO chain-load contract.
 *
 * The builder streams a generic seed ISO (iso-seed/) verbatim, then appends a FAT
 * partition labeled FLAGSHIP whose /preseed.cfg is the full buildDebianPreseed
 * output. The seed's stub preseed (buildSeedStubPreseed / iso-seed/preseed.cfg)
 * sets the handful of settings d-i consumes BEFORE preseed/early_command, then
 * chain-loads the real preseed via debconf-set-selections. These tests pin the
 * two invariants that make that safe:
 *
 *  1. The stub and the generator agree on the pre-early_command constants
 *     (locale + keymap) — otherwise the stub's value silently wins and the
 *     recipe's is applied too late.
 *  2. Every non-comment line of the per-recipe preseed is a valid
 *     debconf-set-selections directive (or a continuation) — anything else
 *     would make debconf-set-selections choke mid-stream and the directive
 *     would never apply.
 */
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  signInstallBlob,
  ed,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { buildSeedStubPreseed } from "../src/preseed.js";
import { buildPreseedFromRecipe } from "../src/preseedEngine.js";

const here = dirname(fileURLToPath(import.meta.url));
const SEED_STUB_PATH = join(here, "..", "..", "..", "iso-seed", "preseed.cfg");

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const kp = (seed: number) => {
  const sk = new Uint8Array(32).fill(seed);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
};

interface RecipeOpts {
  diskEncryption?: "luks" | "none";
  wifiSSID?: string;
  wifiPassword?: string;
}

function buildSignedRecipe(o: RecipeOpts = {}): string {
  const irk = kp(7);
  const delegate = kp(8);
  const rck = kp(9);
  const expiresAt = 1_900_000_000_000;
  const authCode: AuthCode = {
    version: 1,
    serial: "01SEEDTEST00",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: delegate.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: expiresAt - 3_600_000,
    expiresAt,
  };
  const blob: InstallBlob = {
    version: 2,
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    serverName: authCode.serverName,
    phoneDelegatedPubKey: delegate.publicKey,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode,
    authCodeUserSignature: new Uint8Array(64),
    installerGitRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    rckPubKey: rck.publicKey,
    ...(o.diskEncryption ? { diskEncryption: o.diskEncryption } : {}),
  };
  const sig = signInstallBlob(blob, irk);
  return JSON.stringify({
    version: 2,
    serverDomain: blob.serverDomain,
    username: blob.username,
    serverName: blob.serverName,
    phoneDelegatedPubKey: hex(blob.phoneDelegatedPubKey),
    registrationUrl: blob.registrationUrl,
    authCode: {
      version: 1,
      serial: authCode.serial,
      username: authCode.username,
      serverName: authCode.serverName,
      serverDomain: authCode.serverDomain,
      delegatedPubKey: hex(authCode.delegatedPubKey),
      userPubKey: hex(authCode.userPubKey),
      issuedAt: authCode.issuedAt,
      expiresAt: authCode.expiresAt,
    },
    authCodeUserSignature: hex(blob.authCodeUserSignature),
    installerGitRef: blob.installerGitRef,
    rckPubKey: hex(blob.rckPubKey),
    ...(o.diskEncryption ? { diskEncryption: o.diskEncryption } : {}),
    blobSignatureHex: hex(sig),
  });
}

/** The locale + keymap directives, pulled out of any preseed body. */
function localeKeymapLines(preseed: string): string[] {
  return preseed
    .split("\n")
    .filter((l) => /^d-i (debian-installer\/locale|keyboard-configuration\/xkb-keymap) /.test(l));
}

describe("seed stub preseed", () => {
  it("stub and generator agree on the pre-early_command constants (can't drift)", () => {
    const stub = localeKeymapLines(buildSeedStubPreseed());
    const gen = localeKeymapLines(buildPreseedFromRecipe(buildSignedRecipe(), "{}"));
    expect(stub).toEqual([
      "d-i debian-installer/locale string en_US.UTF-8",
      "d-i keyboard-configuration/xkb-keymap select us",
    ]);
    expect(gen).toEqual(stub);
  });

  it("stub is functionally byte-identical to the committed iso-seed/preseed.cfg", () => {
    const functional = (s: string) =>
      s.split("\n").filter((l) => l.trim().length > 0 && !l.trimStart().startsWith("#"));
    const onDisk = readFileSync(SEED_STUB_PATH, "utf8");
    expect(functional(buildSeedStubPreseed())).toEqual(functional(onDisk));
  });
});

const DEBCONF_LINE =
  /^[A-Za-z0-9][A-Za-z0-9.+_-]*\s+\S+\s+(string|boolean|select|multiselect|password|note|text|error|title|seen)(\s|$)/;

/**
 * Every physical line of a preseed body is one of: a comment, a blank line, a
 * continuation (leading whitespace, following a line that ended with a
 * backslash), or a `owner question type value` directive. debconf-set-selections
 * accepts exactly this; a line that is none of these would be silently dropped
 * (the directive never applies) when chain-loaded mid-stream.
 */
function offendingLines(preseed: string): string[] {
  const bad: string[] = [];
  let inContinuation = false;
  for (const raw of preseed.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const isContinuation = inContinuation;
    inContinuation = /\\$/.test(line);
    if (isContinuation) continue;
    if (line.trim().length === 0) continue;
    if (line.trimStart().startsWith("#")) continue;
    if (!DEBCONF_LINE.test(line)) bad.push(line);
  }
  return bad;
}

describe("per-recipe preseed is a valid debconf-set-selections body", () => {
  const cases: Array<{ name: string; recipe: RecipeOpts; burn: Record<string, unknown> }> = [
    { name: "luks default", recipe: { diskEncryption: "luks" }, burn: {} },
    { name: "no encryption", recipe: { diskEncryption: "none" }, burn: { encryptRoot: false } },
    { name: "wifi baked", recipe: {}, burn: { wifiSSID: "myssid", wifiPassword: "p@ss w0rd" } },
  ];
  for (const c of cases) {
    it(`chain-loads cleanly — ${c.name}`, () => {
      const preseed = buildPreseedFromRecipe(buildSignedRecipe(c.recipe), JSON.stringify(c.burn));
      const bad = offendingLines(preseed);
      expect(bad, `debconf-set-selections would choke on:\n${bad.join("\n")}`).toEqual([]);
    });
  }
});

describe("the stub's early_command takes the recipe from the FLAGSHIP partition only", () => {
  const cfg = readFileSync(join(__dirname, "..", "..", "..", "iso-seed", "preseed.cfg"), "utf8");
  const early = cfg.slice(cfg.indexOf("d-i preseed/early_command string")).replace(/^d-i preseed\/early_command string /, "").replace(/\\\n/g, "\n");

  /** devices: [name, label, hasPreseed]. Returns what d-i would have been handed, and whether it halted. */
  function run(devices: Array<[string, string, boolean]>): { applied: string[]; halted: boolean } {
    const dir = mkdtempSync(join(tmpdir(), "stub-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const w = (n: string, body: string) => {
      writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, n), 0o755);
    };
    const labels = "for a in \"$@\"; do d=$a; done; " + devices.map(([d, l]) => `[ "$d" = ${d} ] && echo ${l}`).join("; ");
    const withFile = devices.filter(([, , has]) => has).map(([d]) => d).join(" ");
    w("list-devices", `[ "$1" = partition ] && echo ${devices.map(([d]) => d).join(" ")}; exit 0`);
    w("blkid", `${labels}; exit 0`);
    w("mount", `dev=; prev=; for a in "$@"; do dev=$prev; prev=$a; done; echo "$dev" > "${dir}/mounted"; mkdir -p "${dir}/run"; case " ${withFile} " in *" $dev "*) echo "# from $dev" > "${dir}/run/preseed.cfg";; *) rm -f "${dir}/run/preseed.cfg";; esac`);
    w("umount", "exit 0");
    w("debconf-set-selections", `cat "$1" >> "${dir}/applied"`);
    w("sleep", "kill -TERM $PPID");
    const script = early.replaceAll("/run/flagship", join(dir, "run")).replace("mkdir -p " + join(dir, "run"), `mkdir -p "${join(dir, "run")}"`);
    let halted = false;
    try {
      execFileSync("/bin/sh", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: "pipe", timeout: 10_000 });
    } catch (e) {
      halted = (e as { signal?: string }).signal === "SIGTERM";
    }
    const applied = existsSync(join(dir, "applied")) ? readFileSync(join(dir, "applied"), "utf8").trim().split("\n") : [];
    rmSync(dir, { recursive: true, force: true });
    return { applied, halted };
  }

  it("loads the recipe from the one partition labelled FLAGSHIP", () => {
    expect(run([["/dev/sda1", "FLAGSHIP", true]])).toEqual({ applied: ["# from /dev/sda1"], halted: false });
  });
  it("ignores another disk's FAT preseed.cfg, even one that enumerates first", () => {
    expect(run([["/dev/sda1", "EFI", true], ["/dev/sdb3", "FLAGSHIP", true]])).toEqual({ applied: ["# from /dev/sdb3"], halted: false });
  });
  it("halts when nothing is labelled FLAGSHIP", () => {
    expect(run([["/dev/sda1", "EFI", true]])).toEqual({ applied: [], halted: true });
  });
  it("halts when two partitions claim the label rather than choosing one", () => {
    expect(run([["/dev/sda1", "FLAGSHIP", true], ["/dev/sdb3", "FLAGSHIP", true]])).toEqual({ applied: [], halted: true });
  });
});

describe("the Wi-Fi script refuses text that could end its heredoc", () => {
  it("rejects line breaks and control characters in the name or password", async () => {
    const { wifiSetupScript } = await import("../src/userdata.js");
    expect(() => wifiSetupScript("home", "pass\nFLAGSHIP_WPA_EOF\nreboot")).toThrow(/control characters/);
    expect(() => wifiSetupScript("ho\rme", "pass")).toThrow(/control characters/);
    expect(wifiSetupScript("home", "a long passphrase")).toContain("home");
  });
});
