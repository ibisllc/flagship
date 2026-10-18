// Fast console capture of Studio's QEMU guest over QMP screendump (~every 0.2s, 5 min).
const net = require("net");
const { execSync } = require("child_process");
const fs = require("fs");
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

function qmpPort() {
  try {
    const cmd = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'qemu-system-x86_64.exe\'\\").CommandLine"',
      { encoding: "utf8" },
    );
    const m = cmd.match(/-qmp tcp:127\.0\.0\.1:(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function shot(port, file) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let st = 0;
    let ok = false;
    const done = () => { try { s.destroy(); } catch {} resolve(ok); };
    s.on("error", done);
    s.on("data", (d) => {
      const t = d.toString();
      if (st === 0 && t.includes("QMP")) { s.write(JSON.stringify({ execute: "qmp_capabilities" }) + "\n"); st = 1; }
      else if (st === 1) { s.write(JSON.stringify({ execute: "screendump", arguments: { filename: file, format: "png" } }) + "\n"); st = 2; }
      else if (st === 2) { ok = t.includes("return"); done(); }
    });
    setTimeout(done, 4000);
  });
}

(async () => {
  const end = Date.now() + 5 * 60_000;
  let n = 0;
  let port = null;
  while (Date.now() < end) {
    if (!port) port = qmpPort();
    if (port) {
      const file = `${out}\\cap-${String(n++).padStart(4, "0")}.png`;
      const ok = await shot(port, file);
      if (!ok) port = null;
    } else {
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 120));
  }
})();
