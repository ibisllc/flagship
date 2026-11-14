/**
 * Direct access between the box and `.com` (docs/direct-access-and-domains.md §6 step 3, §8):
 *
 *   - the box sends its signed `direct-address/v1` update (with the owner's order it sits in) to
 *     `POST /api/direct-access/address` whenever its addresses or the order change, so the owner's direct names
 *     follow it without a new biometric order. `.com` checks the update against the order itself;
 *   - the box reads its account's direct names (`GET /api/accounts/<u>/direct-access`, its own read token) and keeps
 *     those whose owner-signed `direct-name/v1` order names this box, is on and verifies HERE under the account's
 *     sensitive-order authority. `.com`'s list is only where the orders come from: a name it lists that the owner
 *     didn't sign is never served. Those names are what the public listener admits at its TLS gate, what the box
 *     orders a `direct` certificate for, and what routes to the app.
 *
 * Failures are quiet: the relay names keep working, the next round tries again.
 */
import { directLabelOf, directNameKind, DIRECT_APEX, parseDirectNameOrder } from "@flagship/protocol";
import type { DirectAccessController } from "./directAccess.js";

export interface DirectNamesOptions {
  controller: DirectAccessController;
  comBaseUrl: string;
  username: string;
  serverFqdn: string;
  signAsBox: (msg: Uint8Array) => Uint8Array;
  /** `GET` with the box's own read token (BoxReadToken). */
  readFetch: (url: string, init?: RequestInit) => Promise<Response>;
  fetchImpl?: typeof fetch;
  directApex?: string;
  log?: (m: string) => void;
}

/** What a name's label routes to: the app `<slug>` of `<creator>`, or null when it isn't a derived name. */
export function directNameService(fqdn: string, apex = DIRECT_APEX): { creator: string; slug: string } | null {
  const label = directLabelOf(fqdn.toLowerCase(), apex);
  const kind = label ? directNameKind(label) : null;
  return kind && kind.kind === "derived" ? { creator: kind.creator, slug: kind.slug } : null;
}

export class DirectNames {
  private held: string[] = [];
  private read = false;
  private lastPushed: string | null = null;
  private readonly listeners = new Set<(names: readonly string[]) => void>();
  private timer: NodeJS.Timeout | null = null;
  private round: Promise<void> | null = null;
  private readonly log: (m: string) => void;
  private readonly apex: string;

  constructor(private readonly o: DirectNamesOptions) {
    this.log = o.log ?? ((m) => console.log(`[direct-names] ${m}`));
    this.apex = (o.directApex ?? DIRECT_APEX).toLowerCase();
  }

  /** The box's verified direct names (full names), sorted. */
  names(): readonly string[] {
    return this.held;
  }

  /** Whether `.com`'s list has been read at least once since start (before it, `names()` is empty, not "none"). */
  ready(): boolean {
    return this.read;
  }

  has(fqdn: string): boolean {
    return this.held.includes(fqdn.toLowerCase());
  }

  onChange(fn: (names: readonly string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private base(): string {
    return this.o.comBaseUrl.replace(/\/$/, "");
  }

  /** Send the current address update when it differs from the last one `.com` took. */
  async pushAddress(): Promise<"sent" | "unchanged" | "off" | "failed"> {
    await this.o.controller.start();
    const u = this.o.controller.addressUpdate(this.o.signAsBox);
    const order = this.o.controller.signedOrder();
    if (!u || !order) {
      this.lastPushed = null;
      return "off";
    }
    const key = `${u.update.issuedAt}|${u.signatureHex}`;
    if (key === this.lastPushed) return "unchanged";
    try {
      const res = await (this.o.fetchImpl ?? fetch)(`${this.base()}/api/direct-access/address`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...u, directAccess: order }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        this.log(`.com did not take the address update (${res.status} ${body.code ?? ""})`);
        return "failed";
      }
      this.lastPushed = key;
      return "sent";
    } catch (e) {
      this.log(`could not send the address update: ${(e as Error).message}`);
      return "failed";
    }
  }

  /** Read the account's names from `.com` and keep the ones this box verifies. A failed read keeps what it had. */
  async refreshNames(): Promise<readonly string[]> {
    await this.o.controller.start();
    let body: { names?: unknown };
    try {
      const res = await this.o.readFetch(`${this.base()}/api/accounts/${encodeURIComponent(this.o.username)}/direct-access`);
      if (!res.ok) {
        this.log(`.com did not list the direct names (${res.status})`);
        return this.held;
      }
      body = (await res.json()) as { names?: unknown };
    } catch (e) {
      this.log(`could not read the direct names: ${(e as Error).message}`);
      return this.held;
    }
    const first = !this.read;
    this.read = true;
    const me = this.o.serverFqdn.toLowerCase();
    const next: string[] = [];
    for (const raw of Array.isArray(body.names) ? body.names : []) {
      const n = raw as { order?: unknown; signatureHex?: unknown; pqSignature?: unknown; suspended?: unknown };
      const order = parseDirectNameOrder(n.order);
      if (!order || !order.enabled || n.suspended || typeof n.signatureHex !== "string") continue;
      if (order.serverDomain.toLowerCase() !== me || !directNameService(order.name, this.apex)) continue;
      if (!this.o.controller.verifyNameOrder(order, n.signatureHex.toLowerCase(), n.pqSignature)) {
        this.log(`${order.name}: its order doesn't verify under this account's admin key; not serving it`);
        continue;
      }
      if (!next.includes(order.name)) next.push(order.name);
    }
    next.sort();
    if (first || next.join("\n") !== this.held.join("\n")) {
      this.held = next;
      for (const fn of this.listeners) {
        try {
          fn(next);
        } catch (e) {
          this.log(`a listener failed: ${(e as Error).message}`);
        }
      }
    }
    return this.held;
  }

  /** One round: address first (it may change what `.com` publishes), then the names. Never throws. */
  tick(): Promise<void> {
    this.round ??= (async () => {
      try {
        await this.pushAddress();
        await this.refreshNames();
      } catch (e) {
        this.log(`round failed: ${(e as Error).message}`);
      } finally {
        this.round = null;
      }
    })();
    return this.round;
  }

  /** Every `intervalMs` (5 min by default; the addresses rescan as often), and at once after a new order. */
  start(intervalMs = 5 * 60_000): () => void {
    const off = this.o.controller.onChange(() => void this.tick());
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    return () => {
      off();
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }
}
