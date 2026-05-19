/**
 * Real-I/O HTTP port for the CLI edge. Uses `node:https`/`node:http`
 * so it can introspect the live peer certificate (issuer / SANs /
 * validity) — that is what makes the green-padlock assertion real
 * rather than a status-code guess. The pure core never imports this;
 * it only sees the `HttpClient` interface.
 *
 * NOT unit-tested (it does real network I/O); the pure core that
 * consumes it is exhaustively tested with a fake.
 */

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { TLSSocket, PeerCertificate } from "node:tls";
import type { HttpClient, HttpResponse, TlsCertInfo } from "./ports.js";

function certInfo(cert: PeerCertificate): TlsCertInfo {
  const sans = (cert.subjectaltname ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^DNS:/i, ""))
    .filter(Boolean);
  const issuer =
    [cert.issuer?.O, cert.issuer?.CN].filter(Boolean).join(" ") || "unknown";
  return {
    issuer,
    subjectAltNames: sans,
    validFrom: Date.parse(cert.valid_from),
    validTo: Date.parse(cert.valid_to),
  };
}

function doRequest(
  method: "GET" | "POST",
  url: string,
  jsonBody?: unknown,
): Promise<HttpResponse> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const reqFn = isHttps ? httpsRequest : httpRequest;
  const payload =
    jsonBody === undefined ? undefined : JSON.stringify(jsonBody);
  return new Promise((resolve, reject) => {
    const req = reqFn(
      url,
      {
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const out: HttpResponse = {
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          if (isHttps) {
            const sock = res.socket as TLSSocket;
            const peer = sock.getPeerCertificate?.();
            if (peer && Object.keys(peer).length > 0) {
              out.tls = certInfo(peer);
            }
          }
          resolve(out);
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export const nodeHttpClient: HttpClient = {
  get: (url) => doRequest("GET", url),
  post: (url, body) => doRequest("POST", url, body),
};
