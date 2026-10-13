import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aptSources, parseDpkgSearch, parseDpkgVerify, repairSystemPackages } from "../src/systemRepair.js";
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

  async function aptDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "apt-"));
    await mkdir(join(dir, "sources.list.d"));
    await mkdir(join(dir, "mirrors"));
    await writeFile(join(dir, "mirrors", "debian.list"), "https://deb.debian.org/debian\n");
    await writeFile(
      join(dir, "sources.list.d", "debian.sources"),
      `Types: deb deb-src\nURIs: mirror+file://${join(dir, "mirrors", "debian.list")}\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n`,
    );
    return dir;
  }

  function archive(o: { packages: string }) {
    const gz = gzipSync(Buffer.from(o.packages));
    const release = ["Origin: Debian", "Suite: stable", "SHA256:", ` ${"ab".repeat(32)} 10 main/binary-arm64/Packages`, ` ${sha(gz)} ${gz.length} main/binary-arm64/Packages.gz`, ""].join("\n");
    const fetched: string[] = [];
    const fetch = async (u: string) => {
      fetched.push(u);
      if (u.endsWith("/dists/trixie/Release")) return new Response(release);
      if (u.endsWith("/dists/trixie/Release.gpg")) return new Response("sig");
      if (u.endsWith("/dists/trixie/main/binary-arm64/Packages.gz")) return new Response(gz);
      if (u.endsWith(".deb")) return new Response(DEB);
      return new Response("", { status: 404 });
    };
    return { fetch, fetched };
  }

  it("fetches Debian's signed lists itself when the box has none (apt may be the damaged one)", async () => {
    const b = box({ damaged: () => true });
    const a = archive({ packages: stanza("libsystemd0", "257.9-1~deb13u1", "arm64", "pool/main/s/systemd/libsystemd0_257.9-1~deb13u1_arm64.deb", sha(DEB)) });
    const work = await mkdtemp(join(tmpdir(), "work-"));
    const r = await repairSystemPackages({ cmd: b.cmd, listsDir: join(work, "none"), aptDir: await aptDir(), archivesDir: join(work, "none"), workDir: join(work, "w"), fetch: a.fetch });
    expect(r).toEqual({ ok: true, packages: ["libsystemd0"] });
    expect(b.calls.some((c) => c.startsWith("apt-get"))).toBe(false);
    expect(b.calls.find((c) => c.startsWith("sqv --keyring"))).toMatch(/^sqv --keyring \/usr\/share\/keyrings\/debian-archive-keyring\.gpg \S+_Release\.gpg \S+_Release$/);
    expect(a.fetched).toEqual([
      "https://deb.debian.org/debian/dists/trixie/Release",
      "https://deb.debian.org/debian/dists/trixie/Release.gpg",
      "https://deb.debian.org/debian/dists/trixie/main/binary-arm64/Packages.gz",
      "https://deb.debian.org/debian/pool/main/s/systemd/libsystemd0_257.9-1~deb13u1_arm64.deb",
    ]);
  });

  it("refuses lists whose signature doesn't verify", async () => {
    const b = box({ damaged: () => true });
    const cmd = {
      ...b.cmd,
      capture: async (c: string, a: string[]) => {
        if (c === "sqv" && a[0] === "--keyring") throw new Error("sqv exited with code 1: Error: Verification failed");
        return b.cmd.capture(c, a);
      },
    };
    const a = archive({ packages: stanza("libsystemd0", "257.9-1~deb13u1", "arm64", "pool/x.deb", sha(DEB)) });
    const work = await mkdtemp(join(tmpdir(), "work-"));
    const r = await repairSystemPackages({ cmd, listsDir: join(work, "none"), aptDir: await aptDir(), archivesDir: join(work, "none"), workDir: join(work, "w"), fetch: a.fetch });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^damaged system packages couldn't be repaired: Debian's package lists couldn't be fetched \(https:\/\/deb\.debian\.org\/debian trixie: its signature didn't verify/);
    expect(a.fetched.some((u) => u.endsWith(".gz") || u.endsWith(".deb"))).toBe(false);
  });

  it("refuses a package list that doesn't match its signed Release", async () => {
    const b = box({ damaged: () => true });
    const a = archive({ packages: stanza("libsystemd0", "257.9-1~deb13u1", "arm64", "pool/x.deb", sha(DEB)) });
    const work = await mkdtemp(join(tmpdir(), "work-"));
    const tampered = async (u: string) => (u.endsWith("Packages.gz") ? new Response(gzipSync(Buffer.from("Package: evil\n"))) : a.fetch(u));
    const r = await repairSystemPackages({ cmd: b.cmd, listsDir: join(work, "none"), aptDir: await aptDir(), archivesDir: join(work, "none"), workDir: join(work, "w"), fetch: tampered });
    expect(!r.ok && r.reason).toMatch(/Packages\.gz: download didn't match its Release/);
  });

  it("reads one-line and deb822 sources, mirror files expanded", async () => {
    const dir = await aptDir();
    await writeFile(join(dir, "sources.list"), "# comment\ndeb [arch=arm64 signed-by=/k.gpg] http://security.debian.org/debian-security trixie-security main\ndeb-src http://x/ trixie main\n");
    expect(await aptSources(dir)).toEqual([
      { uris: ["http://security.debian.org/debian-security"], suites: ["trixie-security"], components: ["main"], signedBy: ["/k.gpg"] },
      { uris: ["https://deb.debian.org/debian"], suites: ["trixie", "trixie-updates"], components: ["main"], signedBy: ["/usr/share/keyrings/debian-archive-keyring.gpg"] },
    ]);
  });

  it("finishes a configure a maintainer script broke, and judges by the files", async () => {
    const b = box({ damaged: () => true, dpkgFails: true });
    const listsDir = await lists(stanza("libsystemd0", "257.9-1~deb13u1", "arm64", "pool/x.deb", sha(DEB)));
    const r = await repairSystemPackages({ cmd: b.cmd, listsDir, archivesDir: join(listsDir, "none"), workDir: join(listsDir, "w"), fetch: async () => new Response(DEB) });
    expect(b.calls.some((c) => c.endsWith("dpkg --force-confdef --force-confold --configure -a"))).toBe(true);
    expect(r).toEqual({ ok: true, packages: ["libsystemd0"] });
  });
});
