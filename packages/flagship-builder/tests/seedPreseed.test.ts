/**
 * Seed-ISO chain-load contract.
 *
 * The burner streams a generic seed ISO (iso-seed/) verbatim, then appends a FAT
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
import { readFileSync } from "node:fs";
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
    installerGitRef: "main",
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
