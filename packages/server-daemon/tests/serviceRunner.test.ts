import { describe, expect, it } from "vitest";
import {
  AppRunner,
  DEFAULT_CONTAINER_LIMITS,
  realCommandRunner,
  runDockerBuild,
  type CommandRunner,
} from "../src/serviceRunner.js";

describe("realCommandRunner spawn-failure (regression: docker-missing daemon crash loop)", () => {
  // A missing binary makes spawn emit an 'error' event, NOT 'exit'. Without an
  // 'error' listener that becomes an unhandled error that crashed the daemon at
  // startup (ensureNetwork → `docker network create` on a box without docker).
  it("run rejects instead of crashing when the binary is missing", async () => {
    await expect(
      realCommandRunner.run("flagship-no-such-binary-xyz", ["network", "create", "flagship-apps"]),
    ).rejects.toBeInstanceOf(Error);
  });
  it("capture rejects instead of crashing when the binary is missing", async () => {
    await expect(
      realCommandRunner.capture!("flagship-no-such-binary-xyz", ["x"]),
    ).rejects.toBeInstanceOf(Error);
  });
  it("ensureNetwork swallows a missing-docker failure so the daemon still starts", async () => {
    const rejecting: CommandRunner = {
      run: () => Promise.reject(new Error("spawn docker ENOENT")),
      capture: () => Promise.reject(new Error("spawn docker ENOENT")),
    };
    await expect(new AppRunner(rejecting).ensureNetwork()).resolves.toBeUndefined();
  });
});

describe("realCommandRunner.capture failure detail", () => {
  // Regression (gating live-e2e): a failed `docker build` surfaced to the
  // remote caller as an opaque "docker exited with code 1" — the stderr
  // ("COPY failed: stat index.html: …") never left the box. The rejection
  // must carry the process output tail.
  it("carries the stderr tail in the rejection message", async () => {
    await expect(
      realCommandRunner.capture!(process.execPath, [
        "-e",
        "console.error('COPY failed: stat index.html: file does not exist'); process.exit(1)",
      ]),
    ).rejects.toThrow(/COPY failed: stat index\.html: file does not exist/);
  });
  it("attaches stdout/stderr to the rejection for callers that echo them", async () => {
    const err = await realCommandRunner
      .capture!(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exit(2)"])
      .then(() => null, (e: Error & { stdout?: string; stderr?: string }) => e);
    expect(err).not.toBeNull();
    expect(err!.stdout).toContain("out");
    expect(err!.stderr).toContain("err");
  });
});

describe("runDockerBuild", () => {
  it("prefers capture so a failure surfaces the builder's stderr", async () => {
    const cmd: CommandRunner = {
      run: async () => {
        throw new Error("run must not be used when capture exists");
      },
      capture: async (c, args) => {
        expect(c).toBe("docker");
        expect(args).toEqual(["build", "-t", "img:1", "/ctx"]);
        throw Object.assign(new Error("docker exited with code 1: COPY failed"), {
          stdout: "",
          stderr: "COPY failed\n",
        });
      },
    };
    await expect(runDockerBuild(cmd, "img:1", "/ctx")).rejects.toThrow(/COPY failed/);
  });
  it("falls back to run when the runner has no capture", async () => {
    const calls: string[][] = [];
    const cmd: CommandRunner = { run: async (c, args) => { calls.push([c, ...args]); } };
    await runDockerBuild(cmd, "img:1", "/ctx");
    expect(calls).toEqual([["docker", "build", "-t", "img:1", "/ctx"]]);
  });
});

class RecordingRunner implements CommandRunner {
  calls: { cmd: string; args: string[] }[] = [];
  captures: { cmd: string; args: string[] }[] = [];
  async run(cmd: string, args: string[]): Promise<void> {
    this.calls.push({ cmd, args });
  }
  async capture(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.captures.push({ cmd, args });
    return { stdout: "log line\n", stderr: "" };
  }
}

/** Find the value following a `--flag` token in an arg list. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("AppRunner", () => {
  it("deploys with the right docker args (image, name prefix, env, port)", async () => {
    const rec = new RecordingRunner();
    const runner = new AppRunner(rec);
    await runner.deploy({
      serviceId: "photos",
      image: "ghcr.io/flagship/photos:latest",
      env: { PORT: "8080" },
      port: 8080,
    });
    const call = rec.calls[0]!;
    expect(call.cmd).toBe("docker");
    expect(call.args).toContain("flagship-photos");
    expect(call.args).toContain("ghcr.io/flagship/photos:latest");
    expect(call.args).toContain("PORT=8080");
    // Published to host loopback only — never exposed off-box.
    expect(call.args).toContain("127.0.0.1:8080:8080");
  });

  it("maps the allocated host port to the app's container port (regression: serve 502)", async () => {
    // The daemon allocates a per-service host-loopback port (what the proxy
    // dials) that is NOT the app's listen port (the manifest runtime.port).
    // The publish MUST be host:container, else nothing answers the proxy.
    const rec = new RecordingRunner();
    const runner = new AppRunner(rec);
    await runner.deploy({
      serviceId: "photos",
      image: "ghcr.io/flagship/photos:latest",
      port: 63015, // allocated host port the proxy dials
      containerPort: 80, // the app's manifest listen port
    });
    const args = rec.calls[0]!.args;
    expect(args).toContain("127.0.0.1:63015:80");
    expect(args).not.toContain("127.0.0.1:63015:63015");
  });

  describe("container isolation (SEC-4)", () => {
    async function deployArgs(
      overrides?: ConstructorParameters<typeof AppRunner>[1],
    ): Promise<string[]> {
      const rec = new RecordingRunner();
      const runner = new AppRunner(rec, overrides);
      await runner.deploy({
        serviceId: "photos",
        image: "img:1",
        env: { PORT: "8080" },
        port: 8080,
      });
      return rec.calls[0]!.args;
    }

    it("drops all capabilities and forbids privilege escalation", async () => {
      const args = await deployArgs();
      expect(args).toContain("--cap-drop=ALL");
      expect(args).toContain("--security-opt=no-new-privileges");
    });

    it("applies memory / cpu / pids resource caps with safe defaults", async () => {
      const args = await deployArgs();
      expect(flagValue(args, "--memory")).toBe(DEFAULT_CONTAINER_LIMITS.memory);
      expect(flagValue(args, "--cpus")).toBe(DEFAULT_CONTAINER_LIMITS.cpus);
      expect(flagValue(args, "--pids-limit")).toBe(String(DEFAULT_CONTAINER_LIMITS.pidsLimit));
    });

    it("confines the app to the dedicated bridge, not host networking nor the default bridge", async () => {
      const args = await deployArgs();
      expect(flagValue(args, "--network")).toBe("flagship-apps");
      // Never host networking (which would expose the daemon API on host loopback).
      const networks = args.filter((_, i) => args[i - 1] === "--network");
      expect(networks).not.toContain("host");
    });

    it("reaches host data services via the host-gateway alias, not container loopback", async () => {
      const args = await deployArgs();
      expect(flagValue(args, "--add-host")).toBe("host.flagship.internal:host-gateway");
    });

    it("runs a read-only rootfs with a writable /tmp tmpfs by default", async () => {
      const args = await deployArgs();
      expect(args).toContain("--read-only");
      expect(flagValue(args, "--tmpfs")).toBe("/tmp:rw,size=64m");
    });

    it("re-adds only the configured capabilities after cap-drop", async () => {
      const args = await deployArgs({ limits: { capAdd: ["NET_BIND_SERVICE"] } });
      expect(args).toContain("--cap-drop=ALL");
      expect(flagValue(args, "--cap-add")).toBe("NET_BIND_SERVICE");
    });

    it("honors operator overrides for limits", async () => {
      const args = await deployArgs({
        limits: { memory: "2g", cpus: "4.0", pidsLimit: 1024, readOnlyRootfs: false },
      });
      expect(flagValue(args, "--memory")).toBe("2g");
      expect(flagValue(args, "--cpus")).toBe("4.0");
      expect(flagValue(args, "--pids-limit")).toBe("1024");
      expect(args).not.toContain("--read-only");
    });

    it("ensureNetwork creates the bridge and swallows the already-exists error", async () => {
      const rec = new RecordingRunner();
      const runner = new AppRunner(rec);
      await runner.ensureNetwork();
      expect(rec.calls[0]!.args).toEqual(["network", "create", "flagship-apps"]);

      const throwing: CommandRunner = {
        async run() {
          throw new Error("network with name flagship-apps already exists");
        },
      };
      const r2 = new AppRunner(throwing);
      await expect(r2.ensureNetwork()).resolves.toBeUndefined();
    });

    it("exposes the network + dataHostAlias for the provisioner to target", async () => {
      const runner = new AppRunner(new RecordingRunner());
      expect(runner.network).toBe("flagship-apps");
      expect(runner.dataHostAlias).toBe("host.flagship.internal");
    });
  });

  it("stop runs docker stop and rm", async () => {
    const rec = new RecordingRunner();
    const runner = new AppRunner(rec);
    await runner.stop("photos");
    expect(rec.calls.length).toBe(2);
    expect(rec.calls[0]!.args).toContain("flagship-photos");
    expect(rec.calls[0]!.args[0]).toBe("stop");
    expect(rec.calls[1]!.args[0]).toBe("rm");
  });

  it("restart stops + rms + redeploys (handles stale containers)", async () => {
    const rec = new RecordingRunner();
    const runner = new AppRunner(rec);
    await runner.restart({ serviceId: "photos", image: "img:2" });
    const verbs = rec.calls.map((c) => c.args[0]);
    expect(verbs).toEqual(["stop", "rm", "run"]);
  });

  it("restart still deploys when stop fails (container did not previously exist)", async () => {
    let firstCall = true;
    const flaky: CommandRunner = {
      async run(_cmd, args) {
        if (firstCall) {
          firstCall = false;
          throw new Error("no such container");
        }
        // subsequent calls (rm fails, then run succeeds) — but our impl bails
        // after the first throw inside `stop()`. That's fine: deploy still runs.
        if (args[0] === "rm") throw new Error("no such container");
      },
    };
    const runner = new AppRunner(flaky);
    await expect(runner.restart({ serviceId: "photos", image: "img:2" })).resolves.toBeUndefined();
  });

  it("logs invokes docker logs --tail and returns stdout/stderr", async () => {
    const rec = new RecordingRunner();
    const runner = new AppRunner(rec);
    const out = await runner.logs("photos", 50);
    expect(rec.captures[0]!.cmd).toBe("docker");
    expect(rec.captures[0]!.args).toEqual(["logs", "--tail", "50", "flagship-photos"]);
    expect(out.stdout).toContain("log line");
  });
});
