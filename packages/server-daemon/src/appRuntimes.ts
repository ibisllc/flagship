/**
 * One app runner for every kind of app (P04/P05): a plain container app
 * goes to AppRunner as before, an app made of several processes to the
 * group runner, a WebAssembly app to the WASI runner. ServicePlatform and
 * everything else keep calling deploy/stop/restart/logs on one object; which
 * runtime serves an app follows from its spec (the normalized manifest), so
 * the install, update, restore and uninstall paths are the same for all.
 */
import { BOX_CAPABILITIES_0_3, type BoxRuntimeCapabilities } from "@flagship/protocol";
import { AppRunner, realCommandRunner, type AppRunnerOptions, type AppSpec, type CommandRunner, type StartCheck } from "./serviceRunner.js";
import { GroupRunner, type GroupLinks, type GroupRunnerOptions } from "./appGroups/runner.js";
import type { WasiRunner } from "./wasi/runner.js";

export type RuntimeKind = "oci" | "group" | "wasi";

export function runtimeKindOf(spec: AppSpec): RuntimeKind {
  return spec.wasi ? "wasi" : spec.group && spec.group.members.length > 0 ? "group" : "oci";
}

export class RuntimeRouter extends AppRunner {
  private wasi: WasiRunner | null = null;
  private readonly groups: GroupRunner;
  private readonly kinds = new Map<string, RuntimeKind>();
  private groupLinks: GroupLinks | null = null;

  constructor(
    private readonly runnerCmd: CommandRunner = realCommandRunner,
    opts: AppRunnerOptions = {},
    groupOpts: GroupRunnerOptions = {},
  ) {
    super(runnerCmd, opts);
    const links: GroupLinks = {
      gateway: () => this.groupLinks?.gateway() ?? null,
      link: (p, t, o) => this.groupLinks?.link(p, t, o) ?? Promise.resolve(false),
      unlink: (p) => this.groupLinks?.unlink(p) ?? Promise.resolve(),
    };
    this.groups = new GroupRunner(new AppRunner(runnerCmd, opts), runnerCmd, links, groupOpts);
  }

  setWasiRunner(w: WasiRunner | null): void {
    this.wasi = w;
  }

  /** The apps gateway's owned ports (egress/gateway.ts), once it enforces. */
  setGroupLinks(links: GroupLinks | null): void {
    this.groupLinks = links;
  }

  get groupRunner(): GroupRunner {
    return this.groups;
  }

  get wasiRunner(): WasiRunner | null {
    return this.wasi;
  }

  kindOf(serviceId: string): RuntimeKind | undefined {
    return this.kinds.get(serviceId);
  }

  private extraCapabilities: (() => Partial<Pick<BoxRuntimeCapabilities, "accelerators" | "isolation">>) | null = null;

  /** Accelerator offers and isolation profiles another runtime adds (the GPU allocator, gpu/). */
  setExtraCapabilities(fn: (() => Partial<Pick<BoxRuntimeCapabilities, "accelerators" | "isolation">>) | null): void {
    this.extraCapabilities = fn;
  }

  /** What this box can run now (manifest v2 admission, protocol admitApp). */
  capabilities(wasiAvailable: boolean): BoxRuntimeCapabilities {
    return {
      ...BOX_CAPABILITIES_0_3,
      ...(this.extraCapabilities?.() ?? {}),
      wasiWorlds: wasiAvailable && this.wasi ? ["command", "http-proxy"] : [],
      appGroups: this.groupLinks?.gateway() != null,
    };
  }

  override async deploy(spec: AppSpec): Promise<string[]> {
    const kind = runtimeKindOf(spec);
    if (kind === "wasi") {
      if (!this.wasi) throw new Error("this server cannot run WebAssembly apps yet: update the server first");
      await this.wasi.deploy(spec);
    } else if (kind === "group") {
      await this.groups.deploy(spec);
    } else {
      const args = await super.deploy(spec);
      this.kinds.set(spec.serviceId, kind);
      return args;
    }
    this.kinds.set(spec.serviceId, kind);
    return [];
  }

  override async stop(serviceId: string): Promise<void> {
    const kind = this.kinds.get(serviceId);
    this.kinds.delete(serviceId);
    if (kind === "wasi") return this.wasi?.stop(serviceId);
    if (kind === "group") return this.groups.stop(serviceId);
    try {
      await super.stop(serviceId);
    } finally {
      // After a restart nothing is remembered: leftover group members go too.
      await this.groups.stopComponents(serviceId);
      if (kind === undefined) await this.wasi?.stop(serviceId);
    }
  }

  /** Every member of the previous version stops before any of the next one starts. */
  override async restart(spec: AppSpec): Promise<void> {
    try {
      await this.stop(spec.serviceId);
    } catch {
      // best effort: nothing may be running
    }
    await this.deploy(spec);
  }

  override async logs(serviceId: string, tail: number): Promise<{ stdout: string; stderr: string }> {
    if (this.kinds.get(serviceId) === "wasi" && this.wasi) return this.wasi.logs(serviceId, tail);
    return super.logs(serviceId, tail);
  }

  /** Uninstall: also drop what a runtime keeps per app (a WASI app's unit folder). */
  async forget(serviceId: string): Promise<void> {
    await this.wasi?.remove(serviceId).catch(() => {});
    this.kinds.delete(serviceId);
  }

  /** The start check for any kind: a WASI app is checked by its runner, the rest by `base`. */
  startCheck(base: StartCheck | undefined): StartCheck | undefined {
    return async (spec) => {
      if (spec.wasi && this.wasi) return this.wasi.check(spec);
      return base ? base(spec) : { ok: true };
    };
  }

  /**
   * Hold an app still while its data is read (a backup, a copy): every
   * member of a group, or a WASI app's worker. Undefined when nothing runs.
   */
  async quiesce(serviceId: string): Promise<(() => Promise<void>) | undefined> {
    const kind = this.kinds.get(serviceId);
    if (kind === "wasi") return this.wasi?.freeze(serviceId);
    if (kind !== "group") return undefined;
    const paused: string[] = [];
    try {
      for (const c of await this.groups.members(serviceId)) {
        await this.runnerCmd.run("docker", ["pause", c]);
        paused.push(c);
      }
    } catch (e) {
      for (const c of paused.reverse()) await this.runnerCmd.run("docker", ["unpause", c]).catch(() => {});
      throw e;
    }
    return async () => {
      for (const c of [...paused].reverse()) await this.runnerCmd.run("docker", ["unpause", c]).catch(() => {});
    };
  }
}
