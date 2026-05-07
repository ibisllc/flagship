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
