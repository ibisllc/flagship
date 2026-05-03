import { spawn } from "node:child_process";

export interface AppSpec {
  appId: string;
  image: string;
  env?: Record<string, string>;
  port?: number;
}

export interface CommandRunner {
  run(cmd: string, args: string[]): Promise<void>;
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
};

export class AppRunner {
  constructor(private readonly cmd: CommandRunner = realCommandRunner) {}

  async deploy(spec: AppSpec): Promise<string[]> {
    const args = [
      "run",
      "-d",
      "--name",
      this.containerName(spec.appId),
      ...this.envArgs(spec.env),
      ...this.portArgs(spec.port),
      spec.image,
    ];
    await this.cmd.run("docker", args);
    return args;
  }

  async stop(appId: string): Promise<void> {
    await this.cmd.run("docker", ["stop", this.containerName(appId)]);
    await this.cmd.run("docker", ["rm", this.containerName(appId)]);
  }

  private containerName(appId: string): string {
    return `flagship-${appId}`;
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
