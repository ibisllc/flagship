import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ed,
  signInstallApp,
  signUninstallApp,
  type Keypair,
} from "@flagship/protocol";
import {
  ProviderError,
  ProviderRegistry,
  type ChatRequest,
  type LLMProvider,
} from "@flagship/llm-providers";
import {
  FileAppByokStore,
  InMemoryAppByokStore,
  type AppByokConfig,
  type AppByokStore,
} from "../src/appByokStore.js";
import { AppByokRuntime } from "../src/appByokRuntime.js";
import { AppPlatform } from "../src/appPlatform.js";
import { AppRunner, type CommandRunner } from "../src/appRunner.js";
import { handleAppRequest } from "../src/appProxy.js";
import type { InstalledApp } from "../src/appPlatform.js";

const SECRET = "sk-user-private-DO-NOT-LEAK-1234567890";
const HOST = "alice";
const HOST_FQDN = `home.${HOST}.flagship.services`;

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function fakeSwk(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}
function fakeRunner(): { runner: AppRunner; calls: string[] } {
  const calls: string[] = [];
  const cmd: CommandRunner = {
    run: async (c, args) => { calls.push(`${c} ${args.join(" ")}`); },
    capture: async () => ({ stdout: "", stderr: "" }),
  };
  return { runner: new AppRunner(cmd), calls };
}

/** Fake provider that records the apiKey it was called with. */
function recordingProvider(name: string): {
  provider: LLMProvider;
  seenKey: () => string;
} {
  let seen = "";
  return {
    seenKey: () => seen,
    provider: {
      name,
      async chat(req: ChatRequest, cfg) {
        seen = cfg.apiKey;
        return { content: `pong:${req.messages.at(-1)!.content}`, model: req.model };
      },
    },
  };
}

const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "byokapp",
  version: "0.1.0",
  runtime: { image: "node:20", port: 8080 },
  data: {},
  network: { subdomain: "byokapp" },
  access: { enabled: true, default_role: "viewer" },
  migration: { portable: true, verification: "standard" },
});

// ── Store contract — both implementations behave identically ──────────

function runStoreContract(label: string, factory: () => Promise<AppByokStore>): void {
  describe(`${label} — interface contract`, () => {
    let store: AppByokStore;
    beforeEach(async () => {
      store = await factory();
    });

    // Justification: a stored config round-trips with the key intact.
    it("put then get round-trips providerId + apiKey + baseUrl", async () => {
      const cfg: AppByokConfig = {
        providerId: "anthropic",
        apiKey: SECRET,
        baseUrl: "https://proxy.example",
      };
      await store.put("alice-byokapp", cfg);
      expect(await store.get("alice-byokapp")).toEqual(cfg);
    });

    // Justification: the non-secret descriptor must never carry the key.
    it("describe omits the apiKey and only signals hasKey", async () => {
      await store.put("alice-byokapp", { providerId: "openai", apiKey: SECRET });
      const d = await store.describe("alice-byokapp");
      expect(d).toEqual({ providerId: "openai", baseUrl: undefined, hasKey: true });
      expect(JSON.stringify(d)).not.toContain(SECRET);
    });

    // Justification: config is strictly scoped to one appId.
    it("get is scoped per app — another app sees nothing", async () => {
      await store.put("alice-byokapp", { providerId: "openai", apiKey: SECRET });
      expect(await store.get("alice-otherapp")).toBeNull();
    });

    // Justification: uninstall must be able to fully drop the key.
    it("forget removes the config; idempotent", async () => {
      await store.put("alice-byokapp", { providerId: "openai", apiKey: SECRET });
      await store.forget("alice-byokapp");
      await store.forget("alice-byokapp");
      expect(await store.get("alice-byokapp")).toBeNull();
    });
  });
}

runStoreContract("InMemoryAppByokStore", async () => new InMemoryAppByokStore());

describe("FileAppByokStore — sealed at rest + persistence", () => {
  let dir: string;
  const swk = fakeSwk();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "byok-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  runStoreContract("FileAppByokStore", async () => {
    const d = await mkdtemp(join(tmpdir(), "byok-c-"));
    return new FileAppByokStore(d, fakeSwk());
  });

  // Justification: the on-disk blob must not contain the plaintext key.
  it("never writes the apiKey in plaintext to disk", async () => {
    const store = new FileAppByokStore(dir, swk);
    await store.put("alice-byokapp", { providerId: "anthropic", apiKey: SECRET });
    const files = await readdir(dir);
    const blob = await readFile(join(dir, files[0]!), "utf8");
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain("anthropic");
  });

  // Justification: a fresh process must recover the sealed config via load().
  it("a new store instance recovers the config after load()", async () => {
    const a = new FileAppByokStore(dir, swk);
    await a.put("alice-byokapp", { providerId: "google", apiKey: SECRET });
    const b = new FileAppByokStore(dir, swk);
    await b.load();
    expect(await b.get("alice-byokapp")).toEqual({
      providerId: "google",
      apiKey: SECRET,
      baseUrl: undefined,
    });
  });

  // Justification: the wrong SWK must not yield the key (it's sealed).
  it("a store with the wrong SWK cannot recover the config", async () => {
    const a = new FileAppByokStore(dir, swk);
    await a.put("alice-byokapp", { providerId: "google", apiKey: SECRET });
    const wrong = new FileAppByokStore(dir, fakeSwk());
    await wrong.load();
    expect(await wrong.get("alice-byokapp")).toBeNull();
  });
});

// ── Runtime seam — the actual provider call uses the stored key ───────

describe("AppByokRuntime — runtime LLM call uses the app's own stored key", () => {
  // Justification: the decisive round-trip — the resolved adapter is
  // invoked with EXACTLY the key persisted for that app.
  it("loads the stored key and passes it to the resolved adapter", async () => {
    const rec = recordingProvider("anthropic");
    const store = new InMemoryAppByokStore();
    await store.put("alice-byokapp", { providerId: "anthropic", apiKey: SECRET });
    const runtime = new AppByokRuntime({
      store,
      registry: new ProviderRegistry([rec.provider]),
    });
    const r = await runtime.chat("alice-byokapp", {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.response.content).toBe("pong:hi");
    expect(rec.seenKey()).toBe(SECRET);
  });

  // Justification: a different app must not borrow this app's key.
  it("returns no-config (never another app's key) when unset for the app", async () => {
    const rec = recordingProvider("anthropic");
    const store = new InMemoryAppByokStore();
    await store.put("alice-byokapp", { providerId: "anthropic", apiKey: SECRET });
    const runtime = new AppByokRuntime({
      store,
      registry: new ProviderRegistry([rec.provider]),
    });
    const r = await runtime.chat("alice-otherapp", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no-config");
    expect(rec.seenKey()).toBe("");
  });

  // Justification: provider errors must not echo the user's key.
  it("a ProviderError never surfaces the apiKey in the message", async () => {
    const throwing: LLMProvider = {
      name: "anthropic",
      async chat() {
        throw new ProviderError("anthropic", 401, `bad key ${SECRET}`);
      },
    };
    const store = new InMemoryAppByokStore();
    await store.put("alice-byokapp", { providerId: "anthropic", apiKey: SECRET });
    const runtime = new AppByokRuntime({
      store,
      registry: new ProviderRegistry([throwing]),
    });
    const r = await runtime.chat("alice-byokapp", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("provider-error");
      expect(r.message).not.toContain(SECRET);
    }
  });

  // Justification: a misbehaving adapter throwing the key must be contained.
  it("a non-ProviderError throw cannot smuggle the key into the message", async () => {
    const evil: LLMProvider = {
      name: "anthropic",
      async chat() {
        throw new Error(`leak ${SECRET}`);
      },
    };
    const store = new InMemoryAppByokStore();
    await store.put("alice-byokapp", { providerId: "anthropic", apiKey: SECRET });
    const runtime = new AppByokRuntime({
      store,
      registry: new ProviderRegistry([evil]),
    });
    const r = await runtime.chat("alice-byokapp", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(SECRET);
  });
});

// ── appProxy — /.flagship/llm/chat intercepted, key never in body ─────

describe("appProxy — BYOK runtime call interception", () => {
  function fakeApp(): InstalledApp {
    const platformDeps = {
      host: { username: HOST, irkPub: makeKey().publicKey },
      swk: fakeSwk(),
      appRunner: fakeRunner().runner,
      dataProvisioner: null,
    };
    void platformDeps;
    return {
      creator: HOST,
      slug: "byokapp",
      appId: "alice-byokapp",
      manifest: JSON.parse(MANIFEST),
      urlLabel: "byokapp",
      // membership is unused on this path (public-route bypass below).
      membership: { members: { isMember: () => false } } as unknown as InstalledApp["membership"],
      containerPort: 1,
      data: null,
      installedAt: 0,
    };
  }

  // Justification: the proxy answers the call itself; the container is
  // never reached and the response carries only the model output.
  it("answers /.flagship/llm/chat with the model output, key never in the body", async () => {
    const rec = recordingProvider("anthropic");
    const store = new InMemoryAppByokStore();
    await store.put("alice-byokapp", { providerId: "anthropic", apiKey: SECRET });
    const runtime = new AppByokRuntime({
      store,
      registry: new ProviderRegistry([rec.provider]),
    });
    const app = fakeApp();
    // Make the BYOK path a public route so access is allowed without a session.
    app.manifest.access.public_routes = ["/.flagship/llm/chat"];

    let forwarded = false;
    const res = await handleAppRequest(
      app,
      {
        method: "POST",
        path: "/.flagship/llm/chat",
        headers: {},
        body: Buffer.from(
          JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }),
        ),
      },
      {
        injectorKey: makeKey(),
        byokRuntime: runtime,
        forward: async () => {
          forwarded = true;
          return { status: 200, headers: {}, body: Buffer.from("container") };
        },
      },
    );
    expect(forwarded).toBe(false);
    expect(res.status).toBe(200);
    const bodyStr = res.body.toString("utf8");
    expect(bodyStr).not.toContain(SECRET);
    expect(JSON.parse(bodyStr).response.content).toBe("pong:hi");
    expect(rec.seenKey()).toBe(SECRET);
  });
});

// ── AppPlatform — persists on install, forgets on uninstall ───────────

describe("AppPlatform — BYOK config lifecycle + no public-surface leak", () => {
  function build(byokStore: AppByokStore) {
    const hostIrk = makeKey();
    const { runner } = fakeRunner();
    const platform = new AppPlatform({
      host: { username: HOST, irkPub: hostIrk.publicKey },
      swk: fakeSwk(),
      appRunner: runner,
      dataProvisioner: null,
      byokStore,
    });
    return { platform, hostIrk };
  }

  // Justification: install persists the per-app key; uninstall drops it.
  it("install stores the BYOK config; uninstall forgets it", async () => {
    const store = new InMemoryAppByokStore();
    const { platform, hostIrk } = build(store);
    const req = {
      serverId: HOST_FQDN,
      creator: HOST,
      slug: "byokapp",
      manifestJson: MANIFEST,
      addOwnerToMembership: false,
      issuedAt: Date.now(),
    };
    const r = await platform.install({
      request: req,
      signature: signInstallApp(req, hostIrk),
      verify: () => true,
      byok: { providerId: "anthropic", apiKey: SECRET },
    });
    expect(r.ok).toBe(true);
    expect(await store.get("alice-byokapp")).toEqual({
      providerId: "anthropic",
      apiKey: SECRET,
    });

    const ureq = { serverId: HOST_FQDN, creator: HOST, slug: "byokapp", issuedAt: Date.now() };
    const ur = await platform.uninstall({
      request: ureq,
      signature: signUninstallApp(ureq, hostIrk),
      verify: () => true,
    });
    expect(ur.ok).toBe(true);
    expect(await store.get("alice-byokapp")).toBeNull();
  });

  // Justification: the public app-list must never expose the key.
  it("the public /api/apps listing does not contain the key", async () => {
    const store = new InMemoryAppByokStore();
    const { platform, hostIrk } = build(store);
    const req = {
      serverId: HOST_FQDN,
      creator: HOST,
      slug: "byokapp",
      manifestJson: MANIFEST,
      addOwnerToMembership: false,
      issuedAt: Date.now(),
    };
    await platform.install({
      request: req,
      signature: signInstallApp(req, hostIrk),
      verify: () => true,
      byok: { providerId: "anthropic", apiKey: SECRET },
    });
    const listed = JSON.stringify(platform.list());
    expect(listed).not.toContain(SECRET);
  });
});
