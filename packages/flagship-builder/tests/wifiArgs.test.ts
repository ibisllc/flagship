import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWifiPassword } from "../src/wifiArgs.js";

describe("Wi-Fi password arguments", () => {
  it("reads the inline flag first, then the file, else nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wifi-args-"));
    const file = join(dir, "pw");
    await writeFile(file, "p@ss w0rd\n", { mode: 0o600 });
    expect(await resolveWifiPassword(["--wifi-password", "inline"])).toBe("inline");
    expect(await resolveWifiPassword(["--wifi-password=inline", "--wifi-password-file", file])).toBe("inline");
    expect(await resolveWifiPassword(["--wifi-password-file", file])).toBe("p@ss w0rd");
    expect(await resolveWifiPassword(["--wifi-ssid", "home"])).toBeUndefined();
  });

  it("keeps everything but one trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wifi-args-"));
    const file = join(dir, "pw");
    await writeFile(file, "  spaced  \n\n");
    expect(await resolveWifiPassword([`--wifi-password-file=${file}`])).toBe("  spaced  \n");
  });
});
