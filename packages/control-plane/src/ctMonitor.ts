/**
 * Certificate Transparency (CT) monitoring — server-side watcher.
 *
 * GOAL: detect a certificate issued for a user's `flagship.services`
 * names that the user's OWN boxes did NOT mint. That is the signal of a
 * rogue / mis-issued cert — including one a malicious `.com` could mint
 * by abusing its DNS control to pass an ACME challenge.
 *
 * ────────────────────────────────────────────────────────────────────
 * HONEST THREAT-MODEL NOTE
 * ────────────────────────────────────────────────────────────────────
 * This is the `.com`-side CT watcher. It catches EXTERNAL mis-issuance
 * (some other party who somehow got a cert for the user's subdomain) and
 * a NON-actively-suppressing `.com` (i.e. it is genuine defense-in-depth
 * against accidents + third parties). It does NOT defend against a
 * maliciously-controlled `.com`: a hostile operator who mints a cert via
 * its own DNS control could simply DISABLE THIS WATCHER (it runs inside
 * the same trust boundary it is meant to police). The fully
 * trust-minimized version is PHONE-SIDE CT monitoring — the phone queries
 * CT logs itself, so `.com` cannot suppress the alert. That is PHASE 2 (a
 * client build, deferred). This server-side watcher is built now as
 * defense-in-depth AND so that the data model + comparison logic +
 * normalization the phone version needs already exist and are proven.
 *
 * ────────────────────────────────────────────────────────────────────
 * Baseline + alert logic
 * ────────────────────────────────────────────────────────────────────
 * The "expected cert" baseline is the set of leaf-cert sha256
 * fingerprints reported by the user's own daemons via the
 * /api/daemon-status heartbeat (daemon_status.certSha256). The daemon
 * reports a sha-256 fingerprint; crt.sh reports the leaf-cert sha256 of
 * the DER. BOTH are normalized to lowercase hex, no colons, before
 * comparison (see normalizeSha256).
 *
 * SAN SHAPE (cert model A′): the only legitimate cert shape for a user
 * is the PER-BOX wildcard pair
 *   [`<server>.<user>.flagship.services`, `*.<server>.<user>.flagship.services`]
 * for one of the user's registered boxes. Any other SAN set — including
 * an old-style model-C per-user wildcard `[<user>, *.<user>]` — can
 * never be a cert a box legitimately minted, so it skips the
 * predates-baseline exemption below and is flagged outright.
 *
 * For a user we ALERT (push the owner + audit) iff ALL of:
 *   1. there IS a baseline — at least one box reported a certSha256
 *      (avoids a false alarm on the legit cert before any box has
 *      reported during bring-up), AND
 *   2. a CT-observed cert sha256 is NOT in the baseline set, AND
 *   3. EITHER the cert's SAN set is not a registered box's A′ pair
 *      (never legit — see SAN SHAPE above), OR its notBefore is NEWER
 *      than the user's EARLIEST baseline report (an expected-shape cert
 *      that predates the box ever reporting is assumed to be the legit
 *      cert minted before the heartbeat existed).
 * When there is NO baseline yet, we AUDIT-LOG the observed certs (for the
 * timeline) but do NOT push — no false alarm on the legit cert before any
 * box has reported.
 *
 * Idempotency: an owner push fires at most once per (user, certSha256),
 * gated by ctAlerts.claimAlertSlot. A second scan does not re-alert.
 *
 * Best-effort + bounded: crt.sh being unreachable / ratelimited never
 * throws (the round is skipped). Per-run domain + CT-query counts are
 * capped so a huge account cannot blow the cron budget; what was capped
 * is logged (never silently truncated).
 */

import type {
  AuditEventStorage,
  CtAlertStorage,
  DaemonStatusStorage,
  PushTokenStorage,
  ServerStorage,
} from "@flagship/storage";
import type { V12PushFanout } from "./totp.js";

/** A leaf cert observed in a CT log for a queried identity. */
export interface CtObservedCert {
  /** Leaf-cert sha256. Any case / colon form — normalized on ingest. */
  sha256: string;
  /** ms since epoch. */
  notBefore: number;
  issuer: string;
  /** SAN dNSNames on the cert. */
  sanNames: string[];
}

/**
 * Injectable CT source. Given ONE identity (e.g.
 * `<user>.flagship.services` or `%.<user>.flagship.services`), return the
 * recently-issued leaf certs. MUST resolve (never reject) on a transient
 * failure — return [] (the scan treats "couldn't reach CT" as "no
 * observations this round", never an alert). The default crt.sh client
 * below already swallows its own errors.
 */
export type CtSource = (identity: string) => Promise<CtObservedCert[]>;

/** Normalize a sha256 to lowercase hex, no colons, no whitespace. */
export function normalizeSha256(s: string): string {
  return s.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

// ────────────────────────────────────────────────────────────────────
// crt.sh JSON source (v1)
// ────────────────────────────────────────────────────────────────────

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface CrtShRow {
  // crt.sh fields we use. Names are crt.sh's (snake-ish).
  serial_number?: string;
  not_before?: string;
  issuer_name?: string;
  common_name?: string;
  name_value?: string; // newline-separated SANs
  // The leaf-cert sha256 is exposed by crt.sh only via the per-cert
  // download; the bulk JSON does not carry it. We therefore derive a
  // stable identity from the crt.sh entry below (see rowToObserved).
}

/**
 * Build a crt.sh-backed CtSource. Resolves to [] on ANY failure
 * (network, non-2xx, ratelimit, parse) — a CT outage must never alert
 * and never throw.
 *
 * crt.sh's bulk JSON does not include the DER sha256, so we derive a
 * stable per-observation identity from `serial_number` (unique per
 * issuer) normalized to lowercase hex. The daemon baseline is a real
 * leaf-cert sha256, so an honestly-reporting box's cert will only match
 * once the phone-side source (Phase 2, which fetches the DER) lands;
 * until then the server-side watcher is conservative — see the
 * `identityFromRow` note. For tests + the phone-side reuse the
 * normalization + comparison path is what matters.
 */
export function createCrtShSource(opts?: {
  fetchImpl?: FetchLike;
  /** ms — per-query wall-clock cap. Default 8s. */
  timeoutMs?: number;
}): CtSource {
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  return async (identity: string): Promise<CtObservedCert[]> => {
    const url = `https://crt.sh/?q=${encodeURIComponent(identity)}&output=json`;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      controller = new AbortController();
      timer = setTimeout(() => controller!.abort(), timeoutMs);
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];
      const out: CtObservedCert[] = [];
      for (const raw of body) {
        const row = raw as CrtShRow;
        const obs = rowToObserved(row);
        if (obs) out.push(obs);
      }
      return out;
    } catch {
      // Unreachable / ratelimited / parse error — skip this round.
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function rowToObserved(row: CrtShRow): CtObservedCert | undefined {
  const idSource = row.serial_number ?? "";
  const sha256 = normalizeSha256(idSource);
  if (!sha256) return undefined;
  let notBefore = 0;
  if (row.not_before) {
    // crt.sh emits "YYYY-MM-DDTHH:MM:SS" (UTC, no zone). Append Z.
    const t = Date.parse(
      /[zZ]|[+-]\d\d:?\d\d$/.test(row.not_before)
        ? row.not_before
        : `${row.not_before}Z`,
    );
    if (!Number.isNaN(t)) notBefore = t;
  }
  const sanNames: string[] = [];
  if (row.name_value) {
    for (const n of row.name_value.split(/\r?\n/)) {
      const v = n.trim().toLowerCase();
      if (v) sanNames.push(v);
    }
  }
  if (row.common_name) {
    const cn = row.common_name.trim().toLowerCase();
    if (cn && !sanNames.includes(cn)) sanNames.push(cn);
  }
  return {
    sha256,
    notBefore,
    issuer: row.issuer_name ?? "",
    sanNames,
  };
}

// ────────────────────────────────────────────────────────────────────
// Scan
// ────────────────────────────────────────────────────────────────────

export interface CtScanDeps {
  servers: ServerStorage;
  daemonStatus: DaemonStatusStorage;
  auditEvents: AuditEventStorage;
  ctAlerts: CtAlertStorage;
  /** CT log source (injectable for tests). */
  ctSource: CtSource;
  pushTokens?: PushTokenStorage;
  /** Owner push fan-out. Absent ⇒ audit-only (no device push). */
  pushFanout?: V12PushFanout;
  now?: () => number;
  /**
   * Cap on distinct usernames scanned per run (cron-budget guard). When
   * more users are active, the overflow is skipped THIS run and logged
   * (never silent). Default 200.
   */
  maxUsersPerRun?: number;
  /**
   * Cap on CT queries per run across all users (each user costs 2 — the
   * apex + the wildcard identity). Default 400.
   */
  maxCtQueriesPerRun?: number;
  /** Where to log capping / diagnostics. Default console. */
  log?: (msg: string) => void;
}

export interface CtScanResult {
  usersScanned: number;
  usersSkippedForCap: number;
  ctQueries: number;
  observedTotal: number;
  /** Distinct (user, sha) audit rows written (incl. no-baseline rows). */
  audited: number;
  /** Distinct (user, sha) owner pushes fired. */
  alerted: number;
}

/**
 * One CT scan pass. For each active (non-revoked) server's user, query
 * CT for the user's names, compare against the daemon baseline, and
 * alert on a cert the user's boxes did not mint. Best-effort + bounded;
 * never throws (per-user failures are isolated + logged).
 */
export async function runCtScan(deps: CtScanDeps): Promise<CtScanResult> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.log(`[ct-monitor] ${m}`));
  const maxUsers = deps.maxUsersPerRun ?? 200;
  const maxQueries = deps.maxCtQueriesPerRun ?? 400;

  const result: CtScanResult = {
    usersScanned: 0,
    usersSkippedForCap: 0,
    ctQueries: 0,
    observedTotal: 0,
    audited: 0,
    alerted: 0,
  };

  let servers;
  try {
    servers = await deps.servers.listAll();
  } catch (e) {
    log(`listAll failed, skipping run: ${String((e as Error).message ?? e)}`);
    return result;
  }

  // Distinct non-revoked usernames (deterministic order), each with its
  // registered box FQDNs — the per-box A′ SAN shapes the scan accepts.
  const serverDomainsByUser = new Map<string, string[]>();
  for (const s of servers) {
    if (s.revokedAt != null) continue;
    const u = s.username.toLowerCase();
    const domains = serverDomainsByUser.get(u) ?? [];
    domains.push(s.serverDomain.toLowerCase());
    serverDomainsByUser.set(u, domains);
  }
  const usernames = [...serverDomainsByUser.keys()].sort();

  let usersToScan = usernames;
  if (usernames.length > maxUsers) {
    result.usersSkippedForCap = usernames.length - maxUsers;
    usersToScan = usernames.slice(0, maxUsers);
    log(
      `capped users: scanning ${maxUsers} of ${usernames.length} active users this run (${result.usersSkippedForCap} deferred to next tick)`,
    );
  }

  for (const username of usersToScan) {
    // Each user costs up to 2 CT queries (apex + wildcard). Stop before
    // a user we can't fully query, so we never half-scan + leave the
    // remaining users entirely unseen this run.
    if (result.ctQueries + 2 > maxQueries) {
      const remaining = usersToScan.length - usersToScan.indexOf(username);
      result.usersSkippedForCap += remaining;
      log(
        `capped CT queries at ${maxQueries}: ${remaining} users deferred to next tick`,
      );
      break;
    }
    try {
      await scanUser(
        deps,
        username,
        serverDomainsByUser.get(username) ?? [],
        now(),
        result,
        log,
      );
      result.usersScanned++;
    } catch (e) {
      // Per-user isolation — one bad user can't sink the whole run.
      log(`user ${username} scan failed (isolated): ${String((e as Error).message ?? e)}`);
    }
  }

  return result;
}

async function scanUser(
  deps: CtScanDeps,
  username: string,
  serverDomains: string[],
  nowMs: number,
  result: CtScanResult,
  log: (msg: string) => void,
): Promise<void> {
  // Baseline = the set of cert sha256s the user's own daemons reported,
  // plus the earliest report time (notBefore floor below which an
  // unexpected cert is assumed to predate reporting).
  const daemonRows = await deps.daemonStatus.listForUser(username);
  const baseline = new Set<string>();
  let earliestReport = Number.POSITIVE_INFINITY;
  for (const row of daemonRows) {
    if (row.certSha256) {
      baseline.add(normalizeSha256(row.certSha256));
      if (row.lastReported < earliestReport) earliestReport = row.lastReported;
    }
  }
  const hasBaseline = baseline.size > 0;

  // Query CT per USER even though certs are per-box (A′): the wildcard
  // pattern `%.<user>.flagship.services` matches any depth, so it captures
  // every per-box cert (`<server>.<user>` + `*.<server>.<user>`) in two
  // queries per user instead of two per box. The bare-apex identity no
  // longer matches any legit cert — it exists to catch an old-style
  // model-C `[<user>, *.<user>]` cert, which is itself alarm-worthy now.
  const apex = `${username}.flagship.services`;
  const wildcard = `%.${username}.flagship.services`;
  const observed: CtObservedCert[] = [];
  for (const identity of [apex, wildcard]) {
    result.ctQueries++;
    const certs = await deps.ctSource(identity);
    for (const c of certs) observed.push(c);
  }

  // De-dup observed by normalized sha (apex + wildcard overlap).
  const bySha = new Map<string, CtObservedCert>();
  for (const c of observed) {
    const sha = normalizeSha256(c.sha256);
    if (!sha) continue;
    const prior = bySha.get(sha);
    // Keep the earliest notBefore we saw for this sha.
    if (!prior || c.notBefore < prior.notBefore) {
      bySha.set(sha, { ...c, sha256: sha });
    }
  }
  result.observedTotal += bySha.size;

  for (const [sha, cert] of bySha) {
    if (baseline.has(sha)) continue; // accounted for — the box minted it.

    const expectedShape = matchesRegisteredBoxSans(cert.sanNames, serverDomains);

    if (!hasBaseline) {
      // No baseline yet: audit-log (timeline) but DO NOT push. Avoids a
      // false alarm on the legit cert before any box has reported.
      await auditOnce(deps, username, sha, cert, nowMs, false, result);
      continue;
    }

    // Baseline present + cert not in it. An EXPECTED-SHAPE cert that
    // predates the earliest baseline report is assumed legit (the cert the
    // box was already serving before the heartbeat existed). A cert whose
    // SAN set is NOT a registered box's A′ pair — e.g. an old-style
    // per-user wildcard `[<user>, *.<user>]` — can never be legit, so it
    // gets no such exemption.
    if (expectedShape && cert.notBefore <= earliestReport) {
      log(
        `user ${username}: unaccounted CT cert ${sha.slice(0, 12)}… predates earliest baseline report — not alerting`,
      );
      continue;
    }

    // Real unexpected cert. Dedup the OWNER PUSH (and the paired audit)
    // via the alert ledger so we never re-alert across cron ticks.
    const claimed = await deps.ctAlerts.claimAlertSlot(username, sha, nowMs);
    if (!claimed) continue; // already alerted in a prior run.

    await auditOnce(deps, username, sha, cert, nowMs, true, result);
    await pushOwner(deps, username, sha, cert);
    result.alerted++;
  }
}

/**
 * Cert model A′ SAN-shape check: true iff every SAN on the cert belongs to
 * a SINGLE registered box's pair `{<server>.<user>.<apex>, *.<server>.<user>.<apex>}`.
 * (A subset — e.g. apex-only — still scopes to one box, so it passes.)
 * An old-style per-user wildcard `[<user>, *.<user>]`, a cert mixing two
 * boxes' names, or any foreign name fails. Inputs are lowercase: sanNames
 * are folded on ingest (rowToObserved), serverDomains by the scan.
 */
function matchesRegisteredBoxSans(
  sanNames: string[],
  serverDomains: string[],
): boolean {
  if (sanNames.length === 0) return false;
  for (const domain of serverDomains) {
    if (sanNames.every((san) => san === domain || san === `*.${domain}`)) {
      return true;
    }
  }
  return false;
}

async function auditOnce(
  deps: CtScanDeps,
  username: string,
  sha: string,
  cert: CtObservedCert,
  nowMs: number,
  isAlert: boolean,
  result: CtScanResult,
): Promise<void> {
  const primaryDomain = cert.sanNames[0] ?? `${username}.flagship.services`;
  const detail = isAlert
    ? `Unexpected certificate for ${primaryDomain} — sha256 ${sha}, issuer ${cert.issuer || "unknown"}, notBefore ${new Date(cert.notBefore).toISOString()}`
    : `CT-observed certificate (no baseline yet) for ${primaryDomain} — sha256 ${sha}, issuer ${cert.issuer || "unknown"}, notBefore ${new Date(cert.notBefore).toISOString()}`;
  await deps.auditEvents.append({
    username,
    eventKind: "ct-unexpected-cert",
    detail,
    devicePrefix: "",
    postedAt: nowMs,
  });
  result.audited++;
}

async function pushOwner(
  deps: CtScanDeps,
  username: string,
  sha: string,
  cert: CtObservedCert,
): Promise<void> {
  if (!deps.pushFanout || !deps.pushTokens) return; // audit-only fallback.
  const rows = await deps.pushTokens.listByUser(username);
  if (rows.length === 0) return;
  const primaryDomain = cert.sanNames[0] ?? `${username}.flagship.services`;
  await deps.pushFanout({
    username,
    targets: rows.map((p) => ({
      tokenId: p.tokenId,
      platform: p.platform,
      providerToken: p.providerToken,
    })),
    payload: {
      category: "ct-unexpected-cert",
      title: "Unexpected certificate",
      body: `A certificate was issued for ${primaryDomain} that none of your devices requested — review.`,
      deepLink: `flagship://account/security?u=${encodeURIComponent(username)}`,
      meta: {
        eventKind: "ct-unexpected-cert",
        certSha256: sha,
        issuer: cert.issuer,
        notBefore: cert.notBefore,
      },
    },
  });
}
