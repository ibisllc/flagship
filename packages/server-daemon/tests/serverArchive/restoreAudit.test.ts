import { describe, expect, it } from "vitest";
import { auditDumpToc, describeExecutable, ownerChanged, pinnedImageRef } from "../../src/serverArchive/restoreAudit.js";

const D = "sha256:" + "a".repeat(64);

describe("pinnedImageRef", () => {
  it("keeps a digest the manifest already names", () => {
    expect(pinnedImageRef(`ghcr.io/acme/notes@${D}`, undefined)).toEqual({ ok: true, ref: `ghcr.io/acme/notes@${D}` });
  });
  it("pins a tag to the digest the backup recorded, whatever the tag is now", () => {
    expect(pinnedImageRef("ghcr.io/acme/notes:latest", D)).toEqual({ ok: true, ref: `ghcr.io/acme/notes@${D}` });
    expect(pinnedImageRef("registry:5000/acme/notes:1.2", D)).toEqual({ ok: true, ref: `registry:5000/acme/notes@${D}` });
  });
  it("refuses a bare tag with nothing recorded, and a malformed record", () => {
    expect(pinnedImageRef("ghcr.io/acme/notes:latest", undefined).ok).toBe(false);
    expect(pinnedImageRef("ghcr.io/acme/notes:latest", "sha256:short").ok).toBe(false);
  });
});

describe("auditDumpToc", () => {
  const toc = (...lines: string[]) => ["; Archive created at 2026", ...lines].join("\n");
  it("a plain schema with tables passes and reports nothing to say", () => {
    const a = auditDumpToc(toc("200; 1259 16400 TABLE public notes app", "201; 1259 16410 TABLE DATA public notes app", "202; 2606 16420 CONSTRAINT public notes notes_pkey app"));
    expect(a.refused).toEqual([]);
    expect(describeExecutable(a)).toBeNull();
  });
  it("counts functions, triggers and rules so the owner is told", () => {
    const a = auditDumpToc(toc("210; 1255 16430 FUNCTION public touch() app", "211; 2620 16440 TRIGGER public notes touch_t app", "212; 2618 16450 RULE public notes r app"));
    expect(a.refused).toEqual([]);
    expect(describeExecutable(a)).toBe("its database holds 1 function, 1 trigger, 1 rule that run inside the app's own database");
  });
  it("refuses event triggers, foreign servers, languages, publications and an extension this server does not provide", () => {
    for (const bad of [
      "1; 1 1 EVENT TRIGGER - ddl_hook postgres",
      "2; 1 1 FOREIGN DATA WRAPPER - fdw postgres",
      "3; 1 1 SERVER - remote postgres",
      "4; 1 1 PROCEDURAL LANGUAGE - plpython3u postgres",
      "5; 1 1 PUBLICATION - everything app",
      "6; 3079 16390 EXTENSION - dblink",
    ]) {
      expect(auditDumpToc(toc(bad)).refused.length, bad).toBe(1);
    }
  });
  it("accepts an extension this server creates for every app, and refuses a line it cannot read", () => {
    expect(auditDumpToc(toc("7; 3079 16391 EXTENSION - pgcrypto")).refused).toEqual([]);
    expect(auditDumpToc(toc("this is not a toc line")).refused.length).toBe(1);
  });
});

describe("ownerChanged", () => {
  it("is true when the backup's creator is not the account this server belongs to", () => {
    expect(ownerChanged("harry--notes", "sam")).toBe(true);
    expect(ownerChanged("sam--notes", "sam")).toBe(false);
    expect(ownerChanged("junk", "sam")).toBe(true);
  });
});
