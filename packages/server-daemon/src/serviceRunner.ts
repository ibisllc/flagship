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

/**
 * Sandbox posture applied to every marketplace-app container. The defaults
 * are the strongest setting that still lets an app reach its provisioned
 * data store (Postgres/Redis/MinIO live on the host loopback; see
 * `dataLayer/provisioner.ts`), so they are deliberately conservative:
 *
 *  - `--cap-drop=ALL` then re-add only `capAdd` (empty by default). A web
 *    app needs no Linux capabilities; binding a low port inside the
 *    container is the only common need and apps are told to listen high.
 *  - `--security-opt=no-new-privileges` so a setuid binary in the image
 *    can't escalate.
 *  - `--memory` / `--cpus` / `--pids-limit` cap blast radius (fork bombs,
 *    OOM-the-host, CPU starvation of siblings).
 *  - `--read-only` root filesystem with a writable `/tmp` tmpfs, so a
 *    compromised app can't tamper with its own image on disk.
 *
 * Network posture: app containers run on a dedicated user-defined bridge
 * (`network`, default `flagship-apps`), NOT host networking and NOT the
 * shared default bridge. Two things follow:
 *
 *  - app → other-app is blocked: each app is the only member it can talk
 *    to on its own published surface; the default bridge (where every
 *    container is mutually reachable) is never used.
 *  - app → daemon control API is blocked: that API binds the host loopback
 *    (127.0.0.1), which is unreachable from inside a bridged container
 *    namespace — only the host gateway is, and the daemon API does not
 *    listen there.
 *
 * The app still reaches its provisioned data store: the data-layer URLs
 * are minted pointing at the host-gateway alias (`dataHostAlias`, default
 * `host.flagship.internal`), wired into every container via
 * `--add-host <alias>:host-gateway`. So Postgres/Redis/MinIO (which bind
 * the host) stay reachable while the daemon's own API does not.
 *
 * Every field is overridable so an operator can loosen a limit for a
 * heavyweight app, but the secure values ship by default.
 */
export interface ContainerLimits {
  /** `--memory` value, e.g. "512m". */
  memory: string;
  /** `--cpus` value, e.g. "1.0". */
  cpus: string;
  /** `--pids-limit` value. */
  pidsLimit: number;
  /** Linux capabilities to re-add after `--cap-drop=ALL`. Empty by default. */
  capAdd: string[];
  /** When true, mount the root filesystem read-only with a writable /tmp tmpfs. */
  readOnlyRootfs: boolean;
  /** Size of the writable /tmp tmpfs when `readOnlyRootfs` is on, e.g. "64m". */
  tmpfsSize: string;
  /**
   * The dedicated user-defined bridge every app container joins. Keeps
   * apps off the default bridge (mutual reachability) and off host
   * networking (daemon-API reachability).
   */
  network: string;
  /**
   * Hostname alias wired to the docker host-gateway via `--add-host`, so
   * a bridged container can still reach host-bound data services. The
   * data-layer URLs must be minted using this alias, not `127.0.0.1`.
   */
  dataHostAlias: string;
}

export const DEFAULT_CONTAINER_LIMITS: ContainerLimits = {
  memory: "512m",
  cpus: "1.0",
  pidsLimit: 256,
  capAdd: [],
  readOnlyRootfs: true,
  tmpfsSize: "64m",
  network: "flagship-apps",
  dataHostAlias: "host.flagship.internal",
};

export interface AppRunnerOptions {
  limits?: Partial<ContainerLimits>;
}

function resolveLimits(limits: Partial<ContainerLimits> | undefined): ContainerLimits {
  return { ...DEFAULT_CONTAINER_LIMITS, ...(limits ?? {}) };
}

export const realCommandRunner: CommandRunner = {
  run(cmd, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: "inherit" });
      // A spawn failure (e.g. the binary is missing — `docker` ENOENT) emits
      // an 'error' event, not 'exit'. Without this listener Node treats it as
      // an unhandled error and crashes the daemon; reject so callers can swallow.
      p.on("error", reject);
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
      p.on("error", reject);
      p.stdout?.on("data", (d) => (stdout += d.toString()));
      p.stderr?.on("data", (d) => (stderr += d.toString()));
      p.on("exit", (code) =>
        code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited with code ${code}`)),
      );
    });
  },
};

export class AppRunner {
  private readonly limits: ContainerLimits;

  constructor(
    private readonly cmd: CommandRunner = realCommandRunner,
    opts: AppRunnerOptions = {},
  ) {
    this.limits = resolveLimits(opts.limits);
  }

  async deploy(spec: AppSpec): Promise<string[]> {
    const args = [
      "run",
      "-d",
      "--name",
      this.containerName(spec.serviceId),
      ...this.hardeningArgs(),
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

  /** The bridge network app containers join. */
  get network(): string {
    return this.limits.network;
  }

  /** The host-gateway alias the data-layer URLs must target. */
  get dataHostAlias(): string {
    return this.limits.dataHostAlias;
  }

  /**
   * Ensure the dedicated app bridge exists. Idempotent: a duplicate
   * `network create` exits non-zero, which we swallow. Call once at
   * daemon start before any deploy.
   */
  async ensureNetwork(): Promise<void> {
    try {
      await this.cmd.run("docker", ["network", "create", this.limits.network]);
    } catch {
      // already exists — fine
    }
  }

  /**
   * The isolation flags applied to every app container. A compromised app
   * is dropped to zero Linux capabilities, can't gain new privileges, is
   * resource-bounded, runs on a read-only rootfs, and is confined to the
   * dedicated app bridge (see the ContainerLimits doc for the network
   * boundary rationale).
   */
  private hardeningArgs(): string[] {
    const out: string[] = [
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--network",
      this.limits.network,
      "--add-host",
      `${this.limits.dataHostAlias}:host-gateway`,
      "--memory",
      this.limits.memory,
      "--cpus",
      this.limits.cpus,
      "--pids-limit",
      String(this.limits.pidsLimit),
    ];
    for (const cap of this.limits.capAdd) {
      out.push("--cap-add", cap);
    }
    if (this.limits.readOnlyRootfs) {
      out.push("--read-only", "--tmpfs", `/tmp:rw,size=${this.limits.tmpfsSize}`);
    }
    return out;
  }

  private envArgs(env: Record<string, string> | undefined): string[] {
    if (!env) return [];
    return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  }

  private portArgs(port: number | undefined): string[] {
    if (!port) return [];
    // Publish to host loopback only. The daemon runs as a HOST process,
    // so it reaches the app at 127.0.0.1:<port>; the port is never
    // exposed off-box. Crucially this does NOT re-open the daemon API to
    // the app: the container is on the dedicated bridge, so the app's own
    // `127.0.0.1` is its container namespace — reaching the host's
    // loopback (where the daemon API binds) is not possible from there.
    return ["-p", `127.0.0.1:${port}:${port}`];
  }
}
