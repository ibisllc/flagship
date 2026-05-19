/**
 * Reference `VpsProvider` adapter — Hetzner Cloud.
 *
 * WHY HETZNER: of the mainstream clouds it is the most custom-ISO
 * friendly with a clean, stable REST API and no SDK required. The flow
 * the live harness drives is exactly:
 *   1. POST /v1/servers                       — create the server
 *   2. POST /v1/servers/{id}/actions/attach_iso { iso: "<name|id>" }
 *   3. POST /v1/servers/{id}/actions/reset     — reboot into the ISO
 *   4. GET  /v1/servers/{id}                   — poll status=="running"
 *   5. DELETE /v1/servers/{id}                 — teardown (idempotent)
 * Auth is a single bearer token (`HCLOUD_TOKEN`). (Vultr's custom-ISO
 * path — POST /v2/iso then attach — is equivalent; Hetzner chosen for
 * the simpler action model.)
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE THIN REAL-I/O LAYER. It is authored + typechecked    │
 * │ but NOT executed by the test suite: a real run needs an          │
 * │ HCLOUD_TOKEN and incurs real cloud cost. The PURE helpers below  │
 * │ (URL/payload builders + response parsers) ARE unit-tested with   │
 * │ fixture payloads; only `HetznerProvider`'s `fetch` calls are     │
 * │ unexercised here.                                                │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * The harness passes `--iso` as an INPUT (path OR url OR a Hetzner ISO
 * name/id). Hetzner attaches ISOs *by name/id*, so the operator must
 * have uploaded the personalized ISO to their Hetzner account and pass
 * its name/id as `--iso`; uploading the ISO is out of scope for this
 * harness (the ISO is an input, not built/uploaded here). A path/url
 * form is rejected with an actionable message.
 *
 * No cloud SDK, no new dependency: `node:fetch` (global, Node ≥ 20).
 */

import type {
  ProvisionRequest,
  VpsInstance,
  VpsProvider,
} from "../ports.js";

const API = "https://api.hetzner.cloud/v1";

/* ───────────────────────── pure helpers (unit-tested) ──────────── */

/**
 * Build the create-server request body. The personalized ISO is
 * attached *after* create (Hetzner has no create-time ISO field), so
 * the server is created from a minimal placeholder image and we boot
 * into the ISO via attach + reset.
 */
export function buildCreateServerBody(
  req: ProvisionRequest,
  placeholderImage = "debian-12",
): Record<string, unknown> {
  return {
    name: sanitizeServerName(req.label),
    server_type: req.size,
    location: req.region,
    image: placeholderImage,
    start_after_create: false,
    labels: { "flagship-e2e": "1" },
  };
}

/** Hetzner server names: lowercase RFC-1035-ish, ≤63 chars. */
export function sanitizeServerName(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (s || "flagship-e2e").slice(0, 63);
}

/**
 * Resolve the `--iso` input to a Hetzner ISO selector. Hetzner
 * attaches ISOs by name or numeric id only — a local path / url cannot
 * be attached and is a fail-closed operator error here.
 */
export function resolveIsoSelector(iso: string): string {
  if (/^https?:\/\//i.test(iso) || iso.includes("/") || iso.endsWith(".iso")) {
    throw new Error(
      `Hetzner attaches ISOs by name/id, not by path/url. Upload the ` +
        `personalized ISO to your Hetzner account first and pass its ` +
        `name or id as --iso (got: ${iso}).`,
    );
  }
  return iso;
}

export function attachIsoBody(iso: string): Record<string, unknown> {
  return { iso: resolveIsoSelector(iso) };
}

/** Parse POST /servers → the new server id + public IPv4. */
export function parseCreateServerResponse(json: unknown): {
  id: string;
  ip: string;
} {
  const j = json as {
    server?: {
      id?: number | string;
      public_net?: { ipv4?: { ip?: string } };
    };
  };
  const id = j.server?.id;
  if (id === undefined || id === null) {
    throw new Error("Hetzner create-server response had no server.id");
  }
  const ip = j.server?.public_net?.ipv4?.ip ?? "";
  return { id: String(id), ip };
}

/** Parse GET /servers/{id} → whether the box is fully booted. */
export function parseServerStatus(json: unknown): {
  status: string;
  running: boolean;
  ip: string;
} {
  const j = json as {
    server?: { status?: string; public_net?: { ipv4?: { ip?: string } } };
  };
  const status = j.server?.status ?? "unknown";
  return {
    status,
    running: status === "running",
    ip: j.server?.public_net?.ipv4?.ip ?? "",
  };
}

/* ──────────────────────── the real-I/O adapter ─────────────────── */

export interface HetznerOptions {
  token: string;
  /** Defaults are sensible but the operator can override. */
  bootPollIntervalMs?: number;
  bootPollMaxAttempts?: number;
}

export class HetznerProvider implements VpsProvider {
  readonly name = "hetzner";
  private readonly token: string;
  private readonly pollMs: number;
  private readonly pollMax: number;

  constructor(opts: HetznerOptions) {
    if (!opts.token) {
      throw new Error("HetznerProvider requires a token (HCLOUD_TOKEN)");
    }
    this.token = opts.token;
    this.pollMs = opts.bootPollIntervalMs ?? 10_000;
    this.pollMax = opts.bootPollMaxAttempts ?? 60;
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Hetzner ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 240)}`,
      );
    }
    return text ? JSON.parse(text) : {};
  }

  async provision(req: ProvisionRequest): Promise<VpsInstance> {
    // Fail fast on a non-attachable ISO selector before spending money.
    resolveIsoSelector(req.iso);
    const created = parseCreateServerResponse(
      await this.api("POST", "/servers", buildCreateServerBody(req)),
    );
    await this.api(
      "POST",
      `/servers/${created.id}/actions/attach_iso`,
      attachIsoBody(req.iso),
    );
    await this.api("POST", `/servers/${created.id}/actions/poweron`);
    await this.api("POST", `/servers/${created.id}/actions/reset`);
    return { id: created.id, ip: created.ip };
  }

  async awaitBoot(id: string): Promise<void> {
    for (let i = 0; i < this.pollMax; i++) {
      const s = parseServerStatus(await this.api("GET", `/servers/${id}`));
      if (s.running) return;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    throw new Error(
      `Hetzner server ${id} did not reach status=running within ` +
        `${this.pollMax} polls`,
    );
  }

  async destroy(id: string): Promise<void> {
    try {
      await this.api("DELETE", `/servers/${id}`);
    } catch (e) {
      // Idempotent: a 404 (already gone) is success. Re-throw anything
      // else so the core records a real teardown failure.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("HTTP 404")) throw e;
    }
  }
}
