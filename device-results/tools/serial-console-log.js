// Attaches to Studio's QEMU serial chardev as soon as it exists and logs everything.
const net = require("net");
const { execSync } = require("child_process");
const fs = require("fs");
const out = process.argv[2];
const end = Date.now() + 6 * 60_000;

function serialPort() {
  try {
    const cmd = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'qemu-system-x86_64.exe\'\\").CommandLine"',
      { encoding: "utf8" },
    );
    const m = cmd.match(/id=ser0,host=127\.0\.0\.1,port=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function attach(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("data", (d) => fs.appendFileSync(out, d));
    s.on("error", () => resolve());
    s.on("close", () => resolve());
  });
}

(async () => {
  fs.writeFileSync(out, "");
  while (Date.now() < end) {
    const p = serialPort();
    if (p) {
      fs.appendFileSync(out, `\n--- attached to ${p} ---\n`);
      await attach(p);
      fs.appendFileSync(out, "\n--- detached ---\n");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
})();
