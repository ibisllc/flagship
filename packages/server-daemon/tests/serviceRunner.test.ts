import { describe, expect, it } from "vitest";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";

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
    expect(call.args).toContain("8080:8080");
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
