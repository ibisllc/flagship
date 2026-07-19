/**
 * The ONE generator, proven byte-identical across engines.
 *
 * The shipped engine bundle (`dist/preseed-engine.js`) is what macOS/iOS
 * (JavaScriptCore) and Android (Rhino) run. This:
 *  1. evaluates the bundle in a BARE Node-free `vm` context (no Buffer / require /
 *     process / TextEncoder) — if it runs there, it runs on JSC + Rhino, and the
 *     per-platform tests (Swift/Kotlin) assert the same outputs;
 *  2. asserts the bundle's `buildPreseedFromRecipe` / `buildUserDataFromRecipe`
 *     are byte-identical to the in-process generator across a recipe matrix
 *     (LUKS on/off × Wi-Fi × debug-grant × swk × pairing);
 *  3. ties the engine path to the canonical CLI path (loadBlobFromString →
 *     buildDebianPreseed) so they can't drift;
 *  4. proves the debug-access grant (the consent artifact) reaches install-blob.json.
 *
 * If the checked-in bundle is stale vs source, (2) fails — so it doubles as a
 * freshness gate. Regenerate with `npm run bundle:engine`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import {
  signInstallBlob,
  ed,
  type InstallBlob,
  type AuthCode,
} from "@flagship/protocol";
import { buildDebianPreseed, buildAutoinstallUserData } from "../src/index.js";
import { optionsFromRecipeJson } from "../src/preseedEngine.js";
import { loadBlobFromString } from "../src/loadBlob.js";

const here = dirname(fileURLToPath(import.meta.url));
// The COMMITTED bundle the native burners ship (Android assets / iOS resource).
// Reading it here makes this test a staleness gate: a bundle out of sync with
// source fails the byte-identical assertions. Regenerate with `npm run bundle:engine`.
const BUNDLE_PATH = join(here, "..", "engine", "preseed-engine.js");

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const kp = (seed: number) => {
  const sk = new Uint8Array(32).fill(seed);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
};

interface RecipeOpts {
  diskEncryption?: "luks" | "none";
  bootUnlockMode?: "auto" | "approve";
  swkHex?: string;
  pairingOrder?: string;
  debugGrant?: string;
  adminRoot?: boolean;
}

function buildSignedRecipe(o: RecipeOpts = {}): string {
  const irk = kp(7);
  const delegate = kp(8);
  const rck = kp(9);
  const adminRoot = kp(10);
  const expiresAt = 1_900_000_000_000; // fixed → deterministic
  const authCode: AuthCode = {
    version: 1,
    serial: "01ENGINETEST",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: delegate.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: expiresAt - 3_600_000,
    expiresAt,
    ...(o.adminRoot ? { adminRootPubKey: adminRoot.publicKey } : {}),
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
    ...(o.bootUnlockMode ? { bootUnlockMode: o.bootUnlockMode } : {}),
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
      ...(authCode.adminRootPubKey
        ? { adminRootPubKey: hex(authCode.adminRootPubKey) }
        : {}),
    },
    authCodeUserSignature: hex(blob.authCodeUserSignature),
    installerGitRef: blob.installerGitRef,
    rckPubKey: hex(blob.rckPubKey),
    ...(o.bootUnlockMode ? { bootUnlockMode: o.bootUnlockMode } : {}),
    ...(o.diskEncryption ? { diskEncryption: o.diskEncryption } : {}),
    blobSignatureHex: hex(sig),
    ...(o.swkHex ? { swkHex: o.swkHex } : {}),
    ...(o.pairingOrder ? { pairingOrder: o.pairingOrder } : {}),
    ...(o.debugGrant ? { debugGrant: o.debugGrant } : {}),
  });
}

/** A bare engine: a vm context with ECMAScript built-ins ONLY (no Node). */
function makeBareEngine(): {
  buildPreseed: (recipe: string, burn?: string) => string;
  buildUserData: (recipe: string, burn?: string) => string;
} {
  const src = readFileSync(BUNDLE_PATH, "utf8");
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  // Deliberately do NOT expose Buffer/process/require/TextEncoder/console.
  vm.runInContext(src, sandbox, { filename: "preseed-engine.js" });
  const api = (sandbox as { FlagshipPreseed?: Record<string, (a: string, b?: string) => string> }).FlagshipPreseed;
  if (!api) throw new Error("bundle did not install FlagshipPreseed global");
  return {
    buildPreseed: (recipe, burn) => api.buildPreseedFromRecipe(recipe, burn),
    buildUserData: (recipe, burn) => api.buildUserDataFromRecipe(recipe, burn),
  };
}

const matrix: Array<{ name: string; recipe: RecipeOpts; burn: Record<string, unknown> }> = [
  { name: "luks (default)", recipe: { diskEncryption: "luks" }, burn: {} },
  { name: "no encryption", recipe: { diskEncryption: "none" }, burn: { encryptRoot: false } },
  { name: "wifi baked", recipe: {}, burn: { wifiSSID: "myssid", wifiPassword: "p@ss w0rd" } },
  { name: "approve unlock", recipe: { bootUnlockMode: "approve" }, burn: {} },
  { name: "admin-root-gated recipe", recipe: { adminRoot: true }, burn: {} },
  { name: "swk + pairing siblings", recipe: { swkHex: "ab".repeat(32), pairingOrder: '{"request":"x","signature":"y"}' }, burn: {} },
  {
    name: "debug grant sibling",
    recipe: { debugGrant: JSON.stringify({ grant: { serverDomain: "home.harry.flagship.services", sshAuthorizedKey: "", issuedAt: 1700000000000 }, signatureHex: "ab".repeat(64) }) },
    burn: {},
  },
];

describe("preseed engine bundle", () => {
  let engine: ReturnType<typeof makeBareEngine>;
  beforeAll(() => { engine = makeBareEngine(); });

  it("the shipped bundle has no Node builtins", () => {
    const src = readFileSync(BUNDLE_PATH, "utf8");
    expect(src).not.toMatch(/require\(/);
    expect(src).not.toMatch(/node:/);
    expect(src).not.toMatch(/\bprocess\./);
    expect(src).not.toMatch(/\bBuffer\b/);
  });

  for (const m of matrix) {
    it(`preseed byte-identical via bare engine — ${m.name}`, () => {
      const recipe = buildSignedRecipe(m.recipe);
      const burnJson = JSON.stringify(m.burn);
      const direct = buildDebianPreseed(optionsFromRecipeJson(recipe, m.burn));
      const viaEngine = engine.buildPreseed(recipe, burnJson);
      expect(viaEngine).toBe(direct);
      expect(viaEngine.length).toBeGreaterThan(100);
    });

    it(`user-data byte-identical via bare engine — ${m.name}`, () => {
      const recipe = buildSignedRecipe(m.recipe);
      const burnJson = JSON.stringify(m.burn);
      const direct = buildAutoinstallUserData(optionsFromRecipeJson(recipe, m.burn));
      expect(engine.buildUserData(recipe, burnJson)).toBe(direct);
    });
  }

  it("engine path matches the canonical CLI path (loadBlobFromString → buildDebianPreseed)", () => {
    const recipe = buildSignedRecipe({ diskEncryption: "luks", swkHex: "cd".repeat(32) });
    const loaded = loadBlobFromString(recipe);
    const viaCli = buildDebianPreseed({
      blob: loaded.blob,
      blobSignatureHex: loaded.blobSignatureHex,
      pairingOrder: loaded.pairingOrder,
      swkHex: loaded.swkHex,
      debugGrant: loaded.debugGrant,
    });
    expect(engine.buildPreseed(recipe, "{}")).toBe(viaCli);
  });

  it("preserves adminRootPubKey into the install-time auth code", () => {
    const preseed = engine.buildPreseed(buildSignedRecipe({ adminRoot: true }), "{}");
    const match = preseed.match(
      /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/target\/var\/flagship\/install-blob\.json/,
    );
    expect(match).not.toBeNull();
    const embedded = JSON.parse(Buffer.from(match![1]!, "base64").toString("utf8"));
    expect(embedded.authCode.adminRootPubKey).toBe(hex(kp(10).publicKey));
  });

  it("reproduces every committed golden vector (the cross-engine contract)", () => {
    const fixture = JSON.parse(
      readFileSync(join(here, "..", "engine", "golden", "preseed-vectors.json"), "utf8"),
    ) as { vectors: Array<{ name: string; recipeJson: string; burnOptsJson: string; expectedPreseed: string; expectedUserData: string }> };
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(6);
    for (const v of fixture.vectors) {
      expect(engine.buildPreseed(v.recipeJson, v.burnOptsJson), `preseed ${v.name}`).toBe(v.expectedPreseed);
      expect(engine.buildUserData(v.recipeJson, v.burnOptsJson), `user-data ${v.name}`).toBe(v.expectedUserData);
    }
  });

  it("the debug-access grant reaches install-blob.json (consent is load-bearing)", () => {
    const grant = JSON.stringify({ grant: { serverDomain: "home.harry.flagship.services", sshAuthorizedKey: "ssh-ed25519 AAAA", issuedAt: 1700000000000 }, signatureHex: "ab".repeat(64) });
    const preseed = engine.buildPreseed(buildSignedRecipe({ debugGrant: grant }), "{}");
    const m = preseed.match(
      /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/target\/var\/flagship\/install-blob\.json/,
    );
    expect(m).toBeTruthy();
    const decoded = Buffer.from(m![1]!, "base64").toString("utf8");
    const blobJson = JSON.parse(decoded) as { debugGrant?: string };
    expect(blobJson.debugGrant).toBe(grant);
    // And a recipe WITHOUT the grant must NOT carry it (production image).
    const plain = engine.buildPreseed(buildSignedRecipe({}), "{}");
    const pm = plain.match(
      /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/target\/var\/flagship\/install-blob\.json/,
    );
    const plainJson = JSON.parse(Buffer.from(pm![1]!, "base64").toString("utf8")) as { debugGrant?: string };
    expect(plainJson.debugGrant).toBeUndefined();
  });
});
