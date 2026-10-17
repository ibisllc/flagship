// Owner rule "one biometric per admin invite" on the webapp: every
// admin-root-signed invite or grant (an app invite and its rank, a rank
// change, a server-share offer, its confirm, raising a share) first takes one
// fresh unlock (lib/freshUnlock.js); turning things off and withdrawing use
// the session. The gym scenarios drive each one; this pins where the gates sit.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = (p: string) => readFileSync(resolve(__dirname, "..", "public", "webapp", p), "utf8");
const body = (s: string, start: string, end: string) => s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start)));

describe("admin invites and rank orders take a fresh unlock", () => {
  const sa = src("views/service-access.js");

  it("an admin's app invite asks once, before anything is signed", () => {
    const add = body(sa, "async function onAdd(", "\n}\n");
    const ask = add.indexOf("freshAdminUnlock(");
    expect(ask).toBeGreaterThan(-1);
    expect(add.slice(0, ask)).toContain("if (admin)");
    expect(ask).toBeLessThan(add.indexOf("createInvite("));
    expect(ask).toBeLessThan(add.indexOf("setAppRank("));
    expect(add.match(/freshAdminUnlock\(/g)).toHaveLength(1);
  });

  it("a rank change asks; refusing, removing and the mode use the session", () => {
    expect(body(sa, "async function onPickRole(", "\n}\n")).toContain("freshAdminUnlock(");
    expect(body(sa, "async function onRefuse(", "\n}\n")).not.toContain("freshAdminUnlock(");
    expect(body(sa, "async function onPickMode(", "\n}\n")).not.toContain("freshAdminUnlock(");
  });

  it("a server share's offer, confirm and raised level or opt-in ask; lowering doesn't", () => {
    const ss = src("views/server-sharing.js");
    expect(ss).toContain("{ prompt: sheetPrompt(dlg) }");
    expect(body(ss, '"[data-share-confirm]"', "});\n  });")).toContain("freshShareUnlock(");
    const level = body(ss, '"[data-share-level]"', "});\n  });");
    expect(level).toContain('if (level === "manage")');
    const opt = body(ss, '"[data-share-opt]"', "});\n  });");
    expect(opt).toContain("if (on)");
    expect(body(ss, '"[data-share-remove]"', "});\n  });")).not.toContain("freshShareUnlock(");
  });
});
