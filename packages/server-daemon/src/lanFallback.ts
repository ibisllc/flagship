/**
 * LAN fallback (mDNS) — when the internet is down, the phone falls back to
 * scanning the local network for the user's Flagship server. The server
 * publishes `_flagship._tcp` so phones on the same WiFi can discover it.
 *
 * The transport that actually goes over the LAN is the same one that goes
 * over the tunnel: BAK-signed pairing, identical canonical-bytes, identical
 * frames. The LAN path is a different transport, not a different protocol.
 *
 * BLE control-channel is the mobile-side concern; this module handles the
 * Node.js TS surface.
 */

export interface MdnsAdvertiser {
  /**
   * Publish a service. Returns a disposer that unpublishes.
   *
   * Implementations: `mdns` npm package on Node, NSNetService on iOS,
   * NsdManager on Android. v0 ships an InMemory variant for tests; v1
   * wraps `mdns` (or `bonjour-service`) once a Linux build target is
   * picked.
   */
  publish(record: ServiceRecord): Promise<{ stop(): Promise<void> }>;
}

export interface ServiceRecord {
  type: string;
  name: string;
  port: number;
  txt?: Record<string, string>;
}

export interface LanFallbackOptions {
  serverId: string;
  /** The user's DNS-safe label, e.g. "harry". */
  username: string;
  /** Port the daemon's LAN listener is on. */
  port: number;
  /** STK pubkey hex — phones verify against the same pubkey they registered with. */
  stkPubHex: string;
  /** Tunnel HTTP base path, default "/tunnel-lan". */
  basePath?: string;
}

/**
 * Build the mDNS service record. Pulled out so tests can assert the txt
 * contents without spinning up a real mDNS responder.
 */
export function buildLanServiceRecord(opts: LanFallbackOptions): ServiceRecord {
  if (!/^[0-9a-f]{64}$/.test(opts.stkPubHex)) {
    throw new Error("stkPubHex must be 32-byte hex");
  }
  return {
    type: "_flagship._tcp",
    name: `flagship-${opts.username}-${opts.serverId}`,
    port: opts.port,
    txt: {
      // Don't bake any secret into the TXT record; LAN observers see this.
      v: "1",
      user: opts.username,
      server: opts.serverId,
      stkPub: opts.stkPubHex,
      path: opts.basePath ?? "/tunnel-lan",
    },
  };
}

export class InMemoryMdnsAdvertiser implements MdnsAdvertiser {
  published: ServiceRecord[] = [];
  async publish(record: ServiceRecord): Promise<{ stop(): Promise<void> }> {
    this.published.push(record);
    return {
      stop: async () => {
        this.published = this.published.filter((r) => r !== record);
      },
    };
  }
}

export async function startLanFallback(
  advertiser: MdnsAdvertiser,
  opts: LanFallbackOptions,
): Promise<{ stop(): Promise<void> }> {
  const record = buildLanServiceRecord(opts);
  return advertiser.publish(record);
}
