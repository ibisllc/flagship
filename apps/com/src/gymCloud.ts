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
  /** The services zone's records (CloudflareDnsClient.listAll / deleteById). */
  dns?: {
    listAll(): Promise<Array<{ id: string; name: string; type: string }>>;
    deleteById(id: string): Promise<boolean>;
  };
  /** The services apex; only names under it are ever deleted. */
  servicesApex: string;
  /** Waits before a retry (tests pass a no-op). */
  pause?: (ms: number) => Promise<void>;
}

export interface GymTeardownBody {
  serverIds?: unknown;
  all?: unknown;
  dryRun?: unknown;
  serverDomains?: unknown;
  /** Gym usernames whose whole user zone (`<user>.<apex>` and below) is reaped. */
  usernames?: unknown;
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

  const usernames = Array.isArray(body?.usernames) ? body!.usernames : [];
  if (!usernames.every((u): u is string => typeof u === "string" && DNS_LABEL_RE.test(u))) {
    return { status: 400, body: { error: "usernames must be DNS labels" } };
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

  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const destroyed: string[] = [];
  const failed: Array<{ serverId: string; error: string }> = [];
  // The provider refuses some calls when many land at once (UpCloud answers
  // 401 AUTHENTICATION_FAILED under load), so a failed destroy is tried
  // twice more, a few seconds apart, before it is reported.
  await Promise.all(
    (dryRun ? [] : targets).map(async (t) => {
      for (let attempt = 1; ; attempt++) {
        try {
          await deps.cloud.destroyServer(t.serverId);
          destroyed.push(t.serverId);
          return;
        } catch (e) {
          if (attempt >= 3) {
            failed.push({ serverId: t.serverId, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
            return;
          }
          await pause(3000 * attempt);
        }
      }
    }),
  );

  // DNS: the named boxes' records, the named users' whole zones, and with
  // `all` every record under the gym apex except the apex and its wildcard.
  // The zone is shared with prod and capped (200 records on this plan), so a
  // gym run must leave nothing behind.
  let dnsDeleted = 0;
  /** A dry run names what it would delete, so a live check can look at an account's record set. */
  const dnsRecords: Array<{ type: string; name: string }> = [];
  const dnsFailed: string[] = [];
  /** Every record in the zone (prod's too): the zone has a record cap gym and prod share. */
  let zoneRecords: number | null = null;
  if (deps.dns && (all || domains.length || usernames.length)) {
    const zones = (usernames as string[]).map((u) => `${u.toLowerCase()}.${apex}`);
    const boxes = (domains as string[]).map((d) => d.toLowerCase());
    const doomed = (name: string): boolean => {
      const n = name.toLowerCase();
      if (all && n.endsWith(`.${apex}`) && n !== `*.${apex}`) return true;
      if (boxes.some((d) => n === d || n.endsWith(`.${d}`))) return true;
      return zones.some((z) => n === z || n.endsWith(`.${z}`));
    };
    let records: Array<{ id: string; name: string; type: string }> = [];
    try {
      records = await deps.dns.listAll();
    } catch {
      dnsFailed.push("list");
    }
    zoneRecords = records.length;
    const retry: Array<{ id: string; name: string; type: string }> = [];
    for (const r of records.filter((x) => doomed(x.name))) {
      if (dryRun) {
        dnsDeleted += 1;
        dnsRecords.push({ type: r.type, name: r.name });
        continue;
      }
      try {
        if (await deps.dns.deleteById(r.id)) dnsDeleted += 1;
      } catch {
        retry.push(r);
      }
    }
    if (retry.length) await pause(2000);
    for (const r of retry) {
      try {
        if (await deps.dns.deleteById(r.id)) dnsDeleted += 1;
      } catch {
        dnsFailed.push(`${r.type} ${r.name}`);
      }
    }
  }

  if (dryRun) {
    return { status: 200, body: { dryRun: true, servers: listed, wouldDestroy: targets, refused, dnsWouldDelete: dnsDeleted, dnsRecords, zoneRecords } };
  }
  const status = failed.length || dnsFailed.length ? 502 : 200;
  return { status, body: { destroyed, failed, refused, dnsDeleted, dnsFailed, zoneRecords } };
}
