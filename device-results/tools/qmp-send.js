// usage: node q.js <port> shot <file> | keys <k1> <k2>... | text <string> | cmd <qmp-json>
const net = require("net");
const [port, op, ...rest] = process.argv.slice(2);
const KEYMAP = { " ": "spc", "=": "equal", "-": "minus", "/": "slash", ".": "dot", ",": "comma", ";": "semicolon", ":": "shift-semicolon", "_": "shift-minus", "\n": "ret", "'": "apostrophe", '"': "shift-apostrophe", "$": "shift-4", "(": "shift-9", ")": "shift-0", "|": "shift-backslash", "&": "shift-7", ">": "shift-dot", "<": "shift-comma", "*": "shift-8", "!": "shift-1", "[": "bracket_left", "]": "bracket_right", "\\": "backslash", "?": "shift-slash", "+": "shift-equal", "%": "shift-5", "#": "shift-3", "@": "shift-2" };
function keyFor(c) { if (KEYMAP[c]) return KEYMAP[c]; if (/[A-Z]/.test(c)) return "shift-" + c.toLowerCase(); return c; }
function keyObj(k) { return { type: "combo", data: k.split("-").map((x) => ({ type: "qcode", data: x })) }; }
function toCmds() {
  if (op === "shot") return [{ execute: "screendump", arguments: { filename: rest[0], format: "png" } }];
  if (op === "keys") return rest.map((k) => ({ execute: "send-key", arguments: { keys: k.split("+").map((x) => ({ type: "qcode", data: x })) } }));
  if (op === "text") return [...rest.join(" ")].map((c) => ({ execute: "send-key", arguments: { keys: keyFor(c).split("-").map((x) => ({ type: "qcode", data: x })) } }));
  if (op === "cmd") return [JSON.parse(rest[0])];
  return [];
}
const cmds = toCmds();
const s = net.connect(Number(port), "127.0.0.1");
let st = 0, i = 0;
s.on("error", (e) => { console.log("ERR", e.message); process.exit(1); });
s.on("data", (d) => {
  for (const line of d.toString().split("\n").filter(Boolean)) {
    if (line.includes('"QMP"')) { s.write(JSON.stringify({ execute: "qmp_capabilities" }) + "\n"); continue; }
    if (line.includes('"event"')) continue;
    if (st === 0) { st = 1; }
    if (i < cmds.length) { s.write(JSON.stringify(cmds[i++]) + "\n"); }
    else { if (line.includes("error")) console.log(line); s.end(); process.exit(0); }
  }
});
setTimeout(() => process.exit(0), 20000);
