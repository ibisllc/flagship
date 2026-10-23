/**
 * Who another box is, from `.com`'s public registry (SECURITY-HARDENING-PLAN.md 17.5). A box
 * authenticates a chat peer by the key that server registered, never by what a frame says, and
 * finds the box that leads another owner's app from `.com`'s own account of their heartbeats. The
 * second answer is only a hint: the box it names must hold the exclusive lead term to admit.
 */
export interface ChatPeerDirectory {
  /** The registered, unrevoked identity key of a server, hex, or null. */
  server(serverDomain: string): Promise<{ pubHex: string; username: string } | null>;
  /** The server that leads (else runs) `serviceRef` (`author--slug`) for `targetUser`, or null. */
  leadOf(targetUser: string, serviceRef: string): Promise<string | null>;
}

export interface ComPeerDirectoryOptions {
  controlPlaneBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a found answer is kept. */
  ttlMs?: number;
  /** How long a "no such server" answer is kept. */
  missTtlMs?: number;
}

export function comPeerDirectory(o: ComPeerDirectoryOptions): ChatPeerDirectory {
  const base = o.controlPlaneBaseUrl.replace(/\/+$/, "");
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? (() => Date.now());
  const ttl = o.ttlMs ?? 5 * 60_000;
  const missTtl = o.missTtlMs ?? 15_000;
  const servers = new Map<string, { at: number; v: { pubHex: string; username: string } | null }>();
  const leads = new Map<string, { at: number; v: string | null }>();
  const MAX = 2048;

  function remember<T>(m: Map<string, { at: number; v: T }>, k: string, v: T): T {
    if (m.size >= MAX) m.delete(m.keys().next().value!);
    m.set(k, { at: now(), v });
    return v;
  }

  return {
    async server(serverDomain) {
      const d = serverDomain.toLowerCase();
      const hit = servers.get(d);
      if (hit && now() - hit.at < (hit.v ? ttl : missTtl)) return hit.v;
      try {
        const r = await fetchImpl(`${base}/api/server/by-domain/${encodeURIComponent(d)}`);
        if (r.status === 404) return remember(servers, d, null);
        if (!r.ok) return hit?.v ?? null;
        const j = (await r.json()) as { identityPubKey?: unknown; username?: unknown; revoked?: unknown };
        const ok = typeof j.identityPubKey === "string" && /^[0-9a-f]{64}$/.test(j.identityPubKey) && typeof j.username === "string" && !j.revoked;
        return remember(servers, d, ok ? { pubHex: j.identityPubKey as string, username: j.username as string } : null);
      } catch {
        return hit?.v ?? null;
      }
    },
    async leadOf(targetUser, serviceRef) {
      const k = `${targetUser.toLowerCase()}|${serviceRef.toLowerCase()}`;
      const hit = leads.get(k);
      if (hit && now() - hit.at < (hit.v ? 30_000 : missTtl)) return hit.v;
      try {
        const r = await fetchImpl(`${base}/api/chat/lead/${encodeURIComponent(targetUser.toLowerCase())}/${encodeURIComponent(serviceRef.toLowerCase())}`);
        if (!r.ok) return remember(leads, k, null);
        const j = (await r.json()) as { serverDomain?: unknown };
        return remember(leads, k, typeof j.serverDomain === "string" ? j.serverDomain.toLowerCase() : null);
      } catch {
        return hit?.v ?? null;
      }
    },
  };
}
