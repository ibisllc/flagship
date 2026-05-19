import { spawn } from "node:child_process";

export interface AppSpec {
  serviceId: string;
  image: string;
  env?: Record<string, string>;
  port?: number;
}

export interface CommandRunner {
  run(cmd: string, args: string[]): Promise<void>;
  /** Capture stdout. Default impl uses spawn with pipe; tests inject a mock. */
  capture?(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export const realCommandRunner: CommandRunner = {
  run(cmd, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: "inherit" });
      p.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
      );
    });
  },
  capture(cmd, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout?.on("data", (d) => (stdout += d.toString()));
      p.stderr?.on("data", (d) => (stderr += d.toString()));
      p.on("exit", (code) =>
        code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited with code ${code}`)),
      );
    });
  },
};

export class AppRunner {
  constructor(private readonly cmd: CommandRunner = realCommandRunner) {}

  async deploy(spec: AppSpec): Promise<string[]> {
    const args = [
      "run",
      "-d",
      "--name",
      this.containerName(spec.serviceId),
      ...this.envArgs(spec.env),
      ...this.portArgs(spec.port),
      spec.image,
    ];
    await this.cmd.run("docker", args);
    return args;
  }

  async stop(serviceId: string): Promise<void> {
    await this.cmd.run("docker", ["stop", this.containerName(serviceId)]);
    await this.cmd.run("docker", ["rm", this.containerName(serviceId)]);
  }

  /**
   * Restart re-creates the container with the same name. We `stop && rm`
   * first to handle "container exists, image needs refresh" — important when
   * the user pushed a new tag after the LLM committed.
   */
  async restart(spec: AppSpec): Promise<void> {
    try {
      await this.stop(spec.serviceId);
    } catch {
      // best-effort: container may not exist
    }
    await this.deploy(spec);
  }

  /**
   * Returns the most recent N lines of container logs as a single string.
   * For a real production setup the daemon would stream incrementally;
   * for v0 a one-shot tail keeps the wire shape simple.
   */
  async logs(serviceId: string, tail: number): Promise<{ stdout: string; stderr: string }> {
    if (!this.cmd.capture) throw new Error("CommandRunner.capture is not configured");
    return this.cmd.capture("docker", ["logs", "--tail", String(tail), this.containerName(serviceId)]);
  }

  containerName(serviceId: string): string {
    return `flagship-${serviceId}`;
  }

  private envArgs(env: Record<string, string> | undefined): string[] {
    if (!env) return [];
    return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  }

  private portArgs(port: number | undefined): string[] {
    if (!port) return [];
    return ["-p", `${port}:${port}`];
  }
}
