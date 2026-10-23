import type { KeydClient } from "@flagship/keyd";
import type { KeydAcmeApi } from "./acme/keydAcme.js";

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
