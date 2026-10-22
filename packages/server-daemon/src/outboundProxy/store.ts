/**
 * The owner-signed outbound proxy this box uses (docs/outbound-proxy.md),
 * kept in `<dataDir>/outbound-proxy.json` (0600, written durably) with its
 * credentials. Sources: the recipe's `outboundProxy` sibling at first boot,
 * then the owner's edits over the paired session. Every order is re-verified
 * on load, so a hand-edited file is ignored.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseBoxProxyCredentials,
  parseSignedBoxProxy,
  verifyBoxProxy,
  type AdminGrantView,
  type BoxProxy,
  type BoxProxyCredentials,
  type SignedBoxProxy,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import { writeFileDurable } from "../durableFile.js";
import type { OutboundProxySetting } from "./outboundNet.js";

export interface StoredOutboundProxy {
  signed: SignedBoxProxy;
  credentials?: BoxProxyCredentials;
  source: "recipe" | "owner";
}

export interface OutboundProxyAuthority {
  serverDomain: string;
  username: string;
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  activeGrants?: readonly AdminGrantView[];
}

function sigBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** The order parsed, for this box, and signed by the sensitive-order authority; else null. */
export function verifiedBoxProxy(raw: unknown, auth: OutboundProxyAuthority): SignedBoxProxy | null {
  const signed = parseSignedBoxProxy(raw);
  if (!signed || !/^[0-9a-f]{128}$/.test(signed.signature)) return null;
  if (signed.proxy.serverDomain !== auth.serverDomain.toLowerCase()) return null;
  const ok = authorizeSensitiveOrder<BoxProxy>({
    order: signed.proxy,
    signature: sigBytes(signed.signature),
    verify: (o, sig, pub) => verifyBoxProxy(o, hex(sig), pub),
    ownerIrkPub: auth.ownerIrkPub,
    ...(auth.adminRootPub ? { adminRootPub: auth.adminRootPub } : {}),
    username: auth.username,
    ...(auth.activeGrants ? { activeGrants: auth.activeGrants } : {}),
  });
  return ok ? signed : null;
}

/** What the connector needs from a stored order; null when it says "no proxy". */
export function settingOf(stored: StoredOutboundProxy | null): OutboundProxySetting | null {
  if (!stored || stored.signed.proxy.kind === "none") return null;
  const p = stored.signed.proxy;
  return {
    upstream: {
      kind: p.kind as "socks5" | "http",
      host: p.host,
      port: p.port,
      ...(p.auth && stored.credentials ? { username: stored.credentials.username, password: stored.credentials.password } : {}),
    },
    fallbackDirect: p.fallbackDirect,
  };
}

export class OutboundProxyStore {
  private held: StoredOutboundProxy | null = null;

  constructor(
    private readonly path: string,
    private readonly auth: OutboundProxyAuthority,
    private readonly log: (m: string) => void = () => {},
  ) {}

  current(): StoredOutboundProxy | null {
    return this.held;
  }

  async load(): Promise<StoredOutboundProxy | null> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf-8")) as {
        signed?: unknown;
        credentials?: unknown;
        source?: unknown;
      };
      const signed = verifiedBoxProxy(raw.signed, this.auth);
      if (!signed) {
        this.log("[outbound-proxy] ignoring a saved proxy setting that doesn't verify");
        return null;
      }
      const credentials = parseBoxProxyCredentials(raw.credentials);
      this.held = {
        signed,
        ...(credentials ? { credentials } : {}),
        source: raw.source === "recipe" ? "recipe" : "owner",
      };
    } catch {
      /* none saved */
    }
    return this.held;
  }

  /**
   * First boot: adopt the recipe's order from the install blob when nothing is
   * saved yet. No freshness window (a recipe may be used hours after it was
   * signed); the signature and the box's domain bind it.
   */
  async adoptFromInstallBlob(blobPath: string): Promise<StoredOutboundProxy | null> {
    if (this.held) return this.held;
    let blob: { outboundProxy?: unknown; outboundProxyCredentials?: unknown };
    try {
      blob = JSON.parse(await readFile(blobPath, "utf-8")) as typeof blob;
    } catch {
      return null;
    }
    if (!blob.outboundProxy) return null;
    const raw = typeof blob.outboundProxy === "string" ? safeJson(blob.outboundProxy) : blob.outboundProxy;
    const signed = verifiedBoxProxy(raw, this.auth);
    if (!signed) {
      this.log("[outbound-proxy] the recipe's proxy setting doesn't verify; connecting directly");
      return null;
    }
    const credsRaw =
      typeof blob.outboundProxyCredentials === "string"
        ? safeJson(blob.outboundProxyCredentials)
        : blob.outboundProxyCredentials;
    const credentials = signed.proxy.auth ? parseBoxProxyCredentials(credsRaw) : null;
    const stored: StoredOutboundProxy = { signed, ...(credentials ? { credentials } : {}), source: "recipe" };
    await this.save(stored);
    this.log(`[outbound-proxy] using the recipe's ${signed.proxy.kind} proxy`);
    return stored;
  }

  /** Replace the held setting (already verified, fresh and tested by the caller). */
  async save(stored: StoredOutboundProxy): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFileDurable(this.path, `${JSON.stringify(stored)}\n`, 0o600);
    this.held = stored;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
