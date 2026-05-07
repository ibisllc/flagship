/**
 * HTTP endpoint that streams a one-shot app backup to the phone.
 *
 *   GET /api/backups/<backupId>
 *
 * Paired-session token gated. Reading the response consumes the
 * backup — the file is deleted on stream close (single-fetch).
 */

import type { PairedSessionGate } from "./alertInboxHttp.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { AppBackupService } from "./appBackup.js";

export interface AppBackupHttpDeps {
  backups: AppBackupService;
  gate: PairedSessionGate;
}

export function buildAppBackupHttpHandlers(deps: AppBackupHttpDeps) {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (!req.path.startsWith("/api/backups/")) return null;
    const denied = deps.gate.check(req);
    if (denied) return denied;
    if (req.method !== "GET") {
      return {
        status: 405,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "method not allowed" }),
      };
    }
    const id = req.path.slice("/api/backups/".length).split("?")[0]!;
    if (!/^[0-9a-f]+$/.test(id)) {
      return {
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "invalid backupId" }),
      };
    }
    const fetched = await deps.backups.streamForFetch(id);
    if (!fetched) {
      return {
        status: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "backup not found or expired" }),
      };
    }
    // Buffer the file into memory and respond as a single Buffer.
    // For the v1 phone-fetch path this is simpler than streaming
    // through the daemon's HTTP harness; production will swap to
    // chunked transfer once the harness gains a streaming-response
    // primitive.
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      fetched.stream.on("data", (c: Buffer) => chunks.push(c));
      fetched.stream.on("end", resolve);
      fetched.stream.on("error", reject);
    });
    const body = Buffer.concat(chunks);
    return {
      status: 200,
      headers: {
        "content-type": fetched.record.encrypted
          ? "application/octet-stream"
          : "application/gzip",
        "content-disposition": `attachment; filename="${id}${fetched.record.encrypted ? ".tar.gz.enc" : ".tar.gz"}"`,
        "x-flagship-encrypted": fetched.record.encrypted ? "1" : "0",
      },
      body,
    };
  };
}
