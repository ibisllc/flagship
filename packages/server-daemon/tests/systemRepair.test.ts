import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDpkgSearch, parseDpkgVerify, repairSystemPackages } from "../src/systemRepair.js";
import type { CommandRunner } from "../src/serviceRunner.js";

const LIB = "/usr/lib/aarch64-linux-gnu/libsystemd.so.0.40.0";
const DEB = Buffer.from("!<arch>\nlibsystemd0 257.9-1~deb13u1\n");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function stanza(pkg: string, version: string, arch: string, file: string, hash: string): string {
  return [`Package: ${pkg}`, "Source: systemd", `Version: ${version}`, `Architecture: ${arch}`, "Description: x", " continued", `Filename: ${file}`, `SHA256: ${hash}`, ""].join("\n");
}

async function lists(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lists-"));
  await writeFile(join(dir, "deb.debian.org_debian_dists_trixie_main_binary-arm64_Packages"), content);
  await writeFile(join(dir, "lock"), "");
  return dir;
}

function box(o: { damaged: () => boolean; dpkgFails?: boolean }) {
  const calls: string[] = [];
  let installed = false;
  const cmd: Required<CommandRunner> = {
    run: async (c, a) => {
      calls.push(`${c} ${a.join(" ")}`);
      if (c === "env" && a.includes("-i")) {
        if (o.dpkgFails) throw new Error("dpkg exited with code 1");
        installed = true;
      }
      if (c === "env" && a.includes("--configure")) installed = true;
    },
    capture: async (c, a) => {
      calls.push(`${c} ${a.join(" ")}`);
      if (c === "dpkg" && a[0] === "--verify") {
        const bad = o.damaged() && !installed;
        const out = ["??5?????? c /etc/default/docker", "missing     /usr/share/doc/foo/changelog.gz", ...(bad ? [`??5??????   ${LIB}`] : [])].join("\n");
        throw Object.assign(new Error("dpkg exited with code 1"), { stdout: out });
      }
      if (c === "dpkg-query" && a[0] === "-S") return { stdout: `libsystemd0:arm64: ${LIB}\n`, stderr: "" };
      if (c === "dpkg-query" && a[0] === "-W") return { stdout: "libsystemd0\t257.9-1~deb13u1\tarm64\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  return { cmd, calls };
}

describe("repairing damaged system files", () => {
  it("reads only content mismatches outside conffiles and stripped docs", () => {
    expect(
      parseDpkgVerify(["??5??????   /usr/lib/x.so", "??5?????? c /etc/x.conf", "missing     /usr/lib/y.so", "?????????   /usr/bin/z", "??5??????   /usr/share/doc/a/copyright", "??5??????   /var/lib/x"].join("\n")),
    ).toEqual(["/usr/lib/x.so"]);
    expect(parseDpkgSearch("libc6:arm64, libc6:armhf: /usr/lib/x.so\ndiversion by dash from: /usr/bin/sh\nsystemd: /usr/bin/systemctl\n")).toEqual(["libc6", "systemd"]);
  });

  it("does nothing when every package file matches", async () => {
    const b = box({ damaged: () => false });
    expect(await repairSystemPackages({ cmd: b.cmd, listsDir: await lists("") })).toEqual({ ok: true, packages: [] });
    expect(b.calls.some((c) => c.startsWith("env"))).toBe(false);
  });

  it("reinstalls the exact installed version, downloaded and checked against apt's list", async () => {
    const b = box({ damaged: () => true });
    const listsDir = await lists(
      stanza("libsystemd0", "257.8-1", "arm64", "pool/main/s/systemd/libsystemd0_257.8-1_arm64.deb", "00".repeat(32)) +
        "\n" +
        stanza("libsystemd0", "257.9-1~deb13u1", "arm64", "pool/main/s/systemd/libsystemd0_257.9-1~deb13u1_arm64.deb", sha(DEB)),
    );
    const fetched: string[] = [];
    const r = await repairSystemPackages({
      cmd: b.cmd,
      listsDir,
      archivesDir: join(listsDir, "none"),
      workDir: join(listsDir, "work"),
      fetch: async (u) => {
        fetched.push(u);
        return new Response(DEB);
      },
    });
    expect(r).toEqual({ ok: true, packages: ["libsystemd0"] });
    expect(fetched).toEqual(["https://deb.debian.org/debian/pool/main/s/systemd/libsystemd0_257.9-1~deb13u1_arm64.deb"]);
    expect(b.calls.find((c) => c.includes(" -i "))).toMatch(/^env DEBIAN_FRONTEND=noninteractive dpkg --force-confdef --force-confold -i .*libsystemd0_257\.9-1~deb13u1_arm64\.deb$/);
    expect(b.calls).toContain("dpkg --verify libsystemd0");
    expect(b.calls.some((c) => c.startsWith("apt-get"))).toBe(false);
  });

  it("uses apt's cached .deb when it matches, and refuses one that doesn't", async () => {
    const b = box({ damaged: () => true });
    const listsDir = await lists(stanza("libsystemd0", "257.9-1~deb13u1", "arm64", "pool/x.deb", sha(DEB)));
    const archivesDir = join(listsDir, "archives");
    await mkdir(archivesDir);
    await writeFile(join(archivesDir, "libsystemd0_257.9-1~deb13u1_arm64.deb"), DEB);
    let fetches = 0;
    const ok = await repairSystemPackages({ cmd: b.cmd, listsDir, archivesDir, workDir: join(listsDir, "w"), fetch: async () => (fetches++, new Response(DEB)) });
    expect(ok.ok).toBe(true);
    expect(fetches).toBe(0);

    const tampered = await repairSystemPackages({
      cmd: box({ damaged: () => true }).cmd,
      listsDir,
      archivesDir: join(listsDir, "none"),
      workDir: join(listsDir, "w"),
      fetch: async () => new Response(Buffer.from("not the package")),
    });
    expect(tampered).toEqual({ ok: false, packages: ["libsystemd0"], reason: "damaged system packages couldn't be downloaded to repair them (libsystemd0 257.9-1~deb13u1)" });
  });

  it("refreshes apt's lists when the installed version isn't in them", async () => {
    const b = box({ damaged: () => true });
    const r = await repairSystemPackages({ cmd: b.cmd, listsDir: await lists(""), fetch: async () => new Response(DEB) });
    expect(b.calls).toContain("apt-get update -qq");
    expect(r).toEqual({ ok: false, packages: ["libsystemd0"], reason: "damaged system packages couldn't be found in the archive to repair them (libsystemd0 257.9-1~deb13u1)" });
  });

  it("finishes a configure a maintainer script broke, and judges by the files", async () => {
    const b = box({ damaged: () => true, dpkgFails: true });
    const listsDir = await lists(stanza("libsystemd0", "257.9-1~deb13u1", "arm64", "pool/x.deb", sha(DEB)));
    const r = await repairSystemPackages({ cmd: b.cmd, listsDir, archivesDir: join(listsDir, "none"), workDir: join(listsDir, "w"), fetch: async () => new Response(DEB) });
    expect(b.calls.some((c) => c.endsWith("dpkg --force-confdef --force-confold --configure -a"))).toBe(true);
    expect(r).toEqual({ ok: true, packages: ["libsystemd0"] });
  });
});
