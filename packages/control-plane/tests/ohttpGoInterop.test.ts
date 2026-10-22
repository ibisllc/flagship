// The initramfs OHTTP client (the Go flagship-unseal helper's ohttp-seal /
// ohttp-open) against `.com`'s TS gateway: what a proxy box will do at boot
// (docs/outbound-proxy.md). Skipped where Go isn't installed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeOhttpKeyConfig } from "@flagship/protocol";
import { handleOhttpGateway, ohttpGatewayKeysFromEnv } from "../src/index.js";

const HELPER_DIR = resolve(__dirname, "../../../installer/unseal-helper");
let hasGo = true;
try {
  execFileSync("go", ["version"], { stdio: "ignore" });
} catch {
  hasGo = false;
}

describe.skipIf(!hasGo)("Go ohttp-seal/ohttp-open against the TS gateway", () => {
  it("carries a signed boot-response poll and reads the answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohttp-go-"));
    const bin = join(dir, "flagship-unseal");
    execFileSync("go", ["build", "-o", bin, "."], { cwd: HELPER_DIR });

    const keys = ohttpGatewayKeysFromEnv(`5:${"77".repeat(32)}`);
    const keyHex = Buffer.from(encodeOhttpKeyConfig(keys[0]!)).toString("hex");
    execFileSync(bin, [
      "ohttp-seal",
      "--key-config-hex", keyHex,
      "--method", "GET",
      "--url", "https://boot.flagshipserver.com/api/boot/response/home.a.flagship.services/n0nce",
      "--header", "Authorization: Flagship-Boot-v1 sig",
      "--out-request", join(dir, "req.bin"),
      "--out-context", join(dir, "ctx.hex"),
    ]);

    let seen: Request | null = null;
    const res = await handleOhttpGateway(
      new Request("https://flagshipserver.com/api/ohttp/gateway", {
        method: "POST",
        headers: { "content-type": "message/ohttp-req" },
        body: readFileSync(join(dir, "req.bin")),
      }),
      {
        keys,
        apexHost: "flagshipserver.com",
        bootHost: "boot.flagshipserver.com",
        dispatch: async (req) => {
          seen = req;
          return new Response('{"sealed":"abcd"}', { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    );
    expect(res.status).toBe(200);
    expect(seen!.url).toBe("https://boot.flagshipserver.com/api/boot/response/home.a.flagship.services/n0nce");
    expect(seen!.headers.get("authorization")).toBe("Flagship-Boot-v1 sig");

    writeFileSync(join(dir, "res.bin"), new Uint8Array(await res.arrayBuffer()));
    const status = execFileSync(bin, [
      "ohttp-open",
      "--context", join(dir, "ctx.hex"),
      "--response-file", join(dir, "res.bin"),
      "--out-body", join(dir, "body.json"),
    ]).toString();
    expect(status).toBe("200");
    expect(readFileSync(join(dir, "body.json"), "utf8")).toBe('{"sealed":"abcd"}');
  }, 120_000);
});
