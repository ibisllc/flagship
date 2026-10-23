// Helpers the 0.3 groups share: removing an app, approving an app's egress to a host, reading a box's
// daemon journal, and waiting on a condition.
import { bytesToHex } from "@noble/hashes/utils";
import {
  accessListSha256,
  normalizeAccessList,
  signAppAccessGrant,
  signJournalRequest,
  signUninstallService,
  withRule,
  type AppAccessGrant,
  type JournalRequest,
  type UninstallServiceRequest,
} from "@flagship/protocol";
import type { Account, Box } from "../../lib/fleet.js";
import { assert, http, postJson, short, sleep, tryHttp } from "../../lib/harness.js";

export async function uninstall(acct: Account, box: Box, slug: string): Promise<void> {
  const req: UninstallServiceRequest = { serverId: box.fqdn, creator: acct.username, slug, issuedAt: Date.now() };
  await tryHttp(`https://${box.fqdn}/api/services/${encodeURIComponent(`${acct.username}--${slug}`)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: req, signature: bytesToHex(signUninstallService(req, acct.keys.adminRoot)) }),
  });
}

/** The owner's admin-root-signed access list for `serviceId`, with `host` allowed. */
export async function allowEgress(acct: Account, box: Box, session: string, serviceId: string, host: string): Promise<void> {
  const s = { "x-flagship-session": session };
  const url = `https://${box.fqdn}/api/screens/services/${encodeURIComponent(serviceId)}/access`;
  const cur = await http(url, { headers: s });
  const list = withRule(normalizeAccessList(String(cur.json?.list ?? cur.json?.access?.list ?? "")), "allow", host);
  const grant: AppAccessGrant = { serverDomain: box.fqdn, serviceId, listSha256: accessListSha256(list), issuedAt: Date.now() };
  const r = await postJson(url, { list, grant, signature: bytesToHex(signAppAccessGrant(grant, acct.keys.adminRoot)) }, s);
  assert(r.status === 200, `access list ${r.status}: ${short(r.text)}`);
}

/** The box's daemon journal lines, read with the owner IRK. */
export async function journal(acct: Account, box: Box, lines = 3000): Promise<string[]> {
  const req: JournalRequest = { serverId: box.fqdn, unit: "flagship-daemon", lines, issuedAt: Date.now() };
  const r = await postJson(`https://${box.fqdn}/api/journal`, { request: req, signature: bytesToHex(signJournalRequest(req, acct.keys.irk)) });
  assert(r.status === 200, `journal ${r.status}: ${short(r.text)}`);
  return (r.json?.lines ?? r.json?.log ?? []) as string[];
}

/** Polls `fn` until it returns a value (not undefined) or the time runs out. */
export async function until<T>(what: string, ms: number, fn: () => Promise<T | undefined>, everyMs = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await sleep(everyMs);
  }
  throw new Error(`${what} not within ${Math.round(ms / 1000)} s${lastErr ? ` (last: ${short(lastErr, 120)})` : ""}`);
}
