// Every webapp module must parse as an ES module. The webapp ships its sources
// as they are (no bundler), so one early error such as an identifier imported
// twice stops the whole shell from booting, and the unit tests only load the
// modules they exercise.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEBAPP = resolve(__dirname, "../public/webapp");

const PARSE_ALL = `
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = process.argv[1], bad = [];
let n = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".js")) {
      n++;
      try { new vm.SourceTextModule(fs.readFileSync(p, "utf8"), { identifier: p }); }
      catch (err) { bad.push(path.relative(root, p) + ": " + err.message); }
    }
  }
})(root);
process.stdout.write(JSON.stringify({ n, bad }));
`;

describe("webapp modules", () => {
  it("every .js under public/webapp parses as an ES module", () => {
    const out = execFileSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", "-e", PARSE_ALL, WEBAPP], {
      encoding: "utf8",
    });
    const { n, bad } = JSON.parse(out) as { n: number; bad: string[] };
    expect(n).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });
});
