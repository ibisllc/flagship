import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RETAIL_HOST_FILES } from "@flagship/boot-chain";
import { APPLIANCE_FORBIDDEN_PATHS } from "../src/appliance.js";
import { RETAIL_FORBIDDEN_PATHS, RETAIL_IMAGE_MARKER_PATH, buildRetailImageLayerScript, retailImageMarker } from "../src/retailImage.js";

const keydReset = readFileSync(fileURLToPath(new URL("../../keyd/src/reset.ts", import.meta.url)), "utf8");
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

  it("masks the seed-disk specializer: a retail box takes its recipe over the claim", () => {
    expect(script).toContain("ln -s /dev/null /etc/systemd/system/flagship-appliance-specialize.service");
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
