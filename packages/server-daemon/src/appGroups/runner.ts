/**
 * Runs an app made of several processes on one box (manifest v2
 * `components`, docs/app-groups.md, IMPLEMENTATION-PLAN.md §8.5 / P05).
 *
 * Every member is an ordinary hardened app container (gVisor, no
 * capabilities, read-only root, its own limits) on the apps bridge, inside
 * the app's one trust boundary: the same approvals, egress list, database
 * and files folder as the app's main process. The bridge keeps containers
 * from reaching each other, so a member is reached through the apps
 * gateway: `<component>:<link port>` (an `/etc/hosts` entry and
 * `FLAGSHIP_COMPONENT_<NAME>`), which the gateway forwards to that member's
 * loopback port for this app's own containers only. Another app's
 * containers are cut at the gateway; grouping never shares anything between
 * apps.
 *
 * Start: components in `startAfter` order, each confirmed running (and
 * listening, when it declares a port) before the next; the routed main
 * process last. A member that won't start stops every member already
 * started, so a failed start leaves nothing half-running; an upgrade that
 * fails is rolled back by starting every previous member again
 * (servicePlatform.redeploy). Stops run in reverse.
 */
import { connect } from "node:net";
import type { AppRunner, AppSpec, CommandRunner } from "../serviceRunner.js";
import { componentContainerName, componentEnvName } from "./names.js";
import { componentStartOrder } from "./plan.js";

export interface GroupMemberSpec {
  name: string;
  image: string;
  command?: string[];
  /** The port it listens on inside its container. */
  port?: number;
  /** The loopback port its container is published on; the gateway forwards linkPort here. */
  hostPort?: number;
  /** The port other members dial on the apps gateway (egress/gateway.ts OWNED_PORT_RANGE). */
  linkPort?: number;
  limits?: AppSpec["limits"];
  startAfter: string[];
}

export interface GroupSpec {
  members: GroupMemberSpec[];
}

/** The apps gateway's owned-port forwarding (egress/gateway.ts). */
export interface GroupLinks {
  gateway(): string | null;
  link(port: number, target: { host: string; port: number }, owner: string): Promise<boolean>;
  unlink(port: number): Promise<void>;
}

export type MemberCheck = (m: { container: string; hostPort?: number }) => Promise<{ ok: true } | { ok: false; reason: string }>;

export interface GroupRunnerOptions {
  memberCheck?: MemberCheck;
  onLog?: (m: string) => void;
}

/** What a member's spec becomes: its own container, the group's env and links. */
export function memberSpecs(spec: AppSpec, gateway: string | null): { order: string[]; members: AppSpec[]; main: AppSpec } {
  const group = spec.group;
  if (!group) throw new Error("not an app group");
  const order = componentStartOrder(group.members);
  const linked = group.members.filter((m) => m.port !== undefined);
  if (linked.length > 0 && !gateway) throw new Error("this server can't connect the app's processes: its egress gateway isn't running");
  const addHosts: Record<string, string> = {};
  const linkEnv: Record<string, string> = {};
  for (const m of linked) {
    if (m.linkPort === undefined || m.hostPort === undefined) throw new Error(`component ${m.name} has no link port`);
    addHosts[m.name] = gateway!;
    linkEnv[componentEnvName(m.name)] = `${m.name}:${m.linkPort}`;
  }
  const byName = new Map(group.members.map((m) => [m.name, m]));
  const { group: _g, ...base } = spec;
  void _g;
  const members = order.map((name): AppSpec => {
    const m = byName.get(name)!;
    const env: Record<string, string> = { ...(spec.env ?? {}), ...linkEnv, FLAGSHIP_COMPONENT: name };
    if (m.port !== undefined) env.PORT = String(m.port);
    else delete env.PORT;
    return {
      serviceId: spec.serviceId,
      containerName: componentContainerName(spec.serviceId, name),
      image: m.image,
      env,
      ...(m.command ? { command: m.command } : {}),
      ...(m.port !== undefined && m.hostPort !== undefined ? { port: m.hostPort, containerPort: m.port } : {}),
      ...(spec.filesVolume ? { filesVolume: spec.filesVolume } : {}),
      ...(Object.keys(addHosts).length ? { addHosts } : {}),
      ...(m.limits ? { limits: m.limits } : {}),
    };
  });
  const main: AppSpec = {
    ...base,
    env: { ...(spec.env ?? {}), ...linkEnv },
    ...(Object.keys(addHosts).length ? { addHosts: { ...(spec.addHosts ?? {}), ...addHosts } } : {}),
  };
  return { order, members, main };
}

function tcpAnswers(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.on("connect", () => done(true));
    s.on("timeout", () => done(false));
    s.on("error", () => done(false));
  });
}

/** A member is up when its container runs and, if it declared a port, something listens there. */
export function realMemberCheck(cmd: CommandRunner, opts: { timeoutMs?: number; intervalMs?: number } = {}): MemberCheck {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 1000;
  return async ({ container, hostPort }) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let state = "missing";
      try {
        state = (await cmd.capture!("docker", ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", container])).stdout.trim();
      } catch {
        /* gone */
      }
      const [status, code] = state.split(" ");
      if (status !== "running" && status !== "created" && status !== "restarting") {
        let out = "";
        try {
          const l = await cmd.capture!("docker", ["logs", "--tail", "10", container]);
          out = `${l.stdout}\n${l.stderr}`.trim().split("\n").slice(-10).join("\n");
        } catch {
          /* no logs */
        }
        return { ok: false, reason: `${status === "missing" ? "it's gone" : `it stopped (exit code ${code ?? "?"})`}${out ? `. Its last output:\n${out}` : ""}` };
      }
      if (status === "running" && (hostPort === undefined || (await tcpAnswers(hostPort, 1000)))) return { ok: true };
      if (Date.now() >= deadline) return { ok: false, reason: hostPort === undefined ? "it never started running" : "nothing listened on its port" };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
}

export class GroupRunner {
  /** serviceId → member containers in start order (components, then the main process). */
  private readonly started = new Map<string, { containers: string[]; links: number[] }>();

  constructor(
    private readonly app: AppRunner,
    private readonly cmd: CommandRunner,
    private readonly links: GroupLinks | null,
    private readonly opts: GroupRunnerOptions = {},
  ) {}

  private log(m: string): void {
    this.opts.onLog?.(`[app-group] ${m}`);
  }

  /** Start every member in order; on any failure stop the ones started and throw why. */
  async deploy(spec: AppSpec): Promise<void> {
    const gateway = this.links?.gateway() ?? null;
    const { order, members, main } = memberSpecs(spec, gateway);
    const startedNow: string[] = [];
    const linked: number[] = [];
    try {
      for (const m of spec.group!.members) {
        if (m.port === undefined) continue;
        const ok = await this.links!.link(m.linkPort!, { host: "127.0.0.1", port: m.hostPort! }, spec.serviceId);
        if (!ok) throw new Error(`the box could not connect component ${m.name} (link port ${m.linkPort} unavailable)`);
        linked.push(m.linkPort!);
      }
      for (let i = 0; i < members.length; i++) {
        const member = members[i]!;
        const name = order[i]!;
        await this.app.deploy(member);
        startedNow.push(member.containerName!);
        const check = await (this.opts.memberCheck ?? realMemberCheck(this.cmd))({
          container: member.containerName!,
          ...(member.port !== undefined ? { hostPort: member.port } : {}),
        });
        if (!check.ok) throw new Error(`component ${name} didn't start: ${check.reason}`);
        this.log(`${spec.serviceId}: started ${name} (${i + 1} of ${members.length + 1})`);
      }
      await this.app.deploy(main);
      startedNow.push(this.app.containerName(spec.serviceId));
      this.log(`${spec.serviceId}: started the main process (${members.length + 1} of ${members.length + 1})`);
    } catch (e) {
      for (const c of [...startedNow].reverse()) await this.removeContainer(c);
      for (const p of linked) await this.links?.unlink(p).catch(() => {});
      this.started.delete(spec.serviceId);
      throw e;
    }
    this.started.set(spec.serviceId, { containers: startedNow, links: linked });
  }

  private async removeContainer(name: string): Promise<void> {
    await this.cmd.run("docker", ["stop", name]).catch(() => {});
    await this.cmd.run("docker", ["rm", "-f", name]).catch(() => {});
  }

  /** Component containers of `serviceId` that exist now (after a daemon restart nothing is remembered). */
  async componentContainers(serviceId: string): Promise<string[]> {
    const known = this.started.get(serviceId);
    if (known) return known.containers.filter((c) => c !== this.app.containerName(serviceId));
    if (!this.cmd.capture) return [];
    try {
      const prefix = `${this.app.containerName(serviceId)}.`;
      const { stdout } = await this.cmd.capture("docker", ["ps", "-a", "--format", "{{.Names}}", "--filter", `name=^${this.app.containerName(serviceId).replace(/\./g, "\\.")}\\.`]);
      return stdout.split("\n").map((l) => l.trim()).filter((n) => n.startsWith(prefix));
    } catch {
      return [];
    }
  }

  /** Stop and remove the components only (the main process is the app runner's). */
  async stopComponents(serviceId: string): Promise<void> {
    const known = this.started.get(serviceId);
    const comps = await this.componentContainers(serviceId);
    for (const c of [...comps].reverse()) await this.removeContainer(c);
    for (const p of known?.links ?? []) await this.links?.unlink(p).catch(() => {});
    this.started.delete(serviceId);
  }

  /** Main process first, then the components in reverse start order. */
  async stop(serviceId: string): Promise<void> {
    await this.app.stop(serviceId).catch(() => {});
    await this.stopComponents(serviceId);
  }

  async restart(spec: AppSpec): Promise<void> {
    await this.stop(spec.serviceId);
    await this.deploy(spec);
  }

  /** Every member's container, in start order. */
  async members(serviceId: string): Promise<string[]> {
    return [...(await this.componentContainers(serviceId)), this.app.containerName(serviceId)];
  }
}
