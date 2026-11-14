// "Release this box" on the box (docs/retail-box-setup.md §7.8, §8.2): an order signed by the
// account's pinned admin root, naming this box and its own server key, wipes the box back to
// unclaimed. The IRK and admin-granted device keys are refused: releasing destroys everything.
// Refusals are reason codes; the apps say them in the owner's language.

import { BOX_RELEASE_MAX_SKEW_MS, parseBoxRelease, verifyBoxRelease, type BoxReleaseOrder } from "@flagship/protocol";
import { readStateFile, writeFileDurable } from "../durableFile.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";

export const BOX_RELEASE_PATH = "/api/screens/box-release";

export type BoxReleaseRefusal =
  | "release-unreadable"
  | "release-other-server"
  | "release-no-admin-root"
  | "release-not-admin"
  | "release-replayed"
  | "release-clock"
  | "release-not-claimed"
  | "release-failed";

export type BoxReleaseResult = { ok: true } | { ok: false; status: number; code: BoxReleaseRefusal };

export interface BoxReleaseDeps {
  serverDomain: string;
  /** The box's own Ed25519 server key, hex. */
  stkPubHex: () => string;
  /** The admin root this box has pinned; null on a box that pins none (it cannot be released). */
  adminRootPub: () => Uint8Array | null;
  /** Newest order taken, so none is taken twice: `<dataDir>/box-release.json`. */
  statePath: string;
  now?: () => number;
  /** Wipes back to unclaimed (RetailClaimService.release); throws when it could not. */
  release: () => Promise<void>;
  /** Runs once the order is answered: the reboot into an unclaimed box. */
  afterRelease?: () => void;
  log?: (m: string) => void;
}

interface Floor {
  v: 1;
  floorIssuedAt: number;
}

export class BoxReleaseConsumer {
  private busy = false;
  constructor(private readonly d: BoxReleaseDeps) {}

  private async floor(): Promise<number> {
    const r = await readStateFile(this.d.statePath);
    if (r.kind === "missing") return 0;
    if (r.kind === "ok") {
      try {
        const o = JSON.parse(r.text) as Floor;
        if (o.v === 1 && Number.isSafeInteger(o.floorIssuedAt)) return o.floorIssuedAt;
      } catch {
        // an unreadable floor refuses every order until a later one, below
      }
    }
    return Number.MAX_SAFE_INTEGER;
  }

  async take(body: unknown): Promise<BoxReleaseResult> {
    const c = (body ?? {}) as { order?: unknown; signatureHex?: unknown };
    const order: BoxReleaseOrder | null = parseBoxRelease(c.order);
    const sigHex = typeof c.signatureHex === "string" && /^[0-9a-fA-F]{128}$/.test(c.signatureHex) ? c.signatureHex : null;
    if (!order || !sigHex) return { ok: false, status: 400, code: "release-unreadable" };
    if (order.serverDomain !== this.d.serverDomain.toLowerCase() || order.stkPubHex !== this.d.stkPubHex().toLowerCase()) {
      return { ok: false, status: 422, code: "release-other-server" };
    }
    const admin = this.d.adminRootPub();
    if (!admin || admin.length !== 32) return { ok: false, status: 403, code: "release-no-admin-root" };
    if (!verifyBoxRelease(order, Buffer.from(sigHex, "hex"), admin)) return { ok: false, status: 403, code: "release-not-admin" };
    const now = (this.d.now ?? Date.now)();
    if (Math.abs(now - order.issuedAt) > BOX_RELEASE_MAX_SKEW_MS) return { ok: false, status: 422, code: "release-clock" };
    if (this.busy || order.issuedAt <= (await this.floor())) return { ok: false, status: 409, code: "release-replayed" };
    this.busy = true;
    try {
      await writeFileDurable(this.d.statePath, JSON.stringify({ v: 1, floorIssuedAt: order.issuedAt } satisfies Floor));
      try {
        await this.d.release();
      } catch (e) {
        const m = (e as Error).message;
        this.d.log?.(`[retail] release failed: ${m}`);
        return { ok: false, status: m === "not-claimed" ? 409 : 500, code: m === "not-claimed" ? "release-not-claimed" : "release-failed" };
      }
      this.d.log?.("[retail] released by the owner's admin root: the box is unclaimed");
      if (this.d.afterRelease) setTimeout(this.d.afterRelease, 1_000);
      return { ok: true };
    } finally {
      this.busy = false;
    }
  }
}

export function buildBoxReleaseHttp(deps: { consumer: Pick<BoxReleaseConsumer, "take">; denyCompanion: (req: HttpRequest) => HttpResponse | null }) {
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path !== BOX_RELEASE_PATH) return null;
    if (method !== "POST") return json(405, { error: "method not allowed" });
    const denied = deps.denyCompanion(req);
    if (denied) return denied;
    let body: unknown;
    try {
      body = req.body.length === 0 ? null : JSON.parse(req.body.toString("utf-8"));
    } catch {
      return json(400, { error: "release-unreadable", code: "release-unreadable" });
    }
    const r = await deps.consumer.take(body);
    if (!r.ok) return json(r.status, { error: r.code, code: r.code });
    return json(200, { ok: true });
  };
}
