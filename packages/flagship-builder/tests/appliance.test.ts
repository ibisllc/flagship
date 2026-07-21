import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPLIANCE_FORBIDDEN_PATHS,
  APPLIANCE_SEED_HEADER_BYTES,
  APPLIANCE_SEED_MAGIC,
  APPLIANCE_SEED_SIZE_BYTES,
  buildAppliancePrepareScript,
  buildApplianceSpecializerScript,
  encodeApplianceSeed,
} from "../src/appliance.js";

describe("generalized VM appliance", () => {
  it("encodes a fixed-size, independently hashed raw seed", () => {
    const recipe = Buffer.from('{"serverDomain":"home.alice.flagship.services"}');
    const seed = Buffer.from(encodeApplianceSeed(recipe, "#!/bin/bash\necho specialize\n"));
    expect(seed.length).toBe(APPLIANCE_SEED_SIZE_BYTES);
    expect(seed.subarray(0, 8).toString("ascii")).toBe(APPLIANCE_SEED_MAGIC);
    const bodyLength = Number.parseInt(seed.subarray(8, 16).toString("ascii"), 16);
    const bodySha = seed.subarray(16, 80).toString("ascii");
    const body = seed.subarray(APPLIANCE_SEED_HEADER_BYTES, APPLIANCE_SEED_HEADER_BYTES + bodyLength);
    expect(createHash("sha256").update(body).digest("hex")).toBe(bodySha);
    const payload = JSON.parse(body.toString("utf8"));
    expect(Buffer.from(payload.recipeBase64, "base64")).toEqual(recipe);
    expect(Buffer.from(payload.bootstrapBase64, "base64").toString()).toContain("specialize");
    expect(payload.recipeSha256).toBe(createHash("sha256").update(recipe).digest("hex"));
  });

  it("specializes only after validating the seed and cleans the public build key last", () => {
    const script = buildApplianceSpecializerScript();
    expect(script).toContain("specialization failed line=$LINENO rc=$rc");
    expect(script).toContain("| xxd -p");
    expect(script).toContain("generalized base readiness marker missing");
    expect(script).toContain("generalized base verified");
    expect(script).toContain(`'${APPLIANCE_SEED_MAGIC}' | xxd -p`);
    expect(script).toContain("sha256sum -c -");
    expect(script).toContain("growpart \"/dev/$ROOT_PARENT\"");
    expect(script).toContain("cryptsetup resize \"$ROOT_MAPPER\"");
    expect(script).toContain("resize2fs \"$ROOT_SOURCE\"");
    expect(script).toContain("FLAGSHIP_APPLIANCE_PREINSTALLED=1");
    expect(script).toContain("canonical bootstrap failed rc=$BOOTSTRAP_RC");
    expect(script).toContain("grep -E '^\\[flagship-bootstrap\\] (FATAL|ERROR|WARN(ING)?):'");
    expect(script.indexOf("FLAGSHIP_APPLIANCE_PREINSTALLED=1")).toBeLessThan(
      script.indexOf("rm -f /etc/flagship/appliance-build.key"),
    );
    expect(script).toContain('cryptsetup luksRemoveKey "$ROOT_LUKS_PART" /etc/flagship/appliance-build.key');
    expect(script).toContain("systemctl poweroff");
  });

  it("prepares a secret-free image and declares the generalization audit", () => {
    const script = buildAppliancePrepareScript({ gitRef: "v-test" });
    expect(script).toContain(".flagship-appliance-ref");
    expect(script).toContain("KEYFILE_PATTERN=/etc/flagship/appliance-build.key");
    expect(script).toContain("flagship-appliance-specialize.service");
    expect(script).toContain("npx tsc -b\n");
    expect(script).toContain("workspace link missing");
    expect(script).toContain("/usr/local/lib/flagship-appliance/flagship-unseal");
    expect(script).toContain("GOMODCACHE=/root/go/pkg/mod");
    expect(script).toContain("git clone --depth 2");
    expect(script).toContain("rm -rf /root/go /root/.cache/go-build /root/.npm /root/.cache");
    expect(script).toContain("apt-get clean");
    expect(script).toContain("rm -rf /var/lib/apt/lists/*");
    expect(script).toContain("touch /etc/flagship/appliance-ready");
    expect(script).not.toContain("npx tsc -b || true");
    for (const path of APPLIANCE_FORBIDDEN_PATHS) {
      expect(script).toContain(path);
    }
    expect(script).not.toContain("home.alice");
  });

  it("purges the Go toolchain, but only after the static unseal helper is built", () => {
    const script = buildAppliancePrepareScript({ gitRef: "v-test" });
    expect(script).toContain("apt-get purge -y golang-go golang-*");
    expect(script).toContain("apt-get autoremove -y --purge");
    // The one-shot go build MUST run before the compiler is removed, and the
    // built static binary is guarded before the purge.
    const buildAt = script.indexOf("GOMODCACHE=/root/go/pkg/mod");
    const guardAt = script.indexOf("unseal helper missing before Go purge");
    const purgeAt = script.indexOf("apt-get purge -y golang-go golang-*");
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(purgeAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeLessThan(guardAt);
    expect(guardAt).toBeLessThan(purgeAt);
  });

  it("strips docs, manuals, and surplus locales while preserving C.UTF-8", () => {
    const script = buildAppliancePrepareScript({ gitRef: "v-test" });
    expect(script).toContain("rm -rf /usr/share/doc/* /usr/share/man/* /usr/share/info/*");
    expect(script).toContain("dpkg.cfg.d/flagship-appliance-lean");
    expect(script).toContain("path-exclude=/usr/share/doc/*");
    expect(script).toContain("path-exclude=/usr/share/man/*");
    // The dpkg exclude config must be written BEFORE packages are installed so
    // the docs never land in the first place.
    const excludeAt = script.indexOf("dpkg.cfg.d/flagship-appliance-lean");
    const installAt = script.indexOf("apt-get -o Acquire::Retries=3");
    expect(excludeAt).toBeGreaterThanOrEqual(0);
    expect(installAt).toBeGreaterThanOrEqual(0);
    expect(excludeAt).toBeLessThan(installAt);
    // Locale purge keeps C / C.UTF-8 (do NOT break UTF-8) and en_US.
    expect(script).toContain("/usr/share/locale");
    expect(script).toContain("! -name 'C.UTF-8'");
    expect(script).toContain("! -name 'en_US'");
    expect(script).not.toContain("rm -rf /usr/share/locale/*");
  });
});
