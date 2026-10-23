import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYD_CLIENT_GROUP, KEYD_REQUIRED_PROPERTIES, KEYD_USER, daemonKeydDropIn, keydServiceUnit, keydSetupScript, migrateKeyFiles, scrubEnvFile } from "../src/index.js";

describe("the keyd systemd unit", () => {
  const unit = keydServiceUnit();
  const directive = (name: string) => unit.split("\n").filter((l) => l.startsWith(`${name}=`)).map((l) => l.slice(name.length + 1));

  it("carries every property the appliance check requires", () => {
    for (const [k, v] of Object.entries(KEYD_REQUIRED_PROPERTIES)) {
      expect(directive(k), k).toContain(v === "" ? "" : v);
    }
  });

  it("runs as its own user, on a Unix socket only, with no network, devices or privileges", () => {
    expect(directive("User")).toEqual([KEYD_USER]);
    expect(directive("RestrictAddressFamilies")).toEqual(["AF_UNIX"]);
    expect(directive("PrivateNetwork")).toEqual(["yes"]);
    expect(directive("CapabilityBoundingSet")).toEqual([""]);
    expect(directive("LimitCORE")).toEqual(["0"]);
    expect(directive("MemoryDenyWriteExecute")).toEqual(["yes"]);
    expect(unit).toContain("SystemCallFilter=~@privileged");
  });

  it("migrates keys in before it serves, with full privileges for that one command only", () => {
    const pre = directive("ExecStartPre");
    expect(pre).toHaveLength(1);
    expect(pre[0]).toMatch(/^\+\/usr\/bin\/env .* migrate$/);
    expect(directive("ExecStart")[0]).toMatch(/ serve$/);
  });

  it("serves without a JIT, since MemoryDenyWriteExecute makes V8's JIT abort at start-up", () => {
    expect(directive("MemoryDenyWriteExecute")).toEqual(["yes"]);
    expect(directive("ExecStart")[0]).toMatch(/^\S+\/node --jitless \S+ serve$/);
  });

  it("gives the daemon the socket and orders it after keyd", () => {
    const d = daemonKeydDropIn();
    expect(d).toContain("Requires=flagship-keyd.service");
    expect(d).toContain("After=flagship-keyd.service");
    expect(d).toContain(`SupplementaryGroups=${KEYD_CLIENT_GROUP}`);
  });

  it("creates the user and group without a shell, home or login", () => {
    const s = keydSetupScript();
    expect(s).toContain("useradd --system");
    expect(s).toContain("--shell /usr/sbin/nologin");
    expect(s).toContain("install -d -m 0700");
  });
});

describe("key migration", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "keyd-mig-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const KEY = "ab".repeat(32);
  const setup = () => {
    mkdirSync(join(dir, "legacy/identity"), { recursive: true });
    writeFileSync(join(dir, "legacy/identity/identity.priv.hex"), KEY + "\n");
    writeFileSync(join(dir, "legacy/swk.hex"), "cd".repeat(32) + "\n");
  };

  it("moves each key into the keyd directory 0400 and removes the readable copy", () => {
    setup();
    const r = migrateKeyFiles({ legacyDir: join(dir, "legacy"), keydDir: join(dir, "keyd") });
    expect(r).toEqual({ moved: ["identity", "swk"], alreadyThere: [], missing: ["cgk"] });
    expect(readFileSync(join(dir, "keyd/identity.key"), "utf8").trim()).toBe(KEY);
    expect(statSync(join(dir, "keyd/identity.key")).mode & 0o777).toBe(0o400);
    expect(existsSync(join(dir, "legacy/identity/identity.priv.hex"))).toBe(false);
    expect(existsSync(join(dir, "legacy/swk.hex"))).toBe(false);
  });

  it("is safe to run again, and refuses to guess when the two copies differ", () => {
    setup();
    migrateKeyFiles({ legacyDir: join(dir, "legacy"), keydDir: join(dir, "keyd") });
    expect(migrateKeyFiles({ legacyDir: join(dir, "legacy"), keydDir: join(dir, "keyd") })).toMatchObject({ moved: [], alreadyThere: ["identity", "swk"] });
    writeFileSync(join(dir, "legacy/swk.hex"), "ee".repeat(32) + "\n");
    expect(() => migrateKeyFiles({ legacyDir: join(dir, "legacy"), keydDir: join(dir, "keyd") })).toThrow(/differs/);
    expect(existsSync(join(dir, "legacy/swk.hex"))).toBe(true);
  });

  it("refuses a file that is not a 32-byte hex key and leaves it where it was", () => {
    mkdirSync(join(dir, "legacy/identity"), { recursive: true });
    writeFileSync(join(dir, "legacy/identity/identity.priv.hex"), "not a key\n");
    expect(() => migrateKeyFiles({ legacyDir: join(dir, "legacy"), keydDir: join(dir, "keyd") })).toThrow(/32-byte/);
    expect(existsSync(join(dir, "legacy/identity/identity.priv.hex"))).toBe(true);
  });

  it("scrubs only the named variables from an environment file", () => {
    const f = join(dir, "daemon.env");
    writeFileSync(f, `FLAGSHIP_SUBDOMAIN=home.a.flagship.services\nFLAGSHIP_IDENTITY_PRIV_HEX=${KEY}\nOTHER=1\n`, { mode: 0o600 });
    expect(scrubEnvFile(f, ["FLAGSHIP_IDENTITY_PRIV_HEX"])).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("FLAGSHIP_SUBDOMAIN=home.a.flagship.services\nOTHER=1\n");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(scrubEnvFile(f, ["FLAGSHIP_IDENTITY_PRIV_HEX"])).toBe(false);
    expect(scrubEnvFile(join(dir, "missing.env"), ["X"])).toBe(false);
  });
});

import { TLSD_REQUIRED_PROPERTIES, TLSD_USER, daemonTlsdDropIn, legacyTlsFiles, loadPolicy, namesFor, tlsdServiceUnit, tlsdSetupScript, writePolicyFromEnv } from "../src/index.js";

describe("the tlsd unit", () => {
  const unit = tlsdServiceUnit();
  const directive = (name: string) => unit.split("\n").filter((l) => l.startsWith(`${name}=`)).map((l) => l.slice(name.length + 1));

  it("carries every required property and holds no key", () => {
    for (const [k, v] of Object.entries(TLSD_REQUIRED_PROPERTIES)) expect(directive(k), k).toContain(v);
    expect(unit).not.toMatch(/Environment=.*(KEY|SEED|PRIV)/i);
  });

  it("listens on loopback only, talks to two Unix sockets and has no capabilities", () => {
    expect(directive("ExecStart")[0]).toContain("--listen 127.0.0.1:18443");
    expect(directive("IPAddressDeny")).toEqual(["any"]);
    expect(directive("IPAddressAllow")).toEqual(["localhost"]);
    expect(directive("CapabilityBoundingSet")).toEqual([""]);
    expect(directive("User")).toEqual([TLSD_USER]);
  });

  it("is ordered after keyd and cannot run without it", () => {
    expect(unit).toContain("Requires=flagship-keyd.service");
    expect(daemonTlsdDropIn()).toContain("FLAGSHIP_TLS_UPSTREAM=/run/flagship-tls/upstream.sock");
    // systemd resets the directory's owner before every Exec command; the daemon sets the group itself.
    expect(daemonTlsdDropIn()).not.toMatch(/^ExecStartPre=/m);
    expect(tlsdSetupScript()).toContain("--shell /usr/sbin/nologin");
  });
});

describe("keyd's policy from the box's own recipe", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "keyd-pol-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("takes the server name once from the environment file and never changes it", () => {
    const env = join(dir, "daemon.env");
    writeFileSync(env, "FLAGSHIP_SUBDOMAIN=Home.Alice.Flagship.Services\nOTHER=1\n");
    expect(writePolicyFromEnv(env, join(dir, "k"))).toEqual({ serverFqdn: "home.alice.flagship.services" });
    writeFileSync(env, "FLAGSHIP_SUBDOMAIN=evil.example.com\n");
    expect(writePolicyFromEnv(env, join(dir, "k"))).toEqual({ serverFqdn: "home.alice.flagship.services" });
    expect(loadPolicy(join(dir, "k"))).toEqual({ serverFqdn: "home.alice.flagship.services" });
    expect(namesFor("home.alice.flagship.services")).toEqual(["home.alice.flagship.services", "*.home.alice.flagship.services", "*.alice.flagship.services"]);
  });

  it("refuses a missing file or a name that is not a hostname", () => {
    expect(writePolicyFromEnv(join(dir, "nope.env"), join(dir, "k"))).toBeNull();
    writeFileSync(join(dir, "bad.env"), "FLAGSHIP_SUBDOMAIN=not a host\n");
    expect(writePolicyFromEnv(join(dir, "bad.env"), join(dir, "k"))).toBeNull();
  });

  it("finds the PEM files an older process wrote", () => {
    mkdirSync(join(dir, "acme/cert"), { recursive: true });
    expect(legacyTlsFiles(dir, "home.a.flagship.services")).toBeNull();
    writeFileSync(join(dir, "acme/cert/home.a.flagship.services.key"), "k");
    writeFileSync(join(dir, "acme/cert/home.a.flagship.services.pem"), "c");
    expect(legacyTlsFiles(dir, "home.a.flagship.services")).toEqual({
      keyPath: join(dir, "acme/cert/home.a.flagship.services.key"),
      certPath: join(dir, "acme/cert/home.a.flagship.services.pem"),
    });
  });
});
