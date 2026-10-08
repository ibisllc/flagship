// Every audit kind the Worker writes gets a human label and never reaches
// the Activity feed raw — parity with iOS AuditLogViewModel.label /
// displayDetail (the reviewer saw `demo-vps-provisioned serverId=… fqdn=…`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUDIT_KIND_LABELS,
  auditDisplayDetail,
  auditKindLabel,
} from "../public/webapp/lib/auditLog.js";

function workerAuditKinds(): string[] {
  const types = readFileSync(
    fileURLToPath(new URL("../../../packages/storage/src/types.ts", import.meta.url)),
    "utf8",
  );
  const union = types.slice(types.indexOf("export type AuditEventKind ="));
  const body = union.slice(0, union.indexOf('";') + 1).replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/\|\s*"([a-z0-9-]+)"/g)].map((m) => m[1]!);
}

describe("webapp audit labels", () => {
  it("labels every kind in the Worker's AuditEventKind union explicitly", () => {
    const kinds = workerAuditKinds();
    expect(kinds.length).toBeGreaterThan(30);
    expect(kinds.filter((k) => !(k in AUDIT_KIND_LABELS))).toEqual([]);
  });

  it("uses the iOS wording for kinds iOS labels", () => {
    expect(auditKindLabel("demo-vps-provisioned")).toBe("Demo server provisioned");
    expect(auditKindLabel("totp-enrolled")).toBe("Turned on authenticator codes");
    expect(auditKindLabel("re-pair-refused-no-credential")).toBe("Refused a device replacement");
  });

  it("humanizes an unknown future kind instead of showing it raw", () => {
    expect(auditKindLabel("brand-new-kind")).toBe("Brand new kind");
    expect(auditKindLabel("")).toBe("Account event");
  });

  it("hides machine-oriented detail and keeps human detail", () => {
    expect(
      auditDisplayDetail({ eventKind: "demo-vps-provisioned", detail: "serverId=1 fqdn=a.b" }),
    ).toBeNull();
    expect(auditDisplayDetail({ eventKind: "server-created", detail: "home" })).toBe("home");
    expect(auditDisplayDetail({ eventKind: "server-created", detail: "  " })).toBeNull();
  });
});
