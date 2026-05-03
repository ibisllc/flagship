import type { FastifyInstance, FastifyRequest } from "fastify";

interface ReportBody {
  email?: string;
  severity?: "critical" | "high" | "medium" | "low";
  component?: string;
  summary?: string;
  details?: string;
}

export interface SecurityReport {
  id: string;
  receivedAt: number;
  remoteAddr: string;
  email?: string;
  severity: string;
  component: string;
  summary: string;
  details: string;
}

export type ReportSink = (report: SecurityReport) => void | Promise<void>;

interface RegisterOptions {
  sink?: ReportSink;
  rateLimit?: { perIpPerHour: number };
  now?: () => number;
}

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

export function registerSecurityReport(app: FastifyInstance, opts: RegisterOptions = {}): void {
  const sink: ReportSink =
    opts.sink ??
    ((r) => {
      // Default sink: structured stderr log. Operations forwards to security@... .
      console.error(JSON.stringify({ level: "security_report", ...r }));
    });
  const limit = opts.rateLimit?.perIpPerHour ?? 5;
  const now = opts.now ?? (() => Date.now());
  const windowMs = 60 * 60_000;
  const buckets = new Map<string, number[]>();

  function rateOk(ip: string): boolean {
    const t = now();
    const arr = buckets.get(ip) ?? [];
    const recent = arr.filter((ts) => t - ts < windowMs);
    if (recent.length >= limit) {
      buckets.set(ip, recent);
      return false;
    }
    recent.push(t);
    buckets.set(ip, recent);
    return true;
  }

  app.post<{ Body: ReportBody }>("/api/security/report", async (req, reply) => {
    const ip = clientIp(req);
    if (!rateOk(ip)) {
      return reply.status(429).send({ error: "Too many reports from your IP. Please email security@flagshipserver.com instead." });
    }

    const body = req.body ?? {};
    const summary = (body.summary ?? "").toString().trim();
    const details = (body.details ?? "").toString().trim();
    if (!summary || summary.length > 200) {
      return reply.status(400).send({ error: "summary is required (1..200 chars)" });
    }
    if (!details || details.length > 20_000) {
      return reply.status(400).send({ error: "details is required (1..20000 chars)" });
    }
    const severity = body.severity && VALID_SEVERITIES.has(body.severity) ? body.severity : "high";
    const component = (body.component ?? "Other").toString().slice(0, 100);
    const email = body.email ? body.email.toString().trim().slice(0, 200) : undefined;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.status(400).send({ error: "email must be a valid address (or omit it)" });
    }

    const report: SecurityReport = {
      id: makeReportId(),
      receivedAt: now(),
      remoteAddr: ip,
      email,
      severity,
      component,
      summary,
      details,
    };

    await sink(report);
    return { reportId: report.id, status: "received" };
  });
}

function clientIp(req: FastifyRequest): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]!.trim();
  return req.ip;
}

function makeReportId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = "FLG-";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s.toUpperCase();
}
