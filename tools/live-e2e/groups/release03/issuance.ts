// The certificate issuance service, live (plan H1/H9/H7; docs/architecture-v2/issuance-service.md). A1 got its
// certificates through `.com`: its own name is served with a certificate that names nothing a box may not have (never
// the bare account name), and its app names with its app certificate. A throwaway server registered from the harness
// (its key held here, the admin's account wildcard grant in hand: the strongest box there is) then asks for the bare
// account name every way Appendix H scenario 5 lists; every request is refused before the CA hears of it. The old
// DNS-01 writer answers 410. Skips when the gym `.com` has no issuance account key.
import acme from "acme-client";
import { createHash, randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  ed,
  signAuthCode,
  signRevocation,
  signServerRegister,
  signServerWildcardGrant,
  signServingRecord,
  type CertificateOrder,
  type Keypair,
} from "@flagship/protocol";
import { authCodeWire, issueAuthCode, newAuthCode } from "../../lib/fleet.js";
import { CONTROL, SERVICES, SkipError, assert, certInfo, postJson, short, tryHttp } from "../../lib/harness.js";
import type { Group } from "../types.js";

async function csrFor(names: string[]): Promise<string> {
  const key = await acme.crypto.createPrivateEcdsaKey("P-256");
  const [, pem] = await acme.crypto.createCsr({ commonName: names[0]!, altNames: names }, key);
  return Buffer.from(pem.toString("utf8").replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64").toString("base64url");
}

export const issuance: Group = {
  name: "issuance",
  title: "certificates come from .com's issuance service: a box's own name and app names are served, the bare account name is never issued to a box (also mixed, as the phone class, or as a raw DNS record)",
  needs: ["A1"],
  phase: 10.5,
  parallel: false,
  async run({ A, rec, box }) {
    const acct = A!;
    const b = box("A1");
    const zone = `${acct.username}.${SERVICES}`;
    const account = await tryHttp(`https://${CONTROL}/api/certificates/account`);
    if (account.status !== 200) {
      await rec.check("the gym .com has an issuance ACME account", async () => {
        throw new SkipError(`GET /api/certificates/account ${account.status}: set ISSUANCE_ACME_ACCOUNT_KEY on the gym Worker`);
      });
      return;
    }

    await rec.check("the service has its own ACME account (the apex CAA pins this URI)", async () => {
      const uri = String(account.json?.accountUri ?? "");
      assert(/^https:\/\//.test(uri), `no account URI: ${short(account.text)}`);
      return uri;
    });

    await rec.check("A1's own name is served with a certificate for box names only, never the bare account name", async () => {
      const c = certInfo(b.fqdn);
      assert(c.sans.length > 0, `no certificate on ${b.fqdn}`);
      assert(!c.sans.includes(zone), `the bare ${zone} is on A1's certificate: ${c.sans.join(", ")}`);
      const allowed = new Set([b.fqdn, `*.${b.fqdn}`, `*.${zone}`]);
      assert(c.sans.every((s) => allowed.has(s)), `unexpected names: ${c.sans.join(", ")}`);
      // The classic stack serves the control certificate (exactly the name); keyd's one active certificate is the app
      // certificate when it covers the name (*.<user>).
      const exact = c.sans.length === 1 && c.sans[0] === b.fqdn;
      const apps = c.sans.includes(`*.${zone}`) && !c.sans.includes(b.fqdn);
      assert(exact || apps, `A1 still serves a combined certificate (${c.sans.join(", ")}): the service has not issued yet`);
      return `${c.sans.join(", ")} (${c.issuer})`;
    });

    await rec.check("an app name under A1 is served with the app certificate", async () => {
      const c = certInfo(`issuance-probe.${b.fqdn}`);
      assert(c.sans.includes(`*.${b.fqdn}`), `no *.${b.fqdn} on ${c.sans.join(", ")}`);
      assert(!c.sans.includes(zone) && !c.sans.includes(b.fqdn), `the app certificate names ${c.sans.join(", ")}`);
      return c.sans.join(", ");
    });

    await rec.check("the old DNS-01 writer is closed (410)", async () => {
      const r = await postJson(`https://${CONTROL}/api/dns-01/publish`, {
        request: { serverId: b.fqdn, recordName: `_acme-challenge.${zone}`, recordValueHash: "00".repeat(32), issuedAt: Date.now() },
        signature: "00".repeat(64),
        recordValue: "attacker",
      });
      assert(r.status === 410, `dns-01/publish ${r.status}: ${short(r.text)}`);
      return "410 dns01-retired";
    });

    // A server the harness registers itself: its key is here, so it can sign what a modified box would.
    const label = `iss${randomBytes(3).toString("hex")}`;
    const fqdn = `${label}.${zone}`;
    const seed = randomBytes(32);
    const stk: Keypair = { privateKey: new Uint8Array(seed), publicKey: ed.getPublicKey(new Uint8Array(seed)) };
    const stkHex = bytesToHex(stk.publicKey);
    let registered = false;
    try {
      await rec.check("register a throwaway server whose key the harness holds", async () => {
        const code = newAuthCode(acct, label);
        if (!acct.demo) {
          const i = await issueAuthCode(code, acct.keys.irk, acct.keys.adminRoot);
          assert(i.status === 200, `auth-code issue ${i.status}: ${short(i.text)}`);
        }
        const request = {
          authCode: code,
          authCodeUserSignature: signAuthCode(code, acct.keys.irk),
          serverIdentityPubKey: stk.publicKey,
          issuedAt: Date.now(),
          nonce: randomBytes(16),
        };
        const r = await postJson(`https://${CONTROL}/api/server/register`, {
          request: {
            authCode: authCodeWire(code),
            authCodeUserSignature: bytesToHex(request.authCodeUserSignature),
            serverIdentityPubKey: stkHex,
            issuedAt: request.issuedAt,
            nonce: bytesToHex(request.nonce),
          },
          signature: bytesToHex(signServerRegister(request, stk)),
        });
        assert(r.status === 200 || r.status === 201, `register ${r.status}: ${short(r.text)}`);
        registered = true;
        return fqdn;
      });
      if (!registered) return;

      const grantAt = Date.now() - 1000;
      const grant = {
        issuedAt: grantAt,
        signature: bytesToHex(signServerWildcardGrant({ username: acct.username, serverDomain: fqdn, stkPubHex: stkHex, issuedAt: grantAt }, (m) => ed.sign(m, acct.keys.adminRoot.privateKey))),
      };
      const order = async (cls: CertificateOrder["class"], names: string[], o: { server?: string | null; withGrant?: boolean } = {}) => {
        const csr = await csrFor(names);
        const der = Buffer.from(csr, "base64url");
        const ord: CertificateOrder = {
          class: cls,
          device: stkHex,
          regGen: cls === "phone" ? 0 : 1,
          csrSha256: createHash("sha256").update(der).digest("hex"),
          requestId: randomBytes(16).toString("hex"),
          issuedAt: Date.now(),
        };
        return postJson(`https://${CONTROL}/api/certificates/orders`, {
          account: acct.username,
          ...(o.server === null ? {} : { server: o.server ?? fqdn }),
          order: ord,
          signature: bytesToHex(signServingRecord("certificate-order", ord, (m) => ed.sign(m, stk.privateKey))),
          csr,
          ...(o.withGrant ? { serverWildcardGrant: grant } : {}),
        });
      };
      const refused = async (what: string, r: Awaited<ReturnType<typeof order>>, codes: string[]) => {
        assert(r.status >= 400 && r.status < 500, `${what}: ${r.status} ${short(r.text)} (expected a refusal)`);
        assert(codes.includes(String(r.json?.code)), `${what}: refused with ${r.json?.code}, expected ${codes.join(" or ")}`);
        return `${what}: ${r.json?.code}`;
      };

      await rec.check("scenario 5: the bare account name alone, as control or apps (with the wildcard grant), is refused", async () => {
        const out = [
          await refused("control", await order("control", [zone]), ["issuance-csr-names"]),
          await refused("apps+grant", await order("apps", [zone], { withGrant: true }), ["issuance-csr-names"]),
        ];
        return out.join("; ");
      });
      await rec.check("scenario 5: mixed orders naming the bare account name are refused", async () => {
        const out = [
          await refused("apps mixed", await order("apps", [`*.${fqdn}`, `*.${zone}`, zone], { withGrant: true }), ["issuance-csr-names"]),
          await refused("control mixed", await order("control", [fqdn, zone]), ["issuance-csr-names"]),
        ];
        return out.join("; ");
      });
      await rec.check("scenario 5: the phone class signed by a box's key is refused", async () => {
        const out = [
          await refused("phone", await order("phone", [zone], { server: null }), ["issuance-not-admin"]),
          await refused("phone with server", await order("phone", [zone]), ["issuance-malformed"]),
        ];
        return out.join("; ");
      });
      await rec.check("a box gets no app certificate for a sibling's name or a forged grant", async () => {
        const out = [
          await refused("sibling", await order("control", [b.fqdn], { server: b.fqdn }), ["issuance-unknown-device"]),
          await refused("no grant", await order("apps", [`*.${fqdn}`, `*.${zone}`]), ["issuance-csr-names"]),
        ];
        return out.join("; ");
      });
    } finally {
      if (registered) {
        await rec.check("cleanup: revoke the throwaway server; its orders are refused from then on", async () => {
          const rv = { userId: acct.username, revokedServerId: fqdn, reason: "decommissioned" as const, issuedAt: Date.now() };
          const r = await postJson(`https://${CONTROL}/api/server-registry/revoke`, { request: rv, signature: bytesToHex(signRevocation(rv, acct.keys.irk)) });
          assert(r.status === 200, `revoke ${r.status}: ${short(r.text)}`);
          const csr = await csrFor([fqdn]);
          const ord: CertificateOrder = {
            class: "control",
            device: stkHex,
            regGen: 1,
            csrSha256: createHash("sha256").update(Buffer.from(csr, "base64url")).digest("hex"),
            requestId: randomBytes(16).toString("hex"),
            issuedAt: Date.now(),
          };
          const after = await postJson(`https://${CONTROL}/api/certificates/orders`, {
            account: acct.username,
            server: fqdn,
            order: ord,
            signature: bytesToHex(signServingRecord("certificate-order", ord, (m) => ed.sign(m, stk.privateKey))),
            csr,
          });
          assert(after.json?.code === "issuance-revoked", `after revocation: ${after.status} ${short(after.text)}`);
          return "revoked; issuance-revoked";
        });
      }
    }
  },
};
