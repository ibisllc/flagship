/**
 * `.com`'s side of the private relay (docs/outbound-proxy.md §OHTTP): the
 * published gateway keys, the gateway itself, the probe target, counting how
 * proxy boxes' setup calls arrive, the /status/ signal, and the daily probe
 * with its operator page.
 */
import {
  handleOhttpGateway,
  ohttpGatewayKeysFromEnv,
  ohttpKeysResponse,
  OHTTP_GATEWAY_PATH,
  OHTTP_KEYS_PATH,
  OHTTP_PROBE_PATH,
  privateRelayStatus,
  runRelayProbe,
  utcDay,
  type PrivateRelayStatus,
} from "@flagship/control-plane";
import { encodeOhttpKeyConfig, ohttpRelayFrom, RELAY_FALLBACK_HEADER, type OhttpRelay } from "@flagship/protocol";
import { D1Storage, type D1Database } from "@flagship/storage";

export interface OhttpEnv {
  DB?: D1Database;
  /** Worker secret: `<keyId>:<64 hex X25519 private key>[,…]`, current key first. */
  OHTTP_GATEWAY_KEYS?: string;
  /** The relay URL boxes use (the provider forwards it to OHTTP_GATEWAY_PATH). */
  OHTTP_RELAY_URL?: string;
  GITHUB_ISSUES_TOKEN?: string;
  GITHUB_ISSUES_REPO?: string;
}

type WaitUntil = { waitUntil(p: Promise<unknown>): void } | undefined;

/** The relay as boxes see it: its URL and our current gateway key. */
export function relayFromEnv(env: OhttpEnv): OhttpRelay | null {
  const key = ohttpGatewayKeysFromEnv(env.OHTTP_GATEWAY_KEYS)[0];
  if (!key) return null;
  let hex = "";
  for (const b of encodeOhttpKeyConfig(key)) hex += b.toString(16).padStart(2, "0");
  return ohttpRelayFrom(env.OHTTP_RELAY_URL, hex);
}

/** Count a direct request a proxy box sent because the relay failed it. */
export function noteRelayFallback(request: Request, env: OhttpEnv, ctx: WaitUntil): void {
  if (!request.headers.has(RELAY_FALLBACK_HEADER) || !env.DB) return;
  const p = new D1Storage(env.DB).relayHealth.bump(utcDay(Date.now()), "direct-fallback").catch(() => {});
  if (ctx) ctx.waitUntil(p);
}

/** The OHTTP endpoints, or null for any other path. */
export async function tryOhttp(
  request: Request,
  url: URL,
  env: OhttpEnv,
  hosts: { apex: string; boot: string },
  dispatch: (req: Request) => Promise<Response>,
): Promise<Response | null> {
  if (url.hostname !== hosts.apex) return null;
  if (url.pathname === OHTTP_KEYS_PATH && request.method === "GET") {
    return ohttpKeysResponse(ohttpGatewayKeysFromEnv(env.OHTTP_GATEWAY_KEYS));
  }
  if (url.pathname === OHTTP_PROBE_PATH && request.method === "GET") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (url.pathname === OHTTP_GATEWAY_PATH) {
    const storage = env.DB ? new D1Storage(env.DB) : null;
    return handleOhttpGateway(request, {
      keys: ohttpGatewayKeysFromEnv(env.OHTTP_GATEWAY_KEYS),
      apexHost: hosts.apex,
      bootHost: hosts.boot,
      dispatch,
      ...(storage ? { recordArrival: () => storage.relayHealth.bump(utcDay(Date.now()), "ohttp") } : {}),
    });
  }
  return null;
}

/** The /status/ signal; null when there's no database to read. */
export async function privateRelayForStatus(env: OhttpEnv): Promise<PrivateRelayStatus | null> {
  if (!env.DB) return null;
  try {
    return await privateRelayStatus(new D1Storage(env.DB).relayHealth, {
      now: Date.now(),
      configured: relayFromEnv(env) !== null,
    });
  } catch {
    return null;
  }
}

export const RELAY_DOWN_ISSUE_TITLE = "Private relay down — proxy servers are reaching Flagship directly (docs/outbound-proxy.md)";

/** Daily: one request through the relay to our own probe path; page on failure. */
export async function runRelayProbeCron(
  env: OhttpEnv,
  now: Date,
  hosts: { apex: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!env.DB) return;
  const storage = new D1Storage(env.DB);
  await runRelayProbe({
    storage: storage.relayHealth,
    relay: relayFromEnv(env),
    apexHost: hosts.apex,
    now: () => now.getTime(),
    fetch: fetchImpl as never,
    notifyOperator: async (detail) => {
      console.error(`[relay-probe] ${detail}`);
      if (!env.GITHUB_ISSUES_TOKEN) return;
      await openIssueOnce(
        { token: env.GITHUB_ISSUES_TOKEN, repo: env.GITHUB_ISSUES_REPO ?? "ibisllc/flagship", fetchImpl },
        RELAY_DOWN_ISSUE_TITLE,
        [
          `The daily probe through the private relay failed: ${detail}`,
          "",
          "Servers with an outbound proxy now send their setup and boot-unlock calls directly (by design, so unlock keeps working), and /status/ says so.",
          "Check the relay plan and `OHTTP_RELAY_URL` / `OHTTP_GATEWAY_KEYS` on the Worker.",
        ].join("\n"),
      );
    },
  });
}

async function openIssueOnce(
  deps: { token: string; repo: string; fetchImpl: typeof fetch },
  title: string,
  body: string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${deps.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "flagship-com-worker",
    "Content-Type": "application/json",
  };
  const q = `repo:${deps.repo} is:issue is:open in:title "${title}"`;
  const search = await deps.fetchImpl(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}`, { headers });
  if (!search.ok) throw new Error(`relay-probe github search failed: ${search.status}`);
  if (((await search.json()) as { total_count: number }).total_count > 0) return;
  const created = await deps.fetchImpl(`https://api.github.com/repos/${deps.repo}/issues`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title, body }),
  });
  if (!created.ok) throw new Error(`relay-probe github issue create failed: ${created.status}`);
}
