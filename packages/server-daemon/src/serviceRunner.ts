import { spawn } from "node:child_process";

export interface AppSpec {
  serviceId: string;
  image: string;
  env?: Record<string, string>;
  /** Host loopback port the daemon's app-proxy dials (allocated per service). */
  port?: number;
  /**
   * Port the app actually LISTENS ON inside the container (the manifest's
   * runtime.port). The publish maps `host:<port>` → `container:<containerPort>`.
   * Absent ⇒ same as `port` (back-compat). Without this the daemon published
   * `host:<port> → container:<port>` while the image listened on its own
   * manifest port, so nothing answered the proxy (502). See the `PORT` env the
   * platform also injects so contract apps bind this port.
   */
  containerPort?: number;
}

export interface CommandRunnerOpts {
  /**
   * Kill the child after this many ms (SIGKILL). Used to bound `docker build`
   * so an attacker-authored Dockerfile can't spin forever. 0/absent ⇒ no bound.
   */
  timeoutMs?: number;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: CommandRunnerOpts): Promise<void>;
  /** Capture stdout. Default impl uses spawn with pipe; tests inject a mock. */
  capture?(cmd: string, args: string[], opts?: CommandRunnerOpts): Promise<{ stdout: string; stderr: string }>;
}

// ──────────────────────────────────────────────────────────────────────
// Docker-invocation safety guard (privilege-separation regression insurance).
//
// The daemon's private state lives under /var/flagship, and the Docker socket
// IS root on the box. NO container the daemon launches — build OR run — may
// ever bind-mount a host path or the socket. This assertion is a cheap tripwire
// on every docker arg list so a future change that introduces a `-v`,
// `--volume`, `--mount`, a `/var/flagship` path, or `docker.sock` fails loudly
// at the invocation site instead of silently handing an attacker-authored
// image the keys to the box. (Runtime app containers already avoid these; this
// keeps it that way.)
// ──────────────────────────────────────────────────────────────────────
export function assertNoHostPathInDockerArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const lower = a.toLowerCase();
    if (lower.includes("/var/flagship")) {
      // `docker build` necessarily receives one host path: its FINAL build
      // context. Vibe/build-mode workspaces live in this dedicated subtree;
      // Docker exposes only that directory to the Dockerfile, not the parent
      // Flagship state tree. Keep the exception exact so `-f`, mounts, the
      // whole /var/flagship root, and `..` traversal remain blocked.
      const isSandboxedBuildContext =
        args[0] === "build" &&
        i === args.length - 1 &&
        lower.startsWith("/var/flagship/data/app-clones/") &&
        !lower.split("/").includes("..");
      if (isSandboxedBuildContext) continue;
      throw new Error(`refusing docker invocation: arg references /var/flagship (${a})`);
    }
    if (lower.includes("docker.sock")) {
      throw new Error(`refusing docker invocation: arg references the docker socket (${a})`);
    }
    // Host-path bind mounts. `--volume`/`-v`/`--mount` on the app-build/run
    // surface is never legitimate (data stores reach containers over the
    // host-gateway alias, not a mount).
    if (a === "-v" || a === "--volume" || a === "--mount" || lower.startsWith("--mount=")) {
      throw new Error(`refusing docker invocation: host-path mount arg is not allowed (${a})`);
    }
  }
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

/** Arm a kill-timer for a spawned child; returns the timer (or null when no
 *  bound is requested). On expiry the child is SIGKILLed and the promise rejects. */
function armTimeout(
  child: ReturnType<typeof spawn>,
  opts: CommandRunnerOpts | undefined,
  reject: (e: Error) => void,
): ReturnType<typeof setTimeout> | null {
  const ms = opts?.timeoutMs ?? 0;
  if (!ms || ms <= 0) return null;
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    reject(new Error(`command timed out after ${ms}ms and was killed`));
  }, ms);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref?: () => void }).unref!();
  }
  return timer;
}

export const realCommandRunner: CommandRunner = {
  run(cmd, args, opts) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: "inherit" });
      const timer = armTimeout(p, opts, reject);
      // A spawn failure (e.g. the binary is missing — `docker` ENOENT) emits
      // an 'error' event, not 'exit'. Without this listener Node treats it as
      // an unhandled error and crashes the daemon; reject so callers can swallow.
      p.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      p.on("exit", (code) => {
        if (timer) clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`));
      });
    });
  },
  capture(cmd, args, opts) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = armTimeout(p, opts, reject);
      p.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      p.stdout?.on("data", (d) => (stdout += d.toString()));
      p.stderr?.on("data", (d) => (stderr += d.toString()));
      p.on("exit", (code) => {
        if (timer) clearTimeout(timer);
        if (code === 0) return resolve({ stdout, stderr });
        // Carry the tail of the process output in the message — a bare
        // "exited with code 1" is undiagnosable from a remote client (the
        // gating live-e2e's vibe-deploy 502 was exactly this).
        const tail = (stderr || stdout).trim().split("\n").slice(-8).join("\n").slice(-800);
        reject(
          Object.assign(
            new Error(`${cmd} exited with code ${code}${tail ? `: ${tail}` : ""}`),
            { stdout, stderr },
          ),
        );
      });
    });
  },
};

/**
 * Sandbox posture for `docker build`. The build runs an ATTACKER-AUTHORED
 * Dockerfile whose `RUN` steps execute as root — the single least-contained
 * surface in the daemon. These caps bound its blast radius:
 *
 *  - `--network` pins the build to a dedicated, non-default bridge
 *    (`flagship-build`) so the builder never joins the default bridge (where
 *    every container is mutually reachable) or the app bridge. NOTE (v1
 *    caveat): a user-defined bridge still has NAT egress, so this ISOLATES the
 *    builder from other containers but does NOT yet enforce an egress allow-
 *    list — package installs (`npm install`, `apt`) still reach the internet.
 *    Tightening this to an allow-listed egress bridge is the follow-up; the
 *    knob is here so an operator can point it at a locked bridge today.
 *  - `--memory` / `--cpu-period`+`--cpu-quota` bound RAM + CPU so a build can't
 *    OOM the host or starve the daemon (honored by the legacy builder; BuildKit
 *    ignores them harmlessly).
 *  - `--ulimit nproc` is the build-time process cap (docker build has no
 *    `--pids-limit`; `nproc` is its equivalent) — a fork-bomb in a RUN step
 *    can't exhaust host PIDs.
 *  - a wall-clock TIMEOUT (enforced by the CommandRunner) kills a build that
 *    hangs or spins, so a malicious Dockerfile can't pin a builder forever.
 *
 * NO base-image digest pinning is imposed here: the user's Dockerfile picks its
 * own `FROM`, so we can't rewrite it — the base is recorded in the build log
 * (the captured output below) rather than forced. Where the build pipeline
 * controls the base (future first-party templates), pin at that layer.
 */
export interface DockerBuildLimits {
  /** `--memory`, e.g. "2g". */
  memory: string;
  /** CPU cap in whole+fractional cores, e.g. "2.0" → --cpu-quota 200000. */
  cpus: string;
  /** Process cap via `--ulimit nproc=<n>:<n>` (build's pids-limit equivalent). */
  pidsLimit: number;
  /** `--network` — the dedicated, non-default build bridge. */
  network: string;
  /** Wall-clock kill bound for the whole build (ms). */
  timeoutMs: number;
}

export const DEFAULT_DOCKER_BUILD_LIMITS: DockerBuildLimits = {
  memory: "2g",
  cpus: "2.0",
  pidsLimit: 2048,
  network: "flagship-build",
  timeoutMs: 10 * 60_000,
};

const CPU_PERIOD = 100_000;

/**
 * Ensure a docker bridge network exists (idempotent — a duplicate create exits
 * non-zero, which we swallow). Call once at boot for the dedicated build bridge
 * so `docker build --network <name>` resolves.
 */
export async function ensureDockerNetwork(cmd: CommandRunner, network: string): Promise<void> {
  try {
    await cmd.run("docker", ["network", "create", network]);
  } catch {
    // already exists — fine
  }
}

/** The hardened `docker build` arg list (pure, so it is unit-testable). */
export function dockerBuildArgs(
  image: string,
  contextDir: string,
  limits: DockerBuildLimits,
): string[] {
  const cpuQuota = Math.max(1, Math.round(Number(limits.cpus) * CPU_PERIOD));
  const args = [
    "build",
    "--network",
    limits.network,
    "--memory",
    limits.memory,
    "--cpu-period",
    String(CPU_PERIOD),
    "--cpu-quota",
    String(cpuQuota),
    "--ulimit",
    `nproc=${limits.pidsLimit}:${limits.pidsLimit}`,
    "-t",
    image,
    contextDir,
  ];
  // Regression insurance: a build must NEVER bind-mount a host path or the
  // docker socket. Its final, sandboxed app-clone build context is the sole
  // host-path argument allowed. Throws loudly at the invocation site.
  assertNoHostPathInDockerArgs(args);
  return args;
}

/**
 * Run `docker build` preferring capture over inherit so a FAILURE carries the
 * builder's stderr back to the caller (the deploy HTTP surface returns the
 * reason to the phone/driver — with stdio:"inherit" the error was an opaque
 * "docker exited with code 1"). The captured output is echoed to the daemon's
 * own stdio so the full build log still lands in the journal. The build is
 * sandboxed per `DockerBuildLimits` (network/memory/cpu/pids) + a wall-clock
 * timeout — see the interface doc for the rationale + the v1 egress caveat.
 */
export async function runDockerBuild(
  cmd: CommandRunner,
  image: string,
  contextDir: string,
  limits: DockerBuildLimits = DEFAULT_DOCKER_BUILD_LIMITS,
): Promise<void> {
  const args = dockerBuildArgs(image, contextDir, limits);
  const runOpts: CommandRunnerOpts = { timeoutMs: limits.timeoutMs };
  if (!cmd.capture) return cmd.run("docker", args, runOpts);
  try {
    const { stdout, stderr } = await cmd.capture("docker", args, runOpts);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  }
}

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
      ...this.portArgs(spec.port, spec.containerPort),
      spec.image,
    ];
    // Regression insurance: a runtime container must never bind-mount a host
    // path or the docker socket either (/var/flagship stays off every mount).
    assertNoHostPathInDockerArgs(args);
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

  private portArgs(hostPort: number | undefined, containerPort?: number): string[] {
    if (!hostPort) return [];
    // Publish to host loopback only. The daemon runs as a HOST process,
    // so it reaches the app at 127.0.0.1:<hostPort>; the port is never
    // exposed off-box. Crucially this does NOT re-open the daemon API to
    // the app: the container is on the dedicated bridge, so the app's own
    // `127.0.0.1` is its container namespace — reaching the host's
    // loopback (where the daemon API binds) is not possible from there.
    //
    // host:<hostPort> → container:<containerPort>. The container port is the
    // app's manifest runtime.port (the port it actually listens on); the host
    // port is an allocated, per-service loopback handle the proxy dials. They
    // are NOT the same number — mapping host→host while the app listened on
    // its manifest port left nothing answering the proxy (the historical 502).
    const cport = containerPort ?? hostPort;
    return ["-p", `127.0.0.1:${hostPort}:${cport}`];
  }
}
