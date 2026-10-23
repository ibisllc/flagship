/**
 * First contact on the box (protocol `enrollment.ts`). The recipe's one-time enrollment secret
 * (`enrollmentKeyHex`, an unsigned sibling of the signed blob like `swkHex`) proves to the creating
 * device that this key is the one built from its recipe; the proof rides in the first request the
 * phone answers. After the phone's blessing the secret is removed from disk. The server code (six
 * digits from the key) is written to the console so a person can compare it with the phone.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { enrollmentProofHex, serverCode } from "@flagship/protocol";
import { writeFileDurable } from "./durableFile.js";

const HEX64 = /^[0-9a-f]{64}$/;
export const SERVER_CODE_ISSUE = "/etc/issue.d/50-flagship-server-code.issue";

/** `{ enrollmentProof }` for the first request's deviceInfo, or `{}` when the recipe carried no secret. */
export async function enrollmentDeviceInfo(o: { blobPath: string; serverDomain: string; stkPubHex: string }): Promise<{ enrollmentProof?: string }> {
  try {
    const b = JSON.parse(await readFile(o.blobPath, "utf8")) as { enrollmentKeyHex?: unknown; authCode?: { serial?: unknown } };
    const key = typeof b.enrollmentKeyHex === "string" ? b.enrollmentKeyHex.toLowerCase() : "";
    const serial = b.authCode?.serial;
    if (!HEX64.test(key) || typeof serial !== "string") return {};
    return { enrollmentProof: enrollmentProofHex(Buffer.from(key, "hex"), { serverDomain: o.serverDomain, stkPubHex: o.stkPubHex, authCodeSerial: serial }) };
  } catch {
    return {};
  }
}

/** Once the phone has blessed this box the secret has done its job: drop it from the install blob. */
export async function forgetEnrollmentSecret(blobPath: string): Promise<void> {
  try {
    const b = JSON.parse(await readFile(blobPath, "utf8")) as Record<string, unknown>;
    if (!("enrollmentKeyHex" in b)) return;
    delete b.enrollmentKeyHex;
    await writeFileDurable(blobPath, JSON.stringify(b), 0o600);
  } catch {
    // Nothing to forget, or the blob is gone: the secret is not on disk either way.
  }
}

/** Show the server code on the machine's own screen: the login banner and, once, the console. */
/** The one-way port Studio adds to a VM it hosts: the guest writes, the host reads, nothing comes back. */
export const STUDIO_CODE_PORT = "/dev/virtio-ports/org.flagshipserver.server-code";

export async function showServerCode(o: { stkPubHex: string; serverDomain: string; issuePath?: string; consolePath?: string; studioPortPath?: string }): Promise<string> {
  const code = serverCode(o.stkPubHex);
  const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;
  const text = `Flagship server ${o.serverDomain}\nIf your phone asks, this server's code is ${pretty}\n\n`;
  const issue = o.issuePath ?? SERVER_CODE_ISSUE;
  await mkdir(issue.slice(0, issue.lastIndexOf("/")), { recursive: true }).catch(() => {});
  await writeFileDurable(issue, text, 0o644).catch(() => {});
  // The fixed line is for Studio, which confirms the code with the phone itself:
  // `flagship-server-code <domain> <code> <stkPubHex>`.
  const line = `flagship-server-code ${o.serverDomain.toLowerCase()} ${code} ${o.stkPubHex}\n`;
  await appendFile(o.consolePath ?? "/dev/console", `\n${text}${line}`).catch(() => {});
  // A VM Studio hosts has no console the host can read; its one-way port is where Studio looks.
  await appendFile(o.studioPortPath ?? STUDIO_CODE_PORT, line).catch(() => {});
  return code;
}
