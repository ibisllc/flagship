/**
 * OPS-3 follow-up — the operator pager for the CA-endorsement lease
 * warning. `runCaLeaseWarningCheck` (packages/control-plane/src/
 * caLeaseWarning.ts) already emits an audit event + console.error on
 * every warn/expired tick; this wires its `notifyOperator` hook to file
 * (or leave alone, if one is already open) a GitHub issue on the repo,
 * so the next lapse pages a human instead of relying on someone to poll
 * `/api/admin/ca-lease-status`.
 *
 * Dedup: the control-plane check has no built-in cadence limit — it
 * calls `notifyOperator` on every 6-hourly tick for the whole ~7-day
 * warn window. We search for an existing OPEN issue with the exact
 * marker title first and no-op if found, so the ceremony gets ONE
 * issue per lapse episode, not ~28.
 */

import type { CaLeaseStatus } from "@flagship/control-plane";

export const CA_LEASE_ISSUE_TITLE =
  "CA-endorsement lease lapsing — run the YubiKey renewal ceremony (Operation 1, docs/ca-operations.md)";

const GITHUB_API = "https://api.github.com";

export interface GithubIssueNotifierDeps {
  token: string;
  repo: string; // "owner/name"
  fetchImpl?: typeof fetch;
}

/**
 * `notifyOperator` implementation for `CaLeaseCheckDeps`. Best-effort —
 * the caller (`runCaLeaseWarningCheck`) already swallows a throw so the
 * audit write is never blocked by a GitHub outage, but we still throw on
 * failure so it's visible in the Worker's own logs.
 */
export async function notifyCaLeaseViaGithubIssue(
  status: CaLeaseStatus,
  message: string,
  deps: GithubIssueNotifierDeps,
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${deps.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "flagship-com-worker",
    "Content-Type": "application/json",
  };

  const query = `repo:${deps.repo} is:issue is:open in:title "${CA_LEASE_ISSUE_TITLE}"`;
  const searchRes = await f(
    `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}`,
    { headers },
  );
  if (!searchRes.ok) {
    throw new Error(`ca-lease github search failed: ${searchRes.status} ${await searchRes.text()}`);
  }
  const searchJson = (await searchRes.json()) as { total_count: number };
  if (searchJson.total_count > 0) {
    // Already paged for this episode — don't spam a new issue every tick.
    return;
  }

  const body = [
    message,
    "",
    `Severity: **${status.severity}**`,
    status.soonestNotAfterMs
      ? `Soonest active lease notAfter: ${new Date(status.soonestNotAfterMs).toISOString()}`
      : "No active lease at all.",
    "",
    "Live status: `GET /api/admin/ca-lease-status` (needs `x-admin-secret`).",
    "Renewal runbook: `docs/ca-operations.md` — Operation 1 (issue/renew a CA lease).",
    "If the ca-track MANDATE itself has also expired (not just the lease), Operation 1 alone won't fix it — see \"upsert-mandate\" in the same doc.",
  ].join("\n");

  const createRes = await f(`${GITHUB_API}/repos/${deps.repo}/issues`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: CA_LEASE_ISSUE_TITLE, body }),
  });
  if (!createRes.ok) {
    throw new Error(`ca-lease github issue create failed: ${createRes.status} ${await createRes.text()}`);
  }
}
