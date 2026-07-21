/**
 * SEC-6 — uniform per-field separator/control-char rejection.
 *
 * `legacyFieldGuard` rejects the canonical-bytes separator '|' (0x7c) and
 * any control char (0x00-0x1F, 0x7F) in a free-text field at sign-time, so a
 * caller-supplied string can never canonicalize ambiguously. This file proves
 * the guard is applied to every previously-unguarded free-text field across
 * the older canonical builders + the daemon-status report.
 *
 * For each field: a '|' AND a control char () must throw from the
 * signer (which calls the canonical builder). Hex / enum / numeric fields are
 * NOT covered here — they are shape-constrained and intentionally unguarded.
 */
import { describe, expect, it } from "vitest";
import {
  type AuthCode,
  type AuthCodeRevocation,
  type Dns01DeleteRequest,
  type Dns01PublishRequest,
  type EntitlementRevocationList,
  type InstallBlob,
  type InstallServiceRequest,
  type LlmPromoIssueComplete,
  type LlmPromoIssueRequest,
  type LlmPromoIssueStart,
  type PbAnnounce,
  type PbPeerConfirm,
  type PhoneOrder,
  type ProvisionEvent,
  type PublishServerDns,
  type PushTokenRegister,
  type RePairInitiate,
  type RePairObject,
  type RegisterUser,
  type ReleaseServerName,
  type RootEntitlement,
  type ServerRegisterRequest,
  type ServerRevokeBySelf,
  type ServiceEntitlement,
  type ServiceRename,
  type SetCustomDomain,
  type SetServiceEnvRequest,
  type TotpDisable,
  type TotpEnrollBegin,
  type TotpEnrollConfirm,
  type UninstallServiceRequest,
  type UpdatePullRequest,
  type UploadRecoveryRecord,
  type VoiciShorten,
  type WipeRestart,
  type AutoUnlockLease,
  type RevokeAutoUnlockLease,
  signAuthCode,
  signAuthCodeRevocation,
  signDns01Delete,
  signDns01Publish,
  signEntitlementRevocationList,
  signInstallBlob,
  signInstallService,
  signLlmPromoIssue,
  signLlmPromoIssueComplete,
  signLlmPromoIssueStart,
  signPbAnnounce,
  signPbPeerConfirm,
  signPhoneOrder,
  signProvisionEvent,
  signPublishServerDns,
  signPushTokenRegister,
  signRePairInitiate,
  signRePairObject,
  signRegisterUser,
  signReleaseServerName,
  signRootEntitlement,
  signServerRegister,
  signServerRevokeBySelf,
  signServiceEntitlement,
  signServiceRename,
  signSetCustomDomain,
  signSetServiceEnv,
  signTotpDisable,
  signTotpEnrollBegin,
  signTotpEnrollConfirm,
  signUninstallService,
  signUpdatePull,
  signUploadRecoveryRecord,
  signVoiciShorten,
  signWipeRestart,
  signAutoUnlockLease,
  signRevokeAutoUnlockLease,
} from "../src/auth.js";
import {
  canonicalDaemonStatusReport,
  type DaemonStatusReport,
} from "../src/daemonStatus.js";
import { deriveIRK } from "../src/keys.js";

const umk = { seed: new Uint8Array(32).fill(42) };
const kp = deriveIRK(umk);

const PIPE = "|";
const CTRL = "";
const NOW = 1_780_000_000_000;
const LATER = NOW + 86_400_000;
const HEX32 = new Uint8Array(32).fill(7);
const PUB = HEX32;

/** Assert a builder throws for BOTH a '|' and a control char in `field`. */
function bothBad<T>(
  build: (bad: string) => T,
  sign: (t: T) => unknown,
): void {
  expect(() => sign(build(PIPE))).toThrow();
  expect(() => sign(build(CTRL))).toThrow();
}

const baseAuthCode = (o: Partial<AuthCode> = {}): AuthCode => ({
  version: 1,
  serial: "SER-1",
  username: "alice",
  serverName: "kitchen",
  serverDomain: "kitchen.alice.flagship.services",
  delegatedPubKey: PUB,
  userPubKey: PUB,
  issuedAt: NOW,
  expiresAt: LATER,
  ...o,
});

describe("SEC-6 — PhoneOrder variants", () => {
  it("revoke-self.reason", () => {
    bothBad<PhoneOrder>(
      (reason) => ({ type: "revoke-self", serverId: "s", reason, issuedAt: NOW }),
      (o) => signPhoneOrder(o, kp),
    );
  });
  it("browser-input-response.{tabId,value,screenshotRef}", () => {
    const mk = (f: "tabId" | "value" | "screenshotRef", bad: string): PhoneOrder => ({
      type: "browser-input-response",
      serverId: "s",
      tabId: f === "tabId" ? bad : "t",
      inputKind: "text",
      value: f === "value" ? bad : "v",
      screenshotRef: f === "screenshotRef" ? bad : "r",
      issuedAt: NOW,
    });
    for (const f of ["tabId", "value", "screenshotRef"] as const) {
      bothBad<PhoneOrder>((bad) => mk(f, bad), (o) => signPhoneOrder(o, kp));
    }
  });
  it("add/remove-subscriber.{serviceId,fqdn}", () => {
    for (const type of ["add-subscriber", "remove-subscriber"] as const) {
      for (const f of ["serviceId", "fqdn"] as const) {
        bothBad<PhoneOrder>(
          (bad) => ({
            type,
            serverId: "s",
            serviceId: f === "serviceId" ? bad : "svc",
            fqdn: f === "fqdn" ? bad : "x.example",
            issuedAt: NOW,
          }),
          (o) => signPhoneOrder(o, kp),
        );
      }
    }
  });
  it("add-paired-session.token + remove-paired-session.token", () => {
    bothBad<PhoneOrder>(
      (token) => ({ type: "add-paired-session", serverId: "s", token, issuedAt: NOW }),
      (o) => signPhoneOrder(o, kp),
    );
    bothBad<PhoneOrder>(
      (token) => ({ type: "remove-paired-session", serverId: "s", token, issuedAt: NOW }),
      (o) => signPhoneOrder(o, kp),
    );
  });
  it("backup-app.{creator,slug,password}", () => {
    for (const f of ["creator", "slug", "password"] as const) {
      bothBad<PhoneOrder>(
        (bad) => ({
          type: "backup-app",
          serverId: "s",
          creator: f === "creator" ? bad : "c",
          slug: f === "slug" ? bad : "g",
          includeUserData: false,
          password: f === "password" ? bad : "pw",
          issuedAt: NOW,
        }),
        (o) => signPhoneOrder(o, kp),
      );
    }
  });
});

describe("SEC-6 — auth-code / install-blob / server-register family", () => {
  it("AuthCode.{serial,username,serverName,serverDomain}", () => {
    for (const f of ["serial", "username", "serverName", "serverDomain"] as const) {
      bothBad<AuthCode>((bad) => baseAuthCode({ [f]: bad }), (c) => signAuthCode(c, kp));
    }
  });
  it("InstallBlob.{serverDomain,username,serverName,registrationUrl,installerGitRef,authCode.serial}", () => {
    const base = (o: Partial<InstallBlob> = {}): InstallBlob => ({
      version: 2,
      serverDomain: "k.alice.flagship.services",
      username: "alice",
      serverName: "kitchen",
      phoneDelegatedPubKey: PUB,
      registrationUrl: "https://flagshipserver.com/api/server/register",
      authCode: baseAuthCode(),
      authCodeUserSignature: PUB,
      installerGitRef: "v0.1.0",
      rckPubKey: PUB,
      ...o,
    });
    for (const f of ["serverDomain", "username", "serverName", "registrationUrl", "installerGitRef"] as const) {
      bothBad<InstallBlob>((bad) => base({ [f]: bad }), (b) => signInstallBlob(b, kp));
    }
    bothBad<InstallBlob>(
      (bad) => base({ authCode: baseAuthCode({ serial: bad }) }),
      (b) => signInstallBlob(b, kp),
    );
  });
  it("ServerRegisterRequest.authCode.{serial,serverDomain}", () => {
    const base = (ac: AuthCode): ServerRegisterRequest => ({
      authCode: ac,
      authCodeUserSignature: PUB,
      serverIdentityPubKey: PUB,
      issuedAt: NOW,
      nonce: PUB,
    });
    bothBad<ServerRegisterRequest>(
      (bad) => base(baseAuthCode({ serial: bad })),
      (r) => signServerRegister(r, kp),
    );
    bothBad<ServerRegisterRequest>(
      (bad) => base(baseAuthCode({ serverDomain: bad })),
      (r) => signServerRegister(r, kp),
    );
  });
  it("AuthCodeRevocation.{serial,username}", () => {
    for (const f of ["serial", "username"] as const) {
      bothBad<AuthCodeRevocation>(
        (bad) => ({ serial: "s", username: "u", [f]: bad, issuedAt: NOW }),
        (r) => signAuthCodeRevocation(r, kp),
      );
    }
  });
  it("ReleaseServerName.{username,serverDomain}", () => {
    for (const f of ["username", "serverDomain"] as const) {
      bothBad<ReleaseServerName>(
        (bad) => ({ username: "u", serverDomain: "d", [f]: bad, issuedAt: NOW }),
        (r) => signReleaseServerName(r, kp),
      );
    }
  });
});

describe("SEC-6 — DNS / peer-backup / promo", () => {
  it("PublishServerDns.{userId,serverId,directIp}", () => {
    for (const f of ["userId", "serverId", "directIp"] as const) {
      bothBad<PublishServerDns>(
        (bad) => ({ userId: "u", serverId: "s", mode: "direct", directIp: "1.2.3.4", [f]: bad, issuedAt: NOW }),
        (r) => signPublishServerDns(r, kp),
      );
    }
  });
  it("Dns01Publish.{serverId,recordName}", () => {
    for (const f of ["serverId", "recordName"] as const) {
      bothBad<Dns01PublishRequest>(
        (bad) => ({ serverId: "s", recordName: "_acme.x", recordValueHash: PUB, [f]: bad, issuedAt: NOW }),
        (r) => signDns01Publish(r, kp),
      );
    }
  });
  it("Dns01Delete.{serverId,recordId}", () => {
    for (const f of ["serverId", "recordId"] as const) {
      bothBad<Dns01DeleteRequest>(
        (bad) => ({ serverId: "s", recordId: "rec", [f]: bad, issuedAt: NOW }),
        (r) => signDns01Delete(r, kp),
      );
    }
  });
  it("PbAnnounce.{region,tunnelEndpoint}", () => {
    for (const f of ["region", "tunnelEndpoint"] as const) {
      bothBad<PbAnnounce>(
        (bad) => ({
          serverId: "s",
          pledgedBytes: 1,
          shareRatio: 1,
          maxShardSize: 1,
          region: f === "region" ? bad : "us",
          tunnelEndpoint: f === "tunnelEndpoint" ? bad : "1.2.3.4:5",
          issuedAt: NOW,
        }),
        (a) => signPbAnnounce(a, kp),
      );
    }
  });
  it("PbPeerConfirm.shardId", () => {
    bothBad<PbPeerConfirm>(
      (shardId) => ({ peerServerId: "p", requesterServerId: "r", shardId, issuedAt: NOW }),
      (c) => signPbPeerConfirm(c, kp),
    );
  });
  it("LlmPromoIssueStart.userId / Complete.{userId,ticket} / Issue.{username,serverFqdn}", () => {
    bothBad<LlmPromoIssueStart>(
      (userId) => ({ userId, method: "phone-otp", identityHash: PUB, issuedAt: NOW }),
      (r) => signLlmPromoIssueStart(r, kp),
    );
    for (const f of ["userId", "ticket"] as const) {
      bothBad<LlmPromoIssueComplete>(
        (bad) => ({ userId: "u", ticket: "t", [f]: bad, otpHash: PUB, issuedAt: NOW }),
        (r) => signLlmPromoIssueComplete(r, kp),
      );
    }
    for (const f of ["username", "serverFqdn"] as const) {
      bothBad<LlmPromoIssueRequest>(
        (bad) => ({
          username: "u",
          serverFqdn: "x.flagship.services",
          provider: "anthropic",
          desiredDailyInputTokenCap: 1,
          desiredDailyOutputTokenCap: 1,
          [f]: bad,
          issuedAt: NOW,
        }),
        (r) => signLlmPromoIssue(r, kp),
      );
    }
  });
});

describe("SEC-6 — service / recovery / lease / totp", () => {
  it("ProvisionEvent.error", () => {
    bothBad<ProvisionEvent>(
      (error) => ({ serverDomain: "d", phase: "failed", error, issuedAt: NOW }),
      (e) => signProvisionEvent(e, kp),
    );
  });
  it("InstallService.{creator,slug} (manifestJson EXEMPT — a '|' is allowed)", () => {
    const base = (o: Partial<InstallServiceRequest> = {}): InstallServiceRequest => ({
      serverId: "s",
      creator: "c",
      slug: "g",
      manifestJson: '{"name":"x"}',
      addOwnerToMembership: true,
      issuedAt: NOW,
      ...o,
    });
    for (const f of ["creator", "slug"] as const) {
      bothBad<InstallServiceRequest>((bad) => base({ [f]: bad }), (r) => signInstallService(r, kp));
    }
    // manifestJson legitimately carries '|' — must NOT throw.
    expect(() => signInstallService(base({ manifestJson: '{"a":"b|c"}' }), kp)).not.toThrow();
  });
  it("UninstallService.{creator,slug}", () => {
    for (const f of ["creator", "slug"] as const) {
      bothBad<UninstallServiceRequest>(
        (bad) => ({ serverId: "s", creator: "c", slug: "g", [f]: bad, issuedAt: NOW }),
        (r) => signUninstallService(r, kp),
      );
    }
  });
  it("SetServiceEnv.{creator,slug,env-key,env-value}", () => {
    const base = (o: Partial<SetServiceEnvRequest> = {}): SetServiceEnvRequest => ({
      serverId: "s",
      creator: "c",
      slug: "g",
      env: { K: "v" },
      issuedAt: NOW,
      ...o,
    });
    for (const f of ["creator", "slug"] as const) {
      bothBad<SetServiceEnvRequest>((bad) => base({ [f]: bad }), (r) => signSetServiceEnv(r, kp));
    }
    // env key
    expect(() => signSetServiceEnv(base({ env: { ["A|B"]: "v" } }), kp)).toThrow();
    expect(() => signSetServiceEnv(base({ env: { ["AB"]: "v" } }), kp)).toThrow();
    // env value
    expect(() => signSetServiceEnv(base({ env: { K: "v|w" } }), kp)).toThrow();
    expect(() => signSetServiceEnv(base({ env: { K: "vw" } }), kp)).toThrow();
  });
  it("UpdatePull.{creator,slug,since}", () => {
    for (const f of ["creator", "slug", "since"] as const) {
      bothBad<UpdatePullRequest>(
        (bad) => ({ pullerServerId: "s", creator: "c", slug: "g", since: "abc", [f]: bad, issuedAt: NOW }),
        (r) => signUpdatePull(r, kp),
      );
    }
  });
  it("UploadRecoveryRecord.{username,credentialIdHex,wrappedUmkHashHex}", () => {
    for (const f of ["username", "credentialIdHex", "wrappedUmkHashHex"] as const) {
      bothBad<UploadRecoveryRecord>(
        (bad) => ({ username: "u", credentialIdHex: "ab", wrappedUmkHashHex: "cd", [f]: bad, issuedAt: NOW }),
        (r) => signUploadRecoveryRecord(r, kp),
      );
    }
  });
  it("WipeRestart.{username,newCredentialIdHex,newWrappedUmkHashHex}", () => {
    for (const f of ["username", "newCredentialIdHex", "newWrappedUmkHashHex"] as const) {
      bothBad<WipeRestart>(
        (bad) => ({
          username: "u",
          oldIrkPub: PUB,
          newIrkPub: PUB,
          newCredentialIdHex: "ab",
          newWrappedUmkHashHex: "cd",
          [f]: bad,
          issuedAt: NOW,
        }),
        (r) => signWipeRestart(r, kp),
      );
    }
  });
  it("ServerRevokeBySelf.reason", () => {
    bothBad<ServerRevokeBySelf>(
      (reason) => ({ serverId: "s", reason, issuedAt: NOW }),
      (r) => signServerRevokeBySelf(r, kp),
    );
  });
  it("AutoUnlockLease.leaseId / RevokeAutoUnlockLease.leaseId", () => {
    bothBad<AutoUnlockLease>(
      (leaseId) => ({ serverId: "s", leaseId, expiresAt: LATER, unlockKey: PUB, multiUse: false, issuedAt: NOW }),
      (r) => signAutoUnlockLease(r, kp),
    );
    bothBad<RevokeAutoUnlockLease>(
      (leaseId) => ({ serverId: "s", leaseId, issuedAt: NOW }),
      (r) => signRevokeAutoUnlockLease(r, kp),
    );
  });
  it("ServiceRename.{username,serviceId,newDisplayLabel}", () => {
    for (const f of ["username", "serviceId", "newDisplayLabel"] as const) {
      bothBad<ServiceRename>(
        (bad) => ({ username: "u", serviceId: "svc", newDisplayLabel: "lbl", [f]: bad, issuedAt: NOW }),
        (r) => signServiceRename(r, kp),
      );
    }
  });
  it("SetCustomDomain.{username,serviceId,fqdn}", () => {
    for (const f of ["username", "serviceId", "fqdn"] as const) {
      bothBad<SetCustomDomain>(
        (bad) => ({ username: "u", serviceId: "svc", fqdn: "x.example.com", [f]: bad, issuedAt: NOW }),
        (r) => signSetCustomDomain(r, kp),
      );
    }
  });
  it("VoiciShorten.{username,serviceId,targetUrl}", () => {
    for (const f of ["username", "serviceId", "targetUrl"] as const) {
      bothBad<VoiciShorten>(
        (bad) => ({ username: "u", serviceId: "svc", targetUrl: "https://x", [f]: bad, issuedAt: NOW }),
        (r) => signVoiciShorten(r, kp),
      );
    }
  });
  it("Totp{EnrollBegin,EnrollConfirm,Disable}.username", () => {
    bothBad<TotpEnrollBegin>((username) => ({ username, issuedAt: NOW }), (r) => signTotpEnrollBegin(r, kp));
    bothBad<TotpEnrollConfirm>((username) => ({ username, issuedAt: NOW }), (r) => signTotpEnrollConfirm(r, kp));
    bothBad<TotpDisable>((username) => ({ username, issuedAt: NOW }), (r) => signTotpDisable(r, kp));
  });
  it("RePairInitiate.username / RePairObject.username", () => {
    bothBad<RePairInitiate>(
      (username) => ({ username, newIrkPub: PUB, oldIrkPub: PUB, issuedAt: NOW }),
      (r) => signRePairInitiate(r, kp),
    );
    bothBad<RePairObject>(
      (username) => ({ username, newIrkPub: PUB, issuedAt: NOW }),
      (r) => signRePairObject(r, kp),
    );
  });
  it("RegisterUser.username", () => {
    bothBad<RegisterUser>((username) => ({ username, irkPub: PUB, issuedAt: NOW }), (r) => signRegisterUser(r, kp));
  });
  it("PushTokenRegister.{username,deviceId,providerToken}", () => {
    for (const f of ["username", "deviceId", "providerToken"] as const) {
      bothBad<PushTokenRegister>(
        (bad) => ({
          username: "u",
          deviceId: "0123456789abcdef0123456789abcdef",
          platform: "apns",
          providerToken: "tok",
          pushX25519Pub: PUB,
          [f]: bad,
          issuedAt: NOW,
        }),
        (r) => signPushTokenRegister(r, kp),
      );
    }
  });
});

describe("SEC-6 — entitlements", () => {
  it("RootEntitlement.{username,podCanonical}", () => {
    for (const f of ["username", "podCanonical"] as const) {
      bothBad<RootEntitlement>(
        (bad) => ({ username: "u", podPubKey: PUB, podCanonical: "k.u.flagship.services", [f]: bad, issuedAt: NOW }),
        (c) => signRootEntitlement(c, kp),
      );
    }
  });
  it("ServiceEntitlement.username + each canonical", () => {
    bothBad<ServiceEntitlement>(
      (username) => ({ username, podPubKey: PUB, canonicals: ["a.u.flagship.services"], issuedAt: NOW, expiresAt: LATER }),
      (c) => signServiceEntitlement(c, kp),
    );
    bothBad<ServiceEntitlement>(
      (canonical) => ({ username: "u", podPubKey: PUB, canonicals: [canonical], issuedAt: NOW, expiresAt: LATER }),
      (c) => signServiceEntitlement(c, kp),
    );
  });
  it("EntitlementRevocationList.username", () => {
    bothBad<EntitlementRevocationList>(
      (username) => ({ username, certIds: ["ab"], issuedAt: NOW }),
      (r) => signEntitlementRevocationList(r, kp),
    );
  });
});

describe("SEC-6 — daemon-status report", () => {
  const base = (o: Partial<DaemonStatusReport> = {}): DaemonStatusReport => ({
    serverDomain: "k.u.flagship.services",
    certSha256: "ab".repeat(32),
    certValidUntil: LATER,
    certIssuer: "CN=YR1",
    appsServed: ["app.k.u.flagship.services"],
    nonce: "abcd",
    issuedAt: NOW,
    ...o,
  });
  it("rejects '|' / control chars in serverDomain, certSha256, certIssuer, appsServed, nonce", () => {
    for (const f of ["serverDomain", "certSha256", "certIssuer", "nonce"] as const) {
      expect(() => canonicalDaemonStatusReport(base({ [f]: PIPE }))).toThrow();
      expect(() => canonicalDaemonStatusReport(base({ [f]: CTRL }))).toThrow();
    }
    expect(() => canonicalDaemonStatusReport(base({ appsServed: [PIPE] }))).toThrow();
    expect(() => canonicalDaemonStatusReport(base({ appsServed: [CTRL] }))).toThrow();
  });
  it("a clean report still canonicalizes", () => {
    expect(() => canonicalDaemonStatusReport(base())).not.toThrow();
  });
});
