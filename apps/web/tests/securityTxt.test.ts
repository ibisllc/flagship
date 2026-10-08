import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const PGP_FINGERPRINT = "D96D675DB03E3F3BBC8870302308936D215496D0";

describe("/.well-known/security.txt (RFC 9116)", () => {
  it("is served and contains the required Contact + Expires fields", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/.well-known/security.txt" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Contact: mailto:security@flagshipserver.com");
    expect(r.body).toContain("Expires:");
    expect(r.body).toContain("Canonical:");
  });

  it("Expires is a valid RFC 3339 timestamp in the future", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/.well-known/security.txt" });
    const m = r.body.match(/Expires: (.+)/);
    expect(m).not.toBeNull();
    const t = Date.parse(m![1]!.trim());
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThan(Date.now());
  });

  it("Policy + web Contact point at the one-page /security sections", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/.well-known/security.txt" });
    expect(r.body).toContain("Policy: https://flagshipserver.com/security#disclosure");
    expect(r.body).toContain("Contact: https://flagshipserver.com/security#report");
  });
});

describe("/security (model + disclosure + report on one page)", () => {
  it("has a section for each nav anchor", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/security.html" });
    expect(r.statusCode).toBe(200);
    for (const id of ["model", "disclosure", "report"]) {
      expect(r.body).toContain(`id="${id}"`);
      expect(r.body).toContain(`href="#${id}"`);
    }
    expect(r.body).toContain('id="report-form"');
    expect(r.body).toContain('"/api/security/report"');
  });

  it("the old disclosure + report URLs redirect to their sections", async () => {
    const app = buildServer();
    for (const id of ["disclosure", "report"]) {
      const r = await app.inject({ method: "GET", url: `/security/${id}.html` });
      expect(r.body).toContain(`location.replace("/security#${id}")`);
    }
  });

  it("the disclosure section lists scope + payouts + SLA", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/security.html" });
    expect(r.statusCode).toBe(200);
    // Scope (in + out) — both the in-scope marker and the explicit out-of-scope items.
    expect(r.body).toContain("In scope");
    expect(r.body).toContain("Out of scope");
    expect(r.body).toContain("@flagship/protocol");
    // Payout table — at least the four severity tiers labelled.
    expect(r.body).toContain("Critical");
    expect(r.body).toContain("High");
    expect(r.body).toContain("Medium");
    expect(r.body).toContain("Low");
    // SLA — initial ack window posted up front.
    expect(r.body).toContain("Initial acknowledgement");
    // Safe harbor language present.
    expect(r.body).toContain("Safe harbor");
  });
});

describe("security@ PGP key", () => {
  it("security.txt advertises the published public key", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/.well-known/security.txt" });
    expect(r.body).toContain("Encryption: https://flagshipserver.com/.well-known/pgp-key.txt");
    const key = await app.inject({ method: "GET", url: "/.well-known/pgp-key.txt" });
    expect(key.statusCode).toBe(200);
    expect(key.body).toContain("-----BEGIN PGP PUBLIC KEY BLOCK-----");
  });

  it("the report section shows the key's fingerprint", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/security.html" });
    const shown = r.body.match(/<code class="fpr">([^<]+)<\/code>/)?.[1] ?? "";
    expect(shown.replace(/&nbsp;|\s/g, "")).toBe(PGP_FINGERPRINT);
  });

  it("the Web Key Directory entry and its policy file are present", () => {
    // z-base-32 SHA-1 of "security" — `gpg --with-wkd-hash`.
    const wkd = readFileSync(join(PUBLIC_DIR, ".well-known/openpgpkey/hu/t5s8ztdbon8yzntexy6oz5y48etqsnbb"));
    expect(wkd.length).toBeGreaterThan(0);
    expect(wkd.toString("hex").toUpperCase()).toContain(PGP_FINGERPRINT.slice(-16));
    expect(statSync(join(PUBLIC_DIR, ".well-known/openpgpkey/policy")).isFile()).toBe(true);
  });

  it("no private key material is ever published", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of walk(join(PUBLIC_DIR, ".well-known"))) {
      expect(readFileSync(file, "latin1"), file).not.toContain("PRIVATE KEY BLOCK");
    }
  });
});
