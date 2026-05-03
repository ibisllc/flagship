import { describe, expect, it } from "vitest";
import { AppRunner, type CommandRunner } from "../src/appRunner.js";

class RecordingRunner implements CommandRunner {
  calls: { cmd: string; args: string[] }[] = [];
  async run(cmd: string, args: string[]): Promise<void> {
    this.calls.push({ cmd, args });
  }
}

describe("AppRunner", () => {
  it("deploys with the right docker args (image, name prefix, env, port)", async () => {
    const rec = new RecordingRunner();
    const runner = new AppRunner(rec);
    await runner.deploy({
      appId: "photos",
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
});
