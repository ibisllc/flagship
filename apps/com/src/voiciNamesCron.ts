// The daily upkeep of custom voi.ci names (docs/named-links.md), one small
// window of names per cron tick (cronPlan.ts). The pure rules live in
// control-plane/voiciNames.ts; this only supplies "does a server of the account
// run this app right now" from the boxes' own heartbeats, and writes what
// happened to the account's Activity.

import { parseServiceId } from "@flagship/protocol";
import { D1Storage } from "@flagship/storage";
import { recordAuditEvent, runVoiciNamesMaintenance } from "@flagship/control-plane";

/** Live names looked at per tick. A window that wraps covers every name in turn. */
export const VOICI_NAMES_PER_TICK = 10;

/** A box whose last report is older than this isn't "running" anything. */
const REPORT_FRESH_MS = 2 * 86_400_000;

export interface VoiciNamesCronEnv {
  DB?: ConstructorParameters<typeof D1Storage>[0];
}

export async function runVoiciNamesCron(
  env: VoiciNamesCronEnv,
  now: Date,
  window: { start: number; count: number },
): Promise<void> {
  if (!env.DB) return;
  const storage = new D1Storage(env.DB);
  const nowMs = now.getTime();

  // The heartbeat is a snapshot, so "idle for 60 days" is built up by this job
  // seeing the app NOT running day after day. A box too old to say what it runs
  // counts as running everything, as everywhere else (appHome).
  const running = async (username: string, serviceId: string): Promise<boolean> => {
    const slug = parseServiceId(serviceId)?.slug ?? serviceId;
    for (const server of await storage.servers.listForUser(username)) {
      if (server.revokedAt) continue;
      const row = await storage.daemonStatus.get(server.serverDomain).catch(() => undefined);
      if (!row || nowMs - (row.lastReported ?? 0) > REPORT_FRESH_MS) continue;
      try {
        const report = row.reportJson ? (JSON.parse(row.reportJson) as { runsServices?: unknown }) : {};
        if (!Array.isArray(report.runsServices)) return true;
        if (report.runsServices.includes(slug)) return true;
      } catch {
        /* a corrupt row says nothing */
      }
    }
    return false;
  };

  await runVoiciNamesMaintenance(
    { voiciNames: storage.voiciNames, now: () => nowMs },
    running,
    { offset: window.start, count: window.count },
    {
      notify: async (e) => {
        await recordAuditEvent(
          { auditEvents: storage.auditEvents },
          {
            username: e.username,
            eventKind: e.kind === "released" ? "voici-name-released" : "voici-name-warning",
            detail: `${e.name}|${e.releasesAt}`,
            devicePrefix: "",
            postedAt: nowMs,
          },
        );
      },
    },
  );
}
