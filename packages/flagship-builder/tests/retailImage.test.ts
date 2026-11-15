import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed, signAuthCode, signInstallBlob, type AuthCode, type InstallBlob } from "@flagship/protocol";
import { buildBootstrapFromRecipe } from "../src/preseedEngine.js";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RETAIL_HOST_FILES } from "@flagship/boot-chain";
import { APPLIANCE_FORBIDDEN_PATHS, RETAIL_CLAIMED_RECIPE, RETAIL_FIRST_BOOT_DONE, RETAIL_MARKER, buildApplianceSpecializerScript } from "../src/appliance.js";
import { DAEMON_UNIT_PATH, daemonServiceUnit } from "../src/daemonUnit.js";
import { RETAIL_FORBIDDEN_PATHS, RETAIL_IMAGE_MARKER_PATH, SPECIALIZER_RETAIL_DROP_IN, SPECIALIZER_RETAIL_DROP_IN_PATH, buildRetailImageLayerScript, retailImageMarker } from "../src/retailImage.js";

const keydReset = readFileSync(fileURLToPath(new URL("../../keyd/src/reset.ts", import.meta.url)), "utf8");
const daemonPaths = readFileSync(fileURLToPath(new URL("../../server-daemon/src/retailClaim/daemon.ts", import.meta.url)), "utf8");
const daemonWipe = readFileSync(fileURLToPath(new URL("../../server-daemon/src/retailClaim/wipe.ts", import.meta.url)), "utf8");

describe("retail image layer", () => {
  const script = buildRetailImageLayerScript();

  it("is valid bash", () => {
    const r = spawnSync("bash", ["-n"], { input: script });
    expect(r.status, r.stderr?.toString()).toBe(0);
  });

  it("installs BlueZ and every claim host file byte for byte", () => {
    expect(script).toContain("install -y --no-install-recommends bluez");
    expect(script).toContain("systemctl enable bluetooth.service");
    for (const f of RETAIL_HOST_FILES) {
      expect(script).toContain(`cat > ${f.path} <<'FLAGSHIP_RETAIL_HOST_EOF'\n${f.content}FLAGSHIP_RETAIL_HOST_EOF\nchmod 644 ${f.path}\n`);
    }
    expect(script).toContain("groupadd --system flagship-powerkey");
  });

  it("never adds the daemon to the bluetooth or input group", () => {
    expect(script).not.toMatch(/usermod|gpasswd|adduser/);
    expect(script).not.toMatch(/SupplementaryGroups=[^\n]*\b(bluetooth|input)\b/);
  });

  it("carries no box key: keyd's unit is installed, its state emptied and checked", () => {
    expect(script).toContain("systemctl enable flagship-keyd.service");
    expect(script).toContain("find /var/lib/flagship-keyd -mindepth 1 -delete");
    expect(script).not.toMatch(/identity(-mldsa)?\.key[^\s]*\s*<<|> *\/var\/lib\/flagship-keyd/);
    for (const p of [...APPLIANCE_FORBIDDEN_PATHS, "/var/lib/flagship-keyd/identity.key", "/var/lib/flagship-keyd/identity-mldsa.key"]) {
      expect(RETAIL_FORBIDDEN_PATHS).toContain(p);
      expect(script).toContain(p);
    }
    expect(script).toContain("rm -rf /var/flagship/identity /var/lib/flagship-retail /var/lib/bluetooth/*");
  });

  it("starts the daemon with no daemon.env, and runs the specializer only once a claim left a recipe", () => {
    expect(script).toContain(`cat > ${DAEMON_UNIT_PATH} <<'FLAGSHIP_RETAIL_DAEMON_EOF'\n${daemonServiceUnit({ envFileOptional: true })}FLAGSHIP_RETAIL_DAEMON_EOF`);
    expect(daemonServiceUnit({ envFileOptional: true })).toContain("EnvironmentFile=-/etc/flagship/daemon.env\n");
    expect(daemonServiceUnit()).toContain("EnvironmentFile=/etc/flagship/daemon.env\n");
    expect(script).toContain("systemctl enable flagship-daemon.service");
    expect(script).not.toContain("ln -s /dev/null /etc/systemd/system/flagship-appliance-specialize.service");
    expect(SPECIALIZER_RETAIL_DROP_IN).toContain(`ConditionPathExists=${RETAIL_CLAIMED_RECIPE}`);
    expect(SPECIALIZER_RETAIL_DROP_IN).toContain("Before=flagship-daemon.service flagship-claim.service");
    expect(script).toContain("systemctl enable flagship-claim-helper.service flagship-claim.service");
    expect(script).toContain(`cat > ${SPECIALIZER_RETAIL_DROP_IN_PATH} <<'FLAGSHIP_RETAIL_HOST_EOF'\n${SPECIALIZER_RETAIL_DROP_IN}FLAGSHIP_RETAIL_HOST_EOF`);
  });

  it("writes the marker keyd and the daemon read, devices null until a SKU's layout exists", () => {
    expect(keydReset).toContain(`RETAIL_IMAGE_MARKER_PATH = "${RETAIL_IMAGE_MARKER_PATH}"`);
    expect(daemonWipe).toContain("RETAIL_IMAGE_MARKER = RETAIL_IMAGE_MARKER_PATH");
    expect(JSON.parse(retailImageMarker())).toEqual({ v: 1, dataLuksDevice: null, recoveryPartition: null });
    expect(script).toContain(`cat > ${RETAIL_IMAGE_MARKER_PATH} <<'FLAGSHIP_RETAIL_MARKER_EOF'\n${retailImageMarker()}FLAGSHIP_RETAIL_MARKER_EOF`);
    expect(JSON.parse(retailImageMarker({ dataLuksDevice: "/dev/disk/by-partlabel/flagship_data", recoveryPartition: "/dev/disk/by-partlabel/flagship_recovery" }))).toEqual({
      v: 1,
      dataLuksDevice: "/dev/disk/by-partlabel/flagship_data",
      recoveryPartition: "/dev/disk/by-partlabel/flagship_recovery",
    });
    expect(() => retailImageMarker({ dataLuksDevice: "/dev/sda; rm -rf /" })).toThrow();
    expect(() => buildRetailImageLayerScript({ recoveryPartition: "../etc" })).toThrow();
  });
});

describe("the specializer as a retail box's first boot", () => {
  const spec = buildApplianceSpecializerScript();

  it("is valid bash and uses the claim's files", () => {
    expect(spawnSync("bash", ["-n"], { input: spec }).status).toBe(0);
    expect(RETAIL_MARKER).toBe(RETAIL_IMAGE_MARKER_PATH);
    expect(daemonPaths).toContain('recipe: join(dir, "claimed-recipe.json")');
    expect(daemonPaths).toContain('firstBootDone: join(dir, "first-boot-done")');
    expect(RETAIL_CLAIMED_RECIPE).toBe("/var/lib/flagship-retail/claimed-recipe.json");
    expect(RETAIL_FIRST_BOOT_DONE).toBe("/var/lib/flagship-retail/first-boot-done");
  });

  it("makes the seed from the claimed recipe, keeps keyd's key, marks the first boot and restarts", () => {
    expect(spec).toContain(`if [ -f ${RETAIL_MARKER} ]; then RETAIL=1; fi`);
    expect(spec).toContain(`packages/server-daemon/dist/retailClaim/seedCli.js \\\n        ${RETAIL_CLAIMED_RECIPE} /opt/flagship/packages/flagship-builder/engine/preseed-engine.js`);
    expect(spec).toContain('FLAGSHIP_APPLIANCE_PREINSTALLED=1 FLAGSHIP_BOX_KEY_IN_KEYD="$RETAIL" /usr/local/sbin/flagship-bootstrap.sh');
    expect(spec).toContain(`if [ "$RETAIL" = 1 ]; then date > ${RETAIL_FIRST_BOOT_DONE}; fi`);
    expect(spec).toMatch(/if \[ "\$RETAIL" = 1 \]; then\n.*\n    systemctl reboot\nelse\n.*\n    systemctl poweroff\nfi/);
    // A VM still reads its seed disk, checked against its header digest.
    expect(spec).toContain('echo "$BODY_SHA  /run/flagship-appliance/seed.json" | sha256sum -c -');
  });
});

describe("the bootstrap keeps keyd's key on a retail box", () => {
  const irk = { privateKey: new Uint8Array(32).fill(0x11), publicKey: ed.getPublicKey(new Uint8Array(32).fill(0x11)) };
  const h = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const t0 = 1_800_000_000_000;
  const c: AuthCode = {
    version: 1, serial: "retail-serial-1-xxxx", username: "harry", serverName: "home", serverDomain: "home.harry.flagship.services",
    delegatedPubKey: ed.getPublicKey(new Uint8Array(32).fill(0x61)), userPubKey: irk.publicKey, issuedAt: t0, expiresAt: t0 + 3600_000,
  };
  const blob: InstallBlob = {
    version: 2, serverDomain: c.serverDomain, username: "harry", serverName: "home", phoneDelegatedPubKey: c.delegatedPubKey,
    registrationUrl: "https://flagshipserver.com/api/server/register", authCode: c, authCodeUserSignature: signAuthCode(c, irk),
    installerGitRef: "a".repeat(40), rckPubKey: ed.getPublicKey(new Uint8Array(32).fill(0x71)),
  };
  const wire = (v: unknown): unknown =>
    v instanceof Uint8Array ? h(v) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)])) : v;
  const recipe = JSON.stringify({ blob: wire(blob), blobSignature: h(signInstallBlob(blob, irk)) });
  const bootstrap = buildBootstrapFromRecipe(recipe, "{}");
  const start = bootstrap.indexOf("# Generate server identity.");
  const endMark = 'ID_ARGS=(--priv-hex "$SERVER_IDENTITY_PRIV_HEX")\nfi\n';
  const block = bootstrap.slice(start, bootstrap.indexOf(endMark) + endMark.length);

  function run(keydMode: boolean, preexisting = false) {
    const dir = mkdtempSync(join(tmpdir(), "retail-boot-"));
    if (preexisting) {
      mkdirSync(join(dir, "identity"));
      writeFileSync(join(dir, "identity", "identity.priv.hex"), "22".repeat(32));
    }
    const stub = `flagship-tsx() {
  echo "$*" >> ${dir}/calls
  case "$2" in
    keyd-public-key) echo ${"ab".repeat(32)} ;;
    gen-identity) echo ${"11".repeat(32)} > "$4"; echo ${"cd".repeat(32)} > "$6" ;;
  esac
}
`;
    const body = block.replaceAll("/var/flagship/identity", `${dir}/identity`);
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${stub}${body}\necho "RESULT|$SERVER_IDENTITY_PRIV_HEX|$SERVER_IDENTITY_PUB_HEX|\${ID_ARGS[*]}"`], {
      env: { PATH: process.env.PATH, FLAGSHIP_BOX_KEY_IN_KEYD: keydMode ? "1" : "0" },
    });
    const out = r.stdout.toString();
    return { status: r.status, out, err: r.stderr.toString(), dir, result: out.split("\n").find((l) => l.startsWith("RESULT|")) };
  }

  it("asks keyd for its key, writes no private key and signs through keyd", () => {
    expect(start).toBeGreaterThan(0);
    for (const step of ["sign-server-register", "sign-boot-key-binding"]) {
      expect(bootstrap).toMatch(new RegExp(`install-helper\\.ts ${step} "\\$\\{ID_ARGS\\[@\\]\\}"`));
    }
    expect(bootstrap).toContain('flagship-tsx scripts/install-helper.ts sign-sealed-key "${SEAL_ID_ARGS[@]}"');
    const r = run(true);
    expect(r.status, r.err).toBe(0);
    expect(r.result).toBe(`RESULT||${"ab".repeat(32)}|--keyd-socket /run/flagship-keyd/keyd.sock`);
    expect(existsSync(join(r.dir, "identity", "identity.priv.hex"))).toBe(false);
    expect(readFileSync(join(r.dir, "identity", "identity.pub.hex"), "utf8").trim()).toBe("ab".repeat(32));
    expect(readFileSync(join(r.dir, "calls"), "utf8")).not.toContain("gen-identity");
  });

  it("refuses a key file beside keyd's key", () => {
    const r = run(true, true);
    expect(r.status).not.toBe(0);
    expect(r.out + r.err).toContain("a box key file exists beside keyd's key");
  });

  it("every other box still makes its key at install", () => {
    const r = run(false);
    expect(r.status, r.err).toBe(0);
    expect(r.result).toBe(`RESULT|${"11".repeat(32)}|${"cd".repeat(32)}|--priv-hex ${"11".repeat(32)}`);
  });
});
