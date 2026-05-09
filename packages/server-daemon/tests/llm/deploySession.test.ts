import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed, type Keypair } from "@flagship/protocol";
import { AppPlatform } from "../../src/appPlatform.js";
import { AppRunner, type CommandRunner } from "../../src/appRunner.js";
import {
  DataProvisioner,
  InMemoryMinioAdmin,
  InMemoryPostgresAdmin,
  InMemoryRedisAdmin,
} from "../../src/dataLayer/index.js";
import { ForgejoAppAdmin } from "../../src/forgejoAppAdmin.js";
import { buildDeploySession } from "../../src/llm/deploySession.js";
import { VibeCodeSession } from "../../src/llm/vibeCodeSession.js";

const HOST = "alice";
const SERVER = `home.${HOST}.flagship.services`;

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
function jsonReply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function recordingCmd(): { cmd: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const cmd: CommandRunner = {
    run: async (c, args) => { calls.push(`${c} ${args.join(" ")}`); },
    capture: async () => ({ stdout: "", stderr: "" }),
  };
  return { cmd, calls };
}

const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "habits",
  version: "0.1.0",
  runtime: { image: "placeholder/will-be-overwritten:0", port: 8080 },
  data: {},
  network: { subdomain: "habits" },
  access: { enabled: true, default_role: "owner" },
  migration: { verification: "standard" },
});

async function tmpWorkdir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "deploy-session-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function makeSession(files: Record<string, string>): VibeCodeSession {
  const session = new VibeCodeSession({ username: HOST, serverFqdn: SERVER });
  session.pushUserMessage("describe");
  // Format per VibeCodeStreamParser: `=== <filename> ===` boundaries,
  // terminated by `=== END ===`.
  let stream = "";
  for (const [path, content] of Object.entries(files)) {
    stream += `=== ${path} ===\n${content}\n`;
  }
  stream += "=== END ===\n";
  session.feedAssistant(stream);
  session.endAssistant();
  return session;
}

describe("buildDeploySession", () => {
  it("happy path: writes files, builds image, signs install, calls AppPlatform", async () => {
    const wd = await tmpWorkdir();
    try {
      const { cmd, calls } = recordingCmd();
      const irk = makeKey();
      const platform = new AppPlatform({
        host: { username: HOST, irkPub: irk.publicKey },
        swk: fakeSwk(),
        appRunner: new AppRunner(cmd),
        dataProvisioner: new DataProvisioner({
          postgres: new InMemoryPostgresAdmin(),
          objects: new InMemoryMinioAdmin(),
          kv: new InMemoryRedisAdmin(),
        }),
        appAuthTokens: null,
        domainGate: null,
        tabRegistry: null,
        pullStateStore: null,
        cloneApp: null,
      });
      const deploy = buildDeploySession({
        appPlatform: platform,
        hostIrk: irk,
        hostUsername: HOST,
        workingDir: wd.dir,
        cmd,
        // Use real time so AppPlatform's freshness check against
        // Date.now() doesn't reject as stale.
      });
      const session = makeSession({
        "flagship.app.json": MANIFEST,
        "Dockerfile": "FROM busybox\nCMD echo hi\n",
        "src/main.js": "console.log('hi');\n",
      });
      const r = await deploy(session);
      if (!r.ok) {
        // surface the actual reason in the failure message for debugging
        throw new Error(`deploy failed: ${r.reason}`);
      }
      expect(r.appId).toBe("alice--habits");
      expect(r.url).toBe(`https://habits.${SERVER}`);
      expect(r.image).toMatch(/^flagship-vibe-alice--habits:\d+$/);
      // docker build was invoked at the working dir
      expect(calls.some((c) => c.startsWith("docker build "))).toBe(true);
      expect(calls.some((c) => c.includes(wd.dir))).toBe(true);
      // docker run was invoked with the patched image tag (not the placeholder)
      expect(calls.some((c) => c.startsWith("docker run ") && c.includes(r.image))).toBe(true);

      // source tree was actually written
      const dockerfile = await readFile(join(wd.dir, "alice--habits", "Dockerfile"), "utf8");
      expect(dockerfile).toContain("FROM busybox");
      const main = await readFile(join(wd.dir, "alice--habits", "src", "main.js"), "utf8");
      expect(main).toContain("console.log");
    } finally {
      await wd.cleanup();
    }
  });

  it("rejects a session with no flagship.app.json", async () => {
    const wd = await tmpWorkdir();
    try {
      const { cmd } = recordingCmd();
      const irk = makeKey();
      const platform = new AppPlatform({
        host: { username: HOST, irkPub: irk.publicKey },
        swk: fakeSwk(),
        appRunner: new AppRunner(cmd),
        dataProvisioner: null,
        appAuthTokens: null,
        domainGate: null,
        tabRegistry: null,
        pullStateStore: null,
        cloneApp: null,
      });
      const deploy = buildDeploySession({
        appPlatform: platform,
        hostIrk: irk,
        hostUsername: HOST,
        workingDir: wd.dir,
        cmd,
      });
      const session = makeSession({ "src/main.js": "x;" });
      const r = await deploy(session);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/flagship.app.json/);
    } finally {
      await wd.cleanup();
    }
  });

  it("rejects unsafe paths in the source tree", async () => {
    const wd = await tmpWorkdir();
    try {
      const { cmd } = recordingCmd();
      const irk = makeKey();
      const platform = new AppPlatform({
        host: { username: HOST, irkPub: irk.publicKey },
        swk: fakeSwk(),
        appRunner: new AppRunner(cmd),
        dataProvisioner: null,
        appAuthTokens: null,
        domainGate: null,
        tabRegistry: null,
        pullStateStore: null,
        cloneApp: null,
      });
      const deploy = buildDeploySession({
        appPlatform: platform,
        hostIrk: irk,
        hostUsername: HOST,
        workingDir: wd.dir,
        cmd,
      });
      const session = makeSession({
        "flagship.app.json": MANIFEST,
        "../../etc/passwd": "evil",
      });
      const r = await deploy(session);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/unsafe path/);
    } finally {
      await wd.cleanup();
    }
  });

  it("when forgejoAdmin is set, ensures the repo + commits files before docker build", async () => {
    const wd = await tmpWorkdir();
    try {
      const { cmd, calls } = recordingCmd();
      const irk = makeKey();

      // Track the order of operations: forgejo calls must precede docker build.
      const events: string[] = [];

      // Mock fetch for ForgejoAppAdmin.
      let createSeen = false;
      let commitSeen = false;
      const fakeFetch = async (
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && /\/api\/v1\/orgs\/[^/]+\/repos$/.test(url)) {
          events.push("createRepo");
          createSeen = true;
          return jsonReply(201, { name: "habits" });
        }
        if (method === "GET" && url.includes("/git/trees/")) {
          // Empty repo (auto_init repo with no committed files yet).
          return jsonReply(404, "Not Found");
        }
        if (method === "POST" && url.endsWith("/contents")) {
          events.push("commitFiles");
          commitSeen = true;
          // Verify the request body includes our files.
          const body = JSON.parse(init?.body ?? "{}") as { files: Array<{ path: string }> };
          expect(body.files.map((f) => f.path).sort()).toEqual(
            ["Dockerfile", "flagship.app.json", "src/main.js"].sort(),
          );
          return jsonReply(200, { commit: { sha: "deadbeef" } });
        }
        throw new Error(`unexpected forgejo call ${method} ${url}`);
      };
      const forgejoAdmin = new ForgejoAppAdmin({
        baseUrl: "http://forgejo.local",
        orgName: "alice-flagship",
        serviceToken: "tk",
        fetchImpl: fakeFetch as never,
      });

      // Tee docker calls into the same event stream so we can assert order.
      const teeingCmd: CommandRunner = {
        run: async (c, args) => {
          if (c === "docker" && args[0] === "build") events.push("dockerBuild");
          return cmd.run(c, args);
        },
        capture: cmd.capture,
      };

      const platform = new AppPlatform({
        host: { username: HOST, irkPub: irk.publicKey },
        swk: fakeSwk(),
        appRunner: new AppRunner(teeingCmd),
        dataProvisioner: new DataProvisioner({
          postgres: new InMemoryPostgresAdmin(),
          objects: new InMemoryMinioAdmin(),
          kv: new InMemoryRedisAdmin(),
        }),
        appAuthTokens: null,
        domainGate: null,
        tabRegistry: null,
        pullStateStore: null,
        cloneApp: null,
      });
      const deploy = buildDeploySession({
        appPlatform: platform,
        hostIrk: irk,
        hostUsername: HOST,
        workingDir: wd.dir,
        cmd: teeingCmd,
        forgejoAdmin,
      });
      const session = makeSession({
        "flagship.app.json": MANIFEST,
        "Dockerfile": "FROM busybox\nCMD echo hi\n",
        "src/main.js": "console.log('hi');\n",
      });
      const r = await deploy(session);
      if (!r.ok) throw new Error(`deploy failed: ${r.reason}`);
      expect(createSeen).toBe(true);
      expect(commitSeen).toBe(true);
      // Forgejo must come before docker build (so the user can review
      // even if the build fails for some reason).
      expect(events.indexOf("createRepo")).toBeLessThan(events.indexOf("dockerBuild"));
      expect(events.indexOf("commitFiles")).toBeLessThan(events.indexOf("dockerBuild"));
      // Confirm docker build was still invoked
      expect(calls.some((c) => c.startsWith("docker build "))).toBe(true);
    } finally {
      await wd.cleanup();
    }
  });

  it("when forgejoAdmin push fails, surfaces the failure and skips docker build", async () => {
    const wd = await tmpWorkdir();
    try {
      const { cmd, calls } = recordingCmd();
      const irk = makeKey();
      const failingFetch = async (
        url: string,
        init?: { method?: string },
      ) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && /\/api\/v1\/orgs\/[^/]+\/repos$/.test(url)) {
          return jsonReply(500, "forgejo internal error");
        }
        throw new Error(`unexpected ${method} ${url}`);
      };
      const forgejoAdmin = new ForgejoAppAdmin({
        baseUrl: "http://forgejo.local",
        orgName: "alice-flagship",
        serviceToken: "tk",
        fetchImpl: failingFetch as never,
      });
      const platform = new AppPlatform({
        host: { username: HOST, irkPub: irk.publicKey },
        swk: fakeSwk(),
        appRunner: new AppRunner(cmd),
        dataProvisioner: null,
        appAuthTokens: null,
        domainGate: null,
        tabRegistry: null,
        pullStateStore: null,
        cloneApp: null,
      });
      const deploy = buildDeploySession({
        appPlatform: platform,
        hostIrk: irk,
        hostUsername: HOST,
        workingDir: wd.dir,
        cmd,
        forgejoAdmin,
      });
      const session = makeSession({
        "flagship.app.json": MANIFEST,
        "Dockerfile": "FROM busybox\n",
      });
      const r = await deploy(session);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/forgejo push failed/);
      // Build was NOT attempted — we never reach docker after a forgejo failure.
      expect(calls.some((c) => c.startsWith("docker build "))).toBe(false);
    } finally {
      await wd.cleanup();
    }
  });

  it("when forgejoAdmin is null, skips repo push (dev path) and still deploys", async () => {
    const wd = await tmpWorkdir();
    try {
      const { cmd, calls } = recordingCmd();
      const irk = makeKey();
      const platform = new AppPlatform({
        host: { username: HOST, irkPub: irk.publicKey },
        swk: fakeSwk(),
        appRunner: new AppRunner(cmd),
        dataProvisioner: new DataProvisioner({
          postgres: new InMemoryPostgresAdmin(),
          objects: new InMemoryMinioAdmin(),
          kv: new InMemoryRedisAdmin(),
        }),
        appAuthTokens: null,
        domainGate: null,
        tabRegistry: null,
        pullStateStore: null,
        cloneApp: null,
      });
      const deploy = buildDeploySession({
        appPlatform: platform,
        hostIrk: irk,
        hostUsername: HOST,
        workingDir: wd.dir,
        cmd,
        forgejoAdmin: null,
      });
      const session = makeSession({
        "flagship.app.json": MANIFEST,
        "Dockerfile": "FROM busybox\n",
      });
      const r = await deploy(session);
      if (!r.ok) throw new Error(`deploy failed: ${r.reason}`);
      // Build still happened
      expect(calls.some((c) => c.startsWith("docker build "))).toBe(true);
    } finally {
      await wd.cleanup();
    }
  });

  it("end-to-end: streamed LLM output → Forgejo commit → AppPlatform.install", async () => {
    // This is the test mandated by the P1.X1 carryover: feed the parser
    // with a realistic streaming response and assert the deploy step
    // follows through to a successful container-launch invocation.
    const wd = await tmpWorkdir();
    try {
      const { cmd, calls } = recordingCmd();
      const irk = makeKey();

      const fakeFetch = async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && /\/repos$/.test(url)) {
          return jsonReply(201, { name: "habits" });
        }
        if (method === "GET" && url.includes("/git/trees/")) {
          return jsonReply(404, "empty");
        }
        if (method === "POST" && url.endsWith("/contents")) {
          return jsonReply(200, { commit: { sha: "feed" + Date.now().toString(16) } });
        }
        throw new Error(`unexpected ${method} ${url}`);
      };
      const forgejoAdmin = new ForgejoAppAdmin({
        baseUrl: "http://forgejo.local",
        orgName: "alice-flagship",
        serviceToken: "tk",
        fetchImpl: fakeFetch as never,
      });

      const platform = new AppPlatform({
        host: { username: HOST, irkPub: irk.publicKey },
        swk: fakeSwk(),
        appRunner: new AppRunner(cmd),
        dataProvisioner: new DataProvisioner({
          postgres: new InMemoryPostgresAdmin(),
          objects: new InMemoryMinioAdmin(),
          kv: new InMemoryRedisAdmin(),
        }),
        appAuthTokens: null,
        domainGate: null,
        tabRegistry: null,
        pullStateStore: null,
        cloneApp: null,
      });
      const deploy = buildDeploySession({
        appPlatform: platform,
        hostIrk: irk,
        hostUsername: HOST,
        workingDir: wd.dir,
        cmd,
        forgejoAdmin,
      });

      // Build a session by feeding chunks the way the streaming-LLM
      // bridge would (one chunk per SSE delta), so the parser is
      // exercised end-to-end. Splits land mid-line on purpose.
      const session = new VibeCodeSession({ username: HOST, serverFqdn: SERVER });
      session.pushUserMessage("build me a hello-world habit tracker");
      const stream = [
        "I will create the app now.\n",
        "=== flagship.app.json ===\n",
        MANIFEST + "\n",
        "=== Dockerfile ===\n",
        "FROM busybox\n",
        "CMD [\"sh\", \"-c\", \"echo hi\"]\n",
        "=== src/index.js ===\n",
        "console.log('serv',process.env.PORT);\n",
        "=== END ===\n",
      ];
      for (const chunk of stream) session.feedAssistant(chunk);
      session.endAssistant();

      // The LLM stream yielded a ready-to-deploy session.
      expect(session.meta.status).toBe("ready-to-deploy");
      expect(Object.keys(session.files()).sort()).toEqual(
        ["Dockerfile", "flagship.app.json", "src/index.js"].sort(),
      );

      const r = await deploy(session);
      if (!r.ok) throw new Error(`deploy failed: ${r.reason}`);
      expect(r.appId).toBe("alice--habits");
      expect(r.url).toBe(`https://habits.${SERVER}`);

      // The container was actually launched (docker run with the patched image).
      expect(calls.some((c) => c.startsWith("docker run ") && c.includes(r.image))).toBe(true);
    } finally {
      await wd.cleanup();
    }
  });

  it("surfaces docker-build failures cleanly", async () => {
    const wd = await tmpWorkdir();
    try {
      const irk = makeKey();
      const cmd: CommandRunner = {
        run: async (c, args) => {
          if (c === "docker" && args[0] === "build") throw new Error("Dockerfile syntax error");
        },
        capture: async () => ({ stdout: "", stderr: "" }),
      };
      const platform = new AppPlatform({
        host: { username: HOST, irkPub: irk.publicKey },
        swk: fakeSwk(),
        appRunner: new AppRunner(cmd),
        dataProvisioner: null,
        appAuthTokens: null,
        domainGate: null,
        tabRegistry: null,
        pullStateStore: null,
        cloneApp: null,
      });
      const deploy = buildDeploySession({
        appPlatform: platform,
        hostIrk: irk,
        hostUsername: HOST,
        workingDir: wd.dir,
        cmd,
      });
      const session = makeSession({
        "flagship.app.json": MANIFEST,
        "Dockerfile": "INVALID\n",
      });
      const r = await deploy(session);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/docker build failed/);
    } finally {
      await wd.cleanup();
    }
  });
});
