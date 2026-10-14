/**
 * UpCloud GPU inference server: config, cloud-init rendering and a small
 * UpCloud API 1.3 client. Shared by provision.mjs and teardown.mjs.
 *
 * Same API style as apps/com/src/upcloud.ts (bearer `ucat_…` token, JSON,
 * labels to find our servers again), kept standalone so it runs with plain
 * `node` from a laptop and never ships in a Worker bundle.
 *
 * Nothing here logs a secret: the dry run prints the request with the
 * cloud-init secrets replaced by "<redacted>".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const UPCLOUD_API_BASE = "https://api.upcloud.com/1.3";
export const LABEL_KEY = "flagship-inference";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REVISION_RE = /^[0-9a-f]{40}$/;
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
/** Secrets land in YAML and an env file: refuse anything that could break out of either. */
const SECRET_RE = /^[A-Za-z0-9._~+/=-]{24,4096}$/;

/* ─────────────────────────── config ─────────────────────────────────── */

export function loadConfig(path = join(HERE, "config.json")) {
  return validateConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** Throws on the first problem; returns the config unchanged when it's sound. */
export function validateConfig(c) {
  const need = (cond, msg) => {
    if (!cond) throw new Error(`config: ${msg}`);
  };
  need(c && typeof c === "object", "must be an object");
  need(NAME_RE.test(c.name ?? ""), "name must be lowercase letters, digits and dashes");
  need(typeof c.zone === "string" && /^[a-z]{2}-[a-z]{3}\d$/.test(c.zone), "zone must look like fi-hel2");
  need(typeof c.plan === "string" && c.plan.length > 0, "plan is required (an UpCloud GPU plan name)");
  need(
    (typeof c.template === "string" && UUID_RE.test(c.template)) || typeof c.templateTitle === "string",
    "template (UUID) or templateTitle is required",
  );
  need(Number.isInteger(c.storageGb) && c.storageGb >= 80, "storageGb must be an integer ≥ 80 (model + image)");
  need(["maxiops", "standard", "hdd"].includes(c.storageTier), "storageTier must be maxiops, standard or hdd");
  const v = c.vllm;
  need(v && typeof v === "object", "vllm block is required");
  need(typeof v.image === "string" && v.image.length > 0, "vllm.image is required");
  need(DIGEST_RE.test(v.imageDigest ?? ""), "vllm.imageDigest must be sha256:<64 hex> (pin the image)");
  need(typeof v.model === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(v.model), "vllm.model must be an org/name Hugging Face repo");
  need(REVISION_RE.test(v.revision ?? ""), "vllm.revision must be a 40-hex commit (pin the weights)");
  need(NAME_RE.test(v.servedModelName ?? ""), "vllm.servedModelName must be a simple lowercase name");
  need(Number.isInteger(v.maxModelLen) && v.maxModelLen >= 8192, "vllm.maxModelLen must be an integer ≥ 8192");
  need(typeof v.gpuMemoryUtilization === "number" && v.gpuMemoryUtilization > 0.5 && v.gpuMemoryUtilization < 0.99,
    "vllm.gpuMemoryUtilization must be between 0.5 and 0.99");
  need(Number.isInteger(v.maxNumSeqs) && v.maxNumSeqs >= 1, "vllm.maxNumSeqs must be a positive integer");
  need(typeof v.toolCallParser === "string" && /^[a-z0-9_]+$/.test(v.toolCallParser), "vllm.toolCallParser is required");
  need(v.defaultChatTemplateKwargs === undefined ||
    (v.defaultChatTemplateKwargs && typeof v.defaultChatTemplateKwargs === "object" && !JSON.stringify(v.defaultChatTemplateKwargs).includes("'")),
    "vllm.defaultChatTemplateKwargs must be an object");
  need(v.extraArgs === undefined || (Array.isArray(v.extraArgs) && v.extraArgs.every((a) => /^[A-Za-z0-9_.:=\-/]+$/.test(a))),
    "vllm.extraArgs must be simple tokens");
  const t = c.cloudflared;
  need(t && typeof t.image === "string" && DIGEST_RE.test(t.imageDigest ?? ""), "cloudflared.image + imageDigest are required");
  need(typeof c.nvidiaDriverBranch === "string" && /^\d{3}(-server)?(-open)?$/.test(c.nvidiaDriverBranch),
    "nvidiaDriverBranch must look like 580-server");
  need(typeof c.nvidiaContainerToolkitVersion === "string" && /^\d+\.\d+\.\d+-\d+$/.test(c.nvidiaContainerToolkitVersion),
    "nvidiaContainerToolkitVersion must look like 1.20.1-1");
  return c;
}

/* ─────────────────────────── secrets ────────────────────────────────── */

/**
 * The two secrets cloud-init needs, read from the environment:
 *   VLLM_API_KEY      — the key the shim sends (its UPSTREAM_API_KEY)
 *   CF_TUNNEL_TOKEN   — the Cloudflare Tunnel's connector token
 * Neither is ever printed.
 */
export function readSecrets(env) {
  const out = {};
  for (const [name, key] of [["VLLM_API_KEY", "apiKey"], ["CF_TUNNEL_TOKEN", "tunnelToken"]]) {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set`);
    if (!SECRET_RE.test(v)) throw new Error(`${name} has characters or a length this script won't put in cloud-init`);
    out[key] = v;
  }
  return out;
}

/* ─────────────────────────── cloud-init ─────────────────────────────── */

/** The vLLM command-line arguments, in order (the container's entrypoint is the OpenAI server). */
export function vllmArgs(c) {
  const v = c.vllm;
  return [
    "--model", v.model,
    "--revision", v.revision,
    "--served-model-name", v.servedModelName,
    "--host", "127.0.0.1",
    "--port", "8000",
    "--max-model-len", String(v.maxModelLen),
    "--gpu-memory-utilization", String(v.gpuMemoryUtilization),
    "--max-num-seqs", String(v.maxNumSeqs),
    ...(v.kvCacheDtype ? ["--kv-cache-dtype", v.kvCacheDtype] : []),
    "--enable-prefix-caching",
    "--enable-auto-tool-choice",
    "--tool-call-parser", v.toolCallParser,
    ...(v.reasoningParser ? ["--reasoning-parser", v.reasoningParser] : []),
    ...(v.defaultChatTemplateKwargs ? ["--default-chat-template-kwargs", JSON.stringify(v.defaultChatTemplateKwargs)] : []),
    ...(v.languageModelOnly ? ["--language-model-only"] : []),
    "--disable-uvicorn-access-log",
    ...(v.extraArgs ?? []),
  ];
}

/**
 * Render cloud-init.yaml with the config and secrets. Every `{{NAME}}` must be
 * filled and nothing unknown may be left over, so a typo can't ship a box
 * with an empty API key.
 */
export function renderCloudInit(c, secrets, template = readFileSync(join(HERE, "cloud-init.yaml"), "utf8")) {
  const values = {
    VLLM_IMAGE: `${c.vllm.image}@${c.vllm.imageDigest}`,
    VLLM_ARGS: vllmArgs(c).map(quoteArg).join(" "),
    VLLM_API_KEY: secrets.apiKey,
    CF_TUNNEL_TOKEN: secrets.tunnelToken,
    CLOUDFLARED_IMAGE: `${c.cloudflared.image}@${c.cloudflared.imageDigest}`,
    NVIDIA_DRIVER_BRANCH: c.nvidiaDriverBranch,
    NVIDIA_CONTAINER_TOOLKIT_VERSION: c.nvidiaContainerToolkitVersion,
    VLLM_MODEL: c.vllm.model,
    VLLM_REVISION: c.vllm.revision,
  };
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => {
    if (!(k in values)) throw new Error(`cloud-init: unknown placeholder {{${k}}}`);
    return values[k];
  });
  return out;
}

/** systemd ExecStart quoting: plain tokens stay bare, anything else is single-quoted (validated to hold no `'`). */
export function quoteArg(a) {
  return /^[A-Za-z0-9_.:=\-/]+$/.test(a) ? a : `'${a}'`;
}

export function redact(text, secrets) {
  let out = text;
  for (const s of Object.values(secrets)) out = out.split(s).join("<redacted>");
  return out;
}

/* ─────────────────────────── firewall ───────────────────────────────── */

/**
 * UpCloud's public firewall is STATELESS (upcloud.com/docs/products/networking/firewall),
 * so a default inbound drop also drops the replies to connections the box
 * opens. The box only ever dials out (apt, Hugging Face, Docker Hub, the
 * Cloudflare Tunnel on 7844), so inbound allows exactly those replies, by
 * source port, and drops everything else, SSH included. The host's own
 * nftables (cloud-init) is the stateful second layer: it drops anything that
 * isn't a reply even if it matches here.
 */
export function firewallRules() {
  const rules = [];
  for (const family of ["IPv4", "IPv6"]) {
    const reply = (protocol, port, comment) =>
      rules.push({
        direction: "in", action: "accept", family, protocol,
        source_port_start: String(port), source_port_end: String(port), comment,
      });
    reply("tcp", 443, "replies from HTTPS (apt, Hugging Face, registries, tunnel fallback)");
    reply("tcp", 80, "replies from HTTP (Ubuntu mirrors)");
    reply("tcp", 7844, "replies from Cloudflare Tunnel edge (http2)");
    reply("udp", 7844, "replies from Cloudflare Tunnel edge (quic)");
    reply("udp", 53, "DNS replies");
    reply("tcp", 53, "DNS replies over TCP");
    reply("udp", 123, "NTP replies");
    rules.push({ direction: "in", action: "accept", family, protocol: "icmp", comment: "ICMP (path MTU discovery)" });
  }
  rules.push({ direction: "in", action: "drop" });
  return rules;
}

/* ─────────────────────────── server body ────────────────────────────── */

export function serverCreateBody(c, userData, template) {
  return {
    server: {
      zone: c.zone,
      plan: c.plan,
      title: c.name,
      hostname: c.name,
      metadata: "yes",
      firewall: "on",
      user_data: userData,
      labels: { label: [{ key: LABEL_KEY, value: c.name }] },
      // No password, no SSH key: nothing can log in over the network. The
      // UpCloud console is the break-glass path.
      login_user: { create_password: "no" },
      storage_devices: {
        storage_device: [{
          action: "clone",
          storage: template,
          title: `${c.name}-disk`,
          size: c.storageGb,
          tier: c.storageTier,
        }],
      },
      networking: {
        interfaces: {
          interface: [
            { type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
            { type: "public", ip_addresses: { ip_address: [{ family: "IPv6" }] } },
          ],
        },
      },
    },
  };
}

/* ─────────────────────────── API client ─────────────────────────────── */

export class UpCloudError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "UpCloudError";
    this.status = status;
  }
}

export function createClient({ token, fetch: f = globalThis.fetch, apiBase = UPCLOUD_API_BASE, sleep } = {}) {
  if (!token) throw new Error("UPCLOUD_TOKEN is not set");
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function call(method, path, body) {
    const res = await f(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, json: safeJson(text) };
  }

  function ok(r, method, path) {
    if (r.status < 200 || r.status >= 300) {
      throw new UpCloudError(`UpCloud ${method} ${path} → HTTP ${r.status}: ${r.text.slice(0, 300)}`, r.status);
    }
    return r.json;
  }

  const client = {
    call,

    async resolveTemplate(c) {
      if (c.template) return c.template;
      const path = "/storage/template";
      const body = ok(await call("GET", path), "GET", path);
      const list = body?.storages?.storage ?? [];
      const want = c.templateTitle.toLowerCase();
      const exact = list.filter((s) => s.title === c.templateTitle);
      const hits = exact.length ? exact : list.filter((s) => String(s.title ?? "").toLowerCase().includes(want));
      if (hits.length === 0) throw new UpCloudError(`no public template matching "${c.templateTitle}"`, 404);
      if (hits.length > 1) {
        throw new UpCloudError(`templateTitle "${c.templateTitle}" matches ${hits.map((s) => `"${s.title}"`).join(", ")}; ` +
          `set config.template to one UUID`, 409);
      }
      return hits[0].uuid;
    },

    async findByName(name) {
      const path = `/server?label=${encodeURIComponent(`${LABEL_KEY}=${name}`)}`;
      const body = ok(await call("GET", path), "GET", "/server");
      const list = body?.servers?.server ?? [];
      return list.find((s) => s.title === name) ?? null;
    },

    async getServer(uuid) {
      const path = `/server/${encodeURIComponent(uuid)}`;
      const r = await call("GET", path);
      if (r.status === 404) return null;
      return ok(r, "GET", path)?.server ?? null;
    },

    async create(body) {
      const r = ok(await call("POST", "/server", body), "POST", "/server");
      if (typeof r?.server?.uuid !== "string") throw new UpCloudError("create response has no server.uuid", 0);
      return r.server;
    },

    async setFirewall(uuid, rules) {
      const path = `/server/${encodeURIComponent(uuid)}/firewall_rule`;
      ok(await call("PUT", path, { firewall_rules: { firewall_rule: rules } }), "PUT", path);
    },

    async start(uuid) {
      const path = `/server/${encodeURIComponent(uuid)}/start`;
      const r = await call("POST", path);
      if (r.status === 409) return; // already started / busy
      ok(r, "POST", path);
    },

    async stop(uuid, { hard = false } = {}) {
      const path = `/server/${encodeURIComponent(uuid)}/stop`;
      const r = await call("POST", path, { stop_server: { stop_type: hard ? "hard" : "soft", timeout: "120" } });
      if (r.status === 409) return;
      ok(r, "POST", path);
    },

    async waitForState(uuid, want, { attempts = 90, intervalMs = 5000 } = {}) {
      for (let i = 0; i < attempts; i += 1) {
        const s = await client.getServer(uuid);
        if (!s) return want === "gone" ? "gone" : null;
        if (s.state === want) return s.state;
        await wait(intervalMs);
      }
      throw new UpCloudError(`server ${uuid} did not reach "${want}" in time`, 0);
    },

    /** Stop, then delete the server with its disks and backups so nothing keeps billing. */
    async destroy(uuid) {
      const s = await client.getServer(uuid);
      if (!s) return;
      if (s.state !== "stopped") {
        await client.stop(uuid, { hard: true });
        await client.waitForState(uuid, "stopped", { attempts: 60, intervalMs: 2000 });
      }
      const path = `/server/${encodeURIComponent(uuid)}?storages=1&backups=delete`;
      const r = await call("DELETE", path);
      if (r.status === 404) return;
      ok(r, "DELETE", path);
    },
  };
  return client;
}

export function publicAddresses(server) {
  const out = [];
  for (const ip of server?.ip_addresses?.ip_address ?? []) {
    if (ip.access === "public" && typeof ip.address === "string") out.push(ip.address);
  }
  for (const iface of server?.networking?.interfaces?.interface ?? []) {
    if (iface.type !== "public") continue;
    for (const ip of iface.ip_addresses?.ip_address ?? []) {
      if (typeof ip.address === "string" && !out.includes(ip.address)) out.push(ip.address);
    }
  }
  return out;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
