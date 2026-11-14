import type { KeydClient } from "@flagship/keyd";
import type { KeydAcmeApi } from "./acme/keydAcme.js";
import type { OpaqueTlsKeyd } from "./acme/opaqueIssuer.js";

/** The asynchronous keyd operations the ACME and TLS code use, over a connected `KeydClient`. */
export function keydAcmeApi(client: KeydClient): KeydAcmeApi {
  return {
    async jwk() {
      const r = await client.call("acme.jwk");
      return { present: r.present === true, ...(typeof r.thumbprint === "string" ? { thumbprint: r.thumbprint } : {}) };
    },
    async create() {
      await client.call("acme.create");
    },
    async sign(args) {
      const r = await client.call("acme.sign", args);
      return { protected: String(r.protected), payload: String(r.payload), signature: String(r.signature) };
    },
    async tlsCreateKey(names) {
      const r = await client.call("tls.createKey", { names });
      return { handle: String(r.handle) };
    },
    async tlsInstall(handle, chainPem) {
      const r = await client.call("tls.install", { handle, chain: chainPem });
      return { notAfter: Number(r.notAfter), names: r.names as string[] };
    },
  };
}

/** keyd's TLS operations for the runtime, over a connected `KeydClient`. */
export function keydTlsKeyd(client: KeydClient): OpaqueTlsKeyd {
  return {
    acme: keydAcmeApi(client),
    async active() {
      const r = (await client.call("tls.active")).active as { handle: string; chainPem: string; notAfter: number; names: string[]; legacy?: boolean } | null;
      return r ? { handle: r.handle, chainPem: r.chainPem, notAfter: r.notAfter, names: r.names, legacy: r.legacy === true } : null;
    },
    async activate(handle, slot) {
      await client.call("tls.activate", slot ? { handle, slot } : { handle });
    },
    async serving() {
      const r = (await client.call("tls.active")).serving;
      return Array.isArray(r) ? (r as Array<{ slot: string; handle: string }>).map((s) => ({ slot: String(s.slot), handle: String(s.handle) })) : null;
    },
    async csr(handle) {
      const r = await client.call("tls.csr", { handle });
      return new Uint8Array(Buffer.from(String(r.csr), "hex"));
    },
    async list() {
      return ((await client.call("tls.list")).keys as Array<{ handle: string; names: string[]; notAfter: number | null; active: boolean; legacy: boolean }>).map((k) => ({
        handle: k.handle,
        names: k.names ?? [],
        notAfter: k.notAfter ?? null,
        active: k.active === true,
        legacy: k.legacy === true,
      }));
    },
    async directNames(names) {
      await client.call("tls.directNames", { names });
    },
    async directServing() {
      const r = (await client.call("tls.active")).serving;
      if (!Array.isArray(r)) return [];
      return (r as Array<{ slot: string; handle: string; names?: unknown; notAfter?: unknown }>)
        .filter((s) => s.slot === "direct" && Array.isArray(s.names) && typeof s.names[0] === "string")
        .map((s) => ({ name: String((s.names as string[])[0]), handle: String(s.handle), notAfter: Number(s.notAfter) || 0 }));
    },
    async pruneLegacy() {
      const keys = (await client.call("tls.list")).keys as Array<{ handle: string; legacy: boolean; active: boolean }>;
      for (const k of keys) if (k.legacy && !k.active) await client.call("tls.remove", { handle: k.handle });
    },
  };
}
