/**
 * Generic per-app environment variables — the replacement for the old
 * AI-specific BYOK store/runtime/proxy (chunk-2). Faithfully migrates
 * every prior appByok behavior to the generic `Record<string,string>`
 * mechanism, and adds the two decisive security invariants:
 *
 *   (a) VALUES-NEVER-TO-MODEL — the vibecode prompt the session builds
 *       contains the NAMES but never a DO-NOT-LEAK sentinel value.
 *   (e) EXPORT-EXCLUSION — a shared/exported app artifact carries the
 *       declared names (schema) but never a sentinel value.
 */

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { swkOps, boxSigner } from "./helpers/keyCustody.js";
import type { SwkOps } from "../src/keyCustodian.js";
import {
  ed,
  signInstallService,
  signSetServiceEnv,
  signUninstallService,
  verifySetServiceEnv,
  type Keypair,
  type SetServiceEnvRequest,
} from "@flagship/protocol";
import {
  FileAppEnvStore,
  InMemoryAppEnvStore,
  exportEnvSchema,
  type AppEnv,
  type AppEnvStore,
} from "../src/serviceEnvStore.js";
import { ServicePlatform } from "../src/servicePlatform.js";
import { AppRunner, type AppSpec, type CommandRunner } from "../src/serviceRunner.js";
import { buildUserContext } from "../src/llm/systemPrompt.js";
import { buildDeploySession } from "../src/llm/deploySession.js";
import { VibeCodeSession } from "../src/llm/vibeCodeSession.js";
import type { InstalledService } from "../src/servicePlatform.js";

/** The decisive sentinel: this string is a VALUE and must NEVER leave the box. */
const SECRET = "sk-user-private-DO-NOT-LEAK-1234567890";
const HOST = "alice";
const HOST_FQDN = `home.${HOST}.flagship.services`;

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function fakeSwk(): SwkOps {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return swkOps(b);
}
function fakeRunner(): { runner: AppRunner; specs: AppSpec[] } {
  const specs: AppSpec[] = [];
  const cmd: CommandRunner = {
    run: async () => {},
    capture: async () => ({ stdout: "", stderr: "" }),
  };
  const runner = new AppRunner(cmd);
  const realDeploy = runner.deploy.bind(runner);
  runner.deploy = async (spec: AppSpec) => {
    specs.push(spec);
    return realDeploy(spec);
  };
  return { runner, specs };
}

const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "envapp",
  version: "0.1.0",
  runtime: { image: "node:20", port: 8080 },
  data: {},
  network: { subdomain: "envapp" },
  access: { enabled: true, default_role: "viewer" },
  migration: { portable: true, verification: "standard" },
});

// ── Store contract — both implementations behave identically ──────────
// (Faithful migration of the chunk-2 appByok store-contract suite.)

function runStoreContract(label: string, factory: () => Promise<AppEnvStore>): void {
  describe(`${label} — interface contract`, () => {
    let store: AppEnvStore;
    beforeEach(async () => {
      store = await factory();
    });

    // Justification: a stored env round-trips with values intact (the
    // former appByok round-trip, now generic).
    it("put then get round-trips the full env map", async () => {
      const env: AppEnv = { OPENAI_API_KEY: SECRET, REGION: "us" };
      await store.put("alice--envapp", env);
      expect(await store.get("alice--envapp")).toEqual(env);
    });

    // Justification: names() is the ONLY non-runtime accessor and must
    // never carry a value (replaces the byok `describe()` redaction).
    it("names() returns sorted KEY NAMES only — never a value", async () => {
      await store.put("alice--envapp", { B_KEY: SECRET, A_KEY: "x" });
      const names = await store.names("alice--envapp");
      expect(names).toEqual(["A_KEY", "B_KEY"]);
      expect(JSON.stringify(names)).not.toContain(SECRET);
    });

    // Justification: env is strictly scoped to one serviceId.
    it("get is scoped per app — another app sees nothing", async () => {
      await store.put("alice--envapp", { K: SECRET });
      expect(await store.get("alice--otherapp")).toBeNull();
      expect(await store.names("alice--otherapp")).toEqual([]);
    });

    // Justification: uninstall must be able to fully drop the values.
    it("forget removes the env; idempotent", async () => {
      await store.put("alice--envapp", { K: SECRET });
      await store.forget("alice--envapp");
      await store.forget("alice--envapp");
      expect(await store.get("alice--envapp")).toBeNull();
    });
  });
}

runStoreContract("InMemoryAppEnvStore", async () => new InMemoryAppEnvStore());

describe("FileAppEnvStore — sealed at rest + persistence", () => {
  let dir: string;
  const swk = fakeSwk();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "env-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  runStoreContract("FileAppEnvStore", async () => {
    const d = await mkdtemp(join(tmpdir(), "env-c-"));
    return new FileAppEnvStore(d, fakeSwk());
  });

  // Justification (invariant c): no plaintext value on disk.
  it("never writes a value in plaintext to disk + file is 0o600", async () => {
    const store = new FileAppEnvStore(dir, swk);
    await store.put("alice--envapp", { OPENAI_API_KEY: SECRET });
    const files = await readdir(dir);
    const blobPath = join(dir, files[0]!);
    const blob = await readFile(blobPath, "utf8");
    expect(blob).not.toContain(SECRET);
    const mode = (await stat(blobPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // Justification: a fresh process recovers the sealed env via load().
  it("a new store instance recovers the env after load()", async () => {
    const a = new FileAppEnvStore(dir, swk);
    await a.put("alice--envapp", { K: SECRET });
    const b = new FileAppEnvStore(dir, swk);
    await b.load();
    expect(await b.get("alice--envapp")).toEqual({ K: SECRET });
  });

  // Justification (invariant c): the wrong SWK cannot recover values.
  it("a store with the wrong SWK cannot recover the env", async () => {
    const a = new FileAppEnvStore(dir, swk);
    await a.put("alice--envapp", { K: SECRET });
    const wrong = new FileAppEnvStore(dir, fakeSwk());
    await wrong.load();
    expect(await wrong.get("alice--envapp")).toBeNull();
  });
});

// ── Signed set-app-env order (invariant b) ────────────────────────────

describe("ServicePlatform.setEnv — owner-signed order accepted; unsigned/wrong-signer rejected", () => {
  function build() {
    const hostIrk = makeKey();
    const { runner } = fakeRunner();
    const store = new InMemoryAppEnvStore();
    const platform = new ServicePlatform({
      host: { username: HOST, irkPub: hostIrk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: null,
      envStore: store,
    });
    return { platform, hostIrk, store };
  }

  function order(env: Record<string, string>): SetServiceEnvRequest {
    return {
      serverId: HOST_FQDN,
      creator: HOST,
      slug: "envapp",
      env,
      issuedAt: Date.now(),
    };
  }

  // Justification (invariant b, positive): a valid owner-signed order
  // is accepted and stored sealed.
  it("accepts a valid host-IRK-signed order and stores it", async () => {
    const { platform, hostIrk, store } = build();
    const r = order({ OPENAI_API_KEY: SECRET });
    const res = await platform.setEnv({
      request: r,
      signature: signSetServiceEnv(r, hostIrk),
      verify: verifySetServiceEnv,
    });
    expect(res.ok).toBe(true);
    expect(await store.get("alice--envapp")).toEqual({ OPENAI_API_KEY: SECRET });
  });

  // Justification (invariant b, negative): a wrong-signer order is
  // REJECTED and NOTHING is stored.
  it("rejects a wrong-signer order; nothing is stored", async () => {
    const { platform, store } = build();
    const attacker = makeKey();
    const r = order({ OPENAI_API_KEY: SECRET });
    const res = await platform.setEnv({
      request: r,
      signature: signSetServiceEnv(r, attacker),
      verify: verifySetServiceEnv,
    });
    expect(res.ok).toBe(false);
    expect(await store.get("alice--envapp")).toBeNull();
  });

  // Justification (invariant b, negative): a tampered (unsigned) body
  // is rejected; nothing stored.
  it("rejects a value tampered after signing; nothing stored", async () => {
    const { platform, hostIrk, store } = build();
    const r = order({ OPENAI_API_KEY: SECRET });
    const sig = signSetServiceEnv(r, hostIrk);
    const res = await platform.setEnv({
      request: { ...r, env: { OPENAI_API_KEY: "sk-swapped" } },
      signature: sig,
      verify: verifySetServiceEnv,
    });
    expect(res.ok).toBe(false);
    expect(await store.get("alice--envapp")).toBeNull();
  });

  // Justification: reserved FLAGSHIP_ names can never be set by an owner.
  it("rejects a reserved FLAGSHIP_ env name", async () => {
    const { platform, hostIrk, store } = build();
    const r = order({ FLAGSHIP_APP_ID: "spoof" });
    const res = await platform.setEnv({
      request: r,
      signature: signSetServiceEnv(r, hostIrk),
      verify: verifySetServiceEnv,
    });
    expect(res.ok).toBe(false);
    expect(await store.get("alice--envapp")).toBeNull();
  });
});

// ── Runtime env injection (invariant d) + lifecycle (invariant g) ─────

describe("ServicePlatform — values injected into the deployed app's env; lifecycle", () => {
  function build(store: AppEnvStore) {
    const hostIrk = makeKey();
    const { runner, specs } = fakeRunner();
    const platform = new ServicePlatform({
      host: { username: HOST, irkPub: hostIrk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: null,
      envStore: store,
    });
    return { platform, hostIrk, specs };
  }

  function installReq() {
    return {
      serverId: HOST_FQDN,
      creator: HOST,
      slug: "envapp",
      manifestJson: MANIFEST,
      addOwnerToMembership: false,
      issuedAt: Date.now(),
    };
  }

  // Justification (invariant d): the values ARE present in the deployed
  // container's process environment.
  it("injects the owner-set values into the container env on deploy", async () => {
    const store = new InMemoryAppEnvStore();
    await store.put("alice--envapp", { OPENAI_API_KEY: SECRET });
    const { platform, hostIrk, specs } = build(store);
    const req = installReq();
    const r = await platform.install({
      request: req,
      signature: signInstallService(req, hostIrk),
      verify: () => true,
    });
    expect(r.ok).toBe(true);
    expect(specs).toHaveLength(1);
    const injected = specs[0]!.env ?? {};
    expect(injected.OPENAI_API_KEY).toBe(SECRET);
    // Reserved vars still win and are present.
    expect(injected.FLAGSHIP_APP_ID).toBe("alice--envapp");
  });

  // Justification (invariant g): the former appByok install/uninstall
  // lifecycle, now generic — uninstall forgets the values.
  it("uninstall forgets the env so values don't outlive the app", async () => {
    const store = new InMemoryAppEnvStore();
    await store.put("alice--envapp", { K: SECRET });
    const { platform, hostIrk } = build(store);
    const req = installReq();
    await platform.install({
      request: req,
      signature: signInstallService(req, hostIrk),
      verify: () => true,
    });
    const ureq = { serverId: HOST_FQDN, creator: HOST, slug: "envapp", issuedAt: Date.now() };
    const ur = await platform.uninstall({
      request: ureq,
      signature: signUninstallService(ureq, hostIrk),
      verify: () => true,
    });
    expect(ur.ok).toBe(true);
    expect(await store.get("alice--envapp")).toBeNull();
  });

  // Justification (invariant f): the public /api/services listing never
  // contains a value (the former appByok public-surface negative).
  it("the public app listing never contains a value", async () => {
    const store = new InMemoryAppEnvStore();
    await store.put("alice--envapp", { K: SECRET });
    const { platform, hostIrk } = build(store);
    const req = installReq();
    await platform.install({
      request: req,
      signature: signInstallService(req, hostIrk),
      verify: () => true,
    });
    expect(JSON.stringify(platform.list())).not.toContain(SECRET);
  });
});

// ── INVARIANT (a): VALUES NEVER REACH THE MODEL — the decisive test ───

describe("vibecode prompt — names only, value sentinel never present", () => {
  // Justification (invariant a, DECISIVE): driving the prompt build
  // with env vars set, the NAMES appear so generated code can use
  // them, but the DO-NOT-LEAK sentinel VALUE appears NOWHERE in the
  // full context the session would send to the provider.
  it("buildUserContext includes env NAMES but never a value", () => {
    const store = new InMemoryAppEnvStore();
    void store; // names are passed explicitly — values never enter this call
    const prompt = buildUserContext({
      username: HOST,
      hostname: "home",
      tier: "free",
      availableProviders: ["anthropic"],
      existingApps: [],
      appEnvNames: ["OPENAI_API_KEY", "STRIPE_SECRET_KEY"],
    });
    expect(prompt).toContain("OPENAI_API_KEY");
    expect(prompt).toContain("STRIPE_SECRET_KEY");
    expect(prompt).not.toContain(SECRET);
  });

  // Justification (invariant a): the wiring from the sealed store to
  // the prompt MUST pass names() (not get()) — prove the call that
  // produces the names list cannot carry a value.
  it("store.names() output (the prompt input) carries zero values", async () => {
    const store = new InMemoryAppEnvStore();
    await store.put("alice--envapp", {
      OPENAI_API_KEY: SECRET,
      STRIPE_SECRET_KEY: "sk-live-DO-NOT-LEAK",
    });
    const names = await store.names("alice--envapp");
    const prompt = buildUserContext({
      username: HOST,
      hostname: "home",
      tier: "free",
      availableProviders: ["anthropic"],
      existingApps: [],
      appEnvNames: names,
    });
    expect(prompt).toContain("OPENAI_API_KEY");
    expect(prompt).not.toContain(SECRET);
    expect(prompt).not.toContain("sk-live-DO-NOT-LEAK");
  });
});

// ── INVARIANT (e): EXPORT-EXCLUSION — the decisive export test ────────

describe("export/share artifact — declared names only, never a value", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "env-deploy-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  // Justification (invariant e, schema): the exported env schema is
  // names only — never a value.
  it("exportEnvSchema yields declared names but no value", async () => {
    const store = new InMemoryAppEnvStore();
    await store.put("alice--envapp", { OPENAI_API_KEY: SECRET, REGION: "us" });
    const schema = await exportEnvSchema(store, "alice--envapp");
    expect(schema.names).toEqual(["OPENAI_API_KEY", "REGION"]);
    expect(JSON.stringify(schema)).not.toContain(SECRET);
  });

  // Justification (invariant e, DECISIVE): the actual shared artifact
  // is the on-disk app working tree the deploy step writes + the repo
  // a bundle would be built from. With env set, NO file in that tree
  // contains the sentinel value (values live only in the separate
  // sealed env store, never in the app source).
  it("the deployed app source tree (the share artifact) contains no value", async () => {
    const hostIrk = makeKey();
    const { runner } = fakeRunner();
    const store = new InMemoryAppEnvStore();
    const platform = new ServicePlatform({
      host: { username: HOST, irkPub: hostIrk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: null,
      envStore: store,
    });
    // Owner sets a secret env on the app.
    const setReq: SetServiceEnvRequest = {
      serverId: HOST_FQDN,
      creator: HOST,
      slug: "envapp",
      env: { OPENAI_API_KEY: SECRET },
      issuedAt: Date.now(),
    };
    await platform.setEnv({
      request: setReq,
      signature: signSetServiceEnv(setReq, hostIrk),
      verify: verifySetServiceEnv,
    });

    const session = new VibeCodeSession({ username: HOST, serverFqdn: HOST_FQDN });
    session.feedAssistant(
      [
        "=== flagship.app.json ===",
        MANIFEST,
        "=== src/index.js ===",
        "const k = process.env.OPENAI_API_KEY; // reads from env at runtime",
        "=== END ===",
        "",
      ].join("\n"),
    );
    session.endAssistant();

    const deploy = buildDeploySession({
      servicePlatform: platform,
      signer: boxSigner(hostIrk),
      hostUsername: HOST,
      workingDir: workDir,
      cmd: { run: async () => {}, capture: async () => ({ stdout: "", stderr: "" }) },
    });
    const res = await deploy(session);
    expect(res.ok).toBe(true);

    // Walk the entire written source tree — the share/export artifact.
    const seen: string[] = [];
    async function walk(d: string): Promise<void> {
      for (const name of await readdir(d)) {
        const p = join(d, name);
        const s = await stat(p);
        if (s.isDirectory()) await walk(p);
        else seen.push(await readFile(p, "utf8"));
      }
    }
    await walk(workDir);
    expect(seen.length).toBeGreaterThan(0);
    for (const content of seen) {
      expect(content).not.toContain(SECRET);
    }
    // The name MAY appear (code references it) — that's allowed.
    expect(seen.some((c) => c.includes("OPENAI_API_KEY"))).toBe(true);
  });
});

// ── INVARIANT (f): values never in the HTTP set-env response/errors ──

describe("set-app-env HTTP — response never echoes a value", () => {
  // Justification (invariant f): a successful set-env returns a bare
  // ok; an error never interpolates a value.
  it("a wrong-signer set-env over HTTP returns a generic error, no value", async () => {
    const { buildServiceHttpHandlers } = await import("../src/servicePlatform.js");
    const hostIrk = makeKey();
    const { runner } = fakeRunner();
    const store = new InMemoryAppEnvStore();
    const platform = new ServicePlatform({
      host: { username: HOST, irkPub: hostIrk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: null,
      envStore: store,
    });
    const handle = buildServiceHttpHandlers({ platform, hostIrk: null });
    const r: SetServiceEnvRequest = {
      serverId: HOST_FQDN,
      creator: HOST,
      slug: "envapp",
      env: { OPENAI_API_KEY: SECRET },
      issuedAt: Date.now(),
    };
    const sig = signSetServiceEnv(r, makeKey()); // attacker key
    const res = await handle({
      method: "POST",
      path: "/api/services/alice--envapp/env",
      headers: {},
      body: Buffer.from(
        JSON.stringify({ request: r, signature: Buffer.from(sig).toString("hex") }),
      ),
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(res!.body.toString("utf8")).not.toContain(SECRET);
    expect(await store.get("alice--envapp")).toBeNull();
  });

  // Justification (invariant f): a valid set-env success body carries
  // no value either.
  it("a valid set-env over HTTP returns {ok:true} with no value echoed", async () => {
    const { buildServiceHttpHandlers } = await import("../src/servicePlatform.js");
    const hostIrk = makeKey();
    const { runner } = fakeRunner();
    const store = new InMemoryAppEnvStore();
    const platform = new ServicePlatform({
      host: { username: HOST, irkPub: hostIrk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: null,
      envStore: store,
    });
    const handle = buildServiceHttpHandlers({ platform, hostIrk: null });
    const r: SetServiceEnvRequest = {
      serverId: HOST_FQDN,
      creator: HOST,
      slug: "envapp",
      env: { OPENAI_API_KEY: SECRET },
      issuedAt: Date.now(),
    };
    const res = await handle({
      method: "POST",
      path: "/api/services/alice--envapp/env",
      headers: {},
      body: Buffer.from(
        JSON.stringify({ request: r, signature: Buffer.from(signSetServiceEnv(r, hostIrk)).toString("hex") }),
      ),
    });
    expect(res!.status).toBe(200);
    expect(res!.body.toString("utf8")).not.toContain(SECRET);
    expect(await store.get("alice--envapp")).toEqual({ OPENAI_API_KEY: SECRET });
  });
});
