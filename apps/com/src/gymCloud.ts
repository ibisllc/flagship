/**
 * Gym-only cloud teardown (docs/runbooks/gym-test-env.md). Every server the
 * gym Worker creates carries the `UPCLOUD_EXTRA_LABELS` label (e.g.
 * `flagship-env=gym`), so the live drivers can reap exactly the gym's own
 * servers through the Worker without holding a cloud token, and a sweep can
 * never touch a prod demo on the same provider account.
 */

import type { UpCloudLabeledServer } from "./upcloud.js";

export interface GymCloudClient {
  listServersByLabel(key: string, value: string): Promise<UpCloudLabeledServer[]>;
  getServerLabels(serverId: string): Promise<Record<string, string> | null>;
  destroyServer(serverId: string): Promise<void>;
}

export interface GymTeardownDeps {
  cloud: GymCloudClient;
  /** The env label every gym server carries; teardown refuses anything else. */
  label: { key: string; value: string };
  /** Deletes A/AAAA records for one name (CloudflareDnsClient.deleteByName). */
  deleteDns?: (name: string, type: string) => Promise<number>;
  /** The services apex; only names under it are ever deleted. */
  servicesApex: string;
}

export interface GymTeardownBody {
  serverIds?: unknown;
  all?: unknown;
  dryRun?: unknown;
  serverDomains?: unknown;
}

export interface GymTeardownResult {
  status: number;
  body: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export async function handleGymTeardown(
  deps: GymTeardownDeps,
  body: GymTeardownBody | undefined,
): Promise<GymTeardownResult> {
  const all = body?.all === true;
  const dryRun = body?.dryRun === true;
  const ids = Array.isArray(body?.serverIds) ? body!.serverIds : [];
  if (!ids.every((v): v is string => typeof v === "string" && UUID_RE.test(v))) {
    return { status: 400, body: { error: "serverIds must be UpCloud server UUIDs" } };
  }
  const domains = Array.isArray(body?.serverDomains) ? body!.serverDomains : [];
  const apex = deps.servicesApex.toLowerCase();
  for (const d of domains) {
    if (typeof d !== "string") return { status: 400, body: { error: "serverDomains must be strings" } };
    const lower = d.toLowerCase();
    if (!lower.endsWith(`.${apex}`)) {
      return { status: 400, body: { error: `serverDomain ${d} is not under ${apex}` } };
    }
    const labels = lower.slice(0, -(apex.length + 1)).split(".");
    if (labels.length !== 2 || !labels.every((l) => DNS_LABEL_RE.test(l))) {
      return { status: 400, body: { error: `serverDomain ${d} must be <server>.<user>.${apex}` } };
    }
  }

  const listed = await deps.cloud.listServersByLabel(deps.label.key, deps.label.value);
  const targets: Array<{ serverId: string; title: string }> = [];
  const refused: string[] = [];
  if (all) targets.push(...listed.map((s) => ({ serverId: s.serverId, title: s.title })));
  for (const id of ids as string[]) {
    if (targets.some((t) => t.serverId === id)) continue;
    const known = listed.find((s) => s.serverId === id);
    if (known) {
      targets.push({ serverId: id, title: known.title });
      continue;
    }
    const labels = await deps.cloud.getServerLabels(id);
    if (labels === null) continue;
    if (labels[deps.label.key] !== deps.label.value) {
      refused.push(id);
      continue;
    }
    targets.push({ serverId: id, title: "" });
  }

  if (dryRun) {
    return {
      status: 200,
      body: { dryRun: true, servers: listed, wouldDestroy: targets, refused },
    };
  }

  const destroyed: string[] = [];
  const failed: Array<{ serverId: string; error: string }> = [];
  await Promise.all(
    targets.map(async (t) => {
      try {
        await deps.cloud.destroyServer(t.serverId);
        destroyed.push(t.serverId);
      } catch (e) {
        failed.push({ serverId: t.serverId, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
      }
    }),
  );

  let dnsDeleted = 0;
  const dnsFailed: string[] = [];
  if (deps.deleteDns) {
    for (const d of domains as string[]) {
      for (const name of [d.toLowerCase(), `*.${d.toLowerCase()}`]) {
        for (const type of ["A", "AAAA"]) {
          try {
            dnsDeleted += await deps.deleteDns(name, type);
          } catch {
            dnsFailed.push(`${type} ${name}`);
          }
        }
      }
    }
  }

  const status = failed.length || dnsFailed.length ? 502 : 200;
  return { status, body: { destroyed, failed, refused, dnsDeleted, dnsFailed } };
}
