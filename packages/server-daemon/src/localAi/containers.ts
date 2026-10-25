/**
 * The exact container shapes local inference and fine-tuning run in, and the root steps they need.
 * Both privileged brokers hold the same shapes (packages/privd/src/policy.ts `isLocalAiRun`,
 * rust/crates/flagship-broker/src/policy.rs `is_local_ai_run`); `checkLocalAiRunArgs` is the
 * daemon's own tripwire before anything is sent.
 *
 *  - the model server `flagship-localai-<16 hex>`: a pinned llama.cpp server image, gVisor (or the
 *    GPU allocation's runtime), not root, read-only root filesystem, every capability dropped, the
 *    staging network (no internet, no other container), published on loopback only, and exactly
 *    one mount: the models volume, read-only;
 *  - a fine-tuning run `flagship-aitrain-<16 hex>`: a pinned llama.cpp `full` image, the same
 *    walls, the models volume read-only, its own output volume `flagship-aitrain-<same hex>`, and at
 *    most one more mount: an app's DEV files volume (its staged sample data) read-only at /dataset.
 *    Never a live app's `flagship-files-` volume.
 */
import { ALL_LOCAL_AI_IMAGES, modelFileName } from "./catalog.js";

/** The volume the installed models live in (read-only to every container). */
export const MODELS_VOLUME = "flagship-models";

export const LOCAL_AI_USER = "10001:10001";
export const SERVICE_NAME_RE = /^flagship-localai-([0-9a-f]{16})$/;
export const TRAIN_NAME_RE = /^flagship-aitrain-([0-9a-f]{16})$/;
export const MODELS_MOUNT = `type=volume,src=${MODELS_VOLUME},dst=/models,readonly`;
const DEV_FILES_RE = /^flagship-devfiles-[a-z0-9](?:-?[a-z0-9]){0,31}--[a-z0-9](?:-?[a-z0-9]){0,31}$/;
export const SERVER_PORT = 8080;

export function outVolume(hex: string): string {
  if (!/^[0-9a-f]{16}$/.test(hex)) throw new Error("bad job id");
  return `flagship-aitrain-${hex}`;
}
export function outMount(hex: string): string {
  return `type=volume,src=${outVolume(hex)},dst=/out`;
}
export function datasetMount(devVolume: string): string {
  if (!DEV_FILES_RE.test(devVolume)) throw new Error("a training dataset is an app's staged sample data (its dev files volume)");
  return `type=volume,src=${devVolume},dst=/dataset,readonly`;
}

export interface ServiceRun {
  name: string;
  image: string;
  modelSha256: string;
  hostPort: number;
  contextTokens: number;
  threads: number;
  memoryMiB: number;
  cpus: string;
  apiKey: string;
  /** The GPU allocation's attach arguments (runtime, devices, label); empty on CPU. */
  gpuArgs: string[];
  /** gVisor (`--runtime=runsc`) on CPU; the GPU args carry their own runtime. */
  sandboxArgs: string[];
  /** The staging network and its filtered resolver. */
  networkArgs: string[];
}

/** `docker run …` for the model server. */
export function serviceRunArgs(r: ServiceRun): string[] {
  if (!SERVICE_NAME_RE.test(r.name)) throw new Error("bad local-ai container name");
  const gpu = r.gpuArgs.length > 0;
  const runtime = gpu ? [] : r.sandboxArgs.filter((a) => a.startsWith("--runtime="));
  return [
    "run",
    "-d",
    "--name",
    r.name,
    ...runtime,
    ...r.gpuArgs,
    ...r.networkArgs,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user",
    LOCAL_AI_USER,
    "--memory",
    `${r.memoryMiB}m`,
    "--cpus",
    r.cpus,
    "--pids-limit",
    "1024",
    "--label",
    "flagship.role=local-ai",
    "--mount",
    MODELS_MOUNT,
    "-p",
    `127.0.0.1:${r.hostPort}:${SERVER_PORT}`,
    "-e",
    `LLAMA_API_KEY=${r.apiKey}`,
    r.image,
    "--host",
    "0.0.0.0",
    "--port",
    String(SERVER_PORT),
    "-m",
    `/models/${modelFileName(r.modelSha256)}`,
    "-c",
    String(r.contextTokens),
    "-t",
    String(r.threads),
    "--jinja",
    "--no-webui",
    // No slot monitoring: it would show what is in each slot's prompt (another caller's text).
    "--no-slots",
    ...(gpu ? ["-ngl", "999"] : []),
  ];
}

export interface TrainRun {
  hex: string;
  image: string;
  gpuArgs: string[];
  sandboxArgs: string[];
  networkArgs: string[];
  memoryMiB: number;
  cpus: string;
  /** Mount the app's staged sample data volume at /dataset (read-only). */
  datasetVolume?: string;
  /** `--entrypoint` and its arguments. */
  entrypoint: string;
  command: string[];
  /** stdin carries the dataset (`-i`) instead of a volume. */
  interactive?: boolean;
  /**
   * Run in the background (`-d`, removed by the caller once it has read the logs): a long epoch
   * outlives the privileged helper's per-command limit, so the box polls it instead of waiting.
   */
  detach?: boolean;
}

export function trainRunArgs(r: TrainRun): string[] {
  const name = `flagship-aitrain-${r.hex}`;
  if (!TRAIN_NAME_RE.test(name)) throw new Error("bad training job id");
  const gpu = r.gpuArgs.length > 0;
  const runtime = gpu ? [] : r.sandboxArgs.filter((a) => a.startsWith("--runtime="));
  return [
    "run",
    ...(r.detach ? ["-d"] : ["--rm"]),
    ...(r.interactive && !r.detach ? ["-i"] : []),
    "--name",
    name,
    ...runtime,
    ...r.gpuArgs,
    ...r.networkArgs,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user",
    LOCAL_AI_USER,
    "--memory",
    `${r.memoryMiB}m`,
    "--cpus",
    r.cpus,
    "--pids-limit",
    "1024",
    "--label",
    "flagship.role=local-ai-train",
    "--mount",
    MODELS_MOUNT,
    "--mount",
    outMount(r.hex),
    ...(r.datasetVolume ? ["--mount", datasetMount(r.datasetVolume)] : []),
    "--entrypoint",
    r.entrypoint,
    r.image,
    ...r.command,
  ];
}

const BOOL_FLAGS = new Set(["-d", "--rm", "-i", "--read-only"]);
const FORBIDDEN = new Set(["--privileged", "--cap-add", "--pid", "--ipc", "--uts", "--userns", "--volumes-from", "--gpus", "-v", "--volume", "--device-cgroup-rule"]);

/**
 * The daemon's own check before a local-AI run reaches the broker: a pinned image, a local-AI name,
 * only the mounts that name allows, gVisor or exactly one GPU runtime, never root or the host.
 */
export function checkLocalAiRunArgs(args: readonly string[]): void {
  if (args[0] !== "run") throw new Error("a local-AI container is started with run");
  let name: string | null = null;
  let runtime = 0;
  const mounts: string[] = [];
  let image: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) {
      image = a;
      break;
    }
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
    if (FORBIDDEN.has(flag)) throw new Error(`refusing local-AI run: ${flag} is not allowed`);
    const v = inline !== null ? inline : BOOL_FLAGS.has(flag) ? "" : args[++i] ?? "";
    if (flag === "--name") name = v;
    if (flag === "--runtime") runtime++;
    if (flag === "--mount") mounts.push(v);
    if (flag === "--network" && v === "host") throw new Error("refusing local-AI run: host networking");
    if (flag === "--user" && /^(root|0+)(:|$)/.test(v)) throw new Error("refusing local-AI run: root");
    if (flag === "-p" && !/^127\.0\.0\.1:[0-9]{2,5}:8080$/.test(v)) throw new Error("refusing local-AI run: the server is published on loopback only");
  }
  if (!image || !ALL_LOCAL_AI_IMAGES.includes(image)) throw new Error("refusing local-AI run: not a pinned local-AI image");
  if (runtime !== 1) throw new Error("refusing local-AI run: it names no single sandbox runtime");
  const service = name !== null && SERVICE_NAME_RE.exec(name);
  const train = name !== null && TRAIN_NAME_RE.exec(name);
  if (!service && !train) throw new Error("refusing local-AI run: not a local-AI container name");
  for (const m of mounts) {
    if (m === MODELS_MOUNT) continue;
    if (train && m === outMount(train[1]!)) continue;
    if (train && /^type=volume,src=([^,]+),dst=\/dataset,readonly$/.test(m) && DEV_FILES_RE.test(/src=([^,]+)/.exec(m)![1]!)) continue;
    throw new Error(`refusing local-AI run: mount ${m} is not allowed`);
  }
}
