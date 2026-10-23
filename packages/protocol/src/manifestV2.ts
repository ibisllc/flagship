/**
 * `flagship.app.json` schema version 2 and the one internal model both versions normalize to
 * (docs/architecture-v2/IMPLEMENTATION-PLAN.md 8.1, package P01).
 *
 * Version 2 is version 1 plus what the v2 runtime can honour: resources, health, restart policy,
 * an isolation profile, an accelerator request, a WASI runtime and a single-host app group. A
 * manifest never grants itself anything: what it asks for becomes part of the capability digest
 * an admin approves, and a box that cannot honour a request refuses it instead of dropping it.
 */
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import {
  MANIFEST_SCHEMA_VERSION,
  NEVER_ALLOWED_MANIFEST_FIELDS,
  RUNTIME_BASES,
  V2_ONLY_MANIFEST_FIELDS,
  parseManifest,
  type AppManifest,
  type RuntimeBase,
} from "./manifest.js";
import { capabilitiesOf, capabilityDigest, diffCapabilities, type CapabilityChange, type CapabilitySet } from "./manifestCapabilities.js";

export const MANIFEST_SCHEMA_VERSION_V2 = 2;

export const ACCELERATOR_BACKENDS = ["nvidia-cuda", "amd-rocm", "intel-level-zero"] as const;
export type AcceleratorBackend = (typeof ACCELERATOR_BACKENDS)[number];
export const ACCELERATOR_CAPABILITIES = ["compute", "graphics", "video-encode", "video-decode"] as const;
export type AcceleratorCapability = (typeof ACCELERATOR_CAPABILITIES)[number];
/** exclusive: one workload per device; partition: a hardware partition such as MIG; cooperative: owner-chosen time slicing within one trust domain. */
export const ACCELERATOR_SHARING = ["exclusive", "partition", "cooperative"] as const;
export type AcceleratorSharing = (typeof ACCELERATOR_SHARING)[number];
export const ACCELERATOR_FALLBACKS = ["none", "cpu-if-supported"] as const;
export type AcceleratorFallback = (typeof ACCELERATOR_FALLBACKS)[number];
/** sandbox: gVisor (today's boundary); vm: a dedicated VM. There is no weaker profile. */
export const ISOLATION_PROFILES = ["sandbox", "vm"] as const;
export type IsolationProfile = (typeof ISOLATION_PROFILES)[number];
export const RESTART_POLICIES = ["always", "on-failure", "never"] as const;
export type RestartPolicy = (typeof RESTART_POLICIES)[number];
export const WASI_WORLDS = ["command", "http-proxy"] as const;
export type WasiWorld = (typeof WASI_WORLDS)[number];

export const MAX_ACCELERATORS = 8;
export const MAX_COMPONENTS = 8;

export interface AppAccelerator {
  backend: AcceleratorBackend;
  count: number;
  /** An admission requirement, not a VRAM quota: not every card can enforce one. */
  minimumMemoryMiB: number;
  capabilities: AcceleratorCapability[];
  sharing: AcceleratorSharing;
  /** cpu-if-supported is honoured only when the approval covers the CPU path too. */
  fallback: AcceleratorFallback;
}

export interface AppResources {
  cpuMillis?: number;
  memoryMiB?: number;
  diskMiB?: number;
  pids?: number;
}

export interface AppHealth {
  path: string;
  intervalSec: number;
  timeoutSec: number;
  startPeriodSec: number;
}

export interface AppWasi {
  /** The .wasm file inside the app; the box compiles it itself and never loads precompiled code. */
  module: string;
  world: WasiWorld;
}

/** One more process in the app's own trust boundary: internal only, no route of its own. */
export interface AppComponent {
  name: string;
  base?: RuntimeBase;
  image: string;
  start?: string[];
  port?: number;
  resources?: AppResources;
  startAfter: string[];
}

export interface NormalizedApp {
  schemaVersion: 1 | 2;
  /** The v1-shaped part, exactly what the v1 parser returns for it. */
  manifest: AppManifest;
  runtimeKind: "oci" | "wasi";
  wasi?: AppWasi;
  resources?: AppResources;
  health?: AppHealth;
  /** Unset means the platform default. */
  restart?: RestartPolicy;
  isolation: IsolationProfile;
  accelerator?: AppAccelerator;
  components: AppComponent[];
  capabilities: CapabilitySetV2;
  capabilityDigest: string;
}

export type AnyManifestParseResult = { ok: true; app: NormalizedApp; notes?: string[] } | { ok: false; errors: string[] };

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEALTH_PATH_RE = /^\/[A-Za-z0-9._~\-/]{0,255}$/;
const MODULE_PATH_RE = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,199}\.wasm$/;

/** Parses either schema version into the one model. Version 1 input gives the v1 parser's exact result. */
export function parseAnyManifest(input: unknown): AnyManifestParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["manifest must be a JSON object"] };
  const m = input as Record<string, unknown>;
  if (m.schema_version === MANIFEST_SCHEMA_VERSION) {
    const r = parseManifest(input);
    if (!r.ok) return r;
    return { ok: true, app: normalize(r.manifest, 1, {}), ...(r.notes ? { notes: r.notes } : {}) };
  }
  if (m.schema_version !== MANIFEST_SCHEMA_VERSION_V2) {
    return { ok: false, errors: [`schema_version must be ${MANIFEST_SCHEMA_VERSION} or ${MANIFEST_SCHEMA_VERSION_V2} (got ${JSON.stringify(m.schema_version)})`] };
  }

  const errors: string[] = [];
  const e = (msg: string) => errors.push(msg);
  const extras: V2Extras = {};

  const projection: Record<string, unknown> = { schema_version: MANIFEST_SCHEMA_VERSION };
  for (const [k, v] of Object.entries(m)) {
    if (k === "schema_version" || V2_ONLY_MANIFEST_FIELDS.includes(k)) continue;
    projection[k] = v;
  }
  if (m.gpu !== undefined) e("gpu is not a field; use accelerator");

  if (typeof m.runtime === "object" && m.runtime !== null && !Array.isArray(m.runtime)) {
    const rt = { ...(m.runtime as Record<string, unknown>) };
    const kind = rt.kind ?? "oci";
    delete rt.kind;
    if (kind === "wasi") {
      extras.wasi = parseWasi(rt, e);
      if (rt.base !== undefined || rt.image !== undefined || rt.start !== undefined) e("a wasi runtime takes module and world, not base, image or start");
      // The v1 parser requires an image; a WASI app's artifact is its module.
      rt.image = extras.wasi?.module ?? "invalid.wasm";
      delete rt.module;
      delete rt.world;
    } else if (kind !== "oci") {
      e('runtime.kind must be "oci" or "wasi"');
    } else if (rt.module !== undefined || rt.world !== undefined) {
      e("runtime.module and runtime.world are only for a wasi runtime");
    }
    projection.runtime = rt;
  }

  if (m.accelerator !== undefined) extras.accelerator = parseAccelerator(m.accelerator, e);
  if (m.resources !== undefined) extras.resources = parseResources(m.resources, "resources", e);
  if (m.health !== undefined) extras.health = parseHealth(m.health, e);
  if (m.restart !== undefined) {
    if (typeof m.restart === "string" && (RESTART_POLICIES as readonly string[]).includes(m.restart)) extras.restart = m.restart as RestartPolicy;
    else e(`restart must be one of ${RESTART_POLICIES.join(", ")}`);
  }
  if (m.isolation !== undefined) {
    if (typeof m.isolation === "string" && (ISOLATION_PROFILES as readonly string[]).includes(m.isolation)) extras.isolation = m.isolation as IsolationProfile;
    else e(`isolation must be one of ${ISOLATION_PROFILES.join(", ")}`);
  }
  if (m.components !== undefined) extras.components = parseComponents(m.components, e);

  const r = parseManifest(projection);
  if (!r.ok) errors.push(...r.errors);
  if (errors.length > 0 || !r.ok) return { ok: false, errors };

  if (extras.components?.some((c) => c.name === r.manifest.name)) e("a component cannot share the app's own name");
  if (extras.wasi && extras.accelerator) e("a wasi runtime cannot ask for an accelerator");
  if (extras.wasi && extras.isolation === "vm") e("a wasi runtime runs in the box's WASI worker, not a VM");
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, app: normalize(r.manifest, 2, extras), ...(r.notes ? { notes: r.notes } : {}) };
}

interface V2Extras {
  wasi?: AppWasi;
  accelerator?: AppAccelerator;
  resources?: AppResources;
  health?: AppHealth;
  restart?: RestartPolicy;
  isolation?: IsolationProfile;
  components?: AppComponent[];
}

function normalize(manifest: AppManifest, schemaVersion: 1 | 2, x: V2Extras): NormalizedApp {
  const app: Omit<NormalizedApp, "capabilities" | "capabilityDigest"> = {
    schemaVersion,
    manifest,
    runtimeKind: x.wasi ? "wasi" : "oci",
    ...(x.wasi ? { wasi: x.wasi } : {}),
    ...(x.resources ? { resources: x.resources } : {}),
    ...(x.health ? { health: x.health } : {}),
    ...(x.restart ? { restart: x.restart } : {}),
    isolation: x.isolation ?? "sandbox",
    ...(x.accelerator ? { accelerator: x.accelerator } : {}),
    components: x.components ?? [],
  };
  const capabilities = capabilitiesOfApp(app);
  return { ...app, capabilities, capabilityDigest: capabilityDigestV2(capabilities) };
}

function parseWasi(rt: Record<string, unknown>, e: (m: string) => void): AppWasi | undefined {
  const mod = rt.module;
  const world = rt.world ?? "command";
  let ok = true;
  if (typeof mod !== "string" || !MODULE_PATH_RE.test(mod) || mod.split("/").includes("..")) {
    e("runtime.module must be a .wasm file inside the app");
    ok = false;
  }
  if (typeof world !== "string" || !(WASI_WORLDS as readonly string[]).includes(world)) {
    e(`runtime.world must be one of ${WASI_WORLDS.join(", ")}`);
    ok = false;
  }
  return ok ? { module: mod as string, world: world as WasiWorld } : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], prefix: string, e: (m: string) => void): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) e(`${prefix}.${k} is not a recognized field`);
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function parseAccelerator(v: unknown, e: (m: string) => void): AppAccelerator | undefined {
  if (!isObject(v)) {
    e("accelerator must be an object");
    return undefined;
  }
  onlyKeys(v, ["backend", "count", "minimumMemoryMiB", "capabilities", "sharing", "fallback"], "accelerator", e);
  let bad = false;
  const fail = (msg: string) => {
    e(msg);
    bad = true;
  };
  if (typeof v.backend !== "string" || !(ACCELERATOR_BACKENDS as readonly string[]).includes(v.backend)) {
    fail(`accelerator.backend must be one of ${ACCELERATOR_BACKENDS.join(", ")}`);
  }
  const count = v.count ?? 1;
  if (!intIn(count, 1, MAX_ACCELERATORS)) fail(`accelerator.count must be an integer from 1 to ${MAX_ACCELERATORS}`);
  const mem = v.minimumMemoryMiB ?? 0;
  if (!intIn(mem, 0, 1 << 22)) fail("accelerator.minimumMemoryMiB must be a whole number of MiB");
  const caps = v.capabilities ?? ["compute"];
  if (
    !Array.isArray(caps) ||
    caps.length === 0 ||
    caps.some((c) => typeof c !== "string" || !(ACCELERATOR_CAPABILITIES as readonly string[]).includes(c)) ||
    new Set(caps).size !== caps.length
  ) {
    fail(`accelerator.capabilities must list distinct values from ${ACCELERATOR_CAPABILITIES.join(", ")}`);
  }
  const sharing = v.sharing ?? "exclusive";
  if (typeof sharing !== "string" || !(ACCELERATOR_SHARING as readonly string[]).includes(sharing)) {
    fail(`accelerator.sharing must be one of ${ACCELERATOR_SHARING.join(", ")}`);
  }
  const fallback = v.fallback ?? "none";
  if (typeof fallback !== "string" || !(ACCELERATOR_FALLBACKS as readonly string[]).includes(fallback)) {
    fail(`accelerator.fallback must be one of ${ACCELERATOR_FALLBACKS.join(", ")}`);
  }
  if (bad) return undefined;
  return {
    backend: v.backend as AcceleratorBackend,
    count: count as number,
    minimumMemoryMiB: mem as number,
    capabilities: [...(caps as AcceleratorCapability[])].sort(),
    sharing: sharing as AcceleratorSharing,
    fallback: fallback as AcceleratorFallback,
  };
}

function parseResources(v: unknown, prefix: string, e: (m: string) => void): AppResources | undefined {
  if (!isObject(v)) {
    e(`${prefix} must be an object`);
    return undefined;
  }
  onlyKeys(v, ["cpuMillis", "memoryMiB", "diskMiB", "pids"], prefix, e);
  const out: AppResources = {};
  const limits: Array<[keyof AppResources, number, number]> = [
    ["cpuMillis", 50, 256_000],
    ["memoryMiB", 32, 1 << 20],
    ["diskMiB", 1, 1 << 24],
    ["pids", 16, 32_768],
  ];
  let bad = false;
  for (const [k, min, max] of limits) {
    if (v[k] === undefined) continue;
    if (!intIn(v[k], min, max)) {
      e(`${prefix}.${k} must be an integer from ${min} to ${max}`);
      bad = true;
    } else out[k] = v[k] as number;
  }
  return bad ? undefined : out;
}

function parseHealth(v: unknown, e: (m: string) => void): AppHealth | undefined {
  if (!isObject(v)) {
    e("health must be an object");
    return undefined;
  }
  onlyKeys(v, ["path", "intervalSec", "timeoutSec", "startPeriodSec"], "health", e);
  const path = v.path;
  const interval = v.intervalSec ?? 30;
  const timeout = v.timeoutSec ?? 5;
  const startPeriod = v.startPeriodSec ?? 0;
  let bad = false;
  if (typeof path !== "string" || !HEALTH_PATH_RE.test(path) || path.split("/").includes("..")) {
    e('health.path must be a path on the app, e.g. "/healthz"');
    bad = true;
  }
  if (!intIn(interval, 1, 3600)) (e("health.intervalSec must be an integer from 1 to 3600"), (bad = true));
  if (!intIn(timeout, 1, 300)) (e("health.timeoutSec must be an integer from 1 to 300"), (bad = true));
  if (!intIn(startPeriod, 0, 3600)) (e("health.startPeriodSec must be an integer from 0 to 3600"), (bad = true));
  if (!bad && (timeout as number) > (interval as number)) (e("health.timeoutSec cannot be longer than health.intervalSec"), (bad = true));
  return bad ? undefined : { path: path as string, intervalSec: interval as number, timeoutSec: timeout as number, startPeriodSec: startPeriod as number };
}

function parseComponents(v: unknown, e: (m: string) => void): AppComponent[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_COMPONENTS) {
    e(`components must be a list of 1 to ${MAX_COMPONENTS} entries`);
    return undefined;
  }
  const out: AppComponent[] = [];
  const names = new Set<string>();
  let bad = false;
  v.forEach((c, i) => {
    const p = `components[${i}]`;
    if (!isObject(c)) {
      e(`${p} must be an object`);
      bad = true;
      return;
    }
    for (const k of Object.keys(c)) {
      if (NEVER_ALLOWED_MANIFEST_FIELDS.includes(k)) {
        e(`${p}.${k} is not allowed: the box decides host access, an app manifest cannot ask for it`);
        bad = true;
      }
    }
    onlyKeys(c, ["name", "base", "image", "start", "port", "resources", "startAfter", ...NEVER_ALLOWED_MANIFEST_FIELDS], p, e);
    if (typeof c.name !== "string" || !LABEL_RE.test(c.name)) {
      e(`${p}.name must be a DNS label`);
      bad = true;
      return;
    }
    if (names.has(c.name)) {
      e(`${p}.name ${c.name} is used twice`);
      bad = true;
    }
    names.add(c.name);
    let base: RuntimeBase | undefined;
    if (c.base !== undefined) {
      if (typeof c.base === "string" && (RUNTIME_BASES as readonly string[]).includes(c.base)) base = c.base as RuntimeBase;
      else (e(`${p}.base must be one of ${RUNTIME_BASES.join(", ")}`), (bad = true));
    }
    const image = c.image === undefined && base !== undefined ? "" : c.image;
    if (typeof image !== "string" || (image === "" && base === undefined)) (e(`${p}.image must be an image reference, or set ${p}.base`), (bad = true));
    let start: string[] | undefined;
    if (c.start !== undefined) {
      if (!Array.isArray(c.start) || c.start.length < 1 || c.start.length > 32 || c.start.some((a) => typeof a !== "string" || a.length < 1 || a.length > 1024 || /[\u0000-\u001f]/.test(a))) {
        e(`${p}.start must be a command as 1-32 strings (no shell)`);
        bad = true;
      } else start = [...(c.start as string[])];
    }
    if (c.port !== undefined && !intIn(c.port, 1, 65535)) (e(`${p}.port must be an integer in [1, 65535]`), (bad = true));
    const resources = c.resources === undefined ? undefined : parseResources(c.resources, `${p}.resources`, e);
    if (c.resources !== undefined && !resources) bad = true;
    const after = c.startAfter ?? [];
    if (!Array.isArray(after) || after.some((a) => typeof a !== "string" || !LABEL_RE.test(a))) (e(`${p}.startAfter must list component names`), (bad = true));
    out.push({
      name: c.name,
      ...(base ? { base } : {}),
      image: typeof image === "string" ? image : "",
      ...(start ? { start } : {}),
      ...(c.port !== undefined ? { port: c.port as number } : {}),
      ...(resources ? { resources } : {}),
      startAfter: Array.isArray(after) ? [...(after as string[])] : [],
    });
  });
  if (bad) return undefined;
  for (const c of out) {
    for (const a of c.startAfter) if (!names.has(a)) (e(`component ${c.name} starts after ${a}, which is not a component`), (bad = true));
  }
  if (!bad && hasCycle(out)) (e("components' startAfter order has a cycle"), (bad = true));
  return bad ? undefined : out;
}

function hasCycle(cs: AppComponent[]): boolean {
  const deps = new Map(cs.map((c) => [c.name, c.startAfter]));
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 2) return false;
    if (state.get(n) === 1) return true;
    state.set(n, 1);
    for (const d of deps.get(n) ?? []) if (visit(d)) return true;
    state.set(n, 2);
    return false;
  };
  return cs.some((c) => visit(c.name));
}

/** The v1 authority plus what v2 can ask for. */
export interface CapabilitySetV2 extends CapabilitySet {
  accelerator: string;
  isolation: IsolationProfile;
  components: string[];
  runtimeKind: "oci" | "wasi";
}

function capabilitiesOfApp(app: Omit<NormalizedApp, "capabilities" | "capabilityDigest">): CapabilitySetV2 {
  const a = app.accelerator;
  return {
    ...capabilitiesOf(app.manifest),
    accelerator: a ? `${a.backend}:${a.count}:${a.capabilities.join("+")}:${a.sharing}:${a.fallback}` : "",
    isolation: app.isolation,
    components: app.components.map((c) => `${c.name}=${c.base ?? c.image}`).sort(),
    runtimeKind: app.runtimeKind,
  };
}

function asksForV2Authority(c: CapabilitySetV2): boolean {
  return c.accelerator !== "" || c.isolation !== "sandbox" || c.components.length > 0 || c.runtimeKind !== "oci";
}

/**
 * A manifest that asks for nothing beyond v1 keeps its v1 digest, so moving to schema 2 alone
 * never needs a fresh approval and existing approvals stay valid.
 */
export function capabilityDigestV2(c: CapabilitySetV2): string {
  if (!asksForV2Authority(c)) return capabilityDigest(c);
  const text = [
    "flagship/app-capabilities/v2",
    `v1=${capabilityDigest(c)}`,
    `accelerator=${c.accelerator}`,
    `isolation=${c.isolation}`,
    `components=${c.components.join(",")}`,
    `runtime=${c.runtimeKind}`,
  ].join("|");
  return hex(sha256(new TextEncoder().encode(text)));
}

export function diffCapabilitiesV2(installed: CapabilitySetV2, next: CapabilitySetV2) {
  const d = diffCapabilities(installed, next);
  const expanded: Array<CapabilityChange | { capability: keyof CapabilitySetV2; added: string[]; removed: string[] }> = [...d.expanded];
  const narrowed = [...d.narrowed] as typeof expanded;
  if (installed.accelerator !== next.accelerator) {
    if (next.accelerator) expanded.push({ capability: "accelerator", added: [next.accelerator], removed: installed.accelerator ? [installed.accelerator] : [] });
    else narrowed.push({ capability: "accelerator", added: [], removed: [installed.accelerator] });
  }
  if (installed.isolation !== next.isolation) expanded.push({ capability: "isolation", added: [next.isolation], removed: [installed.isolation] });
  if (installed.runtimeKind !== next.runtimeKind) expanded.push({ capability: "runtimeKind", added: [next.runtimeKind], removed: [installed.runtimeKind] });
  const addedComponents = next.components.filter((x) => !installed.components.includes(x));
  const removedComponents = installed.components.filter((x) => !next.components.includes(x));
  if (addedComponents.length) expanded.push({ capability: "components", added: addedComponents, removed: [] });
  if (removedComponents.length) narrowed.push({ capability: "components", added: [], removed: removedComponents });
  return { expanded, narrowed, needsApproval: expanded.length > 0 };
}

/** What a box can honour. The admission check refuses everything else. */
export interface BoxRuntimeCapabilities {
  accelerators: Array<{ backend: AcceleratorBackend; devices: number; capabilities: AcceleratorCapability[]; sharing: AcceleratorSharing[] }>;
  isolation: IsolationProfile[];
  wasiWorlds: WasiWorld[];
  appGroups: boolean;
}

/** A box built from release 0.3: gVisor apps only. */
export const BOX_CAPABILITIES_0_3: BoxRuntimeCapabilities = { accelerators: [], isolation: ["sandbox"], wasiWorlds: [], appGroups: false };

export interface AdmissionRefusal {
  field: string;
  code: "accelerator-unavailable" | "accelerator-capability" | "accelerator-sharing" | "accelerator-count" | "isolation-unavailable" | "wasi-unavailable" | "app-groups-unavailable";
  message: string;
}

export interface AdmissionResult {
  ok: boolean;
  refusals: AdmissionRefusal[];
  /** "cpu-fallback" only when the app declared a CPU path; the approval must cover it. */
  placement: "cpu" | "accelerator" | "cpu-fallback" | "wasi";
}

export function admitApp(app: NormalizedApp, box: BoxRuntimeCapabilities): AdmissionResult {
  const refusals: AdmissionRefusal[] = [];
  if (!box.isolation.includes(app.isolation)) {
    refusals.push({ field: "isolation", code: "isolation-unavailable", message: `This server cannot run apps in the "${app.isolation}" isolation profile.` });
  }
  if (app.components.length > 0 && !box.appGroups) {
    refusals.push({ field: "components", code: "app-groups-unavailable", message: "This server cannot run an app made of several processes yet. Update the server first." });
  }
  if (app.wasi && !box.wasiWorlds.includes(app.wasi.world)) {
    refusals.push({ field: "runtime.kind", code: "wasi-unavailable", message: "This server cannot run WebAssembly apps yet. Update the server first." });
  }
  let placement: AdmissionResult["placement"] = app.wasi ? "wasi" : "cpu";
  const a = app.accelerator;
  if (a) {
    const offer = box.accelerators.find((o) => o.backend === a.backend);
    const missing: AdmissionRefusal[] = [];
    if (!offer) missing.push({ field: "accelerator.backend", code: "accelerator-unavailable", message: `This server has no ${backendName(a.backend)} accelerator it can give to apps.` });
    else {
      if (offer.devices < a.count) missing.push({ field: "accelerator.count", code: "accelerator-count", message: `This app needs ${a.count} accelerators; this server can give ${offer.devices}.` });
      const lacking = a.capabilities.filter((c) => !offer.capabilities.includes(c));
      if (lacking.length) missing.push({ field: "accelerator.capabilities", code: "accelerator-capability", message: `This server's accelerator cannot do ${lacking.join(", ")} for apps.` });
      if (!offer.sharing.includes(a.sharing)) missing.push({ field: "accelerator.sharing", code: "accelerator-sharing", message: `This server cannot share its accelerator the "${a.sharing}" way.` });
    }
    if (missing.length === 0) placement = "accelerator";
    else if (a.fallback === "cpu-if-supported") placement = "cpu-fallback";
    else refusals.push(...missing);
  }
  return { ok: refusals.length === 0, refusals, placement };
}

function backendName(b: AcceleratorBackend): string {
  return b === "nvidia-cuda" ? "NVIDIA CUDA" : b === "amd-rocm" ? "AMD ROCm" : "Intel oneAPI";
}
