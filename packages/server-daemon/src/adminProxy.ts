/**
 * Phone-gated proxy to the data-layer admin UIs.
 *
 *   /.flagship/admin/postgres/*  → Adminer            (127.0.0.1:8081)
 *   /.flagship/admin/objects/*   → MinIO Console      (127.0.0.1:9001)
 *   /.flagship/admin/kv/*        → redis-commander    (127.0.0.1:8082)
 *
 * The phone-paired browser embeds these in iframes. Auth is the same
 * `PairedSessionGate` the AlertInbox HTTP uses — a paired-session
 * cookie/token issued at QR-pair time. No credentials transit the
 * URL; the upstream containers are 127.0.0.1-bound (defense in depth)
 * and we strip any inbound `X-Flagship-*` so the upstream can't lean
 * on identity headers.
 *
 * The proxy is mounted at the daemon's own SNI (the serverFqdn host)
 * — apps' subdomains never see /.flagship/admin/*; the appProxy
 * intercepts /.flagship/* before the container, but the runtime's
 * default handler also has to recognize this path on the daemon-
 * itself surface (the user lands on `https://home.alice...` from
 * the phone-paired browser).
 *
 * Default targets are inferred from the compose-default ports above
 * but are overridable via deps for tests + customization.
 */

import { request as httpRequest } from "node:http";
import type { PairedSessionGate } from "./alertInboxHttp.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

const STRIP_PREFIX = "x-flagship-";

export interface AdminTarget {
  host: string;
  port: number;
}

export interface AdminProxyDeps {
  gate: PairedSessionGate;
  /** When undefined, upstream defaults are used. */
  postgresUi?: AdminTarget;
  objectsUi?: AdminTarget;
  kvUi?: AdminTarget;
  /** Override fetch for tests. */
  forward?: (
    target: AdminTarget,
    req: HttpRequest,
  ) => Promise<HttpResponse>;
}

const DEFAULT_TARGETS = {
  postgres: { host: "127.0.0.1", port: 8081 },
  objects: { host: "127.0.0.1", port: 9001 },
  kv: { host: "127.0.0.1", port: 8082 },
} as const;

const SECTION_RE = /^\/\.flagship\/admin\/(postgres|objects|kv)(\/.*)?$/;

export function buildAdminProxyHandler(deps: AdminProxyDeps) {
  const targets = {
    postgres: deps.postgresUi ?? DEFAULT_TARGETS.postgres,
    objects: deps.objectsUi ?? DEFAULT_TARGETS.objects,
    kv: deps.kvUi ?? DEFAULT_TARGETS.kv,
  };
  const forward = deps.forward ?? defaultAdminForward;

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const qIdx = req.path.indexOf("?");
    const cleanPath = qIdx >= 0 ? req.path.slice(0, qIdx) : req.path;
    const m = SECTION_RE.exec(cleanPath);
    if (!m) return null;

    const denied = deps.gate.check(req);
    if (denied) return denied;

    const section = m[1] as "postgres" | "objects" | "kv";
    const tail = m[2] ?? "/";
    const target = targets[section];

    // Forward with the trailing path + the original query string so the
    // upstream UI sees its expected routing. Strip our own X-Flagship-*
    // headers so the UI can't be confused by them.
    const upstreamPath = qIdx >= 0 ? `${tail}?${req.path.slice(qIdx + 1)}` : tail;
    const forwardedHeaders = stripHeaders(req.headers);

    return forward(target, {
      ...req,
      path: upstreamPath,
      headers: forwardedHeaders,
    });
  };
}

function stripHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lc = k.toLowerCase();
    if (lc.startsWith(STRIP_PREFIX)) continue;
    if (lc === "host") continue; // upstream will set its own
    out[k] = v;
  }
  return out;
}

function defaultAdminForward(
  target: AdminTarget,
  req: HttpRequest,
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve) => {
    const proxyReq = httpRequest(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.path,
        headers: req.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
          }
          delete headers["transfer-encoding"];
          delete headers["connection"];
          resolve({ status: res.statusCode ?? 502, headers, body });
        });
        res.on("error", () =>
          resolve({
            status: 502,
            headers: { "content-type": "text/plain" },
            body: "admin upstream error",
          }),
        );
      },
    );
    proxyReq.on("error", (e) =>
      resolve({
        status: 502,
        headers: { "content-type": "text/plain" },
        body: `admin upstream unreachable: ${e.message}`,
      }),
    );
    if (req.body.length > 0) proxyReq.write(req.body);
    proxyReq.end();
  });
}
